// 백업 파일로 DB를 되돌린다. 반드시 서비스를 멈춘 뒤 실행할 것.
// 사용법: npm run restore -- <백업 파일 경로>
//   (Docker: docker compose stop chatbot
//            docker compose run --rm chatbot node dist/server/scripts/restore.js /app/backups/<파일>
//            docker compose start chatbot)
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error('사용법: npm run restore -- <백업 파일 경로>');
  process.exit(1);
}

// 1) 백업 파일이 멀쩡한 챗봇 DB인지 확인
try {
  const check = new Database(source, { readonly: true });
  const ok = (check.pragma('integrity_check', { simple: true }) as string) === 'ok';
  const hasUsers = check.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get();
  check.close();
  if (!ok || !hasUsers) throw new Error(!ok ? '파일이 손상되었습니다.' : '챗봇 DB가 아닙니다.');
} catch (e) {
  console.error(`이 파일로는 되돌릴 수 없습니다: ${(e as Error).message}`);
  process.exit(1);
}

// 2) 지금 DB를 옆에 남겨 두고 백업 파일로 바꾼다
const target = path.resolve(config.databasePath);
fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) {
  const keep = `${target}.before-restore-${Date.now()}`;
  fs.copyFileSync(target, keep);
  console.log(`지금 DB를 ${keep} 에 남겨 두었습니다.`);
}
for (const extra of ['-wal', '-shm']) fs.rmSync(target + extra, { force: true });
fs.copyFileSync(source, target);
console.log(`${source} 로 DB를 되돌렸습니다. 서비스를 다시 시작하세요.`);
