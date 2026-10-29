import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireRole } from '../auth.js';
import { BUSINESS_TYPES } from '../constants.js';
import type { DB } from '../db.js';
import { buildQaWorkbook, parseOutOfScope, parsePrinciples, parseQaWorkbook } from '../knowledge/excel.js';
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
  replaceOutOfScope,
} from '../knowledge/store.js';
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
  const reviewer = requireRole(db, 'reviewer');
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
      return listQaVersions(db).find((v) => v.id === id);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/admin/knowledge/qa/versions', { preHandler: admin }, async () => listQaVersions(db));

  app.post('/api/admin/knowledge/qa/versions/:id/activate', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    if (!id || !activateQaVersion(db, id)) return reply.code(404).send({ error: '버전을 찾을 수 없습니다.' });
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

  app.get('/api/admin/knowledge/qa/versions/:id/items', { preHandler: reviewer }, async (req) => {
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
  app.post('/api/admin/knowledge/principles/parse', { preHandler: admin }, async (req, reply) => {
    const up = await readUpload(req, reply, /\.(xlsx|txt|md)$/i);
    if (!up) return;
    try {
      return { text: await parsePrinciples(up.buffer, up.filename) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ----- 답변범위 외 목록 -----
  app.get('/api/admin/knowledge/out-of-scope', { preHandler: admin }, async () =>
    db.prepare('SELECT * FROM out_of_scope ORDER BY id').all(),
  );

  app.post('/api/admin/knowledge/out-of-scope/upload', { preHandler: admin }, async (req, reply) => {
    const up = await readUpload(req, reply, /\.(xlsx|txt|md|csv)$/i);
    if (!up) return;
    try {
      const items = await parseOutOfScope(up.buffer, up.filename);
      replaceOutOfScope(db, items);
      kb.rebuild();
      return { ok: true, count: items.length };
    } catch (e) {
      return fail(reply, e);
    }
  });

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
    if (!info.changes) return reply.code(404).send({ error: '문서를 찾을 수 없습니다.' });
    kb.rebuild();
    return { ok: true };
  });

  app.delete('/api/admin/knowledge/guidelines/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const info = db.prepare('DELETE FROM guideline_docs WHERE id = ?').run(id);
    if (!info.changes) return reply.code(404).send({ error: '문서를 찾을 수 없습니다.' });
    kb.rebuild();
    return { ok: true };
  });

  // ----- 검색 시험: 질문을 넣으면 어떤 근거가 몇 점으로 찾아지는지 보여준다 -----
  app.post('/api/admin/knowledge/search-test', { preHandler: reviewer }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const query = str(b.query);
    const businessType = str(b.business_type) || '모름';
    if (!query) return reply.code(400).send({ error: '질문을 입력해 주세요.' });
    if (!(BUSINESS_TYPES as readonly string[]).includes(businessType)) return reply.code(400).send({ error: '사업 유형이 올바르지 않습니다.' });
    const r = await kb.search(query, businessType);
    const fmt = <T>(h: { doc: T; keyword: number; semantic: number | null; relevant: boolean }) => ({
      keyword: Math.round(h.keyword * 1000) / 1000,
      semantic: h.semantic === null ? null : Math.round(h.semantic * 1000) / 1000,
      relevant: h.relevant,
    });
    return {
      mode: r.mode,
      passed: r.passed,
      qa: r.qa.map((h) => ({ ...fmt(h), qa_id: h.doc.qa_id, category1: h.doc.category1, question: h.doc.question })),
      guideline: r.guideline.map((h) => ({ ...fmt(h), doc_name: h.doc.doc_name, clause: h.doc.clause, page: h.doc.page })),
      out_of_scope: r.outOfScope ? { ...fmt(r.outOfScope), question: r.outOfScope.doc.question } : null,
    };
  });
}
