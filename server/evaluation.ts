import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import { ANSWER_TYPES, generateAnswer, type AnswerType } from './chat.js';
import { BUSINESS_TYPES } from './constants.js';
import type { DB } from './db.js';
import type { KnowledgeBase } from './knowledge/index.js';
import type { LlmClient } from './llm/index.js';
import { getNumberSetting, getSetting } from './settings.js';

// ================= 평가 질문집 엑셀 =================

export interface ParsedEvalItem {
  question: string;
  business_type: string;
  expected_qa_ids: string[];
  expected_type: AnswerType | null;
  note: string;
}

const HEADERS: Record<keyof ParsedEvalItem, string[]> = {
  question: ['질문', '평가질문', '질의', '대표질의'],
  business_type: ['사업유형', '사업'],
  expected_qa_ids: ['기대통합번호', '정답통합번호', '통합번호', '기대번호'],
  expected_type: ['기대유형', '정답유형', '답변유형', '유형'],
  note: ['비고', '메모'],
};

/** "근거 답변", "연결", "범위 외" 같은 표기를 4가지 유형으로 맞춘다 */
export function normalizeAnswerType(raw: string): AnswerType | null {
  const s = raw.replace(/\s/g, '');
  if (!s) return null;
  if (s.startsWith('근거답') || s === '답변' || s === '근거') return '근거답변';
  if (s.startsWith('연결')) return '연결형';
  if (s.includes('범위')) return '답변범위외';
  if (s.startsWith('근거없') || s.includes('없음')) return '근거없음';
  return (ANSWER_TYPES as readonly string[]).includes(s) ? (s as AnswerType) : null;
}

const norm = (s: string) => s.replace(/\(.*?\)/g, '').replace(/\s/g, '').toLowerCase();

export async function parseEvalWorkbook(buffer: Buffer): Promise<{ items: ParsedEvalItem[]; warnings: string[] }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new Error('엑셀(.xlsx) 파일을 읽을 수 없습니다.');
  }
  for (const sheet of wb.worksheets) {
    for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
      const cols: Partial<Record<keyof ParsedEvalItem, number>> = {};
      sheet.getRow(r).eachCell((cell, c) => {
        const h = norm(cell.text ?? '');
        for (const [field, aliases] of Object.entries(HEADERS) as [keyof ParsedEvalItem, string[]][]) {
          if (cols[field] === undefined && aliases.includes(h)) cols[field] = c;
        }
      });
      if (!cols.question) continue;

      const items: ParsedEvalItem[] = [];
      const warnings: string[] = [];
      for (let i = r + 1; i <= sheet.rowCount; i++) {
        const row = sheet.getRow(i);
        const get = (f: keyof ParsedEvalItem) => (cols[f] ? (row.getCell(cols[f]!).text ?? '').trim() : '');
        const question = get('question');
        if (!question) continue;
        const bt = get('business_type').replace(/\s/g, '');
        const typeRaw = get('expected_type');
        const expectedType = normalizeAnswerType(typeRaw);
        if (typeRaw && !expectedType) warnings.push(`${i}행: 기대 유형 '${typeRaw}'을(를) 알 수 없어 비워 둡니다.`);
        if (bt && !(BUSINESS_TYPES as readonly string[]).includes(bt)) warnings.push(`${i}행: 사업 유형 '${bt}'을(를) 알 수 없어 '모름'으로 둡니다.`);
        items.push({
          question,
          business_type: (BUSINESS_TYPES as readonly string[]).includes(bt) ? bt : '모름',
          expected_qa_ids: get('expected_qa_ids')
            .split(/[,;/\n]+/)
            .map((x) => x.trim())
            .filter(Boolean),
          expected_type: expectedType,
          note: get('note'),
        });
      }
      if (!items.length) throw new Error('평가 질문이 한 건도 없습니다.');
      return { items, warnings };
    }
  }
  throw new Error('‘질문’ 머리글이 있는 시트를 찾지 못했습니다. (머리글: 질문 · 사업 유형 · 기대 통합번호 · 기대 유형 · 비고)');
}

export async function buildEvalTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('평가질문');
  s.columns = [
    { header: '질문', key: 'q', width: 60 },
    { header: '사업 유형', key: 'bt', width: 12 },
    { header: '기대 통합번호', key: 'ids', width: 20 },
    { header: '기대 유형', key: 't', width: 12 },
    { header: '비고', key: 'n', width: 30 },
  ];
  s.addRow({ q: '(예시) 글로컬 사업단장에게 보직수당을 줄 수 있나요?', bt: '글로컬', ids: 'B4-01-a', t: '근거답변', n: '여러 개면 쉼표로 구분' });
  s.addRow({ q: '(예시) 이 장비 구입은 인정되나요?', bt: '순수앵커', ids: '', t: '연결형', n: '개별 인정 판단 → 연결' });
  s.addRow({ q: '(예시) 자체평가 실적으로 인정되나요?', bt: '모름', ids: '', t: '답변범위외', n: '' });
  s.getRow(1).font = { bold: true };
  const guide = wb.addWorksheet('작성 안내');
  [
    '질문: 실제 사용자가 물을 법한 문장 그대로',
    '사업 유형: 순수앵커 / 글로컬 / 의대교육 / 초광역 / 기타 / 모름 (비우면 모름)',
    '기대 통합번호: 이 질문에 인용되어야 하는 표준답안 번호. 여러 개면 쉼표로 구분 (하나라도 인용되면 적중)',
    '기대 유형: 근거답변 / 연결형 / 답변범위외 / 근거없음',
  ].forEach((t) => guide.addRow([t]));
  guide.getColumn(1).width = 100;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function createEvalSet(db: DB, name: string, filename: string, userId: number, items: ParsedEvalItem[]): number {
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO eval_sets (name, filename, created_by) VALUES (?, ?, ?)').run(name, filename, userId).lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO eval_items (set_id, seq, question, business_type, expected_qa_ids, expected_type, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    items.forEach((it, i) => ins.run(id, i + 1, it.question, it.business_type, JSON.stringify(it.expected_qa_ids), it.expected_type, it.note));
    return id;
  })();
}

// ================= 실행 =================

interface EvalItemRow {
  id: number;
  question: string;
  business_type: string;
  expected_qa_ids: string;
  expected_type: AnswerType | null;
}

export interface EvalSummary {
  total: number;
  errors: number;
  /** 기대 통합번호가 있는 문항 중 그 번호를 인용한 비율 */
  cite_hit_rate: number | null;
  cite_hit: number;
  cite_total: number;
  /** 기대 통합번호가 검색 결과(모델에 넘긴 근거) 안에라도 들어 있던 비율. 검색 문제인지 모델 문제인지 가르는 용도 */
  retrieve_hit_rate: number | null;
  /** 기대 유형이 있는 문항 중 유형이 맞은 비율 */
  type_accuracy: number | null;
  type_match: number;
  type_total: number;
  /** 기대 유형이 연결형·범위외·근거없음인 문항(= 답하면 안 되는 질문) 중 맞게 걸러낸 비율 */
  referral_accuracy: number | null;
  /** 검수자가 '잘못된 결론'으로 표시한 건수 */
  wrong: number;
  /** 아직 검수 판정을 하지 않은 근거답변 수 */
  unreviewed: number;
  input_tokens: number;
  output_tokens: number;
  avg_latency_ms: number | null;
  pass_hit_rate: number;
  /** 점수 기준은 넘었지만 검수하지 않은 근거답변이 남아 있음 */
  awaiting_review: boolean;
  passed: boolean;
}

const runningRuns = new Map<number, { cancelled: boolean }>();

/** 서버가 꺼졌다 켜지면 진행 중이던 실행은 중단으로 표시 */
export function markInterruptedRuns(db: DB): void {
  db.prepare(
    `UPDATE eval_runs SET status = 'failed', error = '서버 재시작으로 중단되었습니다.', finished_at = datetime('now') WHERE status = 'running'`,
  ).run();
}

export function isRunning(): boolean {
  return runningRuns.size > 0;
}

function hash(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/** 실행 당시 조건을 남겨 두어 나중에 결과를 비교할 때 무엇이 바뀌었는지 알 수 있게 한다 */
function snapshotConfig(db: DB, llm: LlmClient, kb: KnowledgeBase) {
  const active = db.prepare(`SELECT id, filename FROM qa_versions WHERE status = 'active'`).get() as
    | { id: number; filename: string }
    | undefined;
  const lastPrompt = db.prepare(`SELECT id FROM setting_revisions WHERE key = 'system_prompt' ORDER BY id DESC LIMIT 1`).get() as
    | { id: number }
    | undefined;
  return {
    provider: llm.provider,
    model: llm.model,
    qa_version: active ? `#${active.id} ${active.filename}` : '없음',
    prompt: lastPrompt ? `이력 #${lastPrompt.id}` : '기본값',
    prompt_hash: hash(getSetting(db, 'system_prompt') + getSetting(db, 'principles')),
    include_unreviewed: getSetting(db, 'include_unreviewed') === 'true',
    threshold_keyword: getNumberSetting(db, 'threshold_keyword'),
    threshold_semantic: getNumberSetting(db, 'threshold_semantic'),
    search_mode: kb.stats.semantic_ready ? '키워드+의미' : '키워드',
    qa_count: kb.stats.qa,
    guideline_count: kb.stats.guideline,
  };
}

export function startEvalRun(
  db: DB,
  llm: LlmClient,
  kb: KnowledgeBase,
  setId: number,
  label: string,
  userId: number,
  opts: { concurrency?: number } = {},
): { runId: number; done: Promise<void> } {
  const items = db.prepare('SELECT * FROM eval_items WHERE set_id = ? ORDER BY seq').all(setId) as EvalItemRow[];
  const runId = Number(
    db
      .prepare('INSERT INTO eval_runs (set_id, label, total, config, started_by) VALUES (?, ?, ?, ?, ?)')
      .run(setId, label, items.length, JSON.stringify(snapshotConfig(db, llm, kb)), userId).lastInsertRowid,
  );
  const state = { cancelled: false };
  runningRuns.set(runId, state);

  const save = db.prepare(
    `INSERT INTO eval_results (run_id, item_id, answer_type, answer, cited_qa_ids, retrieved_qa_ids, cite_hit, retrieve_hit, type_match,
       input_tokens, output_tokens, latency_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const progress = db.prepare('UPDATE eval_runs SET done = done + 1 WHERE id = ?');

  async function runItem(item: EvalItemRow) {
    const expected = JSON.parse(item.expected_qa_ids) as string[];
    const started = Date.now();
    try {
      const a = await generateAnswer(db, llm, kb, [], item.business_type, item.question);
      const cited = a.citations.qa.map((q) => q.qa_id);
      const retrieved = a.citations.retrieved.qa.map((q) => q.qa_id);
      save.run(
        runId,
        item.id,
        a.answerType,
        a.text,
        JSON.stringify(cited),
        JSON.stringify(retrieved),
        expected.length ? Number(expected.some((x) => cited.includes(x))) : null,
        expected.length ? Number(expected.some((x) => retrieved.includes(x))) : null,
        item.expected_type ? Number(item.expected_type === a.answerType) : null,
        a.inputTokens,
        a.outputTokens,
        Date.now() - started,
        null,
      );
    } catch (e) {
      save.run(runId, item.id, null, '', '[]', '[]', expected.length ? 0 : null, null, item.expected_type ? 0 : null, null, null, Date.now() - started, (e as Error).message.slice(0, 500));
    }
    progress.run(runId);
  }

  const done = (async () => {
    const queue = [...items];
    const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, async () => {
      while (queue.length && !state.cancelled) await runItem(queue.shift()!);
    });
    try {
      await Promise.all(workers);
      db.prepare(`UPDATE eval_runs SET status = ?, summary = ?, finished_at = datetime('now') WHERE id = ?`).run(
        state.cancelled ? 'cancelled' : 'done',
        JSON.stringify(summarizeRun(db, runId)),
        runId,
      );
    } catch (e) {
      db.prepare(`UPDATE eval_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`).run((e as Error).message, runId);
    } finally {
      runningRuns.delete(runId);
    }
  })();
  return { runId, done };
}

export function cancelEvalRun(runId: number): boolean {
  const s = runningRuns.get(runId);
  if (!s) return false;
  s.cancelled = true;
  return true;
}

const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

export function summarizeRun(db: DB, runId: number): EvalSummary {
  const rows = db
    .prepare(
      `SELECT r.*, i.expected_type FROM eval_results r JOIN eval_items i ON i.id = r.item_id WHERE r.run_id = ?`,
    )
    .all(runId) as {
    answer_type: string | null;
    cite_hit: number | null;
    retrieve_hit: number | null;
    type_match: number | null;
    expected_type: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    latency_ms: number | null;
    error: string | null;
    verdict: string | null;
  }[];
  const cite = rows.filter((r) => r.cite_hit !== null);
  const retr = rows.filter((r) => r.retrieve_hit !== null);
  const typed = rows.filter((r) => r.type_match !== null);
  const refer = typed.filter((r) => r.expected_type && r.expected_type !== '근거답변');
  const lat = rows.filter((r) => r.latency_ms !== null);
  const passHit = getNumberSetting(db, 'eval_pass_hit_rate');
  const citeHitRate = rate(cite.filter((r) => r.cite_hit).length, cite.length);
  const wrong = rows.filter((r) => r.verdict === 'wrong').length;
  const unreviewed = rows.filter((r) => r.answer_type === '근거답변' && !r.verdict).length;
  const scoreOk = citeHitRate !== null && citeHitRate >= passHit && wrong === 0 && rows.every((r) => !r.error);
  return {
    total: rows.length,
    errors: rows.filter((r) => r.error).length,
    cite_hit_rate: citeHitRate,
    cite_hit: cite.filter((r) => r.cite_hit).length,
    cite_total: cite.length,
    retrieve_hit_rate: rate(retr.filter((r) => r.retrieve_hit).length, retr.length),
    type_accuracy: rate(typed.filter((r) => r.type_match).length, typed.length),
    type_match: typed.filter((r) => r.type_match).length,
    type_total: typed.length,
    referral_accuracy: rate(refer.filter((r) => r.type_match).length, refer.length),
    wrong,
    unreviewed,
    input_tokens: rows.reduce((s, r) => s + (r.input_tokens ?? 0), 0),
    output_tokens: rows.reduce((s, r) => s + (r.output_tokens ?? 0), 0),
    avg_latency_ms: lat.length ? Math.round(lat.reduce((s, r) => s + r.latency_ms!, 0) / lat.length) : null,
    pass_hit_rate: passHit,
    awaiting_review: scoreOk && unreviewed > 0,
    // 검수하지 않은 근거답변에 잘못된 결론이 숨어 있을 수 있으므로 모두 검수해야 통과
    passed: scoreOk && unreviewed === 0,
  };
}

export async function buildRunWorkbook(db: DB, runId: number): Promise<Buffer> {
  const rows = db
    .prepare(
      `SELECT i.seq, i.question, i.business_type, i.expected_qa_ids, i.expected_type, r.*
       FROM eval_results r JOIN eval_items i ON i.id = r.item_id WHERE r.run_id = ? ORDER BY i.seq`,
    )
    .all(runId) as Record<string, unknown>[];
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('평가 결과');
  s.columns = [
    { header: '번호', key: 'seq', width: 6 },
    { header: '질문', key: 'question', width: 50 },
    { header: '사업 유형', key: 'business_type', width: 10 },
    { header: '기대 통합번호', key: 'expected', width: 16 },
    { header: '인용 통합번호', key: 'cited', width: 16 },
    { header: '인용 적중', key: 'cite_hit', width: 9 },
    { header: '검색 적중', key: 'retrieve_hit', width: 9 },
    { header: '기대 유형', key: 'expected_type', width: 11 },
    { header: '답변 유형', key: 'answer_type', width: 11 },
    { header: '유형 일치', key: 'type_match', width: 9 },
    { header: '검수 판정', key: 'verdict', width: 10 },
    { header: '검수 메모', key: 'verdict_note', width: 30 },
    { header: '답변', key: 'answer', width: 80 },
    { header: '오류', key: 'error', width: 30 },
  ];
  const ox = (v: unknown) => (v === null || v === undefined ? '-' : v ? 'O' : 'X');
  for (const r of rows) {
    s.addRow({
      ...r,
      expected: (JSON.parse(String(r.expected_qa_ids)) as string[]).join(', '),
      cited: (JSON.parse(String(r.cited_qa_ids)) as string[]).join(', '),
      cite_hit: ox(r.cite_hit),
      retrieve_hit: ox(r.retrieve_hit),
      type_match: ox(r.type_match),
      verdict: r.verdict === 'wrong' ? '잘못된 결론' : r.verdict === 'ok' ? '적절' : '',
    });
  }
  s.getRow(1).font = { bold: true };
  s.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
