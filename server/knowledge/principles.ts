// 집행원리 CSV 읽기·양식 (서버와 데모 페이지가 함께 쓴다).
// 집행원리 = 그간 질의응답 사례에서 뽑은 일반 집행 기준. 근거 계층에서 지침·FAQ 다음, 표준답안 앞(2단계)이다.

export interface ParsedPrinciple {
  row: number;
  /** 원칙 ID */
  code: string;
  /** 중분류 */
  category: string;
  /** 세분류 */
  subcategory: string;
  /** 질문 키워드 */
  keywords: string;
  /** 답변 원칙 (필수) */
  text: string;
  /** 세부 설명 */
  detail: string;
  /** 예외·유의점 */
  caution: string;
  /** 연결처 */
  referral: string;
  /** 공개 근거 (지침·법령·FAQ) */
  basis: string;
}

type PrincipleField = keyof Omit<ParsedPrinciple, 'row'>;

/** CSV 머리글(공백·괄호·가운뎃점·하이픈 무시) → 필드 */
const HEADERS: Record<PrincipleField, string[]> = {
  code: ['원칙id', '원칙번호', '원칙코드', 'id', '번호', '코드', 'no'],
  category: ['중분류', '분야', '구분', '분류', '대분류', '비목'],
  subcategory: ['세분류', '소분류', '세부분류', '세부항목'],
  keywords: ['질문키워드', '키워드', '검색어', '질의키워드', '질문'],
  text: ['답변원칙', '집행원리', '원칙', '원리', '집행기준', '기준', '내용', '일반원칙'],
  detail: ['세부설명', '설명', '상세설명', '상세', '해설'],
  caution: ['예외유의점', '예외및유의점', '예외유의사항', '예외', '유의점', '유의사항', '주의사항'],
  referral: ['연결처', '연결', '문의처', '연결기관', '담당'],
  basis: ['공개근거', '근거', '출처', '관련근거', '참고근거'],
};

// '공개근거(지침,법령,FAQ)'처럼 괄호 설명이 붙거나, 따옴표 없이 저장되어 괄호 안 쉼표에서 칸이 갈라져도 앞부분으로 알아본다
const norm = (s: string) =>
  s.replace(/^\uFEFF/, '').replace(/\(.*?(?:\)|$)/g, '').replace(/[\s_·‧・.,\-–—/()]/g, '').toLowerCase();

/** 집행원리 검색에 쓰는 글: 분류·질문 키워드·답변 원칙·세부 설명·예외 (서버와 데모 공통) */
export function principleSearchText(d: Pick<ParsedPrinciple, 'category' | 'subcategory' | 'keywords' | 'text' | 'detail' | 'caution'>): string {
  return [d.category, d.subcategory, d.keywords, d.text, d.detail, d.caution].filter(Boolean).join('\n');
}

const clean = (s: string) => (s ?? '').replace(/[|\]]/g, '/');

/**
 * 집행원리 한 건을 AI에 넘기는 모양 (서버와 데모 공통).
 * 원칙 ID는 넣지 않는다: 집행원리 번호가 답변에 새어 나가지 않게.
 */
export function principleContext(d: Omit<ParsedPrinciple, 'row' | 'code'>, i: number): string {
  const area = [d.category, d.subcategory].map(clean).filter(Boolean).join(' > ') || '-';
  return [
    `[집행원리 P${i + 1} | 분야: ${area} | 연결처: ${clean(d.referral) || '-'}]`,
    d.keywords ? `질문 키워드: ${d.keywords}` : '',
    `답변 원칙: ${d.text}`,
    d.detail ? `세부 설명: ${d.detail}` : '',
    d.caution ? `예외·유의점: ${d.caution}` : '',
    d.basis ? `공개 근거: ${d.basis}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

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

/** 집행원리 CSV를 읽는다. '답변 원칙' 열은 필수, 나머지는 있으면 쓴다 */
export function parsePrinciplesCsv(bytes: Uint8Array): { items: ParsedPrinciple[]; warnings: string[] } {
  const rows = parseCsv(decodeCsv(bytes));
  if (!rows.length) throw new Error('파일이 비어 있습니다.');
  // 머리글 행: 처음 5행 안에서 '답변 원칙' 열이 있는 행
  let headerIdx = -1;
  let cols: Partial<Record<PrincipleField, number>> = {};
  for (let r = 0; r < Math.min(5, rows.length) && headerIdx < 0; r++) {
    const found: typeof cols = {};
    rows[r].forEach((h, c) => {
      const n = norm(h);
      if (!n) return;
      for (const [field, aliases] of Object.entries(HEADERS) as [PrincipleField, string[]][]) {
        if (found[field] === undefined && aliases.includes(n)) {
          found[field] = c;
          break;
        }
      }
    });
    if (found.text !== undefined) {
      headerIdx = r;
      cols = found;
    }
  }
  if (headerIdx < 0) {
    throw new Error(
      "‘답변 원칙’ 머리글을 찾지 못했습니다. 첫 줄에 원칙 ID·중분류·세분류·질문 키워드·답변 원칙·세부 설명·예외·유의점·연결처·공개 근거를 적어 주세요.",
    );
  }
  // 공개 근거가 맨 끝 열이면, 따옴표 없이 쉼표로 갈라진 뒷부분까지 이어 붙인다 (예: 지침 제5조, FAQ 12)
  const lastCol = Math.max(...Object.values(cols));
  const basisLast = cols.basis !== undefined && cols.basis === lastCol;
  const get = (r: string[], f: PrincipleField) => {
    const c = cols[f];
    if (c === undefined) return '';
    if (f === 'basis' && basisLast) return r.slice(c).map((x) => x.trim()).filter(Boolean).join(', ');
    return (r[c] ?? '').trim();
  };
  const items: ParsedPrinciple[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  rows.slice(headerIdx + 1).forEach((r, i) => {
    const rowNo = headerIdx + i + 2; // 엑셀에서 보이는 행 번호
    const text = get(r, 'text');
    if (!text) {
      if (r.some((c) => c.trim())) warnings.push(`${rowNo}행: 답변 원칙이 비어 있어 건너뜁니다.`);
      return;
    }
    if (text.startsWith('(예시)')) return;
    const code = get(r, 'code') || `P${items.length + 1}`;
    if (seen.has(code)) warnings.push(`${rowNo}행: 원칙 ID ${code}가 앞에도 있습니다.`);
    seen.add(code);
    items.push({
      row: rowNo,
      code,
      category: get(r, 'category'),
      subcategory: get(r, 'subcategory'),
      keywords: get(r, 'keywords'),
      text,
      detail: get(r, 'detail'),
      caution: get(r, 'caution'),
      referral: get(r, 'referral'),
      basis: get(r, 'basis'),
    });
  });
  if (!items.length) throw new Error('읽을 집행원리가 없습니다. 머리글 아래에 내용을 적어 주세요.');
  if (items.length > MAX_PRINCIPLES) throw new Error(`한 번에 ${MAX_PRINCIPLES}건까지 올릴 수 있습니다.`);
  return { items, warnings };
}

/** 내려받는 양식 (엑셀에서 한글이 깨지지 않도록 UTF-8 BOM 포함) */
export function principlesTemplateCsv(): string {
  const lines = [
    '원칙 ID,중분류,세분류,질문키워드,답변원칙,세부설명,예외·유의점,연결처,"공개근거(지침,법령,FAQ)"',
    'P-001,인건비,수당,"과제책임자 수당, 책임자 수당","(예시) 과제책임자에게 해당 과제에서 수당을 지급할 수 없다.","(예시) 다른 과제 참여 수당은 그 과제 기준에 따른다.","(예시) 겸직 여부에 따라 달라질 수 있다.",지역앵커센터,"(예시) 지침 제00조, FAQ 00"',
    'P-002,연구시설·장비,구입,"장비 심의, 사후 심의","(예시) 추정가격 1억원 이상 연구장비는 발주 전에 심의를 거친 경우에만 집행할 수 있다.",,"(예시) 사후 심의는 인정되지 않는다.",재단,"(예시) 지침 제00조"',
  ];
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
