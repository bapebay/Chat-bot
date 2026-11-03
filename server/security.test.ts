import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildApp } from './app.js';
import { backupDatabase, listBackups } from './backup.js';
import { openDatabase } from './db.js';
import { KnowledgeBase } from './knowledge/index.js';
import type { LlmClient } from './llm/index.js';
import { createOpenAiClient } from './llm/openai.js';

const llm: LlmClient = {
  provider: 'fake',
  model: 'fake-1',
  async generate() {
    throw new Error('not used');
  },
};

async function makeApp(opts: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const db = openDatabase(':memory:');
  const kb = new KnowledgeBase(db, null, () => undefined);
  kb.rebuild();
  return buildApp({ db, llm, kb, ...opts });
}

test('모든 응답에 보안 헤더가 붙는다', async () => {
  const app = await makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
  await app.close();
});

test('로그인 시도는 같은 IP에서 1분 10회까지만 받는다', async () => {
  const app = await makeApp({ rateLimit: true });
  const login = (ip: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, payload: { username: 'nobody', password: 'wrongpass1' } });
  for (let i = 0; i < 10; i++) assert.equal((await login('198.51.100.7')).statusCode, 401);
  const blocked = await login('198.51.100.7');
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  // 다른 IP는 따로 센다
  assert.equal((await login('198.51.100.8')).statusCode, 401);
  await app.close();
});

test('같은 서버·내부망의 앞단 웹서버만 믿고 실제 접속자 IP로 센다', async () => {
  const app = await makeApp({ rateLimit: true });
  const login = (remote: string, client: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: remote,
      headers: { 'x-forwarded-for': client },
      payload: { username: 'nobody', password: 'wrongpass1' },
    });
  // 내부망 웹서버(10.x) 뒤: 접속자별로 따로 센다
  for (let i = 0; i < 10; i++) await login('10.0.0.1', '203.0.113.1');
  assert.equal((await login('10.0.0.1', '203.0.113.1')).statusCode, 429);
  assert.equal((await login('10.0.0.1', '203.0.113.2')).statusCode, 401);
  // 외부에서 직접 와서 X-Forwarded-For 를 꾸며도 믿지 않는다 (같은 IP로 셈)
  for (let i = 0; i < 10; i++) await login('198.51.100.9', `198.18.0.${i}`);
  assert.equal((await login('198.51.100.9', '198.18.0.99')).statusCode, 429);
  await app.close();
});

test('백업은 서비스 중에도 온전한 DB 파일을 만들고 오래된 것은 지운다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatbot-backup-'));
  const db = openDatabase(path.join(dir, 'live.db'));
  db.prepare(
    `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type) VALUES ('u1', 'x', '대학', '가', '부산', '모름')`,
  ).run();
  const out = path.join(dir, 'backups');
  for (let i = 0; i < 3; i++) {
    await backupDatabase(db, out, 2);
    await new Promise((r) => setTimeout(r, 1100)); // 파일 이름이 초 단위라 겹치지 않게
  }
  const files = listBackups(out);
  assert.equal(files.length, 2);
  const copy = new Database(path.join(out, files[0].name), { readonly: true });
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1);
  copy.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OpenAI 호환 연결: 형식 지정·키 전달·답변 읽기', async () => {
  let seen: { auth?: string; body?: Record<string, unknown> } = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(raw) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '{"answer_type":"근거답변"}' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const client = createOpenAiClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k-test', model: 'local-model', maxOutputTokens: 100, jsonMode: 'json_object' });
  const out = await client.generate({ system: '시스템', messages: [{ role: 'user', content: '질문' }], jsonSchema: { type: 'object' } });
  server.close();
  assert.equal(out.text, '{"answer_type":"근거답변"}');
  assert.equal(out.inputTokens, 12);
  assert.equal(seen.auth, 'Bearer k-test');
  assert.deepEqual(seen.body?.response_format, { type: 'json_object' });
  assert.deepEqual((seen.body?.messages as { role: string }[]).map((m) => m.role), ['system', 'user']);
});
