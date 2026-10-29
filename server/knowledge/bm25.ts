import { QUERY_STOP_TOKENS, tokenize } from './text.js';

/**
 * BM25 키워드 검색 + '핵심어 포함 비율(coverage)'.
 * coverage 는 질문 바이그램 중 문서에 들어 있는 것의 비율을 IDF로 가중한 값(0~1)이라
 * 질문이 달라도 같은 기준값으로 '근거 있음/없음'을 판단할 수 있다.
 */
export class Bm25 {
  private docs: Map<string, number>[] = [];
  private lengths: number[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  constructor(texts: string[]) {
    for (const t of texts) {
      const tf = new Map<string, number>();
      const tokens = tokenize(t);
      for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
      this.docs.push(tf);
      this.lengths.push(tokens.length);
      for (const tok of tf.keys()) this.df.set(tok, (this.df.get(tok) ?? 0) + 1);
    }
    const total = this.lengths.reduce((a, b) => a + b, 0);
    this.avgLen = this.docs.length ? Math.max(1, total / this.docs.length) : 1;
  }

  get size() {
    return this.docs.length;
  }

  private idf(tok: string): number {
    const n = this.docs.length;
    const df = this.df.get(tok) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** 모든 문서의 [bm25, coverage] */
  score(query: string): { bm25: number; coverage: number }[] {
    const qTokens = [...new Set(tokenize(query))].filter((t) => !QUERY_STOP_TOKENS.has(t));
    const idfs = qTokens.map((t) => this.idf(t));
    const idfSum = idfs.reduce((a, b) => a + b, 0) || 1;
    return this.docs.map((tf, i) => {
      let bm25 = 0;
      let covered = 0;
      qTokens.forEach((tok, k) => {
        const f = tf.get(tok);
        if (!f) return;
        covered += idfs[k];
        bm25 += (idfs[k] * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.lengths[i]) / this.avgLen));
      });
      return { bm25, coverage: covered / idfSum };
    });
  }
}
