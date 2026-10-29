import type { DB } from './db.js';
import { DEFAULT_DISCLAIMER, DEFAULT_SYSTEM_PROMPT } from './defaults.js';

// 이력을 남기며 관리자 화면에서 고치는 설정
export const EDITABLE_SETTINGS = {
  system_prompt: DEFAULT_SYSTEM_PROMPT,
  disclaimer: DEFAULT_DISCLAIMER,
} as const;

export type SettingKey = keyof typeof EDITABLE_SETTINGS;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(EDITABLE_SETTINGS, key);
}

export function getSetting(db: DB, key: SettingKey): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : EDITABLE_SETTINGS[key];
}

export function setSetting(db: DB, key: SettingKey, value: string, changedBy: number | null): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value);
    db.prepare('INSERT INTO setting_revisions (key, value, changed_by) VALUES (?, ?, ?)').run(key, value, changedBy);
  })();
}

export function listRevisions(db: DB, key: SettingKey, limit = 30) {
  return db
    .prepare(
      `SELECT r.id, r.value, r.created_at, u.username AS changed_by
       FROM setting_revisions r LEFT JOIN users u ON u.id = r.changed_by
       WHERE r.key = ? ORDER BY r.id DESC LIMIT ?`,
    )
    .all(key, limit) as { id: number; value: string; created_at: string; changed_by: string | null }[];
}

export function getRevision(db: DB, key: SettingKey, id: number) {
  return db.prepare('SELECT value FROM setting_revisions WHERE key = ? AND id = ?').get(key, id) as
    | { value: string }
    | undefined;
}
