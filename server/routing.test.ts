import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { openDatabase } from './db.js';
import { KnowledgeBase } from './knowledge/index.js';
import { activateQaVersion, createQaDraft } from './knowledge/store.js';
import type { LlmClient, LlmRequest } from './llm/index.js';
import { kstDayStartUtc } from './usage.js';

/** 근거 자료 중 '연결형: 예'인 표준답안만 인용하고, 모델 판정은 일부러 근거답변으로 돌려준다 */
function referralCitingLlm(calls: LlmRequest[]): LlmClient {
  return {
    provider: 'fake',
    model: 'fake-1',
    async generate(req) {
      calls.push(req);
      const ctx = req.messages.at(-1)!.content;
      const ids = [...ctx.matchAll(/통합번호: ([^ |\]]+) \|[^\]]*연결형: 예\]/g)].map((m) => m[1]);
      return {
        text: JSON.stringify({ answer_type: '근거답변', business_type: '순수앵커', answer_markdown: '원칙 안내', cited_qa_ids: ids, cited_guideline: [], referral: '없음' }),
        provider: 'fake',
        model: 'fake-1',
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

async function setup() {
  const db = openDatabase(':memory:');
  const ins = db.prepare(
    `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type, role, status)
     VALUES (?, ?, ?, ?, ?, '순수앵커', ?, 'approved')`,
  );
  ins.run('admin', hashPassword('adminpass1'), '재단', '중앙앵커센터', '해당없음', 'admin');
  ins.run('busan01', hashPassword('userpass1'), '대학', '부산대학교', '부산', 'user');
  const v = createQaDraft(
    db,
    'qa.xlsx',
    1,
    [
      { row: 2, qa_id: 'B4-01-b', category1: '순수앵커', category2: '수당', category3: '', question: '순수앵커 사업의 보직수당 지급 기준은?', checklist: '보직수당 지급 기준', answer: '시도 기준에 따릅니다.', referral_answer: '', is_referral: 1, review_status: '확정', change_history: '' },
    ],
    [],
  );
  activateQaVersion(db, v);
  const kb = new KnowledgeBase(db, null);
  await kb.rebuild();
  const calls: LlmRequest[] = [];
  const app = await buildApp({ db, llm: referralCitingLlm(calls), kb });
  const login = async (username: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    const raw = res.headers['set-cookie'];
    return (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];
  };
  return { db, app, calls, admin: await login('admin', 'adminpass1'), user: await login('busan01', 'userpass1') };
}

async function ask(app: Awaited<ReturnType<typeof setup>>['app'], cookie: string, content: string) {
  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie }, payload: {} })).json();
  return app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, headers: { cookie }, payload: { content } });
}

test('한국 시간 기준 오늘 0시', () => {
  assert.equal(kstDayStartUtc(new Date('2026-10-29T10:00:00Z')), '2026-10-28 15:00:00');
  assert.equal(kstDayStartUtc(new Date('2026-10-29T16:00:00Z')), '2026-10-29 15:00:00');
});

test('연결형 답안만 인용하면 연결형으로 바꾸고 지역앵커센터로 연결', async () => {
  const { app, user } = await setup();
  const res = await ask(app, user, '순수앵커 보직수당 지급 기준 알려주세요');
  const m = res.json().messages.at(-1);
  assert.equal(m.answer_type, '연결형');
  assert.equal(JSON.parse(m.citations).referral, '지역앵커센터');
  assert.deepEqual(res.json().usage, { used: 1, limit: 50 });
});

test('개인정보는 저장·모델 전송 전에 가린다', async () => {
  const { app, user, calls } = await setup();
  const res = await ask(app, user, '순수앵커 보직수당 지급 기준? 제 번호 010-1234-5678 로 연락 주세요');
  const q = res.json().messages[0].content;
  assert.match(q, /\[전화번호\]/);
  assert.doesNotMatch(q, /1234-5678/);
  assert.doesNotMatch(calls[0].messages.at(-1)!.content, /1234-5678/);
});

test('하루 질문 상한', async () => {
  const { app, admin, user } = await setup();
  await app.inject({ method: 'PUT', url: '/api/admin/settings/daily_limit_user', headers: { cookie: admin }, payload: { value: '2' } });
  assert.equal((await ask(app, user, '보직수당 기준 1')).statusCode, 200);
  assert.equal((await ask(app, user, '보직수당 기준 2')).statusCode, 200);
  const third = await ask(app, user, '보직수당 기준 3');
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().code, 'DAILY_LIMIT');
  // 전체 상한
  await app.inject({ method: 'PUT', url: '/api/admin/settings/daily_limit_user', headers: { cookie: admin }, payload: { value: '0' } });
  await app.inject({ method: 'PUT', url: '/api/admin/settings/daily_limit_total', headers: { cookie: admin }, payload: { value: '2' } });
  assert.equal((await ask(app, admin, '보직수당 기준')).statusCode, 429);
});

test('연결 연락처 기능은 없어졌다 (번호를 보여주지 않고 문의 안내만)', async () => {
  const { app, admin, user } = await setup();
  assert.equal((await app.inject({ url: '/api/referral-contacts', headers: { cookie: user } })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/admin/referral-contacts', headers: { cookie: admin } })).statusCode, 404);
});

