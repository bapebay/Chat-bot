import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';

const PREFIX = 'chatbot-';

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface BackupFile {
  name: string;
  size: number;
  created_at: string;
}

/** 백업 폴더의 백업 파일 목록 (최신순) */
export function listBackups(dir: string): BackupFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.db'))
    .sort()
    .reverse()
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, created_at: st.mtime.toISOString() };
    });
}

/**
 * 서비스를 멈추지 않고 DB 전체를 파일 하나로 백업한다.
 * 오래된 백업은 keep 개만 남기고 지운다. 만든 파일 경로를 돌려준다.
 */
export async function backupDatabase(db: DB, dir: string, keep: number): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${PREFIX}${stamp()}.db`);
  if (fs.existsSync(file)) file = file.replace(/\.db$/, `-${Date.now() % 1000}.db`);
  await db.backup(file);
  for (const old of listBackups(dir).slice(keep)) fs.rmSync(path.join(dir, old.name), { force: true });
  return file;
}

/** 서버가 켜진 뒤 10분 후 첫 백업, 그 뒤 intervalHours 마다 백업한다 (0이면 끔) */
export function scheduleBackup(
  db: DB,
  opts: { dir: string; intervalHours: number; keep: number },
  log: (msg: string, error?: boolean) => void,
): void {
  if (!opts.intervalHours) return;
  const run = () =>
    backupDatabase(db, opts.dir, opts.keep)
      .then((f) => log(`DB 백업을 만들었습니다: ${f}`))
      .catch((e) => log(`DB 백업에 실패했습니다: ${(e as Error).message}`, true));
  setTimeout(run, 10 * 60_000).unref();
  setInterval(run, opts.intervalHours * 3600_000).unref();
}
