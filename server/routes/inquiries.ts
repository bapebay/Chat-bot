import type { FastifyInstance } from 'fastify';
import { requireRole } from '../auth.js';
import { formatTranscript, listMessages } from '../chat.js';
import type { DB } from '../db.js';
import { idParam, str } from './util.js';

const SELECT_INQUIRY = `
  SELECT i.*, u.username, u.org_name, u.region, a.username AS answered_by_name
  FROM inquiries i
  JOIN users u ON u.id = i.user_id
  LEFT JOIN users a ON a.id = i.answered_by`;

export function inquiryRoutes(app: FastifyInstance, db: DB) {
  const loggedIn = requireRole(db, 'user');
  const reviewer = requireRole(db, 'reviewer');

  // 내 문의 목록
  app.get('/api/inquiries', { preHandler: loggedIn }, async (req) =>
    db.prepare(`${SELECT_INQUIRY} WHERE i.user_id = ? ORDER BY i.id DESC`).all(req.user.id),
  );

  app.post('/api/inquiries', { preHandler: loggedIn }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const content = str(b.content);
    if (!content) return reply.code(400).send({ error: '문의 내용을 입력해 주세요.' });
    if (content.length > 5000) return reply.code(400).send({ error: '문의 내용은 5,000자 이내로 입력해 주세요.' });

    let conversationId: number | null = null;
    let transcript: string | null = null;
    if (b.conversation_id != null) {
      conversationId = idParam(b.conversation_id);
      const conv = conversationId
        ? db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, req.user.id)
        : undefined;
      if (!conv) return reply.code(400).send({ error: '첨부할 대화를 찾을 수 없습니다.' });
      // 대화가 나중에 지워져도 문의 내용은 남도록 문의 시점의 기록을 복사해 둔다
      transcript = formatTranscript(listMessages(db, conversationId!));
    }
    const info = db
      .prepare('INSERT INTO inquiries (user_id, conversation_id, attached_transcript, content) VALUES (?, ?, ?, ?)')
      .run(req.user.id, conversationId, transcript, content);
    return db.prepare(`${SELECT_INQUIRY} WHERE i.id = ?`).get(info.lastInsertRowid);
  });

  // 검수자·관리자: 전체 문의
  app.get('/api/manage/inquiries', { preHandler: reviewer }, async (req) => {
    const status = str((req.query as Record<string, unknown>).status);
    if (status === 'pending' || status === 'answered') {
      return db.prepare(`${SELECT_INQUIRY} WHERE i.status = ? ORDER BY i.id DESC`).all(status);
    }
    return db.prepare(`${SELECT_INQUIRY} ORDER BY i.id DESC`).all();
  });

  app.post('/api/manage/inquiries/:id/answer', { preHandler: reviewer }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    const answer = str(((req.body ?? {}) as Record<string, unknown>).answer);
    if (!answer) return reply.code(400).send({ error: '답변 내용을 입력해 주세요.' });
    const info = db
      .prepare(
        `UPDATE inquiries SET answer = ?, answered_by = ?, status = 'answered', answered_at = datetime('now') WHERE id = ?`,
      )
      .run(answer, req.user.id, id);
    if (!info.changes) return reply.code(404).send({ error: '문의를 찾을 수 없습니다.' });
    return db.prepare(`${SELECT_INQUIRY} WHERE i.id = ?`).get(id);
  });
}
