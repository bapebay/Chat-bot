import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireRole } from '../auth.js';
import { stripDisclaimer } from '../chat.js';
import type { DB } from '../db.js';
import { getNumberSetting } from '../settings.js';
import { idParam, str } from './util.js';

// SQLite UTC 시각 → 한국 날짜
const KST_DATE = `date(datetime(m.created_at, '+9 hours'))`;

export function adminOpsRoutes(app: FastifyInstance, db: DB) {
  const loggedIn = requireRole(db, 'user');
  const admin = requireRole(db, 'admin');

  // ================= 사용량·비용 =================
  app.get('/api/admin/stats', { preHandler: admin }, async (req) => {
    const days = Math.min(365, Math.max(1, Number((req.query as Record<string, unknown>).days) || 30));
    const since = `-${days} days`;
    const priceIn = getNumberSetting(db, 'price_input_per_mtok');
    const priceOut = getNumberSetting(db, 'price_output_per_mtok');
    const krw = getNumberSetting(db, 'usd_krw');
    const cost = (inp: number, out: number) => ((inp * priceIn + out * priceOut) / 1_000_000) * krw;

    const daily = (
      db
        .prepare(
          `SELECT ${KST_DATE} AS date,
             SUM(m.role = 'user') AS questions,
             COALESCE(SUM(m.input_tokens), 0) AS input_tokens,
             COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
             SUM(m.role = 'assistant' AND m.provider IS NOT NULL) AS llm_calls
           FROM messages m WHERE m.created_at >= datetime('now', ?) GROUP BY 1 ORDER BY 1`,
        )
        .all(since) as { date: string; questions: number; input_tokens: number; output_tokens: number; llm_calls: number }[]
    ).map((d) => ({ ...d, cost_krw: Math.round(cost(d.input_tokens, d.output_tokens)) }));

    const byOrg = db
      .prepare(
        `SELECT u.org_type, u.org_name, u.region, COUNT(*) AS questions, COUNT(DISTINCT u.id) AS users
         FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN users u ON u.id = c.user_id
         WHERE m.role = 'user' AND m.created_at >= datetime('now', ?)
         GROUP BY u.org_type, u.org_name, u.region ORDER BY questions DESC LIMIT 50`,
      )
      .all(since);

    const types = db
      .prepare(
        `SELECT m.answer_type AS type, COUNT(*) AS n FROM messages m
         WHERE m.role = 'assistant' AND m.answer_type IS NOT NULL AND m.created_at >= datetime('now', ?) GROUP BY 1`,
      )
      .all(since) as { type: string; n: number }[];

    const fb = db
      .prepare(
        `SELECT f.rating, f.reason, COUNT(*) AS n FROM feedback f JOIN messages m ON m.id = f.message_id
         WHERE m.created_at >= datetime('now', ?) GROUP BY 1, 2`,
      )
      .all(since) as { rating: string; reason: string | null; n: number }[];

    const totals = daily.reduce(
      (t, d) => ({
        questions: t.questions + d.questions,
        llm_calls: t.llm_calls + d.llm_calls,
        input_tokens: t.input_tokens + d.input_tokens,
        output_tokens: t.output_tokens + d.output_tokens,
        cost_krw: t.cost_krw + d.cost_krw,
      }),
      { questions: 0, llm_calls: 0, input_tokens: 0, output_tokens: 0, cost_krw: 0 },
    );
    const latency = db
      .prepare(`SELECT AVG(latency_ms) AS v FROM messages m WHERE m.role = 'assistant' AND m.provider IS NOT NULL AND m.created_at >= datetime('now', ?)`)
      .get(since) as { v: number | null };

    return {
      days,
      prices: { input_per_mtok: priceIn, output_per_mtok: priceOut, usd_krw: krw },
      totals: { ...totals, avg_latency_ms: latency.v === null ? null : Math.round(latency.v) },
      daily,
      by_org: byOrg,
      answer_types: Object.fromEntries(types.map((t) => [t.type, t.n])),
      feedback: {
        good: fb.filter((f) => f.rating === 'good').reduce((s, f) => s + f.n, 0),
        bad: fb.filter((f) => f.rating === 'bad').reduce((s, f) => s + f.n, 0),
        bad_reasons: Object.fromEntries(fb.filter((f) => f.rating === 'bad').map((f) => [f.reason ?? '사유 없음', f.n])),
      },
    };
  });

  // ================= 답변 모아보기 (Bad 평가·연결형·근거 없음 등) =================
  app.get('/api/admin/answers', { preHandler: admin }, async (req) => {
    const filter = str((req.query as Record<string, unknown>).filter);
    const cond =
      filter === 'bad'
        ? `EXISTS (SELECT 1 FROM feedback f WHERE f.message_id = m.id AND f.rating = 'bad')`
        : filter === 'referral'
          ? `m.answer_type = '연결형'`
          : filter === 'no_evidence'
            ? `m.answer_type = '근거없음'`
            : filter === 'out_of_scope'
              ? `m.answer_type = '답변범위외'`
              : filter === 'security'
                ? `m.citations LIKE '%"security":%'`
                : '1 = 1';
    const rows = db
      .prepare(
        `SELECT m.id, m.conversation_id, m.answer_type, m.content, m.created_at, u.username, u.org_name,
           (SELECT q.content FROM messages q WHERE q.conversation_id = m.conversation_id AND q.role = 'user' AND q.id < m.id
            ORDER BY q.id DESC LIMIT 1) AS question,
           (SELECT f.reason || CASE WHEN f.comment != '' THEN ' - ' || f.comment ELSE '' END FROM feedback f
            WHERE f.message_id = m.id AND f.rating = 'bad' LIMIT 1) AS bad_reason
         FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN users u ON u.id = c.user_id
         WHERE m.role = 'assistant' AND ${cond} ORDER BY m.id DESC LIMIT 200`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({ ...r, content: stripDisclaimer(String(r.content)) }));
  });

  // ================= 공지 =================
  app.get('/api/notices', { preHandler: loggedIn }, async () =>
    db.prepare('SELECT id, title, body, created_at FROM notices WHERE active = 1 ORDER BY id DESC LIMIT 3').all(),
  );

  app.get('/api/admin/notices', { preHandler: admin }, async () => db.prepare('SELECT * FROM notices ORDER BY id DESC').all());

  app.post('/api/admin/notices', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const title = str(b.title).slice(0, 200);
    if (!title) return reply.code(400).send({ error: '공지 제목을 입력해 주세요.' });
    const id = Number(db.prepare('INSERT INTO notices (title, body, created_by) VALUES (?, ?, ?)').run(title, str(b.body).slice(0, 5000), req.user.id).lastInsertRowid);

    // 개정으로 영향을 받는 표준답안을 '재검수 필요'로 표시 (통합번호 목록 또는 중분류)
    const ids = str(b.recheck_qa_ids)
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const category = str(b.recheck_category);
    let marked = 0;
    const active = db.prepare(`SELECT id FROM qa_versions WHERE status = 'active'`).get() as { id: number } | undefined;
    if (active && (ids.length || category)) {
      const count = () =>
        (db.prepare('SELECT COUNT(*) AS n FROM qa_items WHERE version_id = ? AND needs_recheck = 1').get(active.id) as { n: number }).n;
      const before = count();
      db.transaction(() => {
        const byId = db.prepare('UPDATE qa_items SET needs_recheck = 1 WHERE version_id = ? AND qa_id = ?');
        for (const qa of ids) byId.run(active.id, qa);
        if (category) db.prepare('UPDATE qa_items SET needs_recheck = 1 WHERE version_id = ? AND category2 = ?').run(active.id, category);
      })();
      marked = count() - before;
    }
    audit(db, req.user, '공지 등록', title, marked ? `재검수 필요 표시 ${marked}건` : '');
    return { id, marked };
  });

  app.patch('/api/admin/notices/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const active = ((req.body ?? {}) as Record<string, unknown>).active ? 1 : 0;
    if (!db.prepare('UPDATE notices SET active = ? WHERE id = ?').run(active, id).changes) return reply.code(404).send({ error: '공지를 찾을 수 없습니다.' });
    audit(db, req.user, active ? '공지 게시' : '공지 내림', `#${id}`);
    return { ok: true };
  });

  app.delete('/api/admin/notices/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    if (!db.prepare('DELETE FROM notices WHERE id = ?').run(id).changes) return reply.code(404).send({ error: '공지를 찾을 수 없습니다.' });
    audit(db, req.user, '공지 삭제', `#${id}`);
    return { ok: true };
  });

  // ================= 감사 로그 =================
  app.get('/api/admin/audit', { preHandler: admin }, async (req) => {
    const q = str((req.query as Record<string, unknown>).q);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return db
      .prepare(
        `SELECT * FROM audit_logs WHERE (? = '' OR action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\')
         ORDER BY id DESC LIMIT 300`,
      )
      .all(q, like, like, like);
  });
}
