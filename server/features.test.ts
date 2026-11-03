import ExcelJS from 'exceljs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { openDatabase } from './db.js';
import { KnowledgeBase } from './knowledge/index.js';
import { activateQaVersion, createQaDraft } from './knowledge/store.js';
import type { LlmClient } from './llm/index.js';
import { monthRangeUtc } from './report.js';

const llm: LlmClient = {
  provider: 'fake',
  model: 'fake-1',
  async generate() {
    return {
      text: JSON.stringify({ answer_type: '근거답변', business_type: '공통', answer_markdown: '1인당 기준 안에서 집행합니다.', cited_qa_ids: ['C1-01'], cited_guideline: [], referral: '없음' }),
      provider: 'fake',
      model: 'fake-1',
      inputTokens: 100,
      outputTokens: 10,
    };
  },
};

async function setup() {
  const db = openDatabase(':memory:');
  const ins = db.prepare(
    `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type, role, status) VALUES (?, ?, ?, ?, ?, '모름', ?, 'approved')`,
  );
  ins.run('admin', hashPassword('adminpass1'), '재단', '중앙앵커센터', '해당없음', 'admin');
  ins.run('univ01', hashPassword('userpass1'), '대학', '가대학교', '부산', 'user');
  const base = { category3: '', checklist: '', referral_answer: '', is_referral: 0, review_status: '확정', change_history: '' };
  activateQaVersion(
    db,
    createQaDraft(db, '중복질의_통합_표준답안초안_5차.xlsx', 1, [{ ...base, row: 2, qa_id: 'C1-01', category1: '공통', category2: '회의비', question: '회의비 집행 기준은?', answer: '1인당 기준 안에서 집행합니다.' }], []),
  );
  const kb = new KnowledgeBase(db, null);
  await kb.rebuild();
  const app = await buildApp({ db, llm, kb });
  const login = async (username: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    const raw = res.headers['set-cookie'];
    return (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];
  };
  return { db, app, admin: await login('admin', 'adminpass1'), user: await login('univ01', 'userpass1') };
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

test('1:1 문의 답변이 오면 문의자에게 새 답변 수가 보이고, 목록을 열면 사라진다. 답변은 표준답안 등록 표시를 남길 수 있다', async () => {
  const { app, admin, user } = await setup();
  // 챗봇을 거치지 않은 바로 문의는 막힌다
  const direct = await app.inject({ method: 'POST', url: '/api/inquiries', headers: { cookie: user }, payload: { content: '워크숍 숙소비 기준이 궁금합니다' } });
  assert.equal(direct.statusCode, 400);
  assert.equal(direct.json().code, 'CHAT_FIRST');
  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: user }, payload: {} })).json();
  // 대화를 열기만 하고 질문하지 않았어도 막힌다
  const empty = await app.inject({ method: 'POST', url: '/api/inquiries', headers: { cookie: user }, payload: { content: '문의', conversation_id: conv.id } });
  assert.equal(empty.statusCode, 400);
  await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, headers: { cookie: user }, payload: { content: '회의비 집행 기준은?' } });
  const inq = (await app.inject({ method: 'POST', url: '/api/inquiries', headers: { cookie: user }, payload: { content: '워크숍 숙소비 기준이 궁금합니다', conversation_id: conv.id } })).json();
  assert.match(inq.attached_transcript, /회의비 집행 기준은/);
  const unread = async () => (await app.inject({ url: '/api/inquiries/unread', headers: { cookie: user } })).json().count;
  assert.equal(await unread(), 0);
  await app.inject({ method: 'POST', url: `/api/manage/inquiries/${inq.id}/answer`, headers: { cookie: admin }, payload: { answer: '숙박비 기준에 따릅니다.' } });
  assert.equal(await unread(), 1);
  const list = (await app.inject({ url: '/api/inquiries', headers: { cookie: user } })).json();
  assert.equal(list[0].user_unread, 1); // 이번 화면에서는 '새 답변'으로 보이고
  assert.equal(await unread(), 0); // 열고 나면 읽은 것으로
  const marked = await app.inject({ method: 'POST', url: `/api/manage/inquiries/${inq.id}/qa`, headers: { cookie: admin }, payload: { qa_id: 'N1-01' } });
  assert.equal(marked.json().qa_id, 'N1-01');
  assert.equal((await app.inject({ method: 'POST', url: `/api/manage/inquiries/${inq.id}/qa`, headers: { cookie: user }, payload: { qa_id: 'X' } })).statusCode, 403);
});

test('계정 일괄 등록: 양식대로 올리면 만들고, 잘못된 행은 사유를 알려준다', async () => {
  const { db, app, admin, user } = await setup();
  const tpl = await app.inject({ url: '/api/admin/users/template', headers: { cookie: admin } });
  assert.equal(tpl.statusCode, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(tpl.rawPayload as unknown as ArrayBuffer);
  const s = wb.getWorksheet('계정')!;
  s.addRow(['busan_u01', '대학', '나대학교', '부산', '', '']);
  s.addRow(['center_bs', '지역앵커센터', '부산 지역앵커센터', '부산', '모름', '관리자']);
  s.addRow(['old_rev', '재단', '중앙앵커센터', '해당없음', '', '검수자']); // 없어진 역할
  s.addRow(['busan_u01', '대학', '중복', '부산', '', '']);
  s.addRow(['bad_region', '대학', '다대학교', '화성', '', '']);
  s.addRow(['univ01', '대학', '이미 있음', '부산', '', '']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const up = multipart('계정.xlsx', buf);
  const res = await app.inject({ method: 'POST', url: '/api/admin/users/bulk', headers: { cookie: admin, ...up.headers }, payload: up.payload });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.created, 2);
  assert.equal(body.failed, 4);
  assert.match(body.results.find((r: { username: string }) => r.username === 'old_rev').error, /권한/);
  assert.match(body.results.find((r: { row: number }) => r.row === 6).error, /같은 아이디/);
  assert.match(body.results.find((r: { username: string }) => r.username === 'bad_region').error, /지역/);
  assert.match(body.results.find((r: { username: string }) => r.username === 'univ01').error, /이미/);
  const center = db.prepare(`SELECT role, status, must_change_password FROM users WHERE username = 'center_bs'`).get() as Record<string, unknown>;
  assert.deepEqual(center, { role: 'admin', status: 'approved', must_change_password: 1 });
  // 만든 계정은 임시 비밀번호로 로그인된다
  const pw = body.results.find((r: { username: string }) => r.username === 'busan_u01').temp_password;
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'busan_u01', password: pw } })).statusCode, 200);
  // 관리자만
  const m = multipart('계정.xlsx', buf);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/users/bulk', headers: { cookie: user, ...m.headers }, payload: m.payload })).statusCode, 403);
});

test('월간 운영 보고서: 한국 시간 한 달 범위로 시트를 만든다', async () => {
  assert.deepEqual(monthRangeUtc('2026-10'), { from: '2026-09-30 15:00:00', to: '2026-10-31 15:00:00' });
  assert.deepEqual(monthRangeUtc('2026-12'), { from: '2026-11-30 15:00:00', to: '2026-12-31 15:00:00' });
  assert.equal(monthRangeUtc('2026-13'), null);
  const { app, admin, user } = await setup();
  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: user }, payload: {} })).json();
  await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, headers: { cookie: user }, payload: { content: '회의비 집행 기준은?' } });
  const kst = new Date(Date.now() + 9 * 3600_000);
  const month = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
  const res = await app.inject({ url: `/api/admin/report?month=${month}`, headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['요약', '일별', '지역·소속별', '많이 묻는 주제', '근거 없음 질문', '1대1 문의']);
  const summary = wb.getWorksheet('요약')!;
  assert.equal(summary.getRow(3).getCell(2).value, 1); // 질문 수
  assert.equal(wb.getWorksheet('많이 묻는 주제')!.getRow(2).getCell(1).value, '공통 · 회의비');
  assert.equal((await app.inject({ url: '/api/admin/report?month=bad', headers: { cookie: admin } })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/admin/report?month=${month}`, headers: { cookie: user } })).statusCode, 403);
});

test('휴대폰에서는 질문할 수 없다 (AI 사용량 과다 우려)', async () => {
  const { app, user } = await setup();
  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: user }, payload: {} })).json();
  const ask = (ua: string) =>
    app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, headers: { cookie: user, 'user-agent': ua }, payload: { content: '회의비 집행 기준은?' } });
  const phone = await ask('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
  assert.equal(phone.statusCode, 403);
  assert.equal(phone.json().code, 'MOBILE_BLOCKED');
  const pc = await ask('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36');
  assert.equal(pc.statusCode, 200);
});
