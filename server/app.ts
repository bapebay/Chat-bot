import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { BUSINESS_TYPES, ORG_TYPES, REGIONS } from './constants.js';
import type { DB } from './db.js';
import type { KnowledgeBase } from './knowledge/index.js';
import type { LlmClient } from './llm/index.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { conversationRoutes } from './routes/conversations.js';
import { inquiryRoutes } from './routes/inquiries.js';
import { knowledgeRoutes, MAX_UPLOAD_BYTES } from './routes/knowledge.js';

export interface BuildOptions {
  db: DB;
  llm: LlmClient;
  kb: KnowledgeBase;
  logger?: boolean;
  webDir?: string;
}

export async function buildApp({ db, llm, kb, logger = false, webDir }: BuildOptions) {
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  app.get('/api/meta', async () => ({
    org_types: ORG_TYPES,
    regions: REGIONS,
    business_types: BUSINESS_TYPES,
    test_mode: llm.provider === 'mock',
  }));

  authRoutes(app, db);
  conversationRoutes(app, db, llm, kb);
  inquiryRoutes(app, db);
  adminRoutes(app, db, llm, kb);
  knowledgeRoutes(app, db, kb);

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
