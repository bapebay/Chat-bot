import type { FastifyInstance } from 'fastify';
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
import { config } from '../config.js';
import { BUSINESS_TYPES, ORG_TYPES, REGIONS, ROLES, type Role } from '../constants.js';
import type { DB } from '../db.js';
import type { KnowledgeBase } from '../knowledge/index.js';
import type { LlmClient } from '../llm/index.js';
import { getRevision, getSetting, isSettingKey, listRevisions, setSetting, settingProblem } from '../settings.js';
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
    const username = str(b.username);
    const role = str(b.role) as Role;
    const orgType = str(b.org_type);
    const orgName = str(b.org_name);
    const region = str(b.region);
    const businessType = str(b.business_type) || '모름';
    if (!/^[A-Za-z0-9._-]{4,30}$/.test(username)) {
      return reply.code(400).send({ error: '아이디는 영문·숫자·._- 조합 4~30자로 입력해 주세요.' });
    }
    if (!ROLES.includes(role)) return reply.code(400).send({ error: '권한을 선택해 주세요.' });
    if (!(ORG_TYPES as readonly string[]).includes(orgType)) return reply.code(400).send({ error: '소속 구분을 선택해 주세요.' });
    if (!orgName) return reply.code(400).send({ error: '기관명을 입력해 주세요.' });
    if (!(REGIONS as readonly string[]).includes(region)) return reply.code(400).send({ error: '지역을 선택해 주세요.' });
    if (!(BUSINESS_TYPES as readonly string[]).includes(businessType)) {
      return reply.code(400).send({ error: '사업 유형을 선택해 주세요.' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return reply.code(409).send({ error: '이미 사용 중인 아이디입니다.' });
    }
    const tempPassword = generateTempPassword();
    db.prepare(
      `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type, role, status, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 1)`,
    ).run(username, hashPassword(tempPassword), orgType, orgName, region, businessType, role);
    audit(db, req.user, '계정 생성', username, `권한 ${role}`);
    return { ok: true, temp_password: tempPassword };
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

  app.post('/api/admin/users/:id/unlock', { preHandler: admin }, async (req, reply) => {
    const user = findUser((req.params as { id: string }).id);
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다.' });
    db.prepare('UPDATE users SET locked = 0, failed_attempts = 0 WHERE id = ?').run(user.id);
    audit(db, req.user, '잠금 해제', user.username);
    return { ok: true };
  });

  app.post('/api/admin/users/:id/reset-password', { preHandler: admin }, async (req, reply) => {
    const user = findUser((req.params as { id: string }).id);
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다.' });
    const tempPassword = generateTempPassword();
    db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 1, locked = 0, failed_attempts = 0 WHERE id = ?',
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
