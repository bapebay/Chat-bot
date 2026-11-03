import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { openDatabase } from './db.js';
import { KnowledgeBase } from './knowledge/index.js';
import { splitByAnd, splitQuestions } from './knowledge/split.js';
import { activateQaVersion, createQaDraft } from './knowledge/store.js';
import type { LlmClient, LlmRequest } from './llm/index.js';

test('한 메시지의 여러 질문을 나눈다', () => {
  assert.deepEqual(splitQuestions('회의비 집행 기준은? 출장비 정산은 어떻게 하나요?'), ['회의비 집행 기준은?', '출장비 정산은 어떻게 하나요?']);
  assert.deepEqual(splitQuestions('1. 회의비 한도는 얼마인가요 2. 야근 식대 지급 가능한가요'), ['회의비 한도는 얼마인가요', '야근 식대 지급 가능한가요']);
  assert.equal(splitQuestions('회의비 기준이 있는지 그리고 야근 식대 지급이 가능한지 궁금합니다').length, 2);
  // 문장부호 없이 붙여 쓴 두 질문
  assert.equal(splitQuestions('종이 카드매출전표가 필수 증빙서류인지 IRB 심의 비용이 내부거래에 해당하는지').length, 2);
  // 질문이 하나면 그대로
  for (const one of [
    '회의비 집행 기준은?',
    '인건비 및 수당 기준은 어떻게 되나요?',
    '저희 대학은 글로컬 사업에 참여하고 있습니다. 이때 전담인력 인건비를 사업비로 지급할 수 있나요?',
    '안녕하세요. 회의비 기준이 궁금합니다. 감사합니다.',
    '사업비 1.5% 이내로 집행해야 하나요?',
    '야근 식대를 지급할 수 있는지 확인 부탁드립니다.',
    '가능한지 불가능한지 궁금합니다',
  ]) {
    assert.deepEqual(splitQuestions(one), [one], one);
  }
  assert.deepEqual(splitByAnd('회의비 집행 기준이랑 야근 식대 지급 가능 여부 알려주세요'), ['회의비 집행 기준', '야근 식대 지급 가능 여부 알려주세요']);
});

test('두 질문을 한 문장에 담아도 두 표준답안을 모두 근거로 찾는다', async () => {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type, role, status) VALUES ('u1', ?, '대학', '가대학교', '부산', '모름', 'user', 'approved')`,
  ).run(hashPassword('userpass1'));
  const base = { category3: '', checklist: '', referral_answer: '', is_referral: 0, review_status: '확정', change_history: '' };
  activateQaVersion(
    db,
    createQaDraft(db, 'qa.xlsx', 1, [
      { ...base, row: 2, qa_id: 'P1', category1: '공통', category2: '시상', question: '시상품 제공 시 발생하는 제세공과금을 사업비로 집행할 수 있는지', answer: '집행할 수 있습니다.' },
      { ...base, row: 3, qa_id: 'P2', category1: '공통', category2: '식대', question: '전담인력의 야근 식대를 사업운영경비로 지급할 수 있는지', answer: '기준 안에서 지급할 수 있습니다.' },
      { ...base, row: 4, qa_id: 'P3', category1: '공통', category2: '회의비', question: '회의비 1인당 한도는 얼마인가요', answer: '1인당 기준 안에서 집행합니다.' },
    ], []),
  );
  const kb = new KnowledgeBase(db, null);
  await kb.rebuild();
  const calls: LlmRequest[] = [];
  const llm: LlmClient = {
    provider: 'fake',
    model: 'f',
    async generate(req) {
      calls.push(req);
      const ids = [...req.messages.at(-1)!.content.matchAll(/통합번호: ([^ |\]]+)/g)].map((m) => m[1]);
      return { text: JSON.stringify({ answer_type: '근거답변', business_type: '공통', answer_markdown: '1) … 2) …', cited_qa_ids: ids, cited_guideline: [], referral: '없음' }), provider: 'fake', model: 'f', inputTokens: 1, outputTokens: 1 };
    },
  };
  const app = await buildApp({ db, llm, kb });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'u1', password: 'userpass1' } });
  const raw = res.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];
  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie }, payload: {} })).json();
  const ans = await app.inject({
    method: 'POST',
    url: `/api/conversations/${conv.id}/messages`,
    headers: { cookie },
    payload: { content: '시상품 제세공과금을 사업비로 집행할 수 있는지, 또 전담인력 야근 식대도 지급 가능한지 궁금합니다' },
  });
  const m = ans.json().messages.at(-1);
  assert.equal(m.answer_type, '근거답변');
  const relevant = JSON.parse(m.citations).retrieved.qa.filter((q: { relevant: boolean }) => q.relevant).map((q: { qa_id: string }) => q.qa_id);
  assert.ok(relevant.includes('P1') && relevant.includes('P2'), relevant.join(','));
  // AI에게 질문이 두 개라고 알려 준다
  assert.match(calls[0].messages.at(-1)!.content, /질문이 2개 있다/);
});
