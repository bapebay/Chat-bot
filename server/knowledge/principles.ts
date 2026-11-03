// 집행원리 CSV 읽기·양식 (서버와 데모 페이지가 함께 쓴다).
// 집행원리 = 그간 질의응답 사례에서 뽑은 일반 집행 기준. 근거 계층에서 지침·FAQ 다음, 표준답안 앞(2단계)이다.

export interface ParsedPrinciple {
  row: number;
  code: string;
  category: string;
  funding: string;
  period: string;
  text: string;
  note: string;
}

const HEADERS: Record<keyof Omit<ParsedPrinciple, 'row'>, string[]> = {
  code: ['번호', '원리번호', '코드', 'id', 'no'],
  category: ['분야', '구분', '분류', '대분류', '중분류', '항목', '비목'],
  funding: ['재원', '사업유형', '사업', '재원구분'],
  period: ['적용시기', '시기', '적용연도', '연도', '기준일', '적용일'],
  text: ['집행원리', '원리', '집행기준', '기준', '내용', '일반원칙', '원칙'],
  note: ['비고', '근거', '출처', '참고', '메모'],
};

const norm = (s: string) => s.replace(/^﻿/, '').replace(/\(.*?\)/g, '').replace(/[\s_·.-]/g, '').toLowerCase();

/** 엑셀이 한글 CSV를 CP949(EUC-KR)로 저장하는 경우가 많아, UTF-8로 안 읽히면 EUC-KR로 읽는다 */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}

/** 따옴표·쉼표·줄바꿈이 든 칸까지 읽는 CSV 해석 (RFC 4180) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export const MAX_PRINCIPLES = 3000;

/** 집행원리 CSV를 읽는다. '집행원리'(또는 내용·기준) 열은 필수, 나머지는 있으면 쓴다 */
export function parsePrinciplesCsv(bytes: Uint8Array): { items: ParsedPrinciple[]; warnings: string[] } {
  const rows = parseCsv(decodeCsv(bytes));
  if (!rows.length) throw new Error('파일이 비어 있습니다.');
  // 머리글 행: 처음 5행 안에서 '집행원리(내용)' 열이 있는 행
  let headerIdx = -1;
  let cols: Partial<Record<keyof typeof HEADERS, number>> = {};
  for (let r = 0; r < Math.min(5, rows.length) && headerIdx < 0; r++) {
    const found: typeof cols = {};
    rows[r].forEach((h, c) => {
      const n = norm(h);
      for (const [field, aliases] of Object.entries(HEADERS) as [keyof typeof HEADERS, string[]][]) {
        if (found[field] === undefined && aliases.includes(n)) found[field] = c;
      }
    });
    if (found.text !== undefined) {
      headerIdx = r;
      cols = found;
    }
  }
  if (headerIdx < 0) {
    throw new Error("‘집행원리’ 머리글을 찾지 못했습니다. 양식을 내려받아 첫 줄에 번호·분야·재원·적용시기·집행원리·비고를 적어 주세요.");
  }
  const get = (r: string[], c?: number) => (c === undefined ? '' : (r[c] ?? '').trim());
  const items: ParsedPrinciple[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  rows.slice(headerIdx + 1).forEach((r, i) => {
    const rowNo = headerIdx + i + 2; // 엑셀에서 보이는 행 번호
    const text = get(r, cols.text);
    if (!text) {
      if (r.some((c) => c.trim())) warnings.push(`${rowNo}행: 집행원리 내용이 비어 있어 건너뜁니다.`);
      return;
    }
    if (text.startsWith('(예시)')) return;
    const code = get(r, cols.code) || `P${items.length + 1}`;
    if (seen.has(code)) warnings.push(`${rowNo}행: 번호 ${code}가 앞에도 있습니다.`);
    seen.add(code);
    items.push({ row: rowNo, code, category: get(r, cols.category), funding: get(r, cols.funding), period: get(r, cols.period), text, note: get(r, cols.note) });
  });
  if (!items.length) throw new Error('읽을 집행원리가 없습니다. 머리글 아래에 내용을 적어 주세요.');
  if (items.length > MAX_PRINCIPLES) throw new Error(`한 번에 ${MAX_PRINCIPLES}건까지 올릴 수 있습니다.`);
  return { items, warnings };
}

/** 내려받는 양식 (엑셀에서 한글이 깨지지 않도록 UTF-8 BOM 포함) */
export function principlesTemplateCsv(): string {
  const lines = [
    '번호,분야,재원,적용시기,집행원리,비고',
    'P-001,인건비·수당,순수앵커,2026,"(예시) 과제책임자에게 해당 과제에서 수당을 지급하는 것은 불가하다.","관련 질의 다수"',
    'P-002,연구시설·장비,공통,2025~,"(예시) 추정가격 1억원 이상 연구장비는 발주 전에 심의를 거친 경우에 한해 집행할 수 있다.",',
  ];
  return '﻿' + lines.join('\r\n') + '\r\n';
}
