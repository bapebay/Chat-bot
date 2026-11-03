import type { DB } from '../db.js';
import { TEMPORARY_FAQ, TEMPORARY_GUIDELINE } from '../defaults.js';
import type { ParsedQaItem, UploadWarning } from './excel.js';
import type { ParsedPrinciple } from './principles.js';
import { chunkDocument, type Chunk } from './guideline.js';
import { isConfirmed } from './index.js';

export interface QaVersionRow {
  id: number;
  filename: string;
  uploaded_by_name: string | null;
  status: 'draft' | 'active' | 'archived';
  item_count: number;
  confirmed_count: number;
  referral_count: number;
  warnings: UploadWarning[];
  created_at: string;
  activated_at: string | null;
}

export function createQaDraft(db: DB, filename: string, userId: number, items: ParsedQaItem[], warnings: UploadWarning[]): number {
  return db.transaction(() => {
    // 적용하지 않은 이전 미리보기는 정리
    db.prepare(`DELETE FROM qa_versions WHERE status = 'draft'`).run();
    const v = db
      .prepare(`INSERT INTO qa_versions (filename, uploaded_by, item_count, warnings) VALUES (?, ?, ?, ?)`)
      .run(filename, userId, items.length, JSON.stringify(warnings));
    const versionId = Number(v.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO qa_items (version_id, qa_id, category1, category2, category3, question, checklist, answer,
         referral_answer, is_referral, review_status, change_history)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const it of items) {
      ins.run(versionId, it.qa_id, it.category1, it.category2, it.category3, it.question, it.checklist, it.answer,
        it.referral_answer, it.is_referral, it.review_status, it.change_history);
    }
    return versionId;
  })();
}

/** 이 버전을 서비스에 적용한다 (기존 적용 버전은 보관). 되돌리기도 같은 함수 */
export function activateQaVersion(db: DB, versionId: number): boolean {
  return db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM qa_versions WHERE id = ?').get(versionId);
    if (!exists) return false;
    db.prepare(`UPDATE qa_versions SET status = 'archived' WHERE status = 'active'`).run();
    db.prepare(`UPDATE qa_versions SET status = 'active', activated_at = datetime('now') WHERE id = ?`).run(versionId);
    return true;
  })();
}

export function listQaVersions(db: DB): QaVersionRow[] {
  const rows = db
    .prepare(
      `SELECT v.*, u.username AS uploaded_by_name FROM qa_versions v
       LEFT JOIN users u ON u.id = v.uploaded_by ORDER BY v.id DESC`,
    )
    .all() as (Omit<QaVersionRow, 'warnings' | 'confirmed_count' | 'referral_count'> & { warnings: string })[];
  const statusRows = db.prepare('SELECT review_status, is_referral FROM qa_items WHERE version_id = ?');
  return rows.map((r) => {
    const items = statusRows.all(r.id) as { review_status: string; is_referral: number }[];
    return {
      ...r,
      warnings: JSON.parse(r.warnings) as UploadWarning[],
      confirmed_count: items.filter((i) => isConfirmed(i.review_status)).length,
      referral_count: items.filter((i) => i.is_referral).length,
    };
  });
}

export function deleteQaVersion(db: DB, versionId: number): 'ok' | 'active' | 'missing' {
  const row = db.prepare('SELECT status FROM qa_versions WHERE id = ?').get(versionId) as { status: string } | undefined;
  if (!row) return 'missing';
  if (row.status === 'active') return 'active';
  db.prepare('DELETE FROM qa_versions WHERE id = ?').run(versionId);
  return 'ok';
}

export function listQaItems(db: DB, versionId: number, q: string, limit = 200) {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .prepare(
      `SELECT * FROM qa_items WHERE version_id = ?
         AND (? = '' OR qa_id LIKE ? ESCAPE '\\' OR question LIKE ? ESCAPE '\\' OR checklist LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\')
       ORDER BY id LIMIT ?`,
    )
    .all(versionId, q, like, like, like, like, limit);
}

export function addGuidelineDoc(db: DB, doc: { name: string; kind: string; filename: string; userId: number | null }, chunks: Chunk[]): number {
  return db.transaction(() => {
    const info = db
      .prepare('INSERT INTO guideline_docs (name, kind, filename, uploaded_by) VALUES (?, ?, ?, ?)')
      .run(doc.name, doc.kind, doc.filename, doc.userId);
    const id = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO guideline_chunks (doc_id, seq, clause, page, text) VALUES (?, ?, ?, ?, ?)');
    chunks.forEach((c, i) => ins.run(id, i, c.clause, c.page, c.text));
    return id;
  })();
}

export function listGuidelineDocs(db: DB) {
  return db
    .prepare(
      `SELECT d.*, u.username AS uploaded_by_name,
         (SELECT COUNT(*) FROM guideline_chunks c WHERE c.doc_id = d.id) AS chunk_count
       FROM guideline_docs d LEFT JOIN users u ON u.id = d.uploaded_by ORDER BY d.id DESC`,
    )
    .all();
}

/** 처음 실행할 때 데이터가 하나도 없으면, 프로토타입에 있던 지침·FAQ 발췌본을 임시 문서로 넣어 둔다 */
export function seedTemporaryKnowledge(db: DB): boolean {
  const any =
    db.prepare('SELECT 1 FROM guideline_docs LIMIT 1').get() || db.prepare('SELECT 1 FROM qa_versions LIMIT 1').get();
  if (any) return false;
  addGuidelineDoc(
    db,
    { name: '[임시] 사업비 집행 및 관리 지침 발췌 (프로토타입)', kind: '지침', filename: 'prototype-guideline.txt', userId: null },
    chunkDocument([TEMPORARY_GUIDELINE], false),
  );
  addGuidelineDoc(
    db,
    { name: '[임시] 사업비 집행 및 관리 FAQ 발췌 (프로토타입)', kind: 'FAQ', filename: 'prototype-faq.txt', userId: null },
    chunkDocument([TEMPORARY_FAQ], false),
  );
  return true;
}

// ================= 집행원리 =================

export interface PrincipleSetRow {
  id: number;
  filename: string;
  uploaded_by_name: string | null;
  status: 'active' | 'archived';
  item_count: number;
  warnings: string[];
  created_at: string;
  activated_at: string | null;
}

/** CSV 한 묶음을 저장하고 바로 사용 중으로 바꾼다 (이전 묶음은 보관) */
export function savePrincipleSet(db: DB, filename: string, userId: number | null, items: ParsedPrinciple[], warnings: string[]): number {
  return db.transaction(() => {
    const id = Number(
      db
        .prepare(`INSERT INTO principle_sets (filename, uploaded_by, item_count, warnings) VALUES (?, ?, ?, ?)`)
        .run(filename, userId, items.length, JSON.stringify(warnings)).lastInsertRowid,
    );
    const ins = db.prepare('INSERT INTO principles (set_id, code, category, funding, period, text, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const p of items) ins.run(id, p.code, p.category, p.funding, p.period, p.text, p.note);
    activatePrincipleSet(db, id);
    return id;
  })();
}

export function activatePrincipleSet(db: DB, setId: number): boolean {
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM principle_sets WHERE id = ?').get(setId)) return false;
    db.prepare(`UPDATE principle_sets SET status = 'archived' WHERE status = 'active'`).run();
    db.prepare(`UPDATE principle_sets SET status = 'active', activated_at = datetime('now') WHERE id = ?`).run(setId);
    return true;
  })();
}

export function listPrincipleSets(db: DB): PrincipleSetRow[] {
  return (
    db
      .prepare(
        `SELECT s.*, u.username AS uploaded_by_name FROM principle_sets s
         LEFT JOIN users u ON u.id = s.uploaded_by ORDER BY s.id DESC`,
      )
      .all() as (Omit<PrincipleSetRow, 'warnings'> & { warnings: string })[]
  ).map((r) => ({ ...r, warnings: JSON.parse(r.warnings) as string[] }));
}

/** 사용 중인 묶음은 지울 수 없다 */
export function deletePrincipleSet(db: DB, setId: number): 'ok' | 'active' | 'missing' {
  const row = db.prepare('SELECT status FROM principle_sets WHERE id = ?').get(setId) as { status: string } | undefined;
  if (!row) return 'missing';
  if (row.status === 'active') return 'active';
  db.prepare('DELETE FROM principle_sets WHERE id = ?').run(setId);
  return 'ok';
}

export function listPrinciples(db: DB, setId: number, q: string, limit = 300) {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .prepare(
      `SELECT * FROM principles WHERE set_id = ?
         AND (? = '' OR code LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')
       ORDER BY id LIMIT ?`,
    )
    .all(setId, q, like, like, like, limit);
}
