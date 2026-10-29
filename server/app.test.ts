import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { openDatabase } from './db.js';
import { KnowledgeBase } from './knowledge/index.js';
import { seedTemporaryKnowledge } from './knowledge/store.js';
import type { LlmClient } from './llm/index.js';

const fakeLlm = (fail = false): LlmClient => ({
  provider: 'fake',
  model: 'fake-1',
  async generate(req) {
    if (fail) throw new Error('boom');
    const ids = [...req.messages.at(-1)!.content.matchAll(/\[지침 (G\d+)/g)].map((m) => ({ id: m[1], clause: '', page: '' }));
    return {
      text: JSON.stringify({ answer_type: '근거답변', business_type: '공통', answer_markdown: `답변: ${req.messages.at(-1)!.content.slice(-40)}`, cited_qa_ids: [], cited_guideline: ids.slice(0, 1), referral: '없음' }),
      provider: 'fake', model: 'fake-1', inputTokens: 10, outputTokens: 5,
    };
  },
});

async function setup(fail = false) {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type, role, status)
     VALUES ('admin', ?, '재단', '중앙앵커센터', '해당없음', '모름', 'admin', 'approved')`,
  ).run(hashPassword('adminpass1'));
  seedTemporaryKnowledge(db);
  const kb = new KnowledgeBase(db, null);
  await kb.rebuild();
  const app = await buildApp({ db, llm: fakeLlm(fail), kb });
  return { db, app };
}

function cookieOf(res: { headers: Record<string, unknown> }) {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : String(raw);
  return first.split(';')[0];
}

async function login(app: Awaited<ReturnType<typeof setup>>['app'], username: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}

const signup = {
  username: 'univ01',
  password: 'userpass1',
  org_type: '대학',
  org_name: '한국대학교',
  region: '부산',
  business_type: '글로컬',
};

test('가입 → 승인 전 로그인 불가 → 승인 후 질문·답변', async () => {
  const { app } = await setup();
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/signup', payload: signup })).statusCode, 200);
  assert.equal((await login(app, 'univ01', 'userpass1')).statusCode, 403);

  const admin = cookieOf(await login(app, 'admin', 'adminpass1'));
  const users = (await app.inject({ url: '/api/admin/users', headers: { cookie: admin } })).json();
  const target = users.find((u: { username: string }) => u.username === 'univ01');
  assert.equal(target.status, 'pending');
  assert.equal(target.password_hash, undefined);
  await app.inject({ method: 'POST', url: `/api/admin/users/${target.id}/approve`, headers: { cookie: admin } });

  const user = cookieOf(await login(app, 'univ01', 'userpass1'));
  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: user }, payload: {} })).json();
  assert.equal(conv.business_type, '글로컬');

  const res = await app.inject({
    method: 'POST',
    url: `/api/conversations/${conv.id}/messages`,
    headers: { cookie: user },
    payload: { content: '보직수당 한도는 얼마인가요?' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.conversation.title, '보직수당 한도는 얼마인가요?');
  assert.equal(body.messages.length, 2);
  assert.match(body.messages[1].content, /보직수당 한도는 얼마인가요/);
  assert.equal(body.messages[1].answer_type, '근거답변');
  assert.equal(JSON.parse(body.messages[1].citations).guideline.length, 1);
  assert.match(body.messages[1].content, /상위보조사업자/); // 면책 문구 자동 추가

  // 일반 사용자는 관리자 API에 접근할 수 없다
  assert.equal((await app.inject({ url: '/api/admin/users', headers: { cookie: user } })).statusCode, 403);
});

test('10회 실패 시 잠금, 관리자가 해제', async () => {
  const { app, db } = await setup();
  await app.inject({ method: 'POST', url: '/api/auth/signup', payload: signup });
  db.prepare(`UPDATE users SET status = 'approved' WHERE username = 'univ01'`).run();
  for (let i = 0; i < 9; i++) assert.equal((await login(app, 'univ01', 'wrong')).statusCode, 401);
  assert.equal((await login(app, 'univ01', 'wrong')).statusCode, 403);
  assert.equal((await login(app, 'univ01', 'userpass1')).statusCode, 403);

  const admin = cookieOf(await login(app, 'admin', 'adminpass1'));
  const id = (db.prepare(`SELECT id FROM users WHERE username = 'univ01'`).get() as { id: number }).id;
  await app.inject({ method: 'POST', url: `/api/admin/users/${id}/unlock`, headers: { cookie: admin } });
  assert.equal((await login(app, 'univ01', 'userpass1')).statusCode, 200);
});

test('비밀번호 초기화 후에는 변경 전까지 다른 API 사용 불가', async () => {
  const { app, db } = await setup();
  await app.inject({ method: 'POST', url: '/api/auth/signup', payload: signup });
  db.prepare(`UPDATE users SET status = 'approved' WHERE username = 'univ01'`).run();
  const id = (db.prepare(`SELECT id FROM users WHERE username = 'univ01'`).get() as { id: number }).id;
  const admin = cookieOf(await login(app, 'admin', 'adminpass1'));
  const { temp_password } = (
    await app.inject({ method: 'POST', url: `/api/admin/users/${id}/reset-password`, headers: { cookie: admin } })
  ).json();

  const user = cookieOf(await login(app, 'univ01', temp_password));
  assert.equal((await app.inject({ url: '/api/conversations', headers: { cookie: user } })).statusCode, 403);
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { cookie: user },
    payload: { current_password: temp_password, new_password: 'newpass123' },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal((await app.inject({ url: '/api/conversations', headers: { cookie: cookieOf(changed) } })).statusCode, 200);
});

test('AI 호출 실패 시 502, 질문은 저장되지 않음', async () => {
  const { app } = await setup(true);
  const admin = cookieOf(await login(app, 'admin', 'adminpass1'));
  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: admin }, payload: {} })).json();
  const res = await app.inject({
    method: 'POST',
    url: `/api/conversations/${conv.id}/messages`,
    headers: { cookie: admin },
    payload: { content: '사업비 선결제가 가능한가요?' },
  });
  assert.equal(res.statusCode, 502);
  const detail = (await app.inject({ url: `/api/conversations/${conv.id}`, headers: { cookie: admin } })).json();
  assert.equal(detail.messages.length, 0);
});

test('1:1 문의에 대화 기록 자동 첨부, 검수자 답변', async () => {
  const { app, db } = await setup();
  await app.inject({ method: 'POST', url: '/api/auth/signup', payload: signup });
  db.prepare(`UPDATE users SET status = 'approved' WHERE username = 'univ01'`).run();
  const user = cookieOf(await login(app, 'univ01', 'userpass1'));
  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: user }, payload: {} })).json();
  await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, headers: { cookie: user }, payload: { content: '이월 가능?' } });

  const inq = (
    await app.inject({ method: 'POST', url: '/api/inquiries', headers: { cookie: user }, payload: { content: '추가 확인 부탁드립니다', conversation_id: conv.id } })
  ).json();
  assert.match(inq.attached_transcript, /이월 가능\?/);

  // 다른 사람의 대화는 첨부할 수 없다
  const admin = cookieOf(await login(app, 'admin', 'adminpass1'));
  const bad = await app.inject({ method: 'POST', url: '/api/inquiries', headers: { cookie: admin }, payload: { content: 'x', conversation_id: conv.id } });
  assert.equal(bad.statusCode, 400);

  const answered = await app.inject({
    method: 'POST',
    url: `/api/manage/inquiries/${inq.id}/answer`,
    headers: { cookie: admin },
    payload: { answer: '지역앵커센터에 확인하세요.' },
  });
  assert.equal(answered.json().status, 'answered');
  assert.equal((await app.inject({ url: '/api/manage/inquiries', headers: { cookie: user } })).statusCode, 403);
});

test('프롬프트 변경 이력과 되돌리기, 마지막 관리자 보호', async () => {
  const { app, db } = await setup();
  const admin = cookieOf(await login(app, 'admin', 'adminpass1'));
  await app.inject({ method: 'PUT', url: '/api/admin/settings/system_prompt', headers: { cookie: admin }, payload: { value: '버전1' } });
  const v2 = (
    await app.inject({ method: 'PUT', url: '/api/admin/settings/system_prompt', headers: { cookie: admin }, payload: { value: '버전2' } })
  ).json();
  assert.equal(v2.revisions.length, 2);
  const reverted = (
    await app.inject({ method: 'POST', url: '/api/admin/settings/system_prompt/revert', headers: { cookie: admin }, payload: { revision_id: v2.revisions[1].id } })
  ).json();
  assert.equal(reverted.value, '버전1');

  const adminId = (db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as { id: number }).id;
  const demote = await app.inject({ method: 'PATCH', url: `/api/admin/users/${adminId}`, headers: { cookie: admin }, payload: { role: 'user' } });
  assert.equal(demote.statusCode, 400);
});
