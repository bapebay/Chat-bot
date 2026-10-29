import type { FastifyInstance } from 'fastify';
import { requireRole } from '../auth.js';
import { answerQuestion, listMessages, titleFromQuestion } from '../chat.js';
import { BUSINESS_TYPES } from '../constants.js';
import type { DB } from '../db.js';
import type { KnowledgeBase } from '../knowledge/index.js';
import { maskPii } from '../knowledge/text.js';
import { LlmError, type LlmClient } from '../llm/index.js';
import { limitExceeded, userUsage } from '../usage.js';
import { idParam, str } from './util.js';

interface ConversationRow {
  id: number;
  user_id: number;
  title: string;
  business_type: string;
  created_at: string;
  updated_at: string;
}

const MAX_QUESTION_LENGTH = 3000;

export function conversationRoutes(app: FastifyInstance, db: DB, llm: LlmClient, kb: KnowledgeBase) {
  const loggedIn = requireRole(db, 'user');

  function ownConversation(userId: number, rawId: unknown): ConversationRow | undefined {
    const id = idParam(rawId);
    if (!id) return undefined;
    return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId) as
      | ConversationRow
      | undefined;
  }

  app.get('/api/conversations', { preHandler: loggedIn }, async (req) => {
    const q = str((req.query as Record<string, unknown>).q);
    if (!q) {
      return db
        .prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, id DESC')
        .all(req.user.id);
    }
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return db
      .prepare(
        `SELECT c.* FROM conversations c
         WHERE c.user_id = ? AND (c.title LIKE ? ESCAPE '\\' OR EXISTS (
           SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'))
         ORDER BY c.updated_at DESC, c.id DESC`,
      )
      .all(req.user.id, like, like);
  });

  app.post('/api/conversations', { preHandler: loggedIn }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const businessType = str(b.business_type) || req.user.business_type;
    if (!(BUSINESS_TYPES as readonly string[]).includes(businessType)) {
      return reply.code(400).send({ error: '사업 유형을 선택해 주세요.' });
    }
    const info = db
      .prepare('INSERT INTO conversations (user_id, business_type) VALUES (?, ?)')
      .run(req.user.id, businessType);
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
  });

  app.get('/api/conversations/:id', { preHandler: loggedIn }, async (req, reply) => {
    const conv = ownConversation(req.user.id, (req.params as { id: string }).id);
    if (!conv) return reply.code(404).send({ error: '대화를 찾을 수 없습니다.' });
    return { conversation: conv, messages: listMessages(db, conv.id) };
  });

  app.patch('/api/conversations/:id', { preHandler: loggedIn }, async (req, reply) => {
    const conv = ownConversation(req.user.id, (req.params as { id: string }).id);
    if (!conv) return reply.code(404).send({ error: '대화를 찾을 수 없습니다.' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const title = str(b.title);
    const businessType = str(b.business_type);
    if (title) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title.slice(0, 100), conv.id);
    if (businessType) {
      if (!(BUSINESS_TYPES as readonly string[]).includes(businessType)) {
        return reply.code(400).send({ error: '사업 유형이 올바르지 않습니다.' });
      }
      db.prepare('UPDATE conversations SET business_type = ? WHERE id = ?').run(businessType, conv.id);
    }
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id);
  });

  app.delete('/api/conversations/:id', { preHandler: loggedIn }, async (req, reply) => {
    const conv = ownConversation(req.user.id, (req.params as { id: string }).id);
    if (!conv) return reply.code(404).send({ error: '대화를 찾을 수 없습니다.' });
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    return { ok: true };
  });

  app.post('/api/conversations/:id/messages', { preHandler: loggedIn }, async (req, reply) => {
    const conv = ownConversation(req.user.id, (req.params as { id: string }).id);
    if (!conv) return reply.code(404).send({ error: '대화를 찾을 수 없습니다.' });
    const raw = str(((req.body ?? {}) as Record<string, unknown>).content);
    if (!raw) return reply.code(400).send({ error: '질문을 입력해 주세요.' });
    // 화면에서 한 번 경고하지만, 서버도 저장·모델 전송 전에 개인정보 패턴을 항상 가린다
    const question = maskPii(raw);
    const limitMsg = limitExceeded(db, req.user.id);
    if (limitMsg) return reply.code(429).send({ error: limitMsg, code: 'DAILY_LIMIT' });
    if (question.length > MAX_QUESTION_LENGTH) {
      return reply.code(400).send({ error: `질문은 ${MAX_QUESTION_LENGTH}자 이내로 입력해 주세요.` });
    }

    const isFirst = !db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1').get(conv.id);
    try {
      await answerQuestion(db, llm, kb, conv.id, conv.business_type, question);
    } catch (e) {
      req.log.error({ err: e }, 'AI 호출 실패');
      const detail = e instanceof LlmError ? e.message : 'AI 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.';
      return reply.code(502).send({ error: detail, code: 'LLM_FAILED' });
    }
    if (isFirst) {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(titleFromQuestion(question), conv.id);
    }
    return {
      conversation: db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id),
      messages: listMessages(db, conv.id),
      usage: userUsage(db, req.user.id),
    };
  });

  app.get('/api/usage', { preHandler: loggedIn }, async (req) => userUsage(db, req.user.id));
}
