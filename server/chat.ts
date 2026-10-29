import { config } from './config.js';
import type { DB } from './db.js';
import { OUTPUT_INSTRUCTIONS } from './defaults.js';
import { strength, type GuidelineDoc, type Hit, type KnowledgeBase, type QaDoc, type SearchResult } from './knowledge/index.js';
import type { ChatTurn, LlmClient } from './llm/index.js';
import { getSetting } from './settings.js';

export interface MessageRow {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant';
  content: string;
  answer_type: string | null;
  citations: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

export const ANSWER_TYPES = ['근거답변', '연결형', '답변범위외', '근거없음'] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];
const REFERRALS = ['지역앵커센터', '대학규정', 'e나라도움', '교육부', '담당자'] as const;

/** 화면의 근거 카드에 쓰는 정보 (messages.citations 에 JSON으로 저장) */
export interface Citations {
  business_type: string | null;
  referral: string | null;
  qa: {
    qa_id: string;
    category1: string;
    category2: string;
    question: string;
    answer: string;
    referral_answer: string;
    is_referral: boolean;
    review_status: string;
    change_history: string;
  }[];
  guideline: { id: string; doc_name: string; doc_kind: string; clause: string; page: number | null; text: string }[];
  out_of_scope: { question: string; guidance: string; department: string } | null;
  /** 검색 기록 (검토·통계용) */
  retrieved: {
    mode: SearchResult['mode'];
    qa: { qa_id: string; keyword: number; semantic: number | null; relevant: boolean }[];
    guideline: { id: string; clause: string; keyword: number; semantic: number | null; relevant: boolean }[];
  };
}

export const DISCLAIMER_SEPARATOR = '\n\n---\n\n> ';

export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer_type', 'business_type', 'answer_markdown', 'cited_qa_ids', 'cited_guideline', 'referral'],
  properties: {
    answer_type: { type: 'string', enum: [...ANSWER_TYPES] },
    business_type: { type: 'string', enum: ['순수앵커', '글로컬', '의대교육', '초광역', '기타', '공통'] },
    answer_markdown: { type: 'string' },
    cited_qa_ids: { type: 'array', items: { type: 'string' } },
    cited_guideline: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'clause', 'page'],
        properties: { id: { type: 'string' }, clause: { type: 'string' }, page: { type: 'string' } },
      },
    },
    referral: { type: 'string', enum: [...REFERRALS, '없음'] },
  },
} as const;

/**
 * 시스템 프롬프트 = 관리자 프롬프트 + 답변 원칙 + 출력 형식.
 * 매 질문 같은 내용이어야 캐시가 되므로 질문마다 바뀌는 근거 자료는 사용자 메시지 쪽에 넣는다.
 */
export function buildSystemPrompt(db: DB): string {
  const principles = getSetting(db, 'principles').trim();
  return [
    getSetting(db, 'system_prompt'),
    principles ? `# 답변 원칙 (담당자가 검수하며 정한 기준, 항상 지킨다)\n${principles}` : '',
    OUTPUT_INSTRUCTIONS,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const clean = (s: string) => s.replace(/[|\]]/g, '/');

function guidelineKey(h: Hit<GuidelineDoc>, i: number) {
  return `G${i + 1}`;
}

/** 검색된 근거를 모델에 넘길 글로 만든다 */
export function buildContext(result: SearchResult): string {
  const parts: string[] = [];
  for (const h of result.qa) {
    const d = h.doc;
    parts.push(
      [
        `[표준답안 통합번호: ${clean(d.qa_id)} | 대분류: ${clean(d.category1) || '-'} | 중분류: ${clean(d.category2) || '-'} | 연결형: ${d.is_referral ? '예' : '아니오'}]`,
        `대표 질의: ${d.question}`,
        d.checklist ? `요지: ${d.checklist}` : '',
        `통합 답안: ${d.answer}`,
        d.referral_answer ? `연결형 답변: ${d.referral_answer}` : '',
        d.change_history ? `답변 변경 이력: ${d.change_history}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  result.guideline.forEach((h, i) => {
    const d = h.doc;
    parts.push(
      `[지침 ${guidelineKey(h, i)} | ${clean(d.clause)} | 문서: ${clean(d.doc_name)} | 쪽: ${d.page ?? ''}]\n${d.text}`,
    );
  });
  return parts.join('\n\n');
}

/** 모델 출력에서 JSON을 꺼낸다. 코드블록·앞뒤 설명이 섞여도 첫 { 부터 마지막 } 까지 읽는다 */
export function parseModelJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function recentHistory(rows: MessageRow[], limit: number): ChatTurn[] {
  let recent = rows.slice(-limit);
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
  return recent.map((m) => ({ role: m.role, content: stripDisclaimer(m.content) }));
}

export function stripDisclaimer(content: string): string {
  const i = content.lastIndexOf(DISCLAIMER_SEPARATOR);
  return i >= 0 ? content.slice(0, i) : content;
}

export function listMessages(db: DB, conversationId: number): MessageRow[] {
  return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId) as MessageRow[];
}

function retrievedLog(result: SearchResult): Citations['retrieved'] {
  return {
    mode: result.mode,
    qa: result.qa.map((h) => ({ qa_id: h.doc.qa_id, keyword: round(h.keyword), semantic: h.semantic === null ? null : round(h.semantic), relevant: h.relevant })),
    guideline: result.guideline.map((h, i) => ({
      id: guidelineKey(h, i),
      clause: h.doc.clause,
      keyword: round(h.keyword),
      semantic: h.semantic === null ? null : round(h.semantic),
      relevant: h.relevant,
    })),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function qaCard(d: QaDoc): Citations['qa'][number] {
  return {
    qa_id: d.qa_id,
    category1: d.category1,
    category2: d.category2,
    question: d.question,
    answer: d.answer,
    referral_answer: d.referral_answer,
    is_referral: !!d.is_referral,
    review_status: d.review_status,
    change_history: d.change_history,
  };
}

interface Answer {
  text: string;
  answerType: AnswerType;
  citations: Citations;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

const NO_EVIDENCE_TEXT = [
  '**답변 요약**: 등록된 지침과 표준답안에서 이 질문의 근거를 찾지 못했습니다.',
  '',
  '추측으로 안내하지 않기 위해 답변을 드리지 않습니다. 질문을 조금 더 구체적으로(사업 유형, 비목, 상황) 바꿔 다시 물어보시거나, 아래 **담당자에게 문의**로 남겨 주시면 담당자가 확인합니다.',
].join('\n');

function outOfScopeText(h: Hit<{ guidance: string; department: string }>): string {
  return [
    '**답변 요약**: 사업비 지침 챗봇의 답변 범위가 아닙니다.',
    '',
    h.doc.guidance || '이 질문은 사업비 집행 및 관리 지침 안내 범위를 벗어납니다. 담당 부서에 문의해 주세요.',
    h.doc.department ? `\n**담당 부서**: ${h.doc.department}` : '',
  ].join('\n');
}

async function generateAnswer(
  db: DB,
  llm: LlmClient,
  kb: KnowledgeBase,
  history: MessageRow[],
  businessType: string,
  question: string,
): Promise<Answer> {
  let result = await kb.search(question, businessType);
  // 짧은 후속 질문("그럼 글로컬은요?")은 직전 질문과 합쳐 다시 찾아본다
  const prevQuestion = [...history].reverse().find((m) => m.role === 'user')?.content;
  if (!result.passed && prevQuestion) {
    const retry = await kb.search(`${prevQuestion}\n${question}`, businessType);
    if (retry.passed) result = retry;
  }

  const base: Citations = {
    business_type: null,
    referral: null,
    qa: [],
    guideline: [],
    out_of_scope: null,
    retrieved: retrievedLog(result),
  };
  const noModel = { provider: null, model: null, inputTokens: null, outputTokens: null };

  const bestEvidence = Math.max(strength(result.qa.find((h) => h.relevant)), strength(result.guideline.find((h) => h.relevant)));
  if (result.outOfScope && strength(result.outOfScope) >= bestEvidence) {
    const o = result.outOfScope.doc;
    return {
      ...noModel,
      text: outOfScopeText(result.outOfScope),
      answerType: '답변범위외',
      citations: { ...base, referral: '담당자', out_of_scope: { question: o.question, guidance: o.guidance, department: o.department } },
    };
  }
  if (!result.passed) {
    return { ...noModel, text: NO_EVIDENCE_TEXT, answerType: '근거없음', citations: { ...base, referral: '담당자' } };
  }

  const turns: ChatTurn[] = [
    ...recentHistory(history, config.llm.historyMessages),
    {
      role: 'user',
      content: `[근거 자료]\n${buildContext(result)}\n\n[사용자가 선택한 사업 유형: ${businessType}]\n\n[질문]\n${question}`,
    },
  ];
  const llmResult = await llm.generate({ system: buildSystemPrompt(db), messages: turns, jsonSchema: ANSWER_JSON_SCHEMA });
  const json = parseModelJson(llmResult.text);
  const usage = {
    provider: llmResult.provider,
    model: llmResult.model,
    inputTokens: llmResult.inputTokens,
    outputTokens: llmResult.outputTokens,
  };

  if (!json || typeof json.answer_markdown !== 'string' || !json.answer_markdown.trim()) {
    // 형식을 지키지 않은 답은 본문만 보여주고 근거 카드는 생략
    return { ...usage, text: llmResult.text.trim(), answerType: '근거답변', citations: base };
  }

  const citedQa = new Set(Array.isArray(json.cited_qa_ids) ? json.cited_qa_ids.map(String) : []);
  const citedGuide = new Set(
    Array.isArray(json.cited_guideline) ? json.cited_guideline.map((g) => String((g as { id?: unknown })?.id ?? '')) : [],
  );
  const answerType = (ANSWER_TYPES as readonly string[]).includes(String(json.answer_type))
    ? (json.answer_type as AnswerType)
    : '근거답변';
  const referral = (REFERRALS as readonly string[]).includes(String(json.referral)) ? String(json.referral) : null;

  return {
    ...usage,
    text: json.answer_markdown.trim(),
    answerType,
    citations: {
      ...base,
      business_type: typeof json.business_type === 'string' ? json.business_type : null,
      referral,
      // 실제로 검색되어 모델에 넘긴 항목 중 모델이 인용한 것만 카드로 보여준다
      qa: result.qa.filter((h) => citedQa.has(h.doc.qa_id)).map((h) => qaCard(h.doc)),
      guideline: result.guideline
        .map((h, i) => ({ h, key: guidelineKey(h, i) }))
        .filter(({ key }) => citedGuide.has(key))
        .map(({ h, key }) => ({
          id: key,
          doc_name: h.doc.doc_name,
          doc_kind: h.doc.doc_kind,
          clause: h.doc.clause,
          page: h.doc.page,
          text: h.doc.text,
        })),
    },
  };
}

export async function answerQuestion(
  db: DB,
  llm: LlmClient,
  kb: KnowledgeBase,
  conversationId: number,
  businessType: string,
  question: string,
): Promise<MessageRow> {
  const history = listMessages(db, conversationId);
  const started = Date.now();
  const answer = await generateAnswer(db, llm, kb, history, businessType, question);
  const latency = Date.now() - started;
  const content = `${answer.text}${DISCLAIMER_SEPARATOR}${getSetting(db, 'disclaimer')}`;

  // 질문과 답변을 한 번에 저장한다. 모델 호출이 실패하면 아무것도 남지 않는다.
  return db.transaction(() => {
    db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`).run(conversationId, question);
    const info = db
      .prepare(
        `INSERT INTO messages (conversation_id, role, content, answer_type, citations, provider, model, input_tokens, output_tokens, latency_ms)
         VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversationId,
        content,
        answer.answerType,
        JSON.stringify(answer.citations),
        answer.provider,
        answer.model,
        answer.inputTokens,
        answer.outputTokens,
        latency,
      );
    db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conversationId);
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid) as MessageRow;
  })();
}

/** 1:1 문의에 첨부할 대화 기록 텍스트 */
export function formatTranscript(rows: MessageRow[]): string {
  return rows
    .map((m) => `${m.role === 'user' ? '[질문]' : `[챗봇 답변${m.answer_type ? ` · ${m.answer_type}` : ''}]`} ${m.created_at}\n${stripDisclaimer(m.content)}`)
    .join('\n\n');
}

/** 첫 질문으로 대화 제목을 만든다 */
export function titleFromQuestion(q: string): string {
  const oneLine = q.replace(/\s+/g, ' ').trim();
  return oneLine.length > 30 ? `${oneLine.slice(0, 30)}…` : oneLine || '새로운 대화';
}
