import type { DB } from './db.js';
import { getNumberSetting } from './settings.js';

/** 보관 기간이 지난 대화(와 그 안의 답변·평가)를 지운다. 지운 대화 수를 돌려준다 */
export function purgeOldConversations(db: DB): number {
  const days = getNumberSetting(db, 'retention_days');
  if (!days) return 0;
  return db.prepare(`DELETE FROM conversations WHERE updated_at < datetime('now', ?)`).run(`-${days} days`).changes;
}

/** 서버가 켜질 때와 6시간마다 정리한다 */
export function scheduleRetention(db: DB, log: (msg: string) => void): void {
  const run = () => {
    const n = purgeOldConversations(db);
    if (n) log(`보관 기간이 지난 대화 ${n}건을 삭제했습니다.`);
  };
  run();
  setInterval(run, 6 * 3600_000).unref();
}
