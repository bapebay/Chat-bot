import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../audit.js';
import { requireRole } from '../auth.js';
import type { DB } from '../db.js';
import { buildQaWorkbook, parseQaWorkbook } from '../knowledge/excel.js';
import { chunkUpload } from '../knowledge/guideline.js';
import type { KnowledgeBase } from '../knowledge/index.js';
import {
  activateQaVersion,
  addGuidelineDoc,
  createQaDraft,
  deleteQaVersion,
  listGuidelineDocs,
  listQaItems,
  listQaVersions,
  activatePrincipleSet,
  deletePrincipleSet,
  listPrinciples,
  listPrincipleSets,
  savePrincipleSet,
} from '../knowledge/store.js';
import { parsePrinciplesCsv, principlesTemplateCsv } from '../knowledge/principles.js';
import { idParam, str } from './util.js';

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** 업로드된 파일 1개와 함께 온 글자 필드를 읽는다 */
export async function readUpload(req: FastifyRequest, reply: FastifyReply, exts: RegExp) {
  let file: MultipartFile | undefined;
  try {
    file = await req.file();
  } catch {
    file = undefined;
  }
  if (!file) {
    reply.code(400).send({ error: '파일을 선택해 주세요.' });
    return null;
  }
  const filename = file.filename || 'upload';
  if (!exts.test(filename)) {
    file.file.resume();
    reply.code(400).send({ error: '지원하지 않는 파일 형식입니다.' });
    return null;
  }
  const buffer = await file.toBuffer();
  if (file.file.truncated) {
    reply.code(400).send({ error: '파일이 너무 큽니다 (15MB 이하).' });
    return null;
  }
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(file.fields)) {
    const f = v as { type?: string; value?: unknown } | undefined;
    if (f && f.type === 'field') fields[k] = String(f.value ?? '');
  }
  return { filename, buffer, fields };
}

export function sendXlsx(reply: FastifyReply, buffer: Buffer, filename: string) {
  return reply
    .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .send(buffer);
}

export function knowledgeRoutes(app: FastifyInstance, db: DB, kb: KnowledgeBase) {
  const admin = requireRole(db, 'admin');
  const fail = (reply: FastifyReply, e: unknown) => reply.code(400).send({ error: (e as Error).message });

  app.get('/api/admin/knowledge/status', { preHandler: admin }, async () => ({
    ...kb.stats,
    active_version: listQaVersions(db).find((v) => v.status === 'active') ?? null,
  }));

  // ----- 표준 Q&A -----
  app.get('/api/admin/knowledge/qa/template', { preHandler: admin }, async (_req, reply) =>
    sendXlsx(
      reply,
      await buildQaWorkbook([
        {
          qa_id: 'A1-01-a',
          category1: '공통',
          category2: '인건비',
          category3: 'A1',
          question: '(예시) 사업 참여 인력의 인건비 상한은 어떻게 되나요?',
          checklist: '인건비 상한 비율 / 사업비 규모별 차등',
          answer: '(예시) 총 사업비 규모에 따라 인건비 상한을 차등 적용합니다. …',
          referral_answer: '',
          is_referral: 0,
          review_status: '확정',
          change_history: '',
        },
      ]),
      '표준QA_업로드_양식.xlsx',
    ),
  );

  app.post('/api/admin/knowledge/qa/upload', { preHandler: admin }, async (req, reply) => {
    const up = await readUpload(req, reply, /\.xlsx$/i);
    if (!up) return;
    try {
      const { items, warnings } = await parseQaWorkbook(up.buffer);
      const id = createQaDraft(db, up.filename, req.user.id, items, warnings);
      audit(db, req.user, '표준 Q&A 업로드(미리보기)', `#${id} ${up.filename}`, `${items.length}건`);
      return listQaVersions(db).find((v) => v.id === id);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/admin/knowledge/qa/versions', { preHandler: admin }, async () => listQaVersions(db));

  app.post('/api/admin/knowledge/qa/versions/:id/activate', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    if (!id || !activateQaVersion(db, id)) return reply.code(404).send({ error: '버전을 찾을 수 없습니다.' });
    audit(db, req.user, '표준 Q&A 서비스 적용', `#${id}`);
    kb.rebuild();
    return { ok: true, versions: listQaVersions(db) };
  });

  app.delete('/api/admin/knowledge/qa/versions/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    const r = id ? deleteQaVersion(db, id) : 'missing';
    if (r === 'missing') return reply.code(404).send({ error: '버전을 찾을 수 없습니다.' });
    if (r === 'active') return reply.code(400).send({ error: '서비스 중인 버전은 삭제할 수 없습니다.' });
    return { ok: true };
  });

  app.get('/api/admin/knowledge/qa/versions/:id/items', { preHandler: admin }, async (req) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    return listQaItems(db, id, str((req.query as Record<string, unknown>).q));
  });

  app.get('/api/admin/knowledge/qa/versions/:id/export', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const items = listQaItems(db, id, '', 100000) as Parameters<typeof buildQaWorkbook>[0];
    if (!items.length) return reply.code(404).send({ error: '버전을 찾을 수 없습니다.' });
    return sendXlsx(reply, await buildQaWorkbook(items), `표준QA_v${id}.xlsx`);
  });

  // ----- 답변 원칙: 파일에서 글을 읽어 편집기에 채워 준다 (저장은 설정 화면에서) -----
  // ----- 답변범위 외 목록 -----
  // ----- 지침·FAQ 원문 -----
  app.get('/api/admin/knowledge/guidelines', { preHandler: admin }, async () => listGuidelineDocs(db));

  app.post('/api/admin/knowledge/guidelines/upload', { preHandler: admin }, async (req, reply) => {
    const up = await readUpload(req, reply, /\.(pdf|txt|md)$/i);
    if (!up) return;
    const kind = up.fields.kind === 'FAQ' ? 'FAQ' : '지침';
    const name = (up.fields.name || up.filename.replace(/\.[^.]+$/, '')).trim().slice(0, 100);
    try {
      const chunks = await chunkUpload(up.buffer, up.filename);
      const id = addGuidelineDoc(db, { name, kind, filename: up.filename, userId: req.user.id }, chunks);
      audit(db, req.user, '지침·FAQ 업로드', name, `${chunks.length}개 조항`);
      kb.rebuild();
      return { ok: true, id, chunk_count: chunks.length };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/admin/knowledge/guidelines/:id/chunks', { preHandler: admin }, async (req) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    return db.prepare('SELECT id, seq, clause, page, text FROM guideline_chunks WHERE doc_id = ? ORDER BY seq').all(id);
  });

  app.patch('/api/admin/knowledge/guidelines/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const active = ((req.body ?? {}) as Record<string, unknown>).active ? 1 : 0;
    const info = db.prepare('UPDATE guideline_docs SET active = ? WHERE id = ?').run(active, id);
    if (info.changes) audit(db, req.user, active ? '지침 문서 사용' : '지침 문서 사용 중지', `#${id}`);
    if (!info.changes) return reply.code(404).send({ error: '문서를 찾을 수 없습니다.' });
    kb.rebuild();
    return { ok: true };
  });

  app.delete('/api/admin/knowledge/guidelines/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const info = db.prepare('DELETE FROM guideline_docs WHERE id = ?').run(id);
    if (info.changes) audit(db, req.user, '지침 문서 삭제', `#${id}`);
    if (!info.changes) return reply.code(404).send({ error: '문서를 찾을 수 없습니다.' });
    kb.rebuild();
    return { ok: true };
  });


  // ----- 집행원리 (근거 2단계: 지침·FAQ 다음, 표준답안 앞) -----
  app.get('/api/admin/knowledge/principles/template', { preHandler: admin }, async (_req, reply) =>
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('집행원리_양식.csv')}`)
      .send(principlesTemplateCsv()),
  );

  app.get('/api/admin/knowledge/principles', { preHandler: admin }, async () => listPrincipleSets(db));

  app.get('/api/admin/knowledge/principles/sets/:id/items', { preHandler: admin }, async (req) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    return listPrinciples(db, id, str((req.query as Record<string, unknown>).q));
  });

  app.post('/api/admin/knowledge/principles/upload', { preHandler: admin }, async (req, reply) => {
    const up = await readUpload(req, reply, /\.csv$/i);
    if (!up) return reply;
    let parsed: ReturnType<typeof parsePrinciplesCsv>;
    try {
      parsed = parsePrinciplesCsv(up.buffer);
    } catch (e) {
      return fail(reply, e);
    }
    const id = savePrincipleSet(db, up.filename, req.user.id, parsed.items, parsed.warnings);
    kb.rebuild();
    audit(db, req.user, '집행원리 업로드', up.filename, `${parsed.items.length}건`);
    return { id, item_count: parsed.items.length, warnings: parsed.warnings };
  });

  app.post('/api/admin/knowledge/principles/sets/:id/activate', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    if (!activatePrincipleSet(db, id)) return reply.code(404).send({ error: '집행원리 묶음을 찾을 수 없습니다.' });
    kb.rebuild();
    audit(db, req.user, '집행원리 되돌리기', `#${id}`);
    return { ok: true };
  });

  app.delete('/api/admin/knowledge/principles/sets/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const r = deletePrincipleSet(db, id);
    if (r === 'missing') return reply.code(404).send({ error: '집행원리 묶음을 찾을 수 없습니다.' });
    if (r === 'active') return reply.code(400).send({ error: '사용 중인 묶음은 지울 수 없습니다. 다른 묶음을 먼저 사용하세요.' });
    audit(db, req.user, '집행원리 묶음 삭제', `#${id}`);
    return { ok: true };
  });
}
