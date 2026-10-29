import ExcelJS from 'exceljs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { openDatabase } from './db.js';
import { normalizeAnswerType, parseEvalWorkbook } from './evaluation.js';
import { KnowledgeBase } from './knowledge/index.js';
import { activateQaVersion, createQaDraft } from './knowledge/store.js';
import type { LlmClient } from './llm/index.js';

/** 근거 자료의 첫 표준답안만 인용하는 가짜 모델 */
const firstCitingLlm: LlmClient = {
  provider: 'fake',
  model: 'fake-1',
  async generate(req) {
    const id = req.messages.at(-1)!.content.match(/통합번호: ([^ |\]]+)/)?.[1];
    return {
      text: JSON.stringify({ answer_type: '근거답변', business_type: '공통', answer_markdown: '답', cited_qa_ids: id ? [id] : [], cited_guideline: [], referral: '없음' }),
      provider: 'fake',
      model: 'fake-1',
      inputTokens: 100,
      outputTokens: 10,
    };
  },
};

async function evalXlsx(rows: (string | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('평가질문');
  s.addRow(['질문', '사업 유형', '기대 통합번호', '기대 유형', '비고']);
  rows.forEach((r) => s.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function multipart(filename: string, content: Buffer) {
  const boundary = '----t' + Math.random().toString(16).slice(2);
  return {
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

test('기대 유형 표기 맞추기', () => {
  assert.equal(normalizeAnswerType('근거 답변'), '근거답변');
  assert.equal(normalizeAnswerType('연결'), '연결형');
  assert.equal(normalizeAnswerType('범위 외'), '답변범위외');
  assert.equal(normalizeAnswerType('근거 없음'), '근거없음');
  assert.equal(normalizeAnswerType('???'), null);
});

test('평가 질문집 읽기: 여러 기대 번호, 알 수 없는 값 경고', async () => {
  const { items, warnings } = await parseEvalWorkbook(
    await evalXlsx([
      ['질문 1', '글로컬', 'A-1, A-2', '근거답변', ''],
      ['질문 2', '없는사업', '', '모르는유형', ''],
      ['', '', '', '', ''],
    ]),
  );
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].expected_qa_ids, ['A-1', 'A-2']);
  assert.equal(items[1].business_type, '모름');
  assert.equal(items[1].expected_type, null);
  assert.equal(warnings.length, 2);
});

test('평가 실행 → 적중률·유형 정확도·통과 판정, 검수 판정 반영', async () => {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type, role, status)
     VALUES ('admin', ?, '재단', '중앙앵커센터', '해당없음', '모름', 'admin', 'approved')`,
  ).run(hashPassword('adminpass1'));
  const base = { category3: '', checklist: '', referral_answer: '', is_referral: 0, review_status: '확정', change_history: '' };
  activateQaVersion(
    db,
    createQaDraft(db, 'qa.xlsx', 1, [
      { ...base, row: 2, qa_id: 'C2-03-a', category1: '공통', category2: '이월', question: '사업비를 다음 연도로 이월할 수 있나요?', answer: '10% 이내 1회' },
      { ...base, row: 3, qa_id: 'D1-01-a', category1: '공통', category2: '장비', question: '실험장비 구입 시 사전 승인이 필요한가요?', answer: '1억원 이상 승인' },
    ], []),
  );
  const kb = new KnowledgeBase(db, null);
  await kb.rebuild();
  const app = await buildApp({ db, llm: firstCitingLlm, kb });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'adminpass1' } });
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];

  const up = multipart(
    '평가.xlsx',
    await evalXlsx([
      ['사업비 이월 가능한가요?', '모름', 'C2-03-a', '근거답변', ''],
      ['실험장비 구입 사전 승인 필요한가요?', '모름', 'D1-01-a', '근거답변', ''],
      ['사업비 이월 한도는?', '모름', 'D1-01-a', '근거답변', '일부러 틀린 기대값'],
      ['오늘 점심 메뉴 추천', '모름', '', '근거없음', ''],
    ]),
  );
  const set = await app.inject({ method: 'POST', url: '/api/admin/eval/sets', headers: { cookie, ...up.headers }, payload: up.payload });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().count, 4);

  const started = await app.inject({ method: 'POST', url: `/api/admin/eval/sets/${set.json().id}/runs`, headers: { cookie }, payload: { label: '기준선' } });
  assert.equal(started.statusCode, 200);
  const runId = started.json().id;
  assert.equal(started.json().config.model, 'fake-1');

  let detail;
  for (let i = 0; i < 100; i++) {
    detail = (await app.inject({ url: `/api/admin/eval/runs/${runId}`, headers: { cookie } })).json();
    if (detail.run.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(detail.run.status, 'done');
  const s = detail.run.summary;
  assert.equal(s.total, 4);
  assert.equal(s.cite_total, 3);
  assert.equal(s.cite_hit, 2);
  assert.equal(s.cite_hit_rate, 0.667);
  assert.equal(s.type_accuracy, 1);
  assert.equal(s.referral_accuracy, 1);
  assert.equal(s.passed, false); // 0.667 < 0.8

  // 기준을 낮추면 통과, 검수자가 '잘못된 결론'을 표시하면 다시 불통과
  await app.inject({ method: 'PUT', url: '/api/admin/settings/eval_pass_hit_rate', headers: { cookie }, payload: { value: '0.6' } });
  const evidence = detail.results.filter((r: { answer_type: string }) => r.answer_type === '근거답변');
  const first = evidence[0];
  let last;
  for (const r of evidence) {
    // 마지막 하나를 판정하기 전까지는 '검수 대기'
    if (last) assert.equal(last.summary.awaiting_review, true);
    last = (await app.inject({ method: 'PATCH', url: `/api/admin/eval/results/${r.id}`, headers: { cookie }, payload: { verdict: 'ok' } })).json();
  }
  assert.equal(last.summary.awaiting_review, false);
  assert.equal(last.summary.passed, true);
  const wrong = await app.inject({ method: 'PATCH', url: `/api/admin/eval/results/${first.id}`, headers: { cookie }, payload: { verdict: 'wrong', note: '결론 오류' } });
  assert.equal(wrong.json().summary.wrong, 1);
  assert.equal(wrong.json().summary.passed, false);

  const ex = await app.inject({ url: `/api/admin/eval/runs/${runId}/export`, headers: { cookie } });
  assert.equal(ex.statusCode, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(ex.rawPayload as unknown as ArrayBuffer);
  assert.equal(wb.worksheets[0].rowCount, 5);
});
