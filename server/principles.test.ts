import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from './app.js';
import { hashPassword } from './auth.js';
import { buildContext } from './chat.js';
import { openDatabase } from './db.js';
import { KnowledgeBase } from './knowledge/index.js';
import { decodeCsv, parseCsv, parsePrinciplesCsv, principlesTemplateCsv } from './knowledge/principles.js';
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

// 실제 파일 형식: 머리글의 '공개근거(지침,법령,FAQ)'를 따옴표 없이 저장해 괄호 안 쉼표에서 칸이 갈라진 경우까지
const CSV = [
  '원칙 ID,중분류,세분류,질문키워드,답변원칙,세부설명,예외-유의점,연결처,공개근거(지침,법령,FAQ)',
  'P-001,인건비,수당,"과제책임자 수당, 책임자 수당",과제책임자에게 해당 과제에서 수당을 지급할 수 없다.,"다른 과제 참여 수당은\n그 과제 기준에 따른다.",겸직이면 달라질 수 있다.,지역앵커센터,지침 제5조,FAQ 12',
  'P-002,연구시설·장비,구입,"장비 심의, 사후 심의","추정가격 1억원 이상 연구장비는 발주 전에 심의를 거친 경우에 한해 집행할 수 있다, 사후 심의는 불가하다.",,,재단,"지침 제20조, 국가연구개발혁신법"',
  ',,,,,,,,',
  'P-003,회의비,식대,,,,,,',
].join('\r\n');

test('집행원리 CSV: 실제 열 형식(원칙 ID~공개근거), 따옴표 속 쉼표·줄바꿈, 갈라진 머리글, UTF-8·CP949', () => {
  assert.deepEqual(parseCsv('a,"b,c",d\n"x ""y""",z\n'), [['a', 'b,c', 'd'], ['x "y"', 'z']]);
  for (const bytes of [Buffer.from('﻿' + CSV, 'utf8'), encodeCp949(CSV)]) {
    assert.match(decodeCsv(bytes), /답변원칙/);
    const { items, warnings } = parsePrinciplesCsv(bytes);
    assert.equal(items.length, 2);
    const [a, b] = items;
    assert.deepEqual(
      { code: a.code, category: a.category, subcategory: a.subcategory, keywords: a.keywords, caution: a.caution, referral: a.referral, basis: a.basis },
      { code: 'P-001', category: '인건비', subcategory: '수당', keywords: '과제책임자 수당, 책임자 수당', caution: '겸직이면 달라질 수 있다.', referral: '지역앵커센터', basis: '지침 제5조, FAQ 12' },
    );
    assert.equal(a.detail, '다른 과제 참여 수당은\n그 과제 기준에 따른다.');
    assert.match(b.text, /심의를 거친 경우에 한해 집행할 수 있다, 사후 심의는 불가하다/);
    assert.equal(b.basis, '지침 제20조, 국가연구개발혁신법');
    assert.equal(warnings.length, 1); // P-003 답변 원칙 없음
  }
  // 머리글을 따옴표로 감싸 저장한 경우도 같다
  const quoted = CSV.replace('공개근거(지침,법령,FAQ)', '"공개근거(지침,법령,FAQ)"');
  assert.equal(parsePrinciplesCsv(Buffer.from(quoted, 'utf8')).items[0].basis, '지침 제5조, FAQ 12');
  // 내려받는 양식은 예시 행만 있어 그대로 올리면 '내용 없음'
  assert.throws(() => parsePrinciplesCsv(Buffer.from(principlesTemplateCsv(), 'utf8')), /읽을 집행원리가 없습니다/);
  assert.throws(() => parsePrinciplesCsv(Buffer.from('a,b\n1,2')), /답변 원칙/);
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
  assert.match(sent, /<근거자료>[\s\S]*\[집행원리 P1 \| 분야: 인건비 > 수당 \| 연결처: 지역앵커센터\]\n질문 키워드: [^\n]+\n답변 원칙: 과제책임자에게[\s\S]*예외·유의점: 겸직[\s\S]*공개 근거: 지침 제5조, FAQ 12[\s\S]*<\/근거자료>/);
  assert.doesNotMatch(sent, /P-001/, '원칙 ID는 AI에 넘기지 않는다');
  assert.ok(JSON.parse(ans.json().messages.at(-1).citations).retrieved.principle.some((p: { code: string }) => p.code === 'P-001'));
});

test('집행원리 묶음: 새로 올리면 이전 묶음은 보관, 되돌리기, 사용 중인 묶음은 삭제 불가', async () => {
  const { kb, app, cookie, upload } = await setup();
  const first = (await upload('1차.csv', Buffer.from(CSV, 'utf8'))).json();
  const second = (await upload('2차.csv', Buffer.from('답변원칙\n회의비는 1인당 기준 안에서 집행한다.\n', 'utf8'))).json();
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
