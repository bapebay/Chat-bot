import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import type { Role } from './constants.js';
import type { DB } from './db.js';

export const SESSION_COOKIE = 'sid';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  org_type: string;
  org_name: string;
  region: string;
  business_type: string;
  role: Role;
  status: 'pending' | 'approved';
  locked: number;
  failed_attempts: number;
  must_change_password: number;
  created_at: string;
  last_login_at: string | null;
}

export type PublicUser = Omit<UserRow, 'password_hash' | 'locked' | 'must_change_password'> & {
  locked: boolean;
  must_change_password: boolean;
};

export function toPublicUser(u: UserRow): PublicUser {
  const { password_hash: _ignored, ...rest } = u;
  return { ...rest, locked: !!u.locked, must_change_password: !!u.must_change_password };
}

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}

export function verifyPassword(pw: string, hash: string): boolean {
  return bcrypt.compareSync(pw, hash);
}

/** 비밀번호 규칙: 8자 이상, 영문과 숫자 포함. 문제가 없으면 null */
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (pw.length > 100) return '비밀번호가 너무 깁니다.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return '비밀번호에 영문과 숫자를 모두 포함해야 합니다.';
  return null;
}

/** 관리자가 비밀번호를 초기화할 때 주는 임시 비밀번호 */
export function generateTempPassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (s: string) => s[crypto.randomInt(s.length)];
  let out = '';
  for (let i = 0; i < 6; i++) out += pick(letters);
  for (let i = 0; i < 4; i++) out += pick(digits);
  return out;
}

export function createSession(db: DB, userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`).run(
    token,
    userId,
    `+${config.sessionHours} hours`,
  );
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  return token;
}

export function deleteSession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function deleteUserSessions(db: DB, userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function sessionCookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    maxAge: config.sessionHours * 3600,
  };
}

function userFromRequest(db: DB, req: FastifyRequest): UserRow | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`,
    )
    .get(token) as UserRow | undefined;
  if (!row || row.status !== 'approved' || row.locked) return null;
  return row;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow;
  }
}

const ROLE_LEVEL: Record<Role, number> = { user: 1, admin: 3 };

/**
 * 로그인과 권한을 서버에서 다시 확인하는 preHandler.
 * allowPasswordChangePending: 비밀번호 강제 변경 전에도 쓸 수 있는 API(내 정보, 비밀번호 변경, 로그아웃)만 true.
 */
export function requireRole(db: DB, minRole: Role, opts: { allowPasswordChangePending?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = userFromRequest(db, req);
    if (!user) return reply.code(401).send({ error: '로그인이 필요합니다.' });
    if (user.must_change_password && !opts.allowPasswordChangePending) {
      return reply.code(403).send({ error: '비밀번호를 먼저 변경해 주세요.', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    if (ROLE_LEVEL[user.role] < ROLE_LEVEL[minRole]) {
      return reply.code(403).send({ error: '권한이 없습니다.' });
    }
    req.user = user;
  };
}

/** 관리자 계정이 하나도 없으면 .env 값으로 최초 관리자를 만든다 */
export function ensureInitialAdmin(db: DB, log: (msg: string) => void): void {
  const exists = db.prepare(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`).get();
  if (exists) return;
  if (!config.adminInitialPassword) {
    log('관리자 계정이 없습니다. .env 의 ADMIN_INITIAL_PASSWORD 를 설정한 뒤 다시 실행하세요.');
    return;
  }
  db.prepare(
    `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type, role, status, must_change_password)
     VALUES (?, ?, '재단', '중앙앵커센터', '해당없음', '모름', 'admin', 'approved', 1)`,
  ).run(config.adminUsername, hashPassword(config.adminInitialPassword));
  log(`최초 관리자 계정 '${config.adminUsername}'을 만들었습니다. 첫 로그인 시 비밀번호를 변경해야 합니다.`);
}
