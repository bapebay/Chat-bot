import type { DB } from '../db.js';
import { getNumberSetting, getSetting } from '../settings.js';
import { Bm25 } from './bm25.js';
import { dot, embedPassagesCached, type Embedder } from './embedder.js';

export interface QaDoc {
  id: number;
  qa_id: string;
  category1: string;
  category2: string;
  category3: string;
  question: string;
  checklist: string;
  answer: string;
  referral_answer: string;
  is_referral: number;
  review_status: string;
  change_history: string;
}

export interface GuidelineDoc {
  id: number;
  doc_id: number;
  doc_name: string;
  doc_kind: string;
  clause: string;
  page: number | null;
  text: string;
}

/** 집행원리: 질의응답 사례에서 뽑은 일반 집행 기준 (근거 2단계) */
export interface PrincipleDoc {
  id: number;
  code: string;
  category: string;
  funding: string;
  period: string;
  text: string;
  note: string;
}

export interface OutOfScopeDoc {
  id: number;
  question: string;
  guidance: string;
  department: string;
}

export interface Hit<T> {
  doc: T;
  /** 핵심어 포함 비율 0~1 */
  keyword: number;
  /** 의미 유사도 0~1 (의미 검색을 쓰지 않으면 null) */
  semantic: number | null;
  /** 정렬용 점수 */
  score: number;
  /** 기준값을 넘었는지 */
  relevant: boolean;
}

export interface SearchResult {
  qa: Hit<QaDoc>[];
  guideline: Hit<GuidelineDoc>[];
  principle: Hit<PrincipleDoc>[];
  outOfScope: Hit<OutOfScopeDoc> | null;
  /** 근거로 쓸 만한 항목이 하나라도 있는지 */
  passed: boolean;
  mode: 'hybrid' | 'keyword';
}

/** 질문마다 AI에 넘기는 집행원리 최대 건수 */
export const TOP_K_PRINCIPLE = 4;

/** 검수상태가 '확정'인지 (공백·표기 차이 허용) */
export function isConfirmed(status: string): boolean {
  return status.replace(/\s/g, '').startsWith('확정');
}

export function qaSearchText(d: Pick<QaDoc, 'question' | 'checklist' | 'category2' | 'category3'>): string {
  return [d.question, d.checklist, d.category2, d.category3].filter(Boolean).join('\n');
}

export function principleSearchText(d: Pick<PrincipleDoc, 'category' | 'text'>): string {
  return [d.category, d.text].filter(Boolean).join('\n');
}

function guidelineSearchText(d: GuidelineDoc): string {
  return `${d.clause}\n${d.text}`;
}

class Corpus<T> {
  readonly bm25: Bm25;
  vectors: Float32Array[] | null = null;
  constructor(
    readonly docs: T[],
    readonly texts: string[],
  ) {
    this.bm25 = new Bm25(texts);
  }

  /** 키워드·의미 점수를 합쳐 정렬 (순위 융합 RRF) */
  rank(query: string, queryVector: Float32Array | null, thresholds: { keyword: number; semantic: number }): Hit<T>[] {
    if (!this.docs.length) return [];
    const kw = this.bm25.score(query);
    const sem = queryVector && this.vectors ? this.vectors.map((v) => dot(queryVector, v)) : null;

    const rankOf = (values: number[]) => {
      const order = values.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
      const r = new Array<number>(values.length);
      order.forEach(([, i], pos) => (r[i] = pos));
      return r;
    };
    const kwRank = rankOf(kw.map((s) => s.bm25));
    const semRank = sem ? rankOf(sem) : null;

    return this.docs
      .map((doc, i) => {
        const semantic = sem ? sem[i] : null;
        let score = kw[i].bm25 > 0 ? 1 / (60 + kwRank[i]) : 0;
        if (semRank) score += 1 / (60 + semRank[i]);
        const relevant = kw[i].coverage >= thresholds.keyword || (semantic !== null && semantic >= thresholds.semantic);
        return { doc, keyword: kw[i].coverage, semantic, score, relevant };
      })
      .filter((h) => h.score > 0);
  }
}

/** 표준 Q&A·지침·답변범위 외 목록의 검색 색인. 데이터가 바뀌면 rebuild() */
export class KnowledgeBase {
  private qa = new Corpus<QaDoc>([], []);
  private guideline = new Corpus<GuidelineDoc>([], []);
  private principle = new Corpus<PrincipleDoc>([], []);
  private oos = new Corpus<OutOfScopeDoc>([], []);
  private generation = 0;
  private embeddingReady: Promise<void> = Promise.resolve();
  embeddingError: string | null = null;

  constructor(
    private db: DB,
    private embedder: Embedder | null,
    private log: (msg: string) => void = () => undefined,
  ) {}

  get semanticEnabled() {
    return !!this.embedder;
  }

  get stats() {
    return {
      qa: this.qa.docs.length,
      guideline: this.guideline.docs.length,
      principle: this.principle.docs.length,
      out_of_scope: this.oos.docs.length,
      semantic_model: this.embedder?.name ?? null,
      semantic_ready: !!this.embedder && this.qa.vectors !== null && this.guideline.vectors !== null && this.principle.vectors !== null && this.oos.vectors !== null,
      semantic_error: this.embeddingError,
    };
  }

  /** 서비스 중인 데이터를 DB에서 다시 읽어 색인을 만든다. 키워드 색인은 즉시, 의미 색인은 뒤에서 계산 */
  rebuild(): Promise<void> {
    const gen = ++this.generation;
    const includeUnreviewed = getSetting(this.db, 'include_unreviewed') === 'true';
    const qaDocs = (
      this.db
        .prepare(
          `SELECT i.* FROM qa_items i JOIN qa_versions v ON v.id = i.version_id
           WHERE v.status = 'active' ORDER BY i.id`,
        )
        .all() as QaDoc[]
    ).filter((d) => includeUnreviewed || isConfirmed(d.review_status));
    const guideDocs = this.db
      .prepare(
        `SELECT c.id, c.doc_id, d.name AS doc_name, d.kind AS doc_kind, c.clause, c.page, c.text
         FROM guideline_chunks c JOIN guideline_docs d ON d.id = c.doc_id
         WHERE d.active = 1 ORDER BY d.id, c.seq`,
      )
      .all() as GuidelineDoc[];
    const principleDocs = this.db
      .prepare(`SELECT p.* FROM principles p JOIN principle_sets s ON s.id = p.set_id WHERE s.status = 'active' ORDER BY p.id`)
      .all() as PrincipleDoc[];
    const oosDocs = this.db.prepare('SELECT * FROM out_of_scope ORDER BY id').all() as OutOfScopeDoc[];

    const qa = new Corpus(qaDocs, qaDocs.map(qaSearchText));
    const guideline = new Corpus(guideDocs, guideDocs.map(guidelineSearchText));
    const principle = new Corpus(principleDocs, principleDocs.map(principleSearchText));
    const oos = new Corpus(oosDocs, oosDocs.map((d) => d.question));
    this.qa = qa;
    this.guideline = guideline;
    this.principle = principle;
    this.oos = oos;

    if (!this.embedder) return Promise.resolve();
    const embedder = this.embedder;
    this.embeddingError = null;
    this.embeddingReady = (async () => {
      try {
        for (const corpus of [qa, guideline, principle, oos] as Corpus<unknown>[]) {
          const vectors = await embedPassagesCached(this.db, embedder, corpus.texts);
          if (gen !== this.generation) return; // 그사이 데이터가 또 바뀜
          corpus.vectors = vectors;
        }
        this.log(`의미 검색 색인 완료 (표준답안 ${qa.docs.length}, 지침 ${guideline.docs.length}, 집행원리 ${principle.docs.length})`);
      } catch (e) {
        this.embeddingError = (e as Error).message;
        this.log(`의미 검색 색인 실패, 키워드 검색만 사용: ${this.embeddingError}`);
      }
    })();
    return this.embeddingReady;
  }

  async search(query: string, businessType: string): Promise<SearchResult> {
    const thresholds = {
      keyword: getNumberSetting(this.db, 'threshold_keyword'),
      semantic: getNumberSetting(this.db, 'threshold_semantic'),
    };
    const topQa = getNumberSetting(this.db, 'top_k_qa');
    const topGuide = getNumberSetting(this.db, 'top_k_guideline');

    const semanticReady = this.stats.semantic_ready;
    let qv: Float32Array | null = null;
    if (this.embedder && semanticReady) {
      try {
        [qv] = await this.embedder.embed([query], 'query');
      } catch {
        qv = null;
      }
    }

    // 선택한 사업 유형의 답안을 우선한다 (대분류에 사업명이 들어 있으면 가산, '공통'은 조금 가산)
    const qaHits = this.qa.rank(query, qv, thresholds).map((h) => {
      const c1 = h.doc.category1;
      let boost = 1;
      if (businessType && !['모름', '기타'].includes(businessType) && c1.includes(businessType)) boost = 1.3;
      else if (c1.includes('공통')) boost = 1.1;
      return { ...h, score: h.score * boost };
    });

    const pick = <T>(hits: Hit<T>[], k: number) => {
      const sorted = hits.sort((a, b) => b.score - a.score);
      // 기준값을 넘은 항목을 먼저, 모자라면 기준에 가까운 항목으로 채운다
      const relevant = sorted.filter((h) => h.relevant);
      const near = sorted.filter(
        (h) => !h.relevant && (h.keyword >= thresholds.keyword * 0.6 || (h.semantic ?? 0) >= thresholds.semantic - 0.03),
      );
      return [...relevant, ...near].slice(0, k);
    };

    const qa = pick(qaHits, topQa);
    const guideline = pick(this.guideline.rank(query, qv, thresholds), topGuide);
    const principle = pick(this.principle.rank(query, qv, thresholds), TOP_K_PRINCIPLE);
    const oosTop = this.oos.rank(query, qv, thresholds).sort((a, b) => b.score - a.score)[0] ?? null;

    return {
      qa,
      guideline,
      principle,
      outOfScope: oosTop && oosTop.relevant ? oosTop : null,
      passed: qa.some((h) => h.relevant) || guideline.some((h) => h.relevant) || principle.some((h) => h.relevant),
      mode: qv ? 'hybrid' : 'keyword',
    };
  }
}

/** 두 검색 결과 중 더 관련도가 높은 쪽 비교용 (의미 점수가 있으면 의미, 없으면 키워드) */
export function strength(h: Hit<unknown> | undefined | null): number {
  if (!h) return 0;
  return h.semantic ?? h.keyword;
}
