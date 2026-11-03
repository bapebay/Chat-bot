import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { buildContext } from './chat.js';
import { openDatabase } from './db.js';
import { KnowledgeBase } from './knowledge/index.js';
import { decodeCsv, parseCsv, parsePrinciplesCsv } from './knowledge/principles.js';
import { activateQaVersion, createQaDraft } from './knowledge/store.js';
import type { LlmClient, LlmRequest } from './llm/index.js';

/** 테스트용: 한글 엑셀이 저장하는 CP949(EUC-KR) 바이트 만들기 (브라우저·Node 모두 해독만 지원하므로 역표를 만든다) */
function encodeCp949(text: string): Buffer {
  const map = new Map<string, number[]>();
  const dec = new TextDecoder('euc-kr');
  for (let a = 0x81; a <= 0xfe; a++) {
    for (let b = 0x41; b <= 0xfe; b++) {
      const ch = dec.decode(Uint8Array.from([a, b]));
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [a, b]);
    }
  }
  const out: number[] = [];
  for (const ch of text) out.push(...(ch.charCodeAt(0) < 0x80 ? [ch.charCodeAt(0)] : (map.get(ch) ?? [0x3f])));
  return Buffer.from(out);
}

const CSV = [
  '번호,분야,재원,적용시기,집행원리,비고',
  'P-001,인건비·수당,순수앵커,2026,"과제책임자에게 해당 과제에서 수당을 지급하는 것은 불가하다.",관련 질의 다수',
  'P-002,연구시설·장비,공통,2025~,"추정가격 1억원 이상 연구장비는 발주 전에 심의를 거친 경우에 한해 집행할 수 있다, 사후 심의는 불가하다.",',
  ',,,,,',
  'P-003,회의비,공통,,"",',
].join('\r\n');

test('집행원리 CSV: 따옴표 속 쉼표, 빈 행, 내용 없는 행, UTF-8·CP949 모두 읽는다', () => {
  assert.deepEqual(parseCsv('a,"b,c",d\n"x ""y""",z\n'), [['a', 'b,c', 'd'], ['x "y"', 'z']]);
  for (const bytes of [Buffer.from('﻿' + CSV, 'utf8'), encodeCp949(CSV)]) {
    assert.match(decodeCsv(bytes), /집행원리/);
    const { items, warnings } = parsePrinciplesCsv(bytes);
    assert.equal(items.length, 2);
    assert.equal(items[1].code, 'P-002');
    assert.match(items[1].text, /심의를 거친 경우에 한해 집행할 수 있다, 사후 심의는 불가하다/);
    assert.equal(items[0].funding, '순수앵커');
    assert.equal(warnings.length, 1); // P-003 내용 없음
  }
  assert.throws(() => parsePrinciplesCsv(Buffer.from('a,b\n1,2')), /집행원리/);
});

async function setup() {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type, role, status) VALUES ('admin', ?, '재단', '중앙앵커센터', '해당없음', '모름', 'admin', 'approved')`,
  ).run(hashPassword('adminpass1'));
  const base = { category3: '', checklist: '', referral_answer: '', is_referral: 0, review_status: '확정', change_history: '' };
  activateQaVersion(db, createQaDraft(db, 'qa.xlsx', 1, [{ ...base, row: 2, qa_id: 'B4-01', category1: '공통', category2: '수당', question: '과제책임자 수당 지급 가능?', answer: '불가합니다.' }], []));
  const kb = new KnowledgeBase(db, null);
  await kb.rebuild();
  const calls: LlmRequest[] = [];
  const llm: LlmClient = {
    provider: 'fake',
    model: 'f',
    async generate(req) {
      calls.push(req);
      return { text: JSON.stringify({ answer_type: '근거답변', business_type: '공통', answer_markdown: '불가합니다.', cited_qa_ids: [], cited_guideline: [], referral: '없음' }), provider: 'fake', model: 'f', inputTokens: 1, outputTokens: 1 };
    },
  };
  const app = await buildApp({ db, llm, kb });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'adminpass1' } });
  const raw = res.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];
  const upload = (name: string, body: Buffer) => {
    const boundary = '----t' + Math.random().toString(16).slice(2);
    return app.inject({
      method: 'POST',
      url: '/api/admin/knowledge/principles/upload',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n`), body, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    });
  };
  return { db, kb, app, cookie, calls, upload };
}

test('집행원리를 올리면 검색되고, 질문할 때 지침 다음·표준답안 앞에 [집행원리] 꼬리표로 AI에 넘어간다', async () => {
  const { kb, app, cookie, calls, upload } = await setup();
  assert.equal((await app.inject({ url: '/api/admin/knowledge/principles/template', headers: { cookie } })).statusCode, 200);
  const up = await upload('집행원리.csv', encodeCp949(CSV));
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(up.json().item_count, 2);
  assert.equal(kb.stats.principle, 2);

  const r = await kb.search('과제책임자 수당 지급', '모름');
  assert.equal(r.principle[0].doc.code, 'P-001');
  assert.ok(r.principle[0].relevant);
  const ctx = buildContext(r);
  assert.ok(ctx.indexOf('[집행원리 P1') < ctx.indexOf('[표준답안 통합번호'), '집행원리가 표준답안보다 앞');

  const conv = (await app.inject({ method: 'POST', url: '/api/conversations', headers: { cookie }, payload: {} })).json();
  const ans = await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/messages`, headers: { cookie }, payload: { content: '과제책임자에게 수당 지급이 되나요?' } });
  assert.equal(ans.statusCode, 200);
  const sent = calls[0].messages.at(-1)!.content;
  assert.match(sent, /<근거자료>[\s\S]*\[집행원리 P1 \| 번호: P-001[\s\S]*<\/근거자료>/);
  assert.ok(JSON.parse(ans.json().messages.at(-1).citations).retrieved.principle.some((p: { code: string }) => p.code === 'P-001'));
});

test('집행원리 묶음: 새로 올리면 이전 묶음은 보관, 되돌리기, 사용 중인 묶음은 삭제 불가', async () => {
  const { kb, app, cookie, upload } = await setup();
  const first = (await upload('1차.csv', Buffer.from(CSV, 'utf8'))).json();
  const second = (await upload('2차.csv', Buffer.from('집행원리\n회의비는 1인당 기준 안에서 집행한다.\n', 'utf8'))).json();
  assert.equal(kb.stats.principle, 1);
  const sets = (await app.inject({ url: '/api/admin/knowledge/principles', headers: { cookie } })).json();
  assert.deepEqual(sets.map((s: { status: string }) => s.status), ['active', 'archived']);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/knowledge/principles/sets/${second.id}`, headers: { cookie } })).statusCode, 400);
  await app.inject({ method: 'POST', url: `/api/admin/knowledge/principles/sets/${first.id}/activate`, headers: { cookie } });
  assert.equal(kb.stats.principle, 2);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/knowledge/principles/sets/${second.id}`, headers: { cookie } })).statusCode, 200);
  const items = (await app.inject({ url: `/api/admin/knowledge/principles/sets/${first.id}/items?q=심의`, headers: { cookie } })).json();
  assert.equal(items.length, 1);
  // 형식이 다른 파일은 안내와 함께 거절
  assert.equal((await upload('x.xlsx', Buffer.from('x'))).statusCode, 400);
});
