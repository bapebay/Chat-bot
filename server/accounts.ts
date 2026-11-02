import bcrypt from 'bcryptjs';
import { generateTempPassword } from './auth.js';
import type { DB } from './db.js';
import { accountFieldProblem, type AccountInput } from './accounts-excel.js';

export { buildAccountsTemplate, MAX_BULK_ACCOUNTS, parseAccountsWorkbook, type AccountInput } from './accounts-excel.js';

/** 계정 입력값을 확인한다 (형식 + 아이디 중복). 문제가 없으면 null */
export function accountProblem(db: DB, a: AccountInput): string | null {
  const problem = accountFieldProblem(a);
  if (problem) return problem;
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(a.username)) return '이미 사용 중인 아이디입니다.';
  return null;
}

/** 승인된 계정을 만들고 임시 비밀번호를 돌려준다 (첫 로그인 때 비밀번호 변경 필수) */
export async function createAccount(db: DB, a: AccountInput): Promise<string> {
  const tempPassword = generateTempPassword();
  const hash = await bcrypt.hash(tempPassword, 10);
  db.prepare(
    `INSERT INTO users (username, password_hash, org_type, org_name, region, business_type, role, status, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 1)`,
  ).run(a.username, hash, a.org_type, a.org_name, a.region, a.business_type, a.role);
  return tempPassword;
}

