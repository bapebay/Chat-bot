import { bigrams, QUERY_STOP_TOKENS, queryVariants, tokenize, words } from './text.js';

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
    const idfs = [...this.df.keys()].map((t) => this.idf(t)).sort((a, b) => a - b);
    this.unseenIdf = idfs.length ? idfs[Math.floor(idfs.length / 2)] : 1;
  }

  /**
   * 자료 어디에도 없는 낱말의 가중치. 그대로 IDF를 매기면 가장 무겁게 잡혀
   * "연락 주세요" 같은 군더더기만으로 근거 판정이 떨어지므로, 보통 낱말 수준(중앙값)으로 둔다.
   */
  private unseenIdf = 1;

  get size() {
    return this.docs.length;
  }

  private idf(tok: string): number {
    const n = this.docs.length;
    const df = this.df.get(tok) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * 질문 검색어. 띄어쓰기 없이 붙여 쓴 말('회의비집행기준')은 낱말 경계에 '비집'·'행기' 같은
   * 자료에 없는 묶음이 생겨 근거 판정을 떨어뜨리므로, 앞뒤 묶음은 자료에 있는데 그 묶음만 없으면 뺀다.
   */
  private queryTokens(query: string): string[] {
    const out = new Set<string>();
    for (const w of words(query)) {
      const bg = bigrams(w);
      bg.forEach((b, i) => {
        const junction = !this.df.has(b) && i > 0 && i < bg.length - 1 && this.df.has(bg[i - 1]) && this.df.has(bg[i + 1]);
        if (!junction) out.add(b);
      });
    }
    return [...out].filter((t) => !QUERY_STOP_TOKENS.has(t));
  }

  /**
   * 모든 문서의 [bm25, coverage].
   * 같은 뜻의 다른 말로 바꾼 질문('출장비' → '여비')으로도 찾아 문서마다 가장 잘 맞는 값을 쓴다.
   */
  score(query: string): { bm25: number; coverage: number }[] {
    const variants = queryVariants(query);
    const all = variants.map((v) => this.scoreOne(v));
    if (all.length === 1) return all[0];
    return all[0].map((_, i) => ({ bm25: Math.max(...all.map((s) => s[i].bm25)), coverage: Math.max(...all.map((s) => s[i].coverage)) }));
  }

  private scoreOne(query: string): { bm25: number; coverage: number }[] {
    const qTokens = this.queryTokens(query);
    const idfs = qTokens.map((t) => (this.df.has(t) ? this.idf(t) : this.unseenIdf));
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
