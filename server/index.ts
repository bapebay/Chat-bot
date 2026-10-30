import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { scheduleBackup } from './backup.js';
import { markInterruptedRuns } from './evaluation.js';
import { ensureInitialAdmin } from './auth.js';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { DEFAULT_MODELS_DIR, loadLocalEmbedder } from './knowledge/embedder.js';
import { KnowledgeBase } from './knowledge/index.js';
import { seedTemporaryKnowledge } from './knowledge/store.js';
import { createLlmClient } from './llm/index.js';
import { scheduleRetention } from './retention.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const db = openDatabase();
markInterruptedRuns(db);
const llm = createLlmClient();
const log = (msg: string) => console.log(`[지식] ${msg}`);
if (seedTemporaryKnowledge(db)) log('지식 데이터가 없어 프로토타입의 지침·FAQ 발췌본을 임시 문서로 넣었습니다.');
const embedder = await loadLocalEmbedder(process.env.MODELS_DIR || DEFAULT_MODELS_DIR, log);
const kb = new KnowledgeBase(db, embedder, log);
kb.rebuild();
const app = await buildApp({
  db,
  llm,
  kb,
  logger: true,
  webDir: path.resolve(here, '../web'),
  rateLimit: config.security.rateLimit,
  staffAllowedIps: config.security.staffAllowedIps,
  trustProxy: config.security.trustProxy,
});

ensureInitialAdmin(db, (msg) => app.log.warn(msg));
scheduleRetention(db, (msg) => app.log.info(msg));
scheduleBackup(db, config.backup, (msg, error) => (error ? app.log.error(msg) : app.log.info(msg)));
if (!config.security.rateLimit) app.log.warn('요청 횟수 제한이 꺼져 있습니다(RATE_LIMIT=off).');
if (config.security.staffAllowedIps.length) app.log.info(`관리 메뉴 허용 IP: ${config.security.staffAllowedIps.join(', ')}`);
if (llm.provider === 'mock') {
  app.log.warn('테스트 모드(LLM_PROVIDER=mock): 실제 AI 대신 예시 답변을 돌려줍니다.');
} else {
  app.log.info(`AI 모델: ${llm.provider} / ${llm.model}`);
}

await app.listen({ port: config.port, host: '0.0.0.0' });
