import type { DB } from './db.js';
import { LEAK_REASON, SECURITY_DAILY_STRIKES } from './knowledge/guard.js';
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

/** 오늘 이 사용자의 질문 중 보안 의심으로 막힌 횟수 */
export function securityStrikesToday(db: DB, userId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM review_queue rq JOIN messages m ON m.id = rq.message_id JOIN conversations c ON c.id = m.conversation_id
       WHERE rq.source = 'security' AND m.created_at >= ? AND c.user_id = ? AND m.citations NOT LIKE ?`,
    )
    // 답변 단계에서 막힌 것(AI가 지시문을 옮겨 적음)은 질문한 사람 탓이 아니므로 세지 않는다
    .get(kstDayStartUtc(), userId, `%"security":"${LEAK_REASON}"%`) as { n: number };
  return row.n;
}

/** 상한을 넘었으면 사용자에게 보여줄 문구, 아니면 null */
export function limitExceeded(db: DB, userId: number): string | null {
  if (securityStrikesToday(db, userId) >= SECURITY_DAILY_STRIKES) {
    return '보안 정책에 맞지 않는 요청이 반복되어 오늘은 질문할 수 없습니다. 필요하면 1:1 문의를 이용해 주세요.';
  }
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
