import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { ensureInitialAdmin } from './auth.js';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { createLlmClient } from './llm/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const db = openDatabase();
const llm = createLlmClient();
const app = await buildApp({ db, llm, logger: true, webDir: path.resolve(here, '../web') });

ensureInitialAdmin(db, (msg) => app.log.warn(msg));
if (llm.provider === 'mock') {
  app.log.warn('테스트 모드(LLM_PROVIDER=mock): 실제 AI 대신 예시 답변을 돌려줍니다.');
} else {
  app.log.info(`AI 모델: ${llm.provider} / ${llm.model}`);
}

await app.listen({ port: config.port, host: '0.0.0.0' });
