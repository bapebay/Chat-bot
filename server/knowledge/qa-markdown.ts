// 표준 Q&A를 마크다운(MD) 파일로 올릴 때 읽는 곳 (서버와 데모 페이지가 함께 쓴다).
// 파트별로 나눈 여러 파일을 한 번에 올려 하나의 버전으로 합칠 수 있다(combineQaFiles).
//
// 읽는 모양
//   1) 표: 머리글에 질문·답변 열이 있는 마크다운 표 (엑셀을 MD로 바꾼 파일 등)
//      | 통합번호 | 대분류 | 대표 질의 | 통합 답안 | ... |   ← 머리글 이름은 엑셀과 같은 별칭을 넓게 받음
//   2) 항목: 답안마다 제목, 그 아래 '항목: 내용' 줄 (여러 줄 답안 가능)
//      ## B4-01
//      - 대표 질의: …        (질문: / Q. / 문: 도 됨)
//      - 통합 답안: …        (답변: / A. / 답: 도 됨, '### 통합 답안' 소제목도 됨)
//   3) 질문 제목 + 본문: '### 과제책임자 수당을 줄 수 있나요?' 아래 본문을 답으로
// 통합번호가 없으면 '파일이름-001'처럼 붙이고 알려 준다.
// 빈 칸·중복·개인정보 경고 규칙은 엑셀과 같다(collectQaItems).

import { collectQaItems, normHeader, QA_HEADERS, type ParsedQaItem, type QaField, type QaRow, type UploadWarning } from './excel.js';
import { decodeText, stripInlineMarkdown } from './guideline.js';

const keyOf = (label: string) => normHeader(stripInlineMarkdown(label)).replace(/[·‧・.\-–—_/:：)\]]/g, '');

function fieldOf(label: string): QaField | null {
  const h = keyOf(label);
  if (!h) return null;
  for (const [field, aliases] of Object.entries(QA_HEADERS) as [QaField, string[]][]) if (aliases.includes(h)) return field;
  return null;
}

/** 칸·값 글자 정리: <br>은 줄바꿈으로, 꾸밈 기호는 걷어 낸다 */
function cleanValue(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .split('\n')
    .map((l) => stripInlineMarkdown(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const splitCells = (line: string) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/);
const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const looksLikeQuestion = (s: string) => /(\?|？|나요|까요|가요|는지|인지|습니까|니까|여부|되나|있나|하나|될까)\s*[.!]*$/.test(s);

interface Found {
  rows: QaRow[];
  /** 읽지 못했을 때 안내용: 파일에서 본 표 머리글 */
  headers: string[];
}

/** 1) 마크다운 표 */
function readTables(lines: string[]): Found {
  const tables: { title: string; rows: QaRow[] }[] = [];
  const headers: string[] = [];
  let title = '';
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (h) title = h[1];
    if (!isTableLine(lines[i]) || !isSeparator(lines[i + 1] ?? '')) continue;
    const cells = splitCells(lines[i]).map((c) => stripInlineMarkdown(c));
    headers.push(cells.join(' | '));
    const cols: Partial<Record<QaField, number>> = {};
    cells.forEach((c, idx) => {
      const f = fieldOf(c);
      if (f && cols[f] === undefined) cols[f] = idx;
    });
    const rows: QaRow[] = [];
    let j = i + 2;
    for (; j < lines.length && isTableLine(lines[j]); j++) {
      const row = splitCells(lines[j]);
      rows.push({ row: j + 1, get: (f) => (cols[f] === undefined ? '' : cleanValue(row[cols[f]!] ?? '')) });
    }
    if (cols.question !== undefined && cols.answer !== undefined) tables.push({ title, rows });
    i = j - 1;
  }
  // 엑셀처럼 '통합질의' 제목 아래 표가 있으면 그것만, 없으면 형식이 맞는 표를 모두 읽는다
  const main = tables.filter((t) => keyOf(t.title).includes('통합질의'));
  return { rows: (main.length ? main : tables).flatMap((t) => t.rows), headers };
}

// '항목: 내용' 줄 / 'Q. 내용', 'A) 내용', '문1. 내용' 줄
const FIELD_LINE = /^(?:[-*+]\s+)?(?:\*\*|__)?([^:：*_|]{1,20}?)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.*)$/;
const QA_LINE = /^(?:[-*+]\s+)?(?:\*\*|__)?(Q|A|문|답)\s*\d{0,3}\s*[.)．]\s*(?:\*\*|__)?\s*(.*)$/i;

/** 2)·3) 제목·항목 줄 */
function readBlocks(lines: string[]): QaRow[] {
  interface Block {
    line: number;
    heading: string;
    fields: Partial<Record<QaField, string[]>>;
    body: string[];
  }
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let field: QaField | null = null;
  const start = (line: number, heading: string): Block => {
    const b: Block = { line, heading, fields: {}, body: [] };
    blocks.push(b);
    cur = b;
    field = null;
    return b;
  };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*$/);
    if (h) {
      const f = fieldOf(h[1]);
      // '### 통합 답안' 같은 소제목은 항목 이름, 그 밖의 제목은 새 답안의 시작
      if (f && f !== 'qa_id' && cur && !(cur as Block).fields[f]) {
        field = f;
        (cur as Block).fields[f] = [];
      } else start(i + 1, stripInlineMarkdown(h[1]));
      return;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(line)) {
      cur = null; // 가로줄: 답안 구분
      field = null;
      return;
    }
    const qa = line.match(QA_LINE);
    const m = qa ? null : line.match(FIELD_LINE);
    let f: QaField | null = qa ? (/^(q|문)$/i.test(qa[1]) ? 'question' : 'answer') : m ? fieldOf(m[1]) : null;
    // 답변 본문 속 '구분: …', '분야: …' 같은 줄은 분류 항목이 아니라 답변의 일부로 본다
    if (f && field === 'answer' && !qa && ['category1', 'category2', 'category3'].includes(f)) f = null;
    if (f) {
      const value = (qa ? qa[2] : m![2]) ?? '';
      // 같은 항목이 또 나오면 다음 답안 (제목 없이 'Q. … A. …'을 이어 쓴 파일)
      let b: Block = cur ?? start(i + 1, '');
      if (b.fields[f] && (f === 'qa_id' || f === 'question')) b = start(i + 1, '');
      field = f;
      b.fields[f] = value ? [value] : [];
      return;
    }
    if (!cur) return;
    const b = cur as Block;
    if (field) b.fields[field]!.push(raw.replace(/^\s{0,4}/, '').trimEnd());
    else b.body.push(raw.trimEnd());
  });
  return blocks
    .map((b) => {
      const val = (f: QaField) => cleanValue((b.fields[f] ?? []).join('\n'));
      const body = cleanValue(b.body.join('\n'));
      // 제목이 '[B4-02] 질의' 꼴이면 첫 낱말을 통합번호로. 제목이 질문 꼴이면 제목이 질문, 아래 본문이 답
      const [first = '', ...rest] = b.heading.split(/\s+/);
      const idLike = /\d/.test(first) && first.length <= 20 && !looksLikeQuestion(first);
      const headId = idLike ? first.replace(/^[[(]|[\])]$|[.:]$/g, '') : '';
      const headQuestion = (idLike ? rest.join(' ') : b.heading).replace(/^[Qq문]\s*\d{0,3}\s*[.)．:]\s*/, '');
      const hasFields = Object.keys(b.fields).length > 0;
      if (!hasFields && !(body && looksLikeQuestion(headQuestion))) return null; // 단원 제목·설명 글은 건너뛴다
      return {
        row: b.line,
        get: (f: QaField) => {
          const v = val(f);
          if (v) return v;
          if (f === 'qa_id') return headId;
          if (f === 'question' && !b.fields.question) return headQuestion;
          if (f === 'answer' && !b.fields.answer) return body;
          return '';
        },
      } as QaRow;
    })
    .filter((r): r is QaRow => r !== null);
}

/** 통합번호가 없는 행에 '파일이름-001'처럼 번호를 붙인다 */
function withIds(rows: QaRow[], prefix: string): { rows: QaRow[]; added: number } {
  let n = 0;
  const out = rows.map((r) => {
    if (r.get('qa_id') || !r.get('question') || !r.get('answer')) return r;
    const id = `${prefix}-${String(++n).padStart(3, '0')}`;
    return { row: r.row, get: (f: QaField) => (f === 'qa_id' ? id : r.get(f)) };
  });
  return { rows: out, added: n };
}

/** 파일 이름에서 자동 번호 앞부분: '01_인건비.md' → '01_인건비' (공백·기호는 '_') */
const idPrefix = (filename: string) =>
  (filename.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'MD').slice(0, 20);

/** 표준 Q&A 마크다운 파일 하나를 읽는다 */
export function parseQaMarkdown(bytes: Uint8Array, filename = 'MD.md'): { items: ParsedQaItem[]; warnings: UploadWarning[] } {
  const text = decodeText(bytes).replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '');
  const lines = text.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const table = readTables(lines);
  const found = table.rows.length ? table.rows : readBlocks(lines);
  const { rows, added } = withIds(found, idPrefix(filename));
  const { items, warnings } = collectQaItems(rows);
  if (!items.length) {
    const seen = table.headers.length ? ` 이 파일에서 찾은 표 머리글: ${table.headers.slice(0, 3).map((h) => `‘${h}’`).join(', ')}.` : '';
    throw new Error(
      `표준답안을 찾지 못했습니다. 질문 열(대표 질의·질문·질의)과 답변 열(통합 답안·답변·답안)이 있는 표로 쓰거나, 답안마다 ‘질문: …’, ‘답변: …’(또는 Q. / A.) 줄로 써 주세요.${seen}`,
    );
  }
  if (added) warnings.unshift({ row: null, message: `통합번호가 없는 ${added}건에 ‘${idPrefix(filename)}-001’ 형식의 번호를 붙였습니다.` });
  // 검수상태를 적는 칸이 아예 없는 파일은 올린 관리자가 확정한 것으로 본다 (엑셀 양식에는 늘 있음)
  if (items.every((i) => !i.review_status)) {
    for (const i of items) i.review_status = '확정';
    warnings.unshift({ row: null, message: '검수상태 칸이 없어 모두 ‘확정’으로 봅니다. 미리보기에서 내용을 확인한 뒤 적용하세요.' });
  }
  return { items, warnings };
}

export const isQaMarkdown = (filename: string) => /\.(md|markdown)$/i.test(filename);

/**
 * 여러 파일(파트별 MD·엑셀)을 읽은 결과를 하나의 버전으로 합친다.
 * 경고에는 파일 이름을 붙이고, 파일끼리 통합번호가 겹치면 알린다.
 */
export function combineQaFiles(files: { name: string; items: ParsedQaItem[]; warnings: UploadWarning[] }[]): {
  items: ParsedQaItem[];
  warnings: UploadWarning[];
  filename: string;
} {
  const multi = files.length > 1;
  const items: ParsedQaItem[] = [];
  const warnings: UploadWarning[] = [];
  const owner = new Map<string, string>();
  for (const f of files) {
    const tag = multi ? `[${f.name}] ` : '';
    for (const w of f.warnings) warnings.push({ ...w, message: tag + w.message });
    for (const it of f.items) {
      const prev = owner.get(it.qa_id);
      if (prev && prev !== f.name) warnings.push({ row: it.row, qa_id: it.qa_id, message: `${tag}통합번호 ${it.qa_id}가 ‘${prev}’에도 있습니다.` });
      else owner.set(it.qa_id, f.name);
      items.push(it);
    }
  }
  const names = files.map((f) => f.name);
  const filename = names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} 외 ${names.length - 2}개`;
  return { items, warnings, filename: filename.slice(0, 200) };
}

/** 한 번에 올릴 수 있는 파일 수 */
export const MAX_QA_FILES = 30;
