import type { DB } from './db.js';

/** 감사 로그 남기기 (권한 변경·데이터 교체·프롬프트 수정 등) */
export function audit(db: DB, user: { id: number; username: string } | null, action: string, target = '', detail = ''): void {
  db.prepare('INSERT INTO audit_logs (user_id, username, action, target, detail) VALUES (?, ?, ?, ?, ?)').run(
    user?.id ?? null,
    user?.username ?? null,
    action,
    target.slice(0, 200),
    detail.slice(0, 1000),
  );
}
