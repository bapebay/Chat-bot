import ExcelJS from 'exceljs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { openDatabase } from './db.js';
import type { Embedder } from './knowledge/embedder.js';
import { chunkDocument } from './knowledge/guideline.js';
import { KnowledgeBase } from './knowledge/index.js';
import { findPii, maskPii } from './knowledge/text.js';
import type { LlmClient, LlmRequest } from './llm/index.js';

// ----- 시험용 표준 Q&A 엑셀 (가상 데이터) -----
async function sampleQaXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('안내');
  const s = wb.addWorksheet('통합질의');
  s.addRow(['표준 Q&A 통합본']); // 제목 행 (머리글은 2행)
  s.addRow(['통합번호', '대분류(사업 유형)', '중분류', '소분류', '대표 질의', '요지 체크리스트', '통합 답안', '연결형 답변', '검수 상태']);
  s.addRow(['B4-01-a', '글로컬', '수당', 'B4', '글로컬 사업단장에게 보직수당을 지급할 수 있나요?', '보직수당 지급 대상 / 한도', '사업단장 등 전담조직 책임자에게 지급할 수 있습니다. 보직수당과 성과급 합산 5% 이내, 1인당 연 1,000만원 한도입니다.', 'N', '확정']);
  s.addRow(['B4-01-b', '순수앵커', '수당', 'B4', '순수앵커 사업에서 보직수당 지급 기준은?', '보직수당 지급 기준', '순수앵커는 시도 기준에 따릅니다.', 'Y', '확정']);
  s.addRow(['C2-03-a', '공통', '이월', 'C2', '사업비를 다음 연도로 이월할 수 있나요?', '이월 가능 여부 / 이월 한도', '부득이한 경우 10% 이내에서 1회 이월할 수 있습니다. 담당자 010-1234-5678', '', '확정']);
  s.addRow(['D1-01-a', '공통', '장비', 'D1', '실험장비 구입 시 사전 승인이 필요한가요?', '장비 금액 기준', '1억원 이상은 중앙센터 사전 승인이 필요합니다.', '', '미검수']);
  s.addRow(['', '', '', '', '대표 질의만 있는 잘못된 행', '', '', '', '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function multipart(filename: string, content: Buffer, fields: Record<string, string> = {}) {
  const boundary = '----test' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function qaUpload(cookie: string, filename: string) {
  const m = multipart(filename, await sampleQaXlsx());
  return { headers: { cookie, ...m.headers }, payload: m.payload };
}

function recordingLlm() {
  const calls: LlmRequest[] = [];
  const llm: LlmClient = {
    provider: 'fake',
    model: 'fake-1',
    async generate(req) {
      calls.push(req);
      const ctx = req.messages.at(-1)!.content;
      const qaIds = [...ctx.matchAll(/통합번호: ([^ |\]]+)/g)].map((m) => m[1]);
      return {
        text: '```json\n' + JSON.stringify({
          answer_type: '근거답변',
          business_type: '글로컬',
          answer_markdown: '**답변 요약**: 지급할 수 있습니다.',
          cited_qa_ids: [qaIds[0], 'ZZ-99-z'], // 검색되지 않은 번호는 카드에서 빠져야 함
          cited_guideline: [],
          referral: '없음',
        }) + '\n```',
        provider: 'fake',
        model: 'fake-1',
        inputTokens: 100,
        outputTokens: 20,
      };
    },
  };
  return { llm, calls };
}

async function setup(embedder: Embedder | null = null) {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type, role, status)
     VALUES ('admin', ?, '재단', '중앙앵커센터', '해당없음', '모름', 'admin', 'approved')`,
  ).run(hashPassword('adminpass1'));
  const kb = new KnowledgeBase(db, embedder);
  await kb.rebuild();
  const { llm, calls } = recordingLlm();
  const app = await buildApp({ db, llm, kb });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'adminpass1' } });
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];
  return { db, kb, app, cookie, calls };
}

async function ask(app: Awaited<ReturnType<typeof setup>>['app'], cookie: string, question: string, businessType = '글로컬') {
  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie }, payload: { business_type: businessType } })).json();
  const res = await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, headers: { cookie }, payload: { content: question } });
  assert.equal(res.statusCode, 200, res.body);
  const msg = res.json().messages.at(-1);
  return { ...msg, citations: JSON.parse(msg.citations) };
}

test('개인정보 패턴 찾기·가리기 (날짜는 계좌로 보지 않음)', () => {
  const t = '연락처 010-1234-5678, 메일 a.b@univ.ac.kr, 2026-03-01 기준, 계좌 123-456789-01-234, 주민 900101-1234567';
  const kinds = findPii(t).map((m) => m.kind).sort();
  assert.deepEqual(kinds, ['계좌번호', '이메일', '전화번호', '주민등록번호'].sort());
  assert.match(maskPii(t), /\[전화번호\]/);
  assert.match(maskPii(t), /2026-03-01/);
});

test('지침 원문을 조항 단위로 나누고 쪽수를 기록', () => {
  const chunks = chunkDocument(
    ['머리 글\n제1조(목적) 이 지침은 사업비 집행 기준을 정한다.\n제2조(적용 범위) 앵커 사업에 적용한다.', '3\n제3조(인건비) 인건비는 상한 이내로 편성한다.\n- Q1. 이월 가능? A. 10% 이내'],
    true,
  );
  assert.deepEqual(chunks.map((c) => [c.clause, c.page]), [
    ['머리말', 1],
    ['제1조(목적)', 1],
    ['제2조(적용 범위)', 1],
    ['제3조(인건비)', 2],
    ['Q1. 이월 가능? A. 10% 이내', 2],
  ]);
  assert.match(chunks[1].text, /사업비 집행 기준/);
});

test('표준 Q&A 업로드 → 미리보기(경고) → 적용 → 검색형 답변과 근거 카드', async () => {
  const { app, cookie, calls, db } = await setup();
  const up = await app.inject({ method: 'POST', url: '/api/admin/knowledge/qa/upload', ...(await qaUpload(cookie, 'qa.xlsx')) });
  assert.equal(up.statusCode, 200, up.body);
  const v = up.json();
  assert.equal(v.status, 'draft');
  assert.equal(v.item_count, 4);
  assert.equal(v.confirmed_count, 3);
  assert.equal(v.referral_count, 1);
  assert.ok(v.warnings.some((w: { message: string }) => w.message.includes('전화번호')));
  assert.ok(v.warnings.some((w: { message: string }) => w.message.includes('빈 칸')));

  // 적용 전에는 검색 대상이 아님
  assert.equal((await ask(app, cookie, '글로컬 사업단장 보직수당 지급 가능한가요?')).answer_type, '근거없음');
  assert.equal(calls.length, 0);

  await app.inject({ method: 'POST', url: `/api/admin/knowledge/qa/versions/${v.id}/activate`, headers: { cookie } });
  const m = await ask(app, cookie, '글로컬 사업단장 보직수당 지급 가능한가요?');
  assert.equal(m.answer_type, '근거답변');
  assert.deepEqual(m.citations.qa.map((q: { qa_id: string }) => q.qa_id), ['B4-01-a']);
  assert.equal(calls.length, 1);
  // 근거는 사용자 메시지에, 시스템 프롬프트에는 출력 형식
  assert.match(calls[0].messages.at(-1)!.content, /통합번호: B4-01-a/);
  assert.ok(calls[0].jsonSchema);
  assert.match(calls[0].system, /출력 형식/);
  // 선택한 사업 유형 답안이 먼저
  assert.equal(m.citations.retrieved.qa[0].qa_id, 'B4-01-a');

  // 미검수 답안은 기본적으로 검색에서 빠지고, 설정을 켜면 들어온다
  const before = await app.inject({ method: 'POST', url: '/api/admin/knowledge/search-test', headers: { cookie }, payload: { query: '실험장비 구입 사전 승인' } });
  assert.ok(!before.json().qa.some((q: { qa_id: string }) => q.qa_id === 'D1-01-a'));
  await app.inject({ method: 'PUT', url: '/api/admin/settings/include_unreviewed', headers: { cookie }, payload: { value: 'true' } });
  const after = await app.inject({ method: 'POST', url: '/api/admin/knowledge/search-test', headers: { cookie }, payload: { query: '실험장비 구입 사전 승인' } });
  assert.equal(after.json().qa[0].qa_id, 'D1-01-a');

  // 엑셀 내보내기
  const ex = await app.inject({ url: `/api/admin/knowledge/qa/versions/${v.id}/export`, headers: { cookie } });
  assert.equal(ex.statusCode, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(ex.rawPayload as unknown as ArrayBuffer);
  assert.equal(wb.getWorksheet('통합질의')!.rowCount, 5);

  // 서비스 중인 버전은 삭제 불가, 되돌리기
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/knowledge/qa/versions/${v.id}`, headers: { cookie } })).statusCode, 400);
  const up2 = await app.inject({ method: 'POST', url: '/api/admin/knowledge/qa/upload', ...(await qaUpload(cookie, 'qa2.xlsx')) });
  await app.inject({ method: 'POST', url: `/api/admin/knowledge/qa/versions/${up2.json().id}/activate`, headers: { cookie } });
  await app.inject({ method: 'POST', url: `/api/admin/knowledge/qa/versions/${v.id}/activate`, headers: { cookie } });
  const statuses = db.prepare('SELECT id, status FROM qa_versions ORDER BY id').all();
  assert.deepEqual(statuses, [{ id: v.id, status: 'active' }, { id: up2.json().id, status: 'archived' }]);
});

test('근거 없는 질문은 모델을 부르지 않고 근거없음, 범위 외 질문은 답변범위외', async () => {
  const { app, cookie, calls } = await setup();
  const up = await app.inject({ method: 'POST', url: '/api/admin/knowledge/qa/upload', ...(await qaUpload(cookie, 'qa.xlsx')) });
  await app.inject({ method: 'POST', url: `/api/admin/knowledge/qa/versions/${up.json().id}/activate`, headers: { cookie } });
  const oos = multipart('oos.txt', Buffer.from('자체평가 실적 인정 기준\n성과지표 달성 실적 인정 여부\n'));
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/knowledge/out-of-scope/upload', headers: { cookie, ...oos.headers }, payload: oos.payload })).statusCode, 200);

  const none = await ask(app, cookie, '오늘 점심 메뉴 추천해 주세요');
  assert.equal(none.answer_type, '근거없음');
  const outside = await ask(app, cookie, '성과지표 실적 인정 여부를 알려주세요');
  assert.equal(outside.answer_type, '답변범위외');
  assert.equal(calls.length, 0);
});

test('지침 TXT 업로드·사용 중지, 근거 카드에 조항 표시', async () => {
  const { app, cookie, kb } = await setup();
  const doc = multipart('guide.txt', Buffer.from('제5조(장비 구입) 1억원 이상 장비는 중앙센터 사전 승인을 받아야 한다.\n제6조(이월) 이월은 10% 이내 1회 가능하다.'), { name: '집행 지침', kind: '지침' });
  const up = await app.inject({ method: 'POST', url: '/api/admin/knowledge/guidelines/upload', headers: { cookie, ...doc.headers }, payload: doc.payload });
  assert.equal(up.json().chunk_count, 2);
  assert.equal(kb.stats.guideline, 2);
  await app.inject({ method: 'PATCH', url: `/api/admin/knowledge/guidelines/${up.json().id}`, headers: { cookie }, payload: { active: false } });
  assert.equal(kb.stats.guideline, 0);
  const bad = multipart('guide.hwp', Buffer.from('x'));
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/knowledge/guidelines/upload', headers: { cookie, ...bad.headers }, payload: bad.payload })).statusCode, 400);
});

test('의미 검색 모델이 있으면 혼합 검색으로 동작', async () => {
  // 글자 빈도로 만든 가짜 벡터 (실제 모델 대신 경로만 확인)
  const fake: Embedder = {
    name: 'fake-embedder',
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(64);
        for (const ch of t.replace(/^(query|passage): /, '')) v[ch.charCodeAt(0) % 64] += 1;
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
  const { app, cookie, db } = await setup(fake);
  const up = await app.inject({ method: 'POST', url: '/api/admin/knowledge/qa/upload', ...(await qaUpload(cookie, 'qa.xlsx')) });
  await app.inject({ method: 'POST', url: `/api/admin/knowledge/qa/versions/${up.json().id}/activate`, headers: { cookie } });
  // 색인 계산이 끝날 때까지 대기
  for (let i = 0; i < 50 && !(await app.inject({ url: '/api/admin/knowledge/status', headers: { cookie } })).json().semantic_ready; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const r = (await app.inject({ method: 'POST', url: '/api/admin/knowledge/search-test', headers: { cookie }, payload: { query: '사업비 이월 가능?' } })).json();
  assert.equal(r.mode, 'hybrid');
  assert.equal(r.qa[0].qa_id, 'C2-03-a');
  assert.equal(typeof r.qa[0].semantic, 'number');
  assert.ok((db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number }).n > 0);
});
