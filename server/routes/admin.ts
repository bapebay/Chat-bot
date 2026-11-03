import type { FastifyInstance } from 'fastify';
import { accountProblem, buildAccountsTemplate, createAccount, parseAccountsWorkbook, type AccountInput } from '../accounts.js';
import { audit } from '../audit.js';
import {
  deleteUserSessions,
  generateTempPassword,
  hashPassword,
  requireRole,
  toPublicUser,
  type UserRow,
} from '../auth.js';
import { listMessages } from '../chat.js';
import { OUTPUT_INSTRUCTIONS, SECURITY_RULES } from '../defaults.js';
import { guardCheck } from '../knowledge/guard.js';
import { config } from '../config.js';
import { ROLES, type Role } from '../constants.js';
import type { DB } from '../db.js';
import type { KnowledgeBase } from '../knowledge/index.js';
import type { LlmClient } from '../llm/index.js';
import { getRevision, getSetting, isSettingKey, listRevisions, setSetting, settingProblem } from '../settings.js';
import { readUpload, sendXlsx } from './knowledge.js';
import { idParam, str } from './util.js';

export function adminRoutes(app: FastifyInstance, db: DB, llm: LlmClient, knowledge: KnowledgeBase) {
  const admin = requireRole(db, 'admin');

  // 검색 대상이 바뀌는 설정이면 색인을 다시 만든다
  function onKnowledgeChanged(key: string) {
    if (key === 'include_unreviewed') knowledge.rebuild();
  }

  function findUser(rawId: unknown): UserRow | undefined {
    const id = idParam(rawId);
    return id ? (db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) : undefined;
  }

  function otherAdminCount(excludeId: number): number {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'approved' AND id != ?`).get(excludeId) as {
        n: number;
      }
    ).n;
  }

  // ----- 사용자·권한 -----
  app.get('/api/admin/users', { preHandler: admin }, async () => {
    const rows = db.prepare('SELECT * FROM users ORDER BY status DESC, id DESC').all() as UserRow[];
    return rows.map(toPublicUser);
  });

  app.post('/api/admin/users', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const input: AccountInput = {
      username: str(b.username),
      role: str(b.role),
      org_type: str(b.org_type),
      org_name: str(b.org_name),
      region: str(b.region),
      business_type: str(b.business_type) || '모름',
    };
    const problem = accountProblem(db, input);
    if (problem) return reply.code(problem.startsWith('이미') ? 409 : 400).send({ error: problem });
    const tempPassword = await createAccount(db, input);
    audit(db, req.user, '계정 생성', input.username, `권한 ${input.role}`);
    return { ok: true, temp_password: tempPassword };
  });

  // ----- 계정 일괄 등록 (엑셀) -----
  app.get('/api/admin/users/template', { preHandler: admin }, async (_req, reply) =>
    sendXlsx(reply, await buildAccountsTemplate(), '계정_일괄등록_양식.xlsx'),
  );

  app.post('/api/admin/users/bulk', { preHandler: admin }, async (req, reply) => {
    const up = await readUpload(req, reply, /\.xlsx$/i);
    if (!up) return reply;
    let rows: Awaited<ReturnType<typeof parseAccountsWorkbook>>;
    try {
      rows = await parseAccountsWorkbook(up.buffer);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    if (!rows.length) return reply.code(400).send({ error: '등록할 계정이 없습니다. 예시 행 아래에 계정을 적어 주세요.' });
    const seen = new Set<string>();
    const results: { row: number; username: string; org_name: string; role: string; temp_password: string | null; error: string | null }[] = [];
    for (const { row, input } of rows) {
      const problem = seen.has(input.username) ? '파일 안에 같은 아이디가 또 있습니다.' : accountProblem(db, input);
      seen.add(input.username);
      const tempPassword = problem ? null : await createAccount(db, input);
      results.push({ row, username: input.username, org_name: input.org_name, role: input.role, temp_password: tempPassword, error: problem });
    }
    const created = results.filter((r) => r.temp_password).length;
    audit(db, req.user, '계정 일괄 등록', up.filename, `${created}명 등록, ${results.length - created}명 실패`);
    return { created, failed: results.length - created, results };
  });

  app.post('/api/admin/users/:id/approve', { preHandler: admin }, async (req, reply) => {
    const user = findUser((req.params as { id: string }).id);
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다.' });
    db.prepare(`UPDATE users SET status = 'approved' WHERE id = ?`).run(user.id);
    audit(db, req.user, '가입 승인', user.username);
    return { ok: true };
  });

  app.patch('/api/admin/users/:id', { preHandler: admin }, async (req, reply) => {
    const user = findUser((req.params as { id: string }).id);
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다.' });
    const role = str(((req.body ?? {}) as Record<string, unknown>).role) as Role;
    if (!ROLES.includes(role)) return reply.code(400).send({ error: '권한 값이 올바르지 않습니다.' });
    if (user.role === 'admin' && role !== 'admin' && otherAdminCount(user.id) === 0) {
      return reply.code(400).send({ error: '마지막 관리자의 권한은 바꿀 수 없습니다.' });
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
    audit(db, req.user, '권한 변경', user.username, `${user.role} → ${role}`);
    return { ok: true };
  });

  app.post('/api/admin/users/:id/reset-password', { preHandler: admin }, async (req, reply) => {
    const user = findUser((req.params as { id: string }).id);
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다.' });
    const tempPassword = generateTempPassword();
    db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 1, locked = 0, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    ).run(hashPassword(tempPassword), user.id);
    deleteUserSessions(db, user.id);
    audit(db, req.user, '비밀번호 초기화', user.username);
    return { ok: true, temp_password: tempPassword };
  });

  app.delete('/api/admin/users/:id', { preHandler: admin }, async (req, reply) => {
    const user = findUser((req.params as { id: string }).id);
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다.' });
    if (user.id === req.user.id) return reply.code(400).send({ error: '자기 자신은 삭제할 수 없습니다.' });
    if (user.role === 'admin' && otherAdminCount(user.id) === 0) {
      return reply.code(400).send({ error: '마지막 관리자는 삭제할 수 없습니다.' });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    audit(db, req.user, user.status === 'pending' ? '가입 거절' : '계정 삭제', user.username);
    return { ok: true };
  });

  // ----- 대화 열람 (읽기 전용) -----
  app.get('/api/admin/users/:id/conversations', { preHandler: admin }, async (req, reply) => {
    const user = findUser((req.params as { id: string }).id);
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다.' });
    return db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC, c.id DESC`,
      )
      .all(user.id);
  });

  app.get('/api/admin/conversations/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    const conv = id ? db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) : undefined;
    if (!conv) return reply.code(404).send({ error: '대화를 찾을 수 없습니다.' });
    // 다른 사람의 대화를 본 기록을 남긴다 (내부자 열람 추적)
    audit(db, req.user, '대화 열람', `대화 #${id}`);
    return { conversation: conv, messages: listMessages(db, id!) };
  });

  // ----- 프롬프트·면책 문구 (변경 이력과 되돌리기) -----
  app.get('/api/admin/settings/:key', { preHandler: admin }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    if (!isSettingKey(key)) return reply.code(404).send({ error: '알 수 없는 설정입니다.' });
    return { value: getSetting(db, key), revisions: listRevisions(db, key) };
  });

  app.put('/api/admin/settings/:key', { preHandler: admin }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    if (!isSettingKey(key)) return reply.code(404).send({ error: '알 수 없는 설정입니다.' });
    const value = str(((req.body ?? {}) as Record<string, unknown>).value);
    const problem = settingProblem(key, value);
    if (problem) return reply.code(400).send({ error: problem });
    setSetting(db, key, value, req.user.id);
    audit(db, req.user, '설정 변경', key, value.length > 80 ? `${value.slice(0, 80)}…` : value);
    onKnowledgeChanged(key);
    return { value, revisions: listRevisions(db, key) };
  });

  app.post('/api/admin/settings/:key/revert', { preHandler: admin }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    if (!isSettingKey(key)) return reply.code(404).send({ error: '알 수 없는 설정입니다.' });
    const revId = idParam(((req.body ?? {}) as Record<string, unknown>).revision_id);
    const rev = revId ? getRevision(db, key, revId) : undefined;
    if (!rev) return reply.code(404).send({ error: '해당 이력을 찾을 수 없습니다.' });
    setSetting(db, key, rev.value, req.user.id);
    audit(db, req.user, '설정 되돌리기', key, `이력 #${revId}`);
    onKnowledgeChanged(key);
    return { value: rev.value, revisions: listRevisions(db, key) };
  });

  // ----- 보안 차단 점검: 표준답안 전체로 잘못된 차단이 생기는지 AI 호출 없이 미리 본다 -----
  app.post('/api/admin/prompt/guard-check', { preHandler: admin }, async (req) => {
    const draft = str(((req.body ?? {}) as Record<string, unknown>).system_prompt);
    const prompt = draft || getSetting(db, 'system_prompt');
    const items = db
      .prepare(`SELECT i.qa_id, i.question, i.answer FROM qa_items i JOIN qa_versions v ON v.id = i.version_id WHERE v.status = 'active' ORDER BY i.id`)
      .all() as { qa_id: string; question: string; answer: string }[];
    const check = guardCheck(items, [SECURITY_RULES, OUTPUT_INSTRUCTIONS].join('\n'), prompt);
    // 실제로 막힌 답변 (최근 30일, 사유별)
    const recent = db
      .prepare(
        `SELECT json_extract(citations, '$.security') AS reason, COUNT(*) AS n FROM messages
         WHERE role = 'assistant' AND json_valid(citations) AND json_extract(citations, '$.security') IS NOT NULL
           AND created_at >= datetime('now', '-30 days') GROUP BY 1 ORDER BY 2 DESC`,
      )
      .all() as { reason: string; n: number }[];
    const answers = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND created_at >= datetime('now', '-30 days')`).get() as { n: number }).n;
    return {
      draft: !!draft,
      total: check.total,
      question_blocked: check.question_blocked.slice(0, 50),
      question_blocked_count: check.question_blocked.length,
      answer_blocked: check.answer_blocked.slice(0, 50),
      answer_blocked_count: check.answer_blocked.length,
      recent: { answers, blocked: recent },
    };
  });

  // ----- 시스템 정보 -----
  app.get('/api/admin/system', { preHandler: admin }, async () => {
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      llm: { provider: llm.provider, model: llm.model, history_messages: config.llm.historyMessages },
      counts: {
        users: count('SELECT COUNT(*) AS n FROM users'),
        pending_users: count(`SELECT COUNT(*) AS n FROM users WHERE status = 'pending'`),
        conversations: count('SELECT COUNT(*) AS n FROM conversations'),
        questions: count(`SELECT COUNT(*) AS n FROM messages WHERE role = 'user'`),
        pending_inquiries: count(`SELECT COUNT(*) AS n FROM inquiries WHERE status = 'pending'`),
      },
    };
  });
}
