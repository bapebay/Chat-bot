import type { FastifyInstance } from 'fastify';
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  hashPassword,
  passwordProblem,
  requireRole,
  SESSION_COOKIE,
  sessionCookieOptions,
  toPublicUser,
  verifyPassword,
  type UserRow,
} from '../auth.js';
import { BUSINESS_TYPES, LOGIN_LOCK_MINUTES, MAX_LOGIN_FAILURES, ORG_TYPES, REGIONS } from '../constants.js';
import type { DB } from '../db.js';
import { str } from './util.js';

const USERNAME_RE = /^[A-Za-z0-9._-]{4,30}$/;

export function authRoutes(app: FastifyInstance, db: DB) {
  app.post('/api/auth/signup', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = str(b.username);
    const orgType = str(b.org_type);
    const orgName = str(b.org_name);
    const region = str(b.region);
    const businessType = str(b.business_type);

    if (!USERNAME_RE.test(username)) {
      return reply.code(400).send({ error: '아이디는 영문·숫자·._- 조합 4~30자로 입력해 주세요.' });
    }
    const pwErr = passwordProblem(b.password);
    if (pwErr) return reply.code(400).send({ error: pwErr });
    if (!(ORG_TYPES as readonly string[]).includes(orgType)) return reply.code(400).send({ error: '소속 구분을 선택해 주세요.' });
    if (!orgName || orgName.length > 100) return reply.code(400).send({ error: '기관명을 입력해 주세요.' });
    if (!(REGIONS as readonly string[]).includes(region)) return reply.code(400).send({ error: '지역을 선택해 주세요.' });
    if (!(BUSINESS_TYPES as readonly string[]).includes(businessType)) {
      return reply.code(400).send({ error: '사업 유형을 선택해 주세요.' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return reply.code(409).send({ error: '이미 사용 중인 아이디입니다.' });
    }

    db.prepare(
      `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(username, hashPassword(b.password as string), orgType, orgName, region, businessType);
    return { ok: true, message: '가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.' };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = str(b.username);
    const password = typeof b.password === 'string' ? b.password : '';
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    const invalid = '아이디 또는 비밀번호가 일치하지 않습니다.';

    if (!user) return reply.code(401).send({ error: invalid });
    // 연속으로 틀리면 잠시 막는다 (무차별 대입 방지). 시간이 지나면 저절로 풀린다
    const lockedNow = db.prepare(`SELECT 1 FROM users WHERE id = ? AND locked_until > datetime('now')`).get(user.id);
    if (lockedNow) {
      return reply.code(403).send({ error: `로그인을 여러 번 틀려 잠시 막혀 있습니다. ${LOGIN_LOCK_MINUTES}분 뒤 다시 시도하세요.` });
    }
    if (!verifyPassword(password, user.password_hash)) {
      const failures = user.failed_attempts + 1;
      if (failures >= MAX_LOGIN_FAILURES) {
        db.prepare(`UPDATE users SET failed_attempts = 0, locked_until = datetime('now', ?) WHERE id = ?`).run(`+${LOGIN_LOCK_MINUTES} minutes`, user.id);
        return reply.code(403).send({ error: `비밀번호를 ${MAX_LOGIN_FAILURES}회 틀려 ${LOGIN_LOCK_MINUTES}분 동안 로그인할 수 없습니다.` });
      }
      db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(failures, user.id);
      return reply.code(401).send({ error: `${invalid} (실패 ${failures}/${MAX_LOGIN_FAILURES})` });
    }
    if (user.status !== 'approved') {
      return reply.code(403).send({ error: '관리자의 승인을 기다리는 계정입니다.' });
    }

    db.prepare(`UPDATE users SET failed_attempts = 0, last_login_at = datetime('now') WHERE id = ?`).run(user.id);
    const token = createSession(db, user.id);
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
    return { user: toPublicUser({ ...user, failed_attempts: 0 }) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  const loggedIn = requireRole(db, 'user', { allowPasswordChangePending: true });

  app.get('/api/auth/me', { preHandler: loggedIn }, async (req) => ({ user: toPublicUser(req.user) }));

  app.post('/api/auth/change-password', { preHandler: loggedIn }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const current = typeof b.current_password === 'string' ? b.current_password : '';
    const next = b.new_password;
    if (!verifyPassword(current, req.user.password_hash)) {
      return reply.code(400).send({ error: '현재 비밀번호가 일치하지 않습니다.' });
    }
    const pwErr = passwordProblem(next);
    if (pwErr) return reply.code(400).send({ error: pwErr });
    if (current === next) return reply.code(400).send({ error: '새 비밀번호는 현재 비밀번호와 달라야 합니다.' });

    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
      hashPassword(next as string),
      req.user.id,
    );
    // 다른 기기의 로그인은 끊고 현재 기기는 새 세션으로 유지
    deleteUserSessions(db, req.user.id);
    reply.setCookie(SESSION_COOKIE, createSession(db, req.user.id), sessionCookieOptions());
    return { ok: true };
  });

  app.patch('/api/auth/me', { preHandler: requireRole(db, 'user') }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const businessType = str(b.business_type);
    if (!(BUSINESS_TYPES as readonly string[]).includes(businessType)) {
      return reply.code(400).send({ error: '사업 유형을 선택해 주세요.' });
    }
    db.prepare('UPDATE users SET business_type = ? WHERE id = ?').run(businessType, req.user.id);
    return { ok: true };
  });
}
