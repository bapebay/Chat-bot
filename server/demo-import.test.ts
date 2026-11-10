import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.js';
import { seedTemporaryKnowledge } from './knowledge/store.js';
import { exportFromDemoState, importDemoExport } from './knowledge/demo-import.js';
import { getSetting } from './settings.js';

const state = {
  settings: { system_prompt: '데모에서 고친 프롬프트', top_k_qa: '99', demo_model_tier: 'quick' },
  qaVersions: [{ id: 1, status: 'archived', filename: 'old.xlsx' }, { id: 2, status: 'active', filename: 'qa.md' }],
  qaItems: [
    { version_id: 1, qa_id: 'OLD-1', question: '옛 질문', answer: '옛 답' },
    { version_id: 2, qa_id: 'A-1', category1: '인건비', question: '수당 받을 수 있나요?', answer: '가능합니다', is_referral: 0, review_status: '확정' },
  ],
  principleSets: [{ id: 5, status: 'active', filename: 'p.csv' }],
  principles: [{ set_id: 5, code: 'P-1', text: '원칙 본문', basis: '지침 제1조' }],
  guidelineDocs: [{ id: 9, name: '지침', kind: '지침', filename: 'g.pdf', active: 1 }, { id: 10, name: '꺼둔 문서', kind: 'FAQ', filename: 'x.pdf', active: 0 }],
  guidelineChunks: [{ doc_id: 9, seq: 1, clause: '제2조', page: 2, text: '둘째' }, { doc_id: 9, seq: 0, clause: '제1조', page: 1, text: '첫째' }],
  users: [{ username: 'tester' }],
  conversations: [{ id: 1 }],
};

test('데모 자료는 사용 중인 것만 골라 서버 DB로 옮기고, 시험 기록은 옮기지 않는다', () => {
  const data = exportFromDemoState(state, '2026-11-10T00:00:00Z');
  assert.equal(data.qa?.items.length, 1);
  assert.equal(data.guidelines.length, 1);
  assert.deepEqual(data.guidelines[0].chunks.map((c) => c.clause), ['제1조', '제2조']);
  assert.ok(!('demo_model_tier' in data.settings));
  assert.ok(!JSON.stringify(data).includes('tester'));

  const db = openDatabase(':memory:');
  seedTemporaryKnowledge(db);
  const s = importDemoExport(db, JSON.parse(JSON.stringify(data)));
  assert.equal(s.qa_items, 1);
  assert.equal(s.principles, 1);
  assert.equal(s.guideline_chunks, 2);
  assert.equal(s.temporary_docs_hidden, 2);
  assert.deepEqual(s.settings_changed, ['system_prompt']);
  assert.deepEqual(s.settings_skipped, ['top_k_qa']);
  assert.equal(getSetting(db, 'system_prompt'), '데모에서 고친 프롬프트');
  const qa = db.prepare(`SELECT i.qa_id FROM qa_items i JOIN qa_versions v ON v.id = i.version_id WHERE v.status = 'active'`).all();
  assert.deepEqual(qa, [{ qa_id: 'A-1' }]);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM guideline_docs WHERE active = 1`).get() as { n: number }).n, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM users`).get() as { n: number }).n, 0);

  assert.throws(() => importDemoExport(db, { format: 'x' } as never), /데모에서 내보낸 파일이 아닙니다/);
});
