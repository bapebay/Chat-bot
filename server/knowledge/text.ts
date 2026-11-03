// 한국어 검색용 텍스트 처리. 형태소 분석기 없이 '두 글자 묶음(바이그램)'으로 쪼갠다.
// 예: "보직수당 한도" → 보직, 직수, 수당, 한도
// 조사·어미가 붙어도 핵심어 바이그램은 그대로 남아 부분 일치가 된다.

export function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

// 단어 끝의 조사·어미. 긴 것부터 하나만 떼어 낸다 ("한도는" → "한도", "가능한가요" → "가능")
const SUFFIXES = [
  '하였습니까', '되었습니까', '할수있나요', '할수있는지', '해야하나요', '해야하는지',
  '인가요', '한가요', '되나요', '있나요', '없나요', '하나요', '할까요', '될까요', '인지요', '입니까', '습니까', '합니까',
  '에서는', '으로는', '에게는', '까지는', '부터는', '이라도', '이라면', '하려면', '되려면', '인지', '는지', '한지', '할지',
  '에서', '으로', '에게', '까지', '부터', '이나', '에는', '와는', '과는', '이며', '이고', '하고', '하면', '되면', '해도', '여부',
  '은', '는', '이', '가', '을', '를', '에', '의', '로', '와', '과', '도', '만', '요',
];

function stripSuffix(w: string): string {
  if (!/[\p{Script=Hangul}]$/u.test(w)) return w;
  for (const s of SUFFIXES) {
    if (w.length - s.length >= 2 && w.endsWith(s)) return w.slice(0, -s.length);
  }
  return w;
}

// 질문에만 흔히 나오는 의문사·말끝 묶음은 검색어에서 뺀다
// (구어체 말끝 '받을수 있셈?', '되냐', '해줘' 등이 '자료에 없는 낱말'로 잡혀 근거 판정을 떨어뜨리지 않게)
export const QUERY_STOP_TOKENS = new Set([
  '얼마', '어떻', '떻게', '무엇', '어떤', '어느', '언제', '어디', '궁금', '금합', '알려', '려주', '주세', '세요', '문의', '질문', '경우',
  '있셈', '있음', '있어', '있냐', '있니', '있죠', '을수', '할수', '되냐', '되니', '되죠', '려줘', '해줘', '줘요', '건가', '는건', '할래', '나요', '가요',
]);

/** 검색용 낱말 목록 (조사·어미를 떼고, 한 글자 낱말은 버림) */
export function words(text: string): string[] {
  // 한 글자 단어(제, 로, 수 …)는 대부분 조사·대명사라 버린다
  return (normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []).map(stripSuffix).filter((w) => w.length > 1);
}

export function bigrams(word: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < word.length - 1; i++) out.push(word.slice(i, i + 2));
  return out;
}

export function tokenize(text: string): string[] {
  return words(text).flatMap(bigrams);
}

// ----- 같은 뜻 다른 말 (질문 낱말과 자료 낱말이 달라 근거를 못 찾는 경우) -----
// 실제 자료(표준답안·지침·집행원리)에 많이 쓰인 말을 함께 찾는다. 예: 자료에는 '출장비'보다 '여비'가 훨씬 많다.
// 한 줄 = 같은 뜻의 말 묶음. 질문에 어느 하나가 있으면 나머지로 바꾼 질문으로도 찾아 가장 잘 맞는 결과를 쓴다.
export const SYNONYM_GROUPS: string[][] = [
  ['출장비', '여비', '출장여비'],
  ['결재', '품의'],
  ['사전결재', '사전품의'],
  ['과제책임자', '연구책임자'],
  ['부서책임자', '부서장'],
  ['강사비', '강사료'],
  ['회의경비', '회의비'],
  ['밥값', '식비', '식대'],
  ['기자재', '장비'],
  ['내년', '차년도', '다음연도'],
  ['남은돈', '잔액', '집행잔액'],
  ['해외', '국외'],
  ['자문비', '자문료'],
  ['인센티브', '성과급'],
  ['RISE', '앵커'],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 낱말 사이 띄어쓰기는 있어도 없어도 같게 본다 ('과제 책임자' = '과제책임자')
const loose = (term: string) => new RegExp([...term].map(escapeRe).join('\\s*'), 'gi');

/** 질문과, 같은 뜻의 다른 말로 바꾼 질문들 (원문이 맨 앞, 최대 4개) */
export function queryVariants(query: string): string[] {
  const variants = [query];
  for (const group of SYNONYM_GROUPS) {
    const found = group.find((t) => loose(t).test(query));
    if (!found) continue;
    for (const alt of group) {
      if (alt === found || variants.length >= 4) continue;
      variants.push(query.replace(loose(found), alt));
    }
  }
  return variants;
}

// ----- 개인정보 패턴 (전화번호·이메일·주민등록번호·계좌번호) -----

export interface PiiMatch {
  kind: '전화번호' | '이메일' | '주민등록번호' | '계좌번호';
  text: string;
}

const PII_PATTERNS: { kind: PiiMatch['kind']; re: RegExp; valid?: (s: string) => boolean }[] = [
  { kind: '이메일', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: '주민등록번호', re: /\b\d{6}[-\s]?[1-4]\d{6}\b/g },
  { kind: '전화번호', re: /\b0\d{1,2}[-.\s)]\d{3,4}[-.\s]\d{4}\b|\b01[016789]\d{7,8}\b/g },
  // 날짜(2026-03-01) 등과 구분하려고 숫자가 10자리 이상인 것만 계좌번호로 본다
  { kind: '계좌번호', re: /\b\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,6})?\b/g, valid: (s) => s.replace(/\D/g, '').length >= 10 },
];

export function findPii(text: string): PiiMatch[] {
  const found: PiiMatch[] = [];
  const taken: [number, number][] = [];
  for (const { kind, re, valid } of PII_PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (valid && !valid(m[0])) continue;
      const start = m.index!;
      const end = start + m[0].length;
      // 앞 패턴(예: 주민번호)과 겹치는 부분은 한 번만 센다
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      found.push({ kind, text: m[0] });
    }
  }
  return found;
}

/** 개인정보 패턴을 [전화번호] 같은 표시로 바꾼다 */
export function maskPii(text: string): string {
  let out = text;
  for (const m of findPii(text)) out = out.split(m.text).join(`[${m.kind}]`);
  return out;
}
