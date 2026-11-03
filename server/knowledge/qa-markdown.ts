// 표준 Q&A를 마크다운(MD) 파일로 올릴 때 읽는 곳 (서버와 데모 페이지가 함께 쓴다).
// 두 가지 모양을 읽는다.
//   1) 표: 엑셀 '통합질의' 시트와 같은 머리글의 마크다운 표 (엑셀을 MD로 바꾼 파일)
//      | 통합번호 | 대분류 | 대표 질의 | 통합 답안 | ... |
//   2) 항목별 제목: 답안 하나마다 제목, 그 아래 '항목: 내용' 줄 (여러 줄 답안 가능)
//      ## B4-01
//      - 대분류: 순수앵커
//      - 대표 질의: 과제책임자에게 수당을 줄 수 있나요?
//      - 통합 답안: 불가합니다.
//        (다음 줄도 같은 항목으로 이어짐. '### 통합 답안'처럼 소제목으로 써도 됨)
// 머리글 이름·빈 칸·중복·개인정보 경고 규칙은 엑셀과 같다(collectQaItems).

import { collectQaItems, normHeader, QA_HEADERS, type ParsedQaItem, type QaField, type QaRow, type UploadWarning } from './excel.js';
import { decodeText, stripInlineMarkdown } from './guideline.js';

const REQUIRED: QaField[] = ['qa_id', 'question', 'answer'];

function fieldOf(label: string): QaField | null {
  const h = normHeader(stripInlineMarkdown(label)).replace(/[:：]$/, '');
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

/** 1) 마크다운 표 */
function readTables(lines: string[]): QaRow[] | null {
  const tables: { title: string; rows: QaRow[] }[] = [];
  let title = '';
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (h) title = h[1];
    if (!isTableLine(lines[i]) || !isSeparator(lines[i + 1] ?? '')) continue;
    const cols: Partial<Record<QaField, number>> = {};
    splitCells(lines[i]).forEach((c, idx) => {
      const f = fieldOf(c);
      if (f && cols[f] === undefined) cols[f] = idx;
    });
    const rows: QaRow[] = [];
    let j = i + 2;
    for (; j < lines.length && isTableLine(lines[j]); j++) {
      const cells = splitCells(lines[j]);
      rows.push({ row: j + 1, get: (f) => (cols[f] === undefined ? '' : cleanValue(cells[cols[f]!] ?? '')) });
    }
    if (REQUIRED.every((f) => cols[f] !== undefined)) tables.push({ title, rows });
    i = j - 1;
  }
  if (!tables.length) return null;
  // 엑셀처럼 '통합질의' 제목 아래 표가 있으면 그것만, 없으면 형식이 맞는 표를 모두 읽는다
  const main = tables.filter((t) => normHeader(stripInlineMarkdown(t.title)).includes('통합질의'));
  return (main.length ? main : tables).flatMap((t) => t.rows);
}

/** 2) 항목별 제목 + '항목: 내용' */
function readBlocks(lines: string[]): QaRow[] {
  interface Block {
    line: number;
    heading: string;
    fields: Partial<Record<QaField, string[]>>;
  }
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let field: QaField | null = null;
  const start = (line: number, heading: string) => {
    cur = { line, heading, fields: {} };
    blocks.push(cur);
    field = null;
  };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*$/);
    if (h) {
      const f = fieldOf(h[1]);
      // '### 통합 답안' 같은 소제목은 항목 이름, 그 밖의 제목은 새 답안의 시작
      if (f && cur && f !== 'qa_id') {
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
    const m = line.match(/^(?:[-*+]\s+)?(?:\*\*|__)?([^:：*_|]{1,20}?)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.*)$/);
    const f = m ? fieldOf(m[1]) : null;
    if (m && f) {
      // 제목 없이 '통합번호:' 줄로 답안을 나눈 파일도 읽는다
      if (!cur || (f === 'qa_id' && (cur as Block).fields.qa_id)) start(i + 1, '');
      field = f;
      (cur as unknown as Block).fields[f] = m[2] ? [m[2]] : [];
      return;
    }
    if (cur && field) (cur as Block).fields[field]!.push(raw.replace(/^\s{0,4}/, '').trimEnd());
  });
  return blocks
    .filter((b) => Object.keys(b.fields).length) // 제목만 있는 단원 제목은 건너뛴다
    .map((b) => {
      const val = (f: QaField) => cleanValue((b.fields[f] ?? []).join('\n'));
      // 제목이 '[B4-01] 대표 질의' 꼴이면 첫 낱말을 통합번호, 나머지를 대표 질의로 쓴다
      const [first = '', ...rest] = b.heading.split(/\s+/);
      const headId = first.replace(/^[[(]|[\])]$/g, '');
      return {
        row: b.line,
        get: (f: QaField) => {
          const v = val(f);
          if (v) return v;
          if (f === 'qa_id') return headId;
          if (f === 'question' && !b.fields.qa_id) return rest.join(' ');
          return '';
        },
      };
    });
}

/** 표준 Q&A 마크다운 파일을 읽는다 */
export function parseQaMarkdown(bytes: Uint8Array): { items: ParsedQaItem[]; warnings: UploadWarning[] } {
  const text = decodeText(bytes).replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '');
  const lines = text.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const rows = readTables(lines) ?? readBlocks(lines);
  const { items, warnings } = collectQaItems(rows);
  if (!items.length) {
    throw new Error(
      'MD 파일에서 표준답안을 찾지 못했습니다. 엑셀과 같은 머리글(통합번호·대표 질의·통합 답안)의 표로 쓰거나, 답안마다 ‘## 통합번호’ 제목 아래 ‘대표 질의: …’, ‘통합 답안: …’ 줄로 써 주세요.',
    );
  }
  return { items, warnings };
}

/** 확장자에 따라 엑셀 또는 MD로 읽는다 */
export const isQaMarkdown = (filename: string) => /\.(md|markdown)$/i.test(filename);
