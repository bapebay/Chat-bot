import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { BUSINESS_TYPES, ORG_TYPES, REGIONS } from './constants.js';
import type { DB } from './db.js';
import type { LlmClient } from './llm/index.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { conversationRoutes } from './routes/conversations.js';
import { inquiryRoutes } from './routes/inquiries.js';

export interface BuildOptions {
  db: DB;
  llm: LlmClient;
  logger?: boolean;
  webDir?: string;
}

export async function buildApp({ db, llm, logger = false, webDir }: BuildOptions) {
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  await app.register(cookie);

  app.get('/api/meta', async () => ({
    org_types: ORG_TYPES,
    regions: REGIONS,
    business_types: BUSINESS_TYPES,
    test_mode: llm.provider === 'mock',
  }));

  authRoutes(app, db);
  conversationRoutes(app, db, llm);
  inquiryRoutes(app, db);
  adminRoutes(app, db, llm);

  // 배포 시: 빌드된 화면 파일을 함께 제공
  if (webDir && fs.existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: path.resolve(webDir) });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '없는 주소입니다.' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
