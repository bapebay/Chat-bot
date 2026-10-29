/** 요청 값에서 앞뒤 공백을 지운 문자열을 꺼낸다. 문자열이 아니면 빈 문자열 */
export function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** URL 경로의 숫자 id. 올바르지 않으면 null */
export function idParam(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
