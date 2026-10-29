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
  return db;
}
