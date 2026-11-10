// 데모 페이지에서 내보낸 자료 파일을 서버 DB에 넣는다. 서비스를 멈춘 뒤 실행할 것.
// 사용법: npm run import-demo -- <내보낸 파일 경로(.json)>
//   (Docker: 파일을 ./data 폴더에 넣고
//            docker compose stop chatbot
//            docker compose run --rm chatbot node dist/server/scripts/import-demo.js /app/data/<파일>
//            docker compose start chatbot)
import fs from 'node:fs';
import { backupDatabase } from '../backup.js';
import { config } from '../config.js';
import { openDatabase } from '../db.js';
import { importDemoExport } from '../knowledge/demo-import.js';

const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error('사용법: npm run import-demo -- <내보낸 파일 경로>');
  process.exit(1);
}

const db = openDatabase();
try {
  const before = await backupDatabase(db, config.backup.dir, config.backup.keep);
  console.log(`옮기기 전 DB를 백업했습니다: ${before}`);
  const s = importDemoExport(db, JSON.parse(fs.readFileSync(source, 'utf8')));
  console.log(`표준 Q&A ${s.qa_items}개, 집행원리 ${s.principles}개, 지침·FAQ ${s.guideline_docs}건(${s.guideline_chunks}조각)을 넣었습니다.`);
  if (s.temporary_docs_hidden) console.log(`[임시] 발췌본 ${s.temporary_docs_hidden}건은 숨겼습니다.`);
  console.log(`바뀐 설정: ${s.settings_changed.join(', ') || '없음'}`);
  if (s.settings_skipped.length) console.log(`값이 맞지 않아 건너뛴 설정: ${s.settings_skipped.join(', ')}`);
  console.log('서비스를 다시 시작하세요.');
} catch (e) {
  console.error(`옮기지 못했습니다: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
