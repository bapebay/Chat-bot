// 관리자 비밀번호를 잊었거나 계정이 잠겼을 때 서버에서 직접 실행하는 복구 도구
// 사용법: npm run reset-admin -- <아이디>
import { deleteUserSessions, generateTempPassword, hashPassword } from '../auth.js';
import { openDatabase } from '../db.js';

const username = process.argv[2];
if (!username) {
  console.error('사용법: npm run reset-admin -- <관리자 아이디>');
  process.exit(1);
}

const db = openDatabase();
const user = db.prepare(`SELECT id, role FROM users WHERE username = ?`).get(username) as
  | { id: number; role: string }
  | undefined;
if (!user || user.role !== 'admin') {
  console.error(`'${username}' 관리자 계정을 찾을 수 없습니다.`);
  process.exit(1);
}

const temp = generateTempPassword();
db.prepare(
  `UPDATE users SET password_hash = ?, must_change_password = 1, locked = 0, failed_attempts = 0, locked_until = NULL, status = 'approved' WHERE id = ?`,
).run(hashPassword(temp), user.id);
deleteUserSessions(db, user.id);
console.log(`'${username}' 계정의 잠금을 풀고 임시 비밀번호를 발급했습니다: ${temp}`);
console.log('로그인 후 바로 비밀번호를 변경하세요.');
