import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { MAX_QA_FILES } from './knowledge/qa-markdown.js';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { config, TRUST_PROXY } from './config.js';
import { BUSINESS_TYPES, ORG_TYPES, REGIONS } from './constants.js';
import type { DB } from './db.js';
import type { KnowledgeBase } from './knowledge/index.js';
import type { LlmClient } from './llm/index.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { conversationRoutes } from './routes/conversations.js';
import { inquiryRoutes } from './routes/inquiries.js';
import { knowledgeRoutes, MAX_UPLOAD_BYTES } from './routes/knowledge.js';
import { adminOpsRoutes } from './routes/admin-ops.js';
import { operationsRoutes } from './routes/operations.js';
import { DEFAULT_RATE_RULES, rateLimit, securityHeaders } from './security.js';

export interface BuildOptions {
  db: DB;
  llm: LlmClient;
  kb: KnowledgeBase;
  logger?: boolean;
  webDir?: string;
  /** IP별 요청 횟수 제한 (실서비스는 켬, 테스트는 기본 끔) */
  rateLimit?: boolean;
  /** 관리 메뉴를 쓸 수 있는 IP·대역 (비우면 제한 없음) */
  /** 테스트용: 프록시 신뢰 방식을 바꿀 때 */
  trustProxy?: boolean | string | ((addr: string, hop: number) => boolean);
}

export async function buildApp({
  db,
  llm,
  kb,
  logger = false,
  webDir,
  rateLimit: limitRequests = false,
  trustProxy = TRUST_PROXY,
}: BuildOptions) {
  const app = Fastify({ logger, bodyLimit: 1024 * 1024, trustProxy });
  securityHeaders(app, { hsts: config.cookieSecure });
  if (limitRequests) rateLimit(app, DEFAULT_RATE_RULES);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_QA_FILES } });

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
  operationsRoutes(app, db, kb);
  adminOpsRoutes(app, db);

  app.get('/api/health', async () => ({ ok: true }));

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
