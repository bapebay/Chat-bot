import type { DB } from './db.js';
import { getNumberSetting } from './settings.js';

/** 한국 시간 기준 오늘 0시를 DB 시각 형식(UTC, 'YYYY-MM-DD HH:MM:SS')으로 */
export function kstDayStartUtc(now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const startKst = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
  return new Date(startKst - 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}

export function questionsToday(db: DB, userId?: number): number {
  const since = kstDayStartUtc();
  const row = (
    userId === undefined
      ? db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at >= ?`).get(since)
      : db
          .prepare(
            `SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
             WHERE m.role = 'user' AND m.created_at >= ? AND c.user_id = ?`,
          )
          .get(since, userId)
  ) as { n: number };
  return row.n;
}

export interface Usage {
  used: number;
  limit: number; // 0 = 제한 없음
}

export function userUsage(db: DB, userId: number): Usage {
  return { used: questionsToday(db, userId), limit: getNumberSetting(db, 'daily_limit_user') };
}

/** 상한을 넘었으면 사용자에게 보여줄 문구, 아니면 null */
export function limitExceeded(db: DB, userId: number): string | null {
  const u = userUsage(db, userId);
  if (u.limit > 0 && u.used >= u.limit) {
    return `오늘 질문 가능 횟수(${u.limit}회)를 모두 사용했습니다. 내일 다시 이용하시거나 1:1 문의를 이용해 주세요.`;
  }
  const total = getNumberSetting(db, 'daily_limit_total');
  if (total > 0 && questionsToday(db) >= total) {
    return '오늘 전체 질문 한도에 도달해 잠시 이용이 제한됩니다. 내일 다시 이용하시거나 1:1 문의를 이용해 주세요.';
  }
  return null;
}
