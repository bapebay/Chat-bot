// 지금 바로 DB를 백업한다. 서비스가 켜져 있어도 안전하다.
// 사용법: npm run backup            (Docker: docker compose exec chatbot node dist/server/scripts/backup.js)
import { backupDatabase } from '../backup.js';
import { config } from '../config.js';
import { openDatabase } from '../db.js';

const db = openDatabase();
const file = await backupDatabase(db, config.backup.dir, config.backup.keep);
db.close();
console.log(`백업을 만들었습니다: ${file}`);
