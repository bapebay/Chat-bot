import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireRole } from '../auth.js';
import { stripDisclaimer } from '../chat.js';
import type { DB } from '../db.js';
import { isConfirmed, type KnowledgeBase } from '../knowledge/index.js';
import { getSetting } from '../settings.js';
import { idParam, str } from './util.js';

export const FEEDBACK_REASONS = ['틀린 내용', '답이 부족', '근거가 엉뚱함', '연결이 부적절'] as const;

const QA_FIELDS = ['qa_id', 'category1', 'category2', 'category3', 'question', 'checklist', 'answer', 'referral_answer', 'review_status', 'change_history'] as const;

interface QaRow {
  id: number;
  version_id: number;
  qa_id: string;
  category1: string;
  category2: string;
  category3: string;
  question: string;
  checklist: string;
  answer: string;
  referral_answer: string;
  is_referral: number;
  review_status: string;
  change_history: string;
  needs_recheck: number;
}

/** 이 대화에서 내가 남긴 평가 */
export function feedbackFor(db: DB, conversationId: number, userId: number) {
  return db
    .prepare(
      `SELECT f.message_id, f.rating, f.reason, f.comment FROM feedback f JOIN messages m ON m.id = f.message_id
       WHERE m.conversation_id = ? AND f.user_id = ?`,
    )
    .all(conversationId, userId);
}

function activeVersionId(db: DB): number | null {
  const row = db.prepare(`SELECT id FROM qa_versions WHERE status = 'active'`).get() as { id: number } | undefined;
  return row?.id ?? null;
}

export function operationsRoutes(app: FastifyInstance, db: DB, kb: KnowledgeBase) {
  const loggedIn = requireRole(db, 'user');
  const admin = requireRole(db, 'admin');

  // ================= 답변 평가 (Good / Bad) =================
  app.put('/api/messages/:id/feedback', { preHandler: loggedIn }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const msg = db
      .prepare(
        `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = ? AND m.role = 'assistant' AND c.user_id = ?`,
      )
      .get(id, req.user.id);
    if (!msg) return reply.code(404).send({ error: '답변을 찾을 수 없습니다.' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const rating = b.rating === 'good' || b.rating === 'bad' ? b.rating : null;
    if (!rating) return reply.code(400).send({ error: '평가를 선택해 주세요.' });
    const reason = rating === 'bad' && (FEEDBACK_REASONS as readonly string[]).includes(str(b.reason)) ? str(b.reason) : null;
    const comment = str(b.comment).slice(0, 1000);

    db.transaction(() => {
      db.prepare(
        `INSERT INTO feedback (message_id, user_id, rating, reason, comment) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id, user_id) DO UPDATE SET rating = excluded.rating, reason = excluded.reason,
           comment = excluded.comment, created_at = datetime('now')`,
      ).run(id, req.user.id, rating, reason, comment);
      if (rating === 'bad') {
        // Bad 평가는 검토 대기함으로 (이미 처리된 항목이면 다시 대기로)
        db.prepare(
          `INSERT INTO review_queue (message_id, source) VALUES (?, 'bad')
           ON CONFLICT(message_id) DO UPDATE SET source = 'bad', status = 'pending', resolution = NULL, resolved_at = NULL`,
        ).run(id);
      } else {
        db.prepare(`DELETE FROM review_queue WHERE message_id = ? AND source = 'bad' AND status = 'pending'`).run(id);
      }
    })();
    return { ok: true };
  });

  // ================= 검토 대기함 =================
  app.get('/api/review/queue', { preHandler: admin }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const status = str(q.status) === 'done' ? 'done' : 'pending';
    const rows = db
      .prepare(
        `SELECT rq.*, m.content AS answer, m.answer_type, m.citations, m.created_at AS answered_at, m.conversation_id,
           c.business_type, u.username, u.org_name, u.region, r.username AS resolved_by_name,
           (SELECT q.content FROM messages q WHERE q.conversation_id = m.conversation_id AND q.role = 'user' AND q.id < m.id
            ORDER BY q.id DESC LIMIT 1) AS question
         FROM review_queue rq
         JOIN messages m ON m.id = rq.message_id
         JOIN conversations c ON c.id = m.conversation_id
         JOIN users u ON u.id = c.user_id
         LEFT JOIN users r ON r.id = rq.resolved_by
         WHERE ${status === 'pending' ? `rq.status = 'pending'` : `rq.status != 'pending'`}
         ORDER BY rq.id DESC LIMIT 300`,
      )
      .all() as Record<string, unknown>[];
    const fb = db.prepare(`SELECT rating, reason, comment FROM feedback WHERE message_id = ? AND rating = 'bad'`);
    return rows.map((r) => {
      const cit = r.citations ? JSON.parse(String(r.citations)) : null;
      return {
        ...r,
        answer: stripDisclaimer(String(r.answer)),
        citations: undefined,
        cited_qa_ids: cit?.qa?.map((x: { qa_id: string }) => x.qa_id) ?? [],
        retrieved_qa_ids: cit?.retrieved?.qa?.map((x: { qa_id: string }) => x.qa_id) ?? [],
        feedback: fb.all(r.message_id),
      };
    });
  });

  app.post('/api/review/queue/:id/resolve', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const action = str(b.action);
    if (!['edited', 'added', 'ignored'].includes(action)) return reply.code(400).send({ error: '처리 방법을 선택해 주세요.' });
    const info = db
      .prepare(
        `UPDATE review_queue SET status = ?, resolution = ?, qa_id = ?, note = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`,
      )
      .run(action === 'ignored' ? 'ignored' : 'resolved', action, str(b.qa_id) || null, str(b.note).slice(0, 500), req.user.id, id);
    if (!info.changes) return reply.code(404).send({ error: '항목을 찾을 수 없습니다.' });
    return { ok: true };
  });

  // ================= 표준답안 편집기 (서비스 중인 버전을 직접 수정) =================
  app.get('/api/review/qa', { preHandler: admin }, async (req) => {
    const vid = activeVersionId(db);
    if (!vid) return { version_id: null, items: [] };
    const q = req.query as Record<string, unknown>;
    const text = str(q.q);
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const where = ['version_id = ?'];
    const params: unknown[] = [vid];
    if (text) {
      where.push(`(qa_id LIKE ? ESCAPE '\\' OR question LIKE ? ESCAPE '\\' OR checklist LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like);
    }
    if (str(q.category1)) {
      where.push('category1 = ?');
      params.push(str(q.category1));
    }
    if (str(q.category2)) {
      where.push('category2 = ?');
      params.push(str(q.category2));
    }
    if (str(q.review_status)) {
      where.push('review_status = ?');
      params.push(str(q.review_status));
    }
    if (q.recheck === '1') where.push('needs_recheck = 1');
    const items = db.prepare(`SELECT * FROM qa_items WHERE ${where.join(' AND ')} ORDER BY id LIMIT 300`).all(...params);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM qa_items WHERE ${where.join(' AND ')}`).get(...params) as { n: number }).n;
    return { version_id: vid, total, items };
  });

  app.get('/api/review/qa/facets', { preHandler: admin }, async () => {
    const vid = activeVersionId(db) ?? 0;
    const distinct = (col: string) =>
      (db.prepare(`SELECT DISTINCT ${col} AS v FROM qa_items WHERE version_id = ? AND ${col} != '' ORDER BY ${col}`).all(vid) as { v: string }[]).map((r) => r.v);
    return { category1: distinct('category1'), category2: distinct('category2'), review_status: distinct('review_status') };
  });

  app.get('/api/review/qa/:qaId/revisions', { preHandler: admin }, async (req) =>
    db
      .prepare(
        `SELECT r.id, r.before_json, r.after_json, r.reason, r.created_at, u.username AS changed_by
         FROM qa_revisions r LEFT JOIN users u ON u.id = r.changed_by WHERE r.qa_id = ? ORDER BY r.id DESC LIMIT 50`,
      )
      .all((req.params as { qaId: string }).qaId),
  );

  function readQaBody(b: Record<string, unknown>) {
    const v = Object.fromEntries(QA_FIELDS.map((f) => [f, str(b[f])])) as Record<(typeof QA_FIELDS)[number], string>;
    if (!v.qa_id || !v.question || !v.answer) return { error: '통합번호·대표 질의·통합 답안은 비울 수 없습니다.' };
    return { value: { ...v, is_referral: b.is_referral ? 1 : 0 } };
  }

  const snapshot = (r: Partial<QaRow>) =>
    JSON.stringify(Object.fromEntries([...QA_FIELDS, 'is_referral'].map((f) => [f, (r as Record<string, unknown>)[f]])));

  app.put('/api/review/qa/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const vid = activeVersionId(db);
    const before = db.prepare('SELECT * FROM qa_items WHERE id = ? AND version_id = ?').get(id, vid) as QaRow | undefined;
    if (!before) return reply.code(404).send({ error: '서비스 중인 버전의 표준답안이 아닙니다.' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const v = readQaBody(b);
    if (!v.value) return reply.code(400).send({ error: v.error });
    const dup = db.prepare('SELECT 1 FROM qa_items WHERE version_id = ? AND qa_id = ? AND id != ?').get(vid, v.value.qa_id, id);
    if (dup) return reply.code(409).send({ error: `통합번호 ${v.value.qa_id}가 이미 있습니다.` });
    const c = v.value;
    db.transaction(() => {
      db.prepare(
        `UPDATE qa_items SET qa_id = ?, category1 = ?, category2 = ?, category3 = ?, question = ?, checklist = ?, answer = ?,
           referral_answer = ?, is_referral = ?, review_status = ?, change_history = ?, needs_recheck = 0 WHERE id = ?`,
      ).run(c.qa_id, c.category1, c.category2, c.category3, c.question, c.checklist, c.answer, c.referral_answer, c.is_referral, c.review_status, c.change_history, id);
      db.prepare('INSERT INTO qa_revisions (qa_id, version_id, before_json, after_json, reason, changed_by) VALUES (?, ?, ?, ?, ?, ?)').run(
        c.qa_id,
        vid,
        snapshot(before),
        snapshot(c),
        str(b.reason).slice(0, 500),
        req.user.id,
      );
    })();
    audit(db, req.user, '표준답안 수정', c.qa_id, str(b.reason));
    kb.rebuild();
    return db.prepare('SELECT * FROM qa_items WHERE id = ?').get(id);
  });

  app.post('/api/review/qa', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const v = readQaBody(b);
    if (!v.value) return reply.code(400).send({ error: v.error });
    let vid = activeVersionId(db);
    if (!vid) {
      // 아직 올린 엑셀이 없으면 화면에서 쓰는 버전을 하나 만든다
      vid = Number(
        db.prepare(`INSERT INTO qa_versions (filename, uploaded_by, status, activated_at) VALUES ('(화면에서 직접 작성)', ?, 'active', datetime('now'))`).run(req.user.id)
          .lastInsertRowid,
      );
    }
    if (db.prepare('SELECT 1 FROM qa_items WHERE version_id = ? AND qa_id = ?').get(vid, v.value.qa_id)) {
      return reply.code(409).send({ error: `통합번호 ${v.value.qa_id}가 이미 있습니다.` });
    }
    const c = v.value;
    const info = db
      .prepare(
        `INSERT INTO qa_items (version_id, qa_id, category1, category2, category3, question, checklist, answer, referral_answer,
           is_referral, review_status, change_history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(vid, c.qa_id, c.category1, c.category2, c.category3, c.question, c.checklist, c.answer, c.referral_answer, c.is_referral, c.review_status, c.change_history);
    db.prepare('UPDATE qa_versions SET item_count = item_count + 1 WHERE id = ?').run(vid);
    db.prepare('INSERT INTO qa_revisions (qa_id, version_id, before_json, after_json, reason, changed_by) VALUES (?, ?, NULL, ?, ?, ?)').run(
      c.qa_id,
      vid,
      snapshot(c),
      str(b.reason).slice(0, 500) || '새 표준답안 추가',
      req.user.id,
    );
    audit(db, req.user, '표준답안 추가', c.qa_id, str(b.reason));
    kb.rebuild();
    return db.prepare('SELECT * FROM qa_items WHERE id = ?').get(info.lastInsertRowid);
  });

  app.delete('/api/review/qa/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const vid = activeVersionId(db);
    const before = db.prepare('SELECT * FROM qa_items WHERE id = ? AND version_id = ?').get(id, vid) as QaRow | undefined;
    if (!before) return reply.code(404).send({ error: '서비스 중인 버전의 표준답안이 아닙니다.' });
    const reason = str(((req.body ?? {}) as Record<string, unknown>).reason);
    db.transaction(() => {
      db.prepare('DELETE FROM qa_items WHERE id = ?').run(id);
      db.prepare('UPDATE qa_versions SET item_count = item_count - 1 WHERE id = ?').run(vid);
      db.prepare('INSERT INTO qa_revisions (qa_id, version_id, before_json, after_json, reason, changed_by) VALUES (?, ?, ?, NULL, ?, ?)').run(
        before.qa_id,
        vid,
        snapshot(before),
        reason || '삭제',
        req.user.id,
      );
    })();
    audit(db, req.user, '표준답안 삭제', before.qa_id, reason);
    kb.rebuild();
    return { ok: true };
  });
}
