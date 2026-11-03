import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { openDatabase } from './db.js';
import { KnowledgeBase } from './knowledge/index.js';
import { activateQaVersion, createQaDraft } from './knowledge/store.js';
import type { LlmClient } from './llm/index.js';
import { purgeOldConversations } from './retention.js';

const llm: LlmClient = {
  provider: 'fake',
  model: 'fake-1',
  async generate(req) {
    const id = req.messages.at(-1)!.content.match(/통합번호: ([^ |\]]+)/)?.[1];
    return {
      text: JSON.stringify({ answer_type: '근거답변', business_type: '공통', answer_markdown: '답변', cited_qa_ids: id ? [id] : [], cited_guideline: [], referral: '없음' }),
      provider: 'fake',
      model: 'fake-1',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    };
  },
};

async function setup() {
  const db = openDatabase(':memory:');
  const ins = db.prepare(
    `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type, role, status)
     VALUES (?, ?, ?, ?, '부산', '모름', ?, 'approved')`,
  );
  ins.run('admin', hashPassword('adminpass1'), '재단', '중앙앵커센터', 'admin');
  ins.run('rev01', hashPassword('revpass12'), '재단', '중앙앵커센터', 'admin'); // 검수자 역할을 없애 관리자가 검수 업무를 맡는다
  ins.run('user01', hashPassword('userpass1'), '대학', '부산대학교', 'user');
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
  const app = await buildApp({ db, llm, kb });
  const login = async (username: string, password: string) => {
    const raw = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).headers['set-cookie'];
    return (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];
  };
  return { db, kb, app, admin: await login('admin', 'adminpass1'), rev: await login('rev01', 'revpass12'), user: await login('user01', 'userpass1') };
}

async function ask(app: Awaited<ReturnType<typeof setup>>['app'], cookie: string, content: string) {
  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie }, payload: {} })).json();
  const res = await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, headers: { cookie }, payload: { content } });
  return { conv, msg: res.json().messages.at(-1) };
}

test('Bad 평가·근거 없음은 검토 대기함으로, Good으로 바꾸면 빠짐, 처리 기록', async () => {
  const { app, user, rev, admin } = await setup();
  const { conv, msg } = await ask(app, user, '사업비 이월 가능한가요?');
  await ask(app, user, '오늘 점심 메뉴 추천해 주세요'); // 근거 없음 → 자동으로 대기함

  const bad = await app.inject({ method: 'PUT', url: `/api/messages/${msg.id}/feedback`, headers: { cookie: user }, payload: { rating: 'bad', reason: '답이 부족', comment: '한도 설명이 없음' } });
  assert.equal(bad.statusCode, 200);
  // 다른 사람의 답변에는 평가할 수 없음
  assert.equal((await app.inject({ method: 'PUT', url: `/api/messages/${msg.id}/feedback`, headers: { cookie: admin }, payload: { rating: 'good' } })).statusCode, 404);
  const detail = (await app.inject({ url: `/api/conversations/${conv.id}`, headers: { cookie: user } })).json();
  assert.equal(detail.feedback[0].reason, '답이 부족');

  let queue = (await app.inject({ url: '/api/review/queue', headers: { cookie: rev } })).json();
  assert.deepEqual(queue.map((q: { source: string }) => q.source).sort(), ['bad', 'no_evidence']);
  const badItem = queue.find((q: { source: string }) => q.source === 'bad');
  assert.equal(badItem.question, '사업비 이월 가능한가요?');
  assert.equal(badItem.feedback[0].comment, '한도 설명이 없음');
  assert.deepEqual(badItem.cited_qa_ids, ['C2-03-a']);
  assert.equal((await app.inject({ url: '/api/review/queue', headers: { cookie: user } })).statusCode, 403);

  await app.inject({ method: 'PUT', url: `/api/messages/${msg.id}/feedback`, headers: { cookie: user }, payload: { rating: 'good' } });
  queue = (await app.inject({ url: '/api/review/queue', headers: { cookie: rev } })).json();
  assert.equal(queue.length, 1);
  await app.inject({ method: 'POST', url: `/api/review/queue/${queue[0].id}/resolve`, headers: { cookie: rev }, payload: { action: 'ignored', note: '범위 밖' } });
  assert.equal((await app.inject({ url: '/api/review/queue', headers: { cookie: rev } })).json().length, 0);
  const done = (await app.inject({ url: '/api/review/queue?status=done', headers: { cookie: rev } })).json();
  assert.equal(done[0].resolved_by_name, 'rev01');
});

test('표준답안 편집기: 수정·추가·삭제가 바로 검색에 반영되고 이력·감사 로그가 남음', async () => {
  const { app, rev, admin, kb } = await setup();
  const list = (await app.inject({ url: '/api/review/qa?q=이월', headers: { cookie: rev } })).json();
  assert.equal(list.items.length, 1);
  const item = list.items[0];

  const upd = await app.inject({
    method: 'PUT',
    url: `/api/review/qa/${item.id}`,
    headers: { cookie: rev },
    payload: { ...item, question: '사업비 이월(다음 연도) 가능 여부', reason: '대표 질의 다듬기' },
  });
  assert.equal(upd.statusCode, 200, upd.body);
  const revs = (await app.inject({ url: '/api/review/qa/C2-03-a/revisions', headers: { cookie: rev } })).json();
  assert.equal(revs[0].reason, '대표 질의 다듬기');
  assert.match(revs[0].before_json, /이월할 수 있나요/);

  const add = await app.inject({
    method: 'POST',
    url: '/api/review/qa',
    headers: { cookie: rev },
    payload: { qa_id: 'E1-01-a', category1: '공통', category2: '회의비', question: '회의비로 다과 구입이 가능한가요?', answer: '회의 목적이면 가능', review_status: '확정' },
  });
  assert.equal(add.statusCode, 200, add.body);
  assert.equal(kb.stats.qa, 3);
  const dup = await app.inject({ method: 'POST', url: '/api/review/qa', headers: { cookie: rev }, payload: { qa_id: 'E1-01-a', question: 'x', answer: 'y' } });
  assert.equal(dup.statusCode, 409);
  const s = await kb.search('회의비 다과 구입', '모름');
  assert.equal(s.qa[0].doc.qa_id, 'E1-01-a');

  await app.inject({ method: 'DELETE', url: `/api/review/qa/${add.json().id}`, headers: { cookie: rev }, payload: { reason: '중복' } });
  assert.equal(kb.stats.qa, 2);

  const facets = (await app.inject({ url: '/api/review/qa/facets', headers: { cookie: rev } })).json();
  assert.deepEqual(facets.category2, ['이월', '장비']);
  const logs = (await app.inject({ url: '/api/admin/audit', headers: { cookie: admin } })).json();
  assert.deepEqual(logs.slice(0, 3).map((l: { action: string }) => l.action), ['표준답안 삭제', '표준답안 추가', '표준답안 수정']);
});

test('공지 등록 시 관련 표준답안 재검수 표시, 편집하면 해제', async () => {
  const { app, admin, rev, user } = await setup();
  const n = await app.inject({ method: 'POST', url: '/api/admin/notices', headers: { cookie: admin }, payload: { title: '지침 2차 개정', body: '이월 기준 변경', recheck_qa_ids: 'C2-03-a', recheck_category: '장비' } });
  assert.equal(n.json().marked, 2);
  assert.equal((await app.inject({ url: '/api/notices', headers: { cookie: user } })).json()[0].title, '지침 2차 개정');
  const flagged = (await app.inject({ url: '/api/review/qa?recheck=1', headers: { cookie: rev } })).json();
  assert.equal(flagged.items.length, 2);
  const it = flagged.items[0];
  await app.inject({ method: 'PUT', url: `/api/review/qa/${it.id}`, headers: { cookie: rev }, payload: { ...it, reason: '재검수 완료' } });
  assert.equal((await app.inject({ url: '/api/review/qa?recheck=1', headers: { cookie: rev } })).json().items.length, 1);
  await app.inject({ method: 'PATCH', url: `/api/admin/notices/${n.json().id}`, headers: { cookie: admin }, payload: { active: false } });
  assert.equal((await app.inject({ url: '/api/notices', headers: { cookie: user } })).json().length, 0);
});

test('사용량·비용 통계와 자주 묻는 질문', async () => {
  const { app, admin, user } = await setup();
  const { msg } = await ask(app, user, '사업비 이월 가능한가요?');
  await ask(app, user, '오늘 점심 메뉴 추천해 주세요');
  await app.inject({ method: 'PUT', url: `/api/messages/${msg.id}/feedback`, headers: { cookie: user }, payload: { rating: 'bad', reason: '틀린 내용' } });
  const s = (await app.inject({ url: '/api/admin/stats?days=7', headers: { cookie: admin } })).json();
  assert.equal(s.totals.questions, 2);
  assert.equal(s.totals.llm_calls, 1);
  // 입력 100만 토큰 × $0.10 + 출력 10만 토큰 × $0.50 = $0.15 → 210원
  assert.equal(s.totals.cost_krw, 210);
  assert.equal(s.answer_types['근거답변'], 1);
  assert.equal(s.answer_types['근거없음'], 1);
  assert.equal(s.feedback.bad_reasons['틀린 내용'], 1);
  assert.equal(s.by_org[0].org_name, '부산대학교');

  const answers = (await app.inject({ url: '/api/admin/answers?filter=bad', headers: { cookie: admin } })).json();
  assert.equal(answers.length, 1);
  assert.equal(answers[0].question, '사업비 이월 가능한가요?');

  // 추천 질문 기능은 없앴다 (점검표 결정)
  assert.equal((await app.inject({ url: '/api/suggestions', headers: { cookie: user } })).statusCode, 404);
});

test('보관 기간이 지난 대화 자동 삭제', async () => {
  const { app, db, admin, user } = await setup();
  await ask(app, user, '사업비 이월 가능한가요?');
  db.prepare(`UPDATE conversations SET updated_at = datetime('now', '-40 days')`).run();
  await ask(app, user, '실험장비 사전 승인?');
  assert.equal(purgeOldConversations(db), 0); // 기본값 0 = 삭제 안 함
  await app.inject({ method: 'PUT', url: '/api/admin/settings/retention_days', headers: { cookie: admin }, payload: { value: '30' } });
  assert.equal(purgeOldConversations(db), 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n, 1);
});

test('같은 대화의 엉뚱한 질문은 앞 질문 근거로 답하지 않고, 짧은 후속 질문은 이어서 답함', async () => {
  const { app, user } = await setup();
  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: user }, payload: {} })).json();
  const send = async (content: string) =>
    (await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, headers: { cookie: user }, payload: { content } })).json().messages.at(-1);
  assert.equal((await send('사업비 이월 가능한가요?')).answer_type, '근거답변');
  assert.equal((await send('오늘 점심 메뉴 추천해 주세요')).answer_type, '근거없음');
  assert.equal((await send('사업비 이월 가능한가요?')).answer_type, '근거답변');
  assert.equal((await send('더 자세히요')).answer_type, '근거답변');
  assert.equal((await send('점심 메뉴 하나 추천해 줄래요')).answer_type, '근거없음');
  assert.equal((await send('그럼 예시를 들어 설명해 주세요')).answer_type, '근거답변');
  assert.equal((await send('만약 부득이한 사정이 생긴 경우라면 어떻게 하나요?')).answer_type, '근거답변');
  assert.equal((await send('그 한도는 얼마까지예요?')).answer_type, '근거답변');
});
