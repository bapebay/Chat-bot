import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
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

  // 내 문의 목록. 목록을 열면 새 답변은 읽은 것으로 바꾼다 (이번 응답의 user_unread 로 '새 답변' 표시)
  app.get('/api/inquiries', { preHandler: loggedIn }, async (req) => {
    const rows = db.prepare(`${SELECT_INQUIRY} WHERE i.user_id = ? ORDER BY i.id DESC`).all(req.user.id);
    db.prepare('UPDATE inquiries SET user_unread = 0 WHERE user_id = ? AND user_unread = 1').run(req.user.id);
    return rows;
  });

  // 아직 확인하지 않은 답변 수 (상단 '1:1 문의' 배지)
  app.get('/api/inquiries/unread', { preHandler: loggedIn }, async (req) => ({
    count: (db.prepare('SELECT COUNT(*) AS n FROM inquiries WHERE user_id = ? AND user_unread = 1').get(req.user.id) as { n: number }).n,
  }));

  app.post('/api/inquiries', { preHandler: loggedIn }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const content = str(b.content);
    if (!content) return reply.code(400).send({ error: '문의 내용을 입력해 주세요.' });
    if (content.length > 5000) return reply.code(400).send({ error: '문의 내용은 5,000자 이내로 입력해 주세요.' });

    // 1:1 문의는 챗봇에 먼저 물어본 뒤 그 대화에서만 남길 수 있다 (챗봇을 거치지 않은 바로 문의 방지)
    const conversationId = idParam(b.conversation_id);
    const conv = conversationId
      ? db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, req.user.id)
      : undefined;
    if (!conv) return reply.code(400).send({ error: '첨부할 대화를 찾을 수 없습니다.', code: 'CHAT_FIRST' });
    const answered = db.prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'assistant' LIMIT 1`).get(conversationId);
    if (!answered) {
      return reply.code(400).send({ error: "재단 문의는 챗봇에 먼저 질문한 뒤, 답변 아래 '재단에 문의하기'로 남길 수 있습니다.", code: 'CHAT_FIRST' });
    }
    // 대화가 나중에 지워져도 문의 내용은 남도록 문의 시점의 기록을 복사해 둔다
    const transcript = formatTranscript(listMessages(db, conversationId!));
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
        `UPDATE inquiries SET answer = ?, answered_by = ?, status = 'answered', answered_at = datetime('now'), user_unread = 1 WHERE id = ?`,
      )
      .run(answer, req.user.id, id);
    if (!info.changes) return reply.code(404).send({ error: '문의를 찾을 수 없습니다.' });
    return db.prepare(`${SELECT_INQUIRY} WHERE i.id = ?`).get(id);
  });

  // 문의 답변을 표준답안으로 등록했다고 표시 (표준답안 저장은 /api/review/qa 가 한다)
  app.post('/api/manage/inquiries/:id/qa', { preHandler: reviewer }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    const qaId = str(((req.body ?? {}) as Record<string, unknown>).qa_id);
    if (!qaId) return reply.code(400).send({ error: '통합번호가 없습니다.' });
    const info = db.prepare('UPDATE inquiries SET qa_id = ? WHERE id = ?').run(qaId, id);
    if (!info.changes) return reply.code(404).send({ error: '문의를 찾을 수 없습니다.' });
    audit(db, req.user, '문의 답변을 표준답안으로 등록', `문의 #${id}`, qaId);
    return db.prepare(`${SELECT_INQUIRY} WHERE i.id = ?`).get(id);
  });
}
