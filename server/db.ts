import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  org_type TEXT NOT NULL,
  org_name TEXT NOT NULL,
  region TEXT NOT NULL,
  business_type TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'pending',
  locked INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '새로운 대화',
  business_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  answer_type TEXT,
  citations TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  attached_transcript TEXT,
  content TEXT NOT NULL,
  answer TEXT,
  answered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS setting_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_setting_revisions_key ON setting_revisions(key, id);

-- 표준 Q&A: 엑셀 업로드 1회 = 버전 1개. status: draft(미리보기) / active(서비스 중) / archived
CREATE TABLE IF NOT EXISTS qa_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  item_count INTEGER NOT NULL DEFAULT 0,
  warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT
);

CREATE TABLE IF NOT EXISTS qa_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES qa_versions(id) ON DELETE CASCADE,
  qa_id TEXT NOT NULL,
  category1 TEXT NOT NULL DEFAULT '',
  category2 TEXT NOT NULL DEFAULT '',
  category3 TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL,
  checklist TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL,
  referral_answer TEXT NOT NULL DEFAULT '',
  is_referral INTEGER NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT '',
  change_history TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_qa_items_version ON qa_items(version_id);

CREATE TABLE IF NOT EXISTS out_of_scope (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  guidance TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT ''
);

-- 집행원리: 질의응답 사례에서 뽑은 일반 집행 기준 (근거 2단계). CSV 한 번 올릴 때마다 한 묶음, 하나만 사용 중
CREATE TABLE IF NOT EXISTS principle_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'archived',
  item_count INTEGER NOT NULL DEFAULT 0,
  warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT
);
CREATE TABLE IF NOT EXISTS principles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES principle_sets(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  funding TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_principles_set ON principles(set_id, id);

-- 지침·FAQ 원문. 조항 단위로 쪼개 guideline_chunks 에 저장
CREATE TABLE IF NOT EXISTS guideline_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS guideline_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES guideline_docs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  clause TEXT NOT NULL DEFAULT '',
  page INTEGER,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guideline_chunks_doc ON guideline_chunks(doc_id, seq);

-- 평가 질문집: 질문 + 기대 통합번호 + 기대 유형
CREATE TABLE IF NOT EXISTS eval_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eval_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  question TEXT NOT NULL,
  business_type TEXT NOT NULL DEFAULT '모름',
  expected_qa_ids TEXT NOT NULL DEFAULT '[]',
  expected_type TEXT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_eval_items_set ON eval_items(set_id, seq);

-- 평가 실행 1회. config: 실행 당시 모델·데이터 버전·기준값, summary: 점수
CREATE TABLE IF NOT EXISTS eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  summary TEXT,
  error TEXT,
  started_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS eval_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES eval_items(id) ON DELETE CASCADE,
  answer_type TEXT,
  answer TEXT NOT NULL DEFAULT '',
  cited_qa_ids TEXT NOT NULL DEFAULT '[]',
  retrieved_qa_ids TEXT NOT NULL DEFAULT '[]',
  cite_hit INTEGER,
  retrieve_hit INTEGER,
  type_match INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  error TEXT,
  verdict TEXT,
  verdict_note TEXT NOT NULL DEFAULT '',
  UNIQUE (run_id, item_id)
);

-- 답변 평가 (사용자 1명이 답변 1개에 하나)
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating TEXT NOT NULL,
  reason TEXT,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (message_id, user_id)
);

-- 검토 대기함: Bad 평가·근거 없음·범위 외 답변을 모아 관리자가 처리
CREATE TABLE IF NOT EXISTS review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  resolution TEXT,
  qa_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(status, id);

-- 표준답안 수정 이력
CREATE TABLE IF NOT EXISTS qa_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qa_id TEXT NOT NULL,
  version_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  reason TEXT NOT NULL DEFAULT '',
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_qa_revisions_qa ON qa_revisions(qa_id, id);

-- 지침 개정 공지
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 감사 로그: 누가 언제 무엇을 바꿨는지
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(id);

-- 의미 검색용 벡터 캐시 (같은 문장은 다시 계산하지 않음)
CREATE TABLE IF NOT EXISTS embeddings (
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (hash, model)
);
`;

export function openDatabase(file = config.databasePath): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 예전 DB에 없던 열을 추가한다 */
function migrate(db: DB) {
  const has = (table: string, col: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
  // 지침 개정 등으로 다시 검수해야 하는 표준답안 표시 (검색에서는 빠지지 않음)
  if (!has('qa_items', 'needs_recheck')) db.exec('ALTER TABLE qa_items ADD COLUMN needs_recheck INTEGER NOT NULL DEFAULT 0');
  // 문의자가 아직 보지 않은 답변 표시
  if (!has('inquiries', 'user_unread')) db.exec('ALTER TABLE inquiries ADD COLUMN user_unread INTEGER NOT NULL DEFAULT 0');
  // 문의 답변으로 만든 표준답안 통합번호 (같은 문의를 두 번 등록하지 않게 표시)
  if (!has('inquiries', 'qa_id')) db.exec('ALTER TABLE inquiries ADD COLUMN qa_id TEXT');
  // 로그인 잠금은 잠시 막았다가 저절로 풀리는 방식으로 (관리자 해제 화면 없앰). 예전 영구 잠금은 풀어 준다
  if (!has('users', 'locked_until')) {
    db.exec('ALTER TABLE users ADD COLUMN locked_until TEXT');
    db.exec('UPDATE users SET locked = 0, failed_attempts = 0');
  }
  // 답변범위 외 목록 기능을 없앴다: 예전에 올린 목록이 답변에 계속 영향을 주지 않게 비운다
  db.exec('DELETE FROM out_of_scope');
  // 검수자 역할을 없애고 그 권한을 관리자에게 합쳤다 (기존 검수자 계정은 관리자로)
  db.exec(`UPDATE users SET role = 'admin' WHERE role = 'reviewer'`);
  // 연결 대상 연락처 기능을 없앴다 (답변에는 '○○에 문의하시기 바랍니다'만 안내)
  db.exec('DROP TABLE IF EXISTS referral_contacts');
}
