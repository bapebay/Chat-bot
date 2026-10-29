// 개인정보 패턴 (server/knowledge/text.ts 와 같은 규칙). 보내기 전에 화면에서 경고하는 용도
export interface PiiMatch {
  kind: '전화번호' | '이메일' | '주민등록번호' | '계좌번호';
  text: string;
}

const PATTERNS: { kind: PiiMatch['kind']; re: RegExp; valid?: (s: string) => boolean }[] = [
  { kind: '이메일', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: '주민등록번호', re: /\b\d{6}[-\s]?[1-4]\d{6}\b/g },
  { kind: '전화번호', re: /\b0\d{1,2}[-.\s)]\d{3,4}[-.\s]\d{4}\b|\b01[016789]\d{7,8}\b/g },
  { kind: '계좌번호', re: /\b\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,6})?\b/g, valid: (s) => s.replace(/\D/g, '').length >= 10 },
];

export function findPii(text: string): PiiMatch[] {
  const found: PiiMatch[] = [];
  const taken: [number, number][] = [];
  for (const { kind, re, valid } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (valid && !valid(m[0])) continue;
      const start = m.index!;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      found.push({ kind, text: m[0] });
    }
  }
  return found;
}

export function maskPii(text: string): string {
  let out = text;
  for (const m of findPii(text)) out = out.split(m.text).join(`[${m.kind}]`);
  return out;
}
