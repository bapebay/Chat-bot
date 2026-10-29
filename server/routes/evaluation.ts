import type { FastifyInstance } from 'fastify';
import { requireRole } from '../auth.js';
import type { DB } from '../db.js';
import {
  buildEvalTemplate,
  buildRunWorkbook,
  cancelEvalRun,
  createEvalSet,
  isRunning,
  parseEvalWorkbook,
  startEvalRun,
  summarizeRun,
} from '../evaluation.js';
import type { KnowledgeBase } from '../knowledge/index.js';
import type { LlmClient } from '../llm/index.js';
import { readUpload, sendXlsx } from './knowledge.js';
import { idParam, str } from './util.js';

interface RunRow {
  id: number;
  set_id: number;
  label: string;
  status: string;
  total: number;
  done: number;
  config: string;
  summary: string | null;
  error: string | null;
  started_by_name: string | null;
  started_at: string;
  finished_at: string | null;
}

function parseRun(r: RunRow) {
  return { ...r, config: JSON.parse(r.config), summary: r.summary ? JSON.parse(r.summary) : null };
}

export function evaluationRoutes(app: FastifyInstance, db: DB, llm: LlmClient, kb: KnowledgeBase) {
  const admin = requireRole(db, 'admin');
  const SELECT_RUN = `SELECT r.*, u.username AS started_by_name FROM eval_runs r LEFT JOIN users u ON u.id = r.started_by`;

  app.get('/api/admin/eval/template', { preHandler: admin }, async (_req, reply) =>
    sendXlsx(reply, await buildEvalTemplate(), '평가질문집_양식.xlsx'),
  );

  app.post('/api/admin/eval/sets', { preHandler: admin }, async (req, reply) => {
    const up = await readUpload(req, reply, /\.xlsx$/i);
    if (!up) return;
    try {
      const { items, warnings } = await parseEvalWorkbook(up.buffer);
      const name = (up.fields.name || up.filename.replace(/\.[^.]+$/, '')).trim().slice(0, 100);
      const id = createEvalSet(db, name, up.filename, req.user.id, items);
      return { id, count: items.length, warnings };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/admin/eval/sets', { preHandler: admin }, async () =>
    db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM eval_items i WHERE i.set_id = s.id) AS item_count,
           (SELECT COUNT(*) FROM eval_runs r WHERE r.set_id = s.id) AS run_count
         FROM eval_sets s ORDER BY s.id DESC`,
      )
      .all(),
  );

  app.get('/api/admin/eval/sets/:id/items', { preHandler: admin }, async (req) =>
    db.prepare('SELECT * FROM eval_items WHERE set_id = ? ORDER BY seq').all(idParam((req.params as { id: string }).id) ?? 0),
  );

  app.delete('/api/admin/eval/sets/:id', { preHandler: admin }, async (req, reply) => {
    if (isRunning()) return reply.code(409).send({ error: '평가가 실행 중입니다. 끝난 뒤 삭제하세요.' });
    const info = db.prepare('DELETE FROM eval_sets WHERE id = ?').run(idParam((req.params as { id: string }).id) ?? 0);
    if (!info.changes) return reply.code(404).send({ error: '평가 질문집을 찾을 수 없습니다.' });
    return { ok: true };
  });

  app.post('/api/admin/eval/sets/:id/runs', { preHandler: admin }, async (req, reply) => {
    const setId = idParam((req.params as { id: string }).id) ?? 0;
    if (!db.prepare('SELECT 1 FROM eval_sets WHERE id = ?').get(setId)) return reply.code(404).send({ error: '평가 질문집을 찾을 수 없습니다.' });
    if (isRunning()) return reply.code(409).send({ error: '이미 실행 중인 평가가 있습니다. 끝난 뒤 다시 실행하세요.' });
    const label = str(((req.body ?? {}) as Record<string, unknown>).label).slice(0, 100);
    const { runId, done } = startEvalRun(db, llm, kb, setId, label, req.user.id);
    done.catch((e) => req.log.error({ err: e }, '평가 실행 실패'));
    return parseRun(db.prepare(`${SELECT_RUN} WHERE r.id = ?`).get(runId) as RunRow);
  });

  app.get('/api/admin/eval/runs', { preHandler: admin }, async (req) => {
    const setId = idParam((req.query as Record<string, unknown>).set_id);
    const rows = (setId
      ? db.prepare(`${SELECT_RUN} WHERE r.set_id = ? ORDER BY r.id DESC`).all(setId)
      : db.prepare(`${SELECT_RUN} ORDER BY r.id DESC`).all()) as RunRow[];
    return rows.map(parseRun);
  });

  app.get('/api/admin/eval/runs/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const run = db.prepare(`${SELECT_RUN} WHERE r.id = ?`).get(id) as RunRow | undefined;
    if (!run) return reply.code(404).send({ error: '평가 실행을 찾을 수 없습니다.' });
    const results = db
      .prepare(
        `SELECT r.*, i.seq, i.question, i.business_type, i.expected_qa_ids, i.expected_type, i.note
         FROM eval_results r JOIN eval_items i ON i.id = r.item_id WHERE r.run_id = ? ORDER BY i.seq`,
      )
      .all(id) as Record<string, unknown>[];
    const parsed = parseRun(run);
    // 실행 중이면 지금까지의 점수를 계산해 보여준다
    if (run.status === 'running') parsed.summary = summarizeRun(db, id);
    return {
      run: parsed,
      results: results.map((r) => ({
        ...r,
        expected_qa_ids: JSON.parse(String(r.expected_qa_ids)),
        cited_qa_ids: JSON.parse(String(r.cited_qa_ids)),
        retrieved_qa_ids: JSON.parse(String(r.retrieved_qa_ids)),
      })),
    };
  });

  app.post('/api/admin/eval/runs/:id/cancel', { preHandler: admin }, async (req, reply) => {
    if (!cancelEvalRun(idParam((req.params as { id: string }).id) ?? 0)) return reply.code(400).send({ error: '실행 중인 평가가 아닙니다.' });
    return { ok: true };
  });

  app.delete('/api/admin/eval/runs/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const run = db.prepare('SELECT status FROM eval_runs WHERE id = ?').get(id) as { status: string } | undefined;
    if (!run) return reply.code(404).send({ error: '평가 실행을 찾을 수 없습니다.' });
    if (run.status === 'running') return reply.code(409).send({ error: '실행 중에는 삭제할 수 없습니다.' });
    db.prepare('DELETE FROM eval_runs WHERE id = ?').run(id);
    return { ok: true };
  });

  // 검수자 판정: 근거답변이 '적절' / '잘못된 결론'인지. 잘못된 결론이 1건이라도 있으면 통과하지 못한다
  app.patch('/api/admin/eval/results/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const verdict = b.verdict === 'ok' || b.verdict === 'wrong' ? b.verdict : null;
    const row = db.prepare('SELECT run_id FROM eval_results WHERE id = ?').get(id) as { run_id: number } | undefined;
    if (!row) return reply.code(404).send({ error: '결과를 찾을 수 없습니다.' });
    db.prepare('UPDATE eval_results SET verdict = ?, verdict_note = ? WHERE id = ?').run(verdict, str(b.note).slice(0, 500), id);
    const run = db.prepare('SELECT status FROM eval_runs WHERE id = ?').get(row.run_id) as { status: string };
    const summary = summarizeRun(db, row.run_id);
    if (run.status !== 'running') db.prepare('UPDATE eval_runs SET summary = ? WHERE id = ?').run(JSON.stringify(summary), row.run_id);
    return { ok: true, summary };
  });

  app.get('/api/admin/eval/runs/:id/export', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    if (!db.prepare('SELECT 1 FROM eval_runs WHERE id = ?').get(id)) return reply.code(404).send({ error: '평가 실행을 찾을 수 없습니다.' });
    return sendXlsx(reply, await buildRunWorkbook(db, id), `평가결과_${id}.xlsx`);
  });
}
