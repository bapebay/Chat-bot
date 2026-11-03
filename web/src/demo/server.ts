/* 데모 페이지용 가짜 서버: 브라우저 메모리 안에서 실제 서버 API를 흉내 낸다.
   검색은 실제 서버의 키워드 검색 코드(server/knowledge)를 그대로 쓰고,
   AI 대신 '테스트 모델'이 검색된 표준답안으로 답을 만든다. 새로고침하면 처음 상태로 돌아간다. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Bm25 } from '../../../server/knowledge/bm25';
import { DEFAULT_SYSTEM_PROMPT, OUTPUT_INSTRUCTIONS, SECURITY_RULES } from '../../../server/defaults';
import { accountFieldProblem, parseAccountsWorkbook } from '../../../server/accounts-excel';
import { parseQaWorkbook } from '../../../server/knowledge/excel';
import { looksLikeFollowUp } from '../../../server/knowledge/followup';
import { BLOCKED_TEXT, detectInjection, guardCheck, publicRefs, LEAK_REASON, leaksInstructions, SECURITY_DAILY_STRIKES } from '../../../server/knowledge/guard';
import { combineQaFiles, isQaMarkdown, MAX_QA_FILES, parseQaMarkdown } from '../../../server/knowledge/qa-markdown';
import { parsePrinciplesCsv, principleContext, principleSearchText } from '../../../server/knowledge/principles';
import { mergeSearchResults, multiQuestionNote, splitByAnd, splitQuestions } from '../../../server/knowledge/split';
import { chunkDocument, chunkTextFile, extractPdfPages } from '../../../server/knowledge/guideline';
import { maskPii, QUERY_STOP_TOKENS, tokenize } from '../../../server/knowledge/text';
import { DEMO_GUIDELINE_TEXT, REGIONS_17, type DemoQa } from './data';
// 데모 기본 표준답안: 관리자가 올린 '중복질의_통합_표준답안초안_5차' (요청에 따라 기본값으로 내장)
import DEFAULT_QA from './default-qa.json';

type Json = any;
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

// ================= 시각·도구 =================
const pad = (n: number) => String(n).padStart(2, '0');
/** 서버와 같은 형식의 UTC 시각 문자열 */
function ts(d = new Date()): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
const ago = (min: number) => ts(new Date(Date.now() - min * 60_000));
const kstDate = (utc: string) => new Date(new Date(utc.replace(' ', 'T') + 'Z').getTime() + 9 * 3600_000).toISOString().slice(0, 10);
let seq = 1000;
const nextId = () => ++seq;
const round = (n: number) => Math.round(n * 1000) / 1000;
const BUSINESS_TYPES = ['순수앵커', '글로컬', '의대교육', '초광역', '기타', '모름'];
const REGIONS = [...REGIONS_17, '해당없음'];

// ================= 실제 AI (claude.ai 아티팩트의 sample 기능) =================
// 데모 페이지를 claude.ai에서 열면 보는 사람의 Claude 계정으로 실제 AI를 부를 수 있다.
// 못 쓰면(권한 거절, 다른 곳에서 열람) null → 테스트 모델로 답한다.
type SampleFn = ((input: string, opts?: Record<string, unknown>) => Promise<{ text: string }>) | null;
let ai: SampleFn = null;
export function setAi(fn: SampleFn) {
  ai = fn;
}
export const aiAvailable = () => !!ai;
const TIER_LABEL: Record<string, string> = { quick: '빠름 (Haiku급)', default: '균형 (Sonnet급)', complex: '최고 성능 (Opus급)' };

// ================= 상태 =================
const settings: Record<string, string> = {
  system_prompt: DEFAULT_SYSTEM_PROMPT,
  disclaimer: '본 답변은 사업비 지침과 기존 질의응답에 근거한 안내이며, 구체적인 집행 인정 여부는 상위보조사업자(지역앵커센터)의 판단에 따릅니다.',
  include_unreviewed: 'false',
  threshold_keyword: '0.5',
  threshold_semantic: '0.83',
  top_k_qa: '6',
  top_k_guideline: '3',
  daily_limit_user: '50',
  daily_limit_total: '3000',
  price_input_per_mtok: '0.10',
  price_output_per_mtok: '0.50',
  usd_krw: '1400',
  retention_days: '0',
  // 데모 전용: 실제 AI 등급 (실서비스 기본값인 경량 모델과 맞춰 quick)
  demo_model_tier: 'quick',
};
const revisions: { id: number; key: string; value: string; changed_by: string; created_at: string }[] = [];

const users: Json[] = [];
function addUser(u: Partial<Json>) {
  const row = {
    id: nextId(),
    status: 'approved',
    locked: false,
    failed_attempts: 0,
    must_change_password: false,
    created_at: ago(60 * 24 * 20),
    last_login_at: ago(60),
    business_type: '순수앵커',
    ...u,
  };
  users.push(row);
  return row;
}
const admin = addUser({ username: 'admin', role: 'admin', org_type: '재단', org_name: '중앙앵커센터', region: '해당없음' });
// 새 대화의 기본 사업 유형은 모든 사용자 '순수앵커' (요청에 따라 고정)
const user = addUser({ username: 'user', role: 'user', org_type: '대학', org_name: '가상대학교 산학협력단', region: '부산', business_type: '순수앵커' });
const others = [
  addUser({ username: 'center_daegu', role: 'user', org_type: '지역앵커센터', org_name: '대구 지역앵커센터(가상)', region: '대구' }),
  addUser({ username: 'univ_gw', role: 'user', org_type: '대학', org_name: '가상과학기술대학교', region: '강원', business_type: '순수앵커' }),
];
addUser({ username: 'univ_new', role: 'user', org_type: '대학', org_name: '가상국립대학교', region: '전남', business_type: '의대교육', status: 'pending', last_login_at: null, created_at: ago(90) });
const DEMO_PASSWORD = 'demo1234';
let currentUserId: number | null = null;

let qaVersionId = nextId();
const qaVersions: Json[] = [
  { id: qaVersionId, filename: DEFAULT_QA.filename, uploaded_by_name: 'admin', status: 'active', item_count: DEFAULT_QA.items.length, warnings: [], created_at: ago(60 * 24 * 3), activated_at: ago(60 * 24 * 3) },
];
let qaItems: Json[] = (DEFAULT_QA.items as DemoQa[]).map((q) => ({ id: nextId(), version_id: qaVersionId, needs_recheck: 0, ...q }));

/** 중분류마다 첫 표준답안 (예시 대화·예시 평가 질문용) */
const PER_CATEGORY: DemoQa[] = [...new Map((DEFAULT_QA.items as DemoQa[]).map((q) => [q.category2, q] as const)).values()];
const qaRevisions: Json[] = [];

// 지침 발췌를 조항 단위로 나눈다 (실제 서버의 조항 분할을 단순화)
const guidelineDocs: Json[] = [{ id: nextId(), name: '앵커 사업비 집행 및 관리 지침 발췌 (가상)', kind: '지침', filename: '지침_발췌.pdf', active: 1, uploaded_by_name: 'admin', created_at: ago(60 * 24 * 3) }];
const guidelineChunks: Json[] = [];
{
  let cur: Json = null;
  let s = 0;
  for (const line of DEMO_GUIDELINE_TEXT.split('\n')) {
    if (/^\d+\./.test(line)) {
      cur = { id: nextId(), doc_id: guidelineDocs[0].id, seq: s++, clause: line, page: 3 + s, text: line };
      guidelineChunks.push(cur);
    } else if (cur) cur.text += `\n${line}`;
  }
}
// 답변범위 외 목록 기능은 없앴다 (점검표 결정). 검색 코드는 빈 목록으로 둔다
let outOfScope: Json[] = [];


const notices: Json[] = [{ id: nextId(), title: '[데모] 사업비 지침 개정 안내 (가상)', body: '보직수당 1인당 한도 기준이 변경되었습니다. 관련 답안은 재검수 중입니다.', active: 1, created_at: ago(60 * 24) }];
const auditLogs: Json[] = [];
function audit(action: string, target = '', detail = '') {
  const u = users.find((x) => x.id === currentUserId);
  auditLogs.unshift({ id: nextId(), username: u?.username ?? null, action, target, detail, created_at: ts() });
}
auditLogs.push(
  { id: nextId(), username: 'admin', action: '표준 Q&A 서비스 적용', target: `#${qaVersionId}`, detail: '', created_at: ago(60 * 24 * 3) },
  { id: nextId(), username: 'admin', action: '가입 승인', target: 'center_daegu', detail: '', created_at: ago(60 * 24 * 5) },
);

const conversations: Json[] = [];
const messages: Json[] = [];
const feedback: Json[] = [];
const reviewQueue: Json[] = [];
const inquiries: Json[] = [];
// 집행원리 (CSV로 올린 묶음. 사용 중인 묶음은 하나)
const principleSets: Json[] = [];
const principles: Json[] = [];

// ================= 검색 (실제 서버의 BM25·핵심어 비율 사용) =================
const num = (k: string) => Number(settings[k]);
const isConfirmed = (s: string) => s.replace(/\s/g, '').startsWith('확정');
const qaText = (d: Json) => [d.question, d.checklist, d.category2, d.category3].filter(Boolean).join('\n');

function activeQa(): Json[] {
  const v = qaVersions.find((x) => x.status === 'active');
  if (!v) return [];
  return qaItems.filter((i) => i.version_id === v.id && (settings.include_unreviewed === 'true' || isConfirmed(i.review_status)));
}
function activeGuides(): Json[] {
  const on = new Set(guidelineDocs.filter((d) => d.active).map((d) => d.id));
  return guidelineChunks
    .filter((c) => on.has(c.doc_id))
    .map((c) => {
      const d = guidelineDocs.find((x) => x.id === c.doc_id)!;
      return { ...c, doc_name: d.name, doc_kind: d.kind };
    });
}

function activePrinciples(): Json[] {
  const set = principleSets.find((x) => x.status === 'active');
  return set ? principles.filter((p) => p.set_id === set.id) : [];
}

function rank(docs: Json[], texts: string[], query: string, tk: number) {
  if (!docs.length) return [];
  const scores = new Bm25(texts).score(query);
  return docs
    .map((doc, i) => ({ doc, keyword: scores[i].coverage, semantic: null as number | null, score: scores[i].bm25, relevant: scores[i].coverage >= tk }))
    .filter((h) => h.score > 0);
}

function search(query: string, businessType: string) {
  const tk = num('threshold_keyword');
  const qa = rank(activeQa(), activeQa().map(qaText), query, tk).map((h) => {
    const c1 = h.doc.category1;
    const boost = businessType && !['모름', '기타'].includes(businessType) && c1.includes(businessType) ? 1.3 : c1.includes('공통') ? 1.1 : 1;
    return { ...h, score: h.score * boost };
  });
  const guides = activeGuides();
  const pick = (hits: Json[], k: number) => {
    const sorted = hits.sort((a, b) => b.score - a.score);
    return [...sorted.filter((h) => h.relevant), ...sorted.filter((h) => !h.relevant && h.keyword >= tk * 0.6)].slice(0, k);
  };
  const qaHits = pick(qa, num('top_k_qa'));
  const gHits = pick(rank(guides, guides.map((g) => `${g.clause}\n${g.text}`), query, tk), num('top_k_guideline'));
  const prs = activePrinciples();
  const pHits = pick(rank(prs, prs.map((p) => principleSearchText(p)), query, tk), 4);
  const oos = rank(outOfScope, outOfScope.map((o) => o.question), query, tk).sort((a, b) => b.score - a.score)[0];
  return {
    qa: qaHits,
    guideline: gHits,
    principle: pHits,
    outOfScope: oos && oos.relevant ? oos : null,
    passed: qaHits.some((h) => h.relevant) || gHits.some((h) => h.relevant) || pHits.some((h) => h.relevant),
    mode: 'keyword' as const,
  };
}

/** 이번 질문의 낱말이 찾은 근거 안에 들어 있는지 (서버와 같은 규칙) */
function overlapsEvidence(query: string, r: Json): boolean {
  const tokens = new Set(tokenize(query).filter((t) => !QUERY_STOP_TOKENS.has(t)));
  const texts = [
    ...r.qa.filter((h: Json) => h.relevant).map((h: Json) => `${qaText(h.doc)}\n${h.doc.answer}`),
    ...r.guideline.filter((h: Json) => h.relevant).map((h: Json) => `${h.doc.clause}\n${h.doc.text}`),
    ...r.principle.filter((h: Json) => h.relevant).map((h: Json) => principleSearchText(h.doc)),
  ];
  return texts.some((t: string) => tokenize(t).some((tok) => tokens.has(tok)));
}

// ================= 테스트 모델 답변 =================
/** AI 대신 검색된 표준답안 내용으로 답을 만든다 (서버의 근거 판정·유형 규칙은 같게) */
function generateAnswer(history: Json[], businessType: string, question: string) {
  const query = question.replace(/\[(?:전화번호|이메일|주민등록번호|계좌번호)\]/g, ' ');
  let r = search(query, businessType);
  // 서버와 같은 규칙: 한 메시지에 질문이 여럿이면 하나씩 찾아 근거를 합친다
  let parts = splitQuestions(query);
  if (parts.length === 1 && !r.passed) parts = splitByAnd(query);
  const partResults = parts.length > 1 ? parts.map((p) => search(p, businessType)) : [];
  if (partResults.length) {
    r = mergeSearchResults(r, partResults, { qa: (h: Json) => h.doc.id, guideline: (h: Json) => h.doc.id, principle: (h: Json) => h.doc.id }, {
      perPart: 3,
      maxPrinciple: Math.min(8, 4 + parts.length),
      maxQa: Math.min(12, Math.max(num('top_k_qa'), 3 * parts.length)),
      maxGuide: Math.min(6, num('top_k_guideline') + parts.length),
    });
  }
  const multi = partResults.length ? multiQuestionNote(parts, partResults.map((p) => p.passed)) : '';
  const prevQ = [...history]
    .map((m, i) => ({ m, i }))
    .reverse()
    .find(({ m, i }) => m.role === 'user' && !looksLikeFollowUp(m.content) && ['근거답변', '연결형'].includes(history[i + 1]?.answer_type))?.m.content;
  if (!r.passed && prevQ) {
    // 서버와 같은 규칙: 앞 질문과 합쳐 다시 찾고, 이어 묻는 말이면 앞 질문만으로도 찾는다
    const followUp = looksLikeFollowUp(query);
    let retry = search(`${prevQ}\n${query}`, businessType);
    if (!retry.passed && followUp) retry = search(prevQ, businessType);
    if (retry.passed && (followUp || overlapsEvidence(query, retry))) r = retry;
  }
  const retrieved = {
    mode: r.mode,
    qa: r.qa.map((h: Json) => ({ qa_id: h.doc.qa_id, keyword: round(h.keyword), semantic: null, relevant: h.relevant })),
    guideline: r.guideline.map((h: Json, i: number) => ({ id: `G${i + 1}`, clause: h.doc.clause, keyword: round(h.keyword), semantic: null, relevant: h.relevant })),
    principle: r.principle.map((h: Json, i: number) => ({ id: `P${i + 1}`, code: h.doc.code, keyword: round(h.keyword), semantic: null, relevant: h.relevant })),
  };
  const base = { business_type: null, referral: null as string | null, qa: [] as Json[], guideline: [] as Json[], out_of_scope: null as Json, retrieved };
  const best = Math.max(r.qa.find((h: Json) => h.relevant)?.keyword ?? 0, r.guideline.find((h: Json) => h.relevant)?.keyword ?? 0, r.principle.find((h: Json) => h.relevant)?.keyword ?? 0);
  if (r.outOfScope && r.outOfScope.keyword >= best) {
    const o = r.outOfScope.doc;
    return {
      text: `**답변 요약**: 사업비 지침 챗봇의 답변 범위가 아닙니다.\n\n${o.guidance}${o.department ? `\n\n**담당 부서**: ${o.department}` : ''}`,
      answerType: '답변범위외',
      citations: { ...base, referral: '담당자', out_of_scope: { question: o.question, guidance: o.guidance, department: o.department } },
      model: false,
      r,
    };
  }
  if (!r.passed) {
    return {
      text: '**답변 요약**: 등록된 지침과 표준답안에서 이 질문의 근거를 찾지 못했습니다.\n\n추측으로 안내하지 않기 위해 답변을 드리지 않습니다. 질문을 조금 더 구체적으로(사업 유형, 비목, 상황) 바꿔 다시 물어보시거나, 아래 **재단에 문의하기**로 남겨 주시면 담당자가 확인합니다.',
      answerType: '근거없음',
      citations: { ...base, referral: '담당자' },
      model: false,
      r,
      multi,
    };
  }
  const relQa = r.qa.filter((h: Json) => h.relevant);
  const top = relQa[0];
  // 여러 질문이면 질문마다 가장 맞는 답안 하나씩
  const perPart = partResults.map((p) => p.qa.find((h: Json) => h.relevant)?.doc).filter(Boolean);
  const referral = perPart.length ? perPart.every((d: Json) => d.is_referral) : top?.doc.is_referral;
  const citedQa = perPart.length
    ? [...new Map(perPart.map((d: Json) => [d.id, d])).values()]
    : (referral ? relQa.slice(0, 1) : relQa.slice(0, 2)).map((h: Json) => h.doc);
  const g = r.guideline.findIndex((h: Json) => h.relevant);
  const citedGuide = g >= 0 ? [{ ...r.guideline[g].doc, id: `G${g + 1}` }] : [];
  // 표준답안이 없으면 집행원리 문장으로 안내 (집행원리 번호는 밖에 보이지 않는다)
  const relPrinciple = citedQa.length ? [] : r.principle.filter((h: Json) => h.relevant).slice(0, 2).map((h: Json) => h.doc);
  const lines = [
    `**질의 요약**: ${question.slice(0, 100)}`,
    '',
    referral
      ? `**답변 요약**: 지역앵커센터 확인이 필요한 사항입니다. 아래 원칙을 참고하세요.`
      : `**답변 요약**: ${citedQa.length ? `표준답안 ${citedQa.map((q: Json) => q.qa_id).join(', ')}` : relPrinciple.length ? '사업비 집행 원칙' : '지침 조항'}에 근거해 안내합니다.`,
    '',
    '**상세 안내**',
    ...citedQa.map((q: Json) => `- ${q.answer}`),
    ...relPrinciple.flatMap((p: Json) => [`- ${p.text}`, ...(p.caution ? [`  - 예외·유의점: ${p.caution}`] : []), ...(p.basis ? [`  - 근거: ${p.basis}`] : [])]),
    ...(citedQa.length || relPrinciple.length ? [] : citedGuide.map((c: Json) => `- ${c.text.split('\n').slice(1).join(' ')}`)),
    '',
    '**유의사항**: (데모) 이 페이지는 실제 AI 대신 테스트 모델이 검색된 표준답안 문장을 그대로 보여줍니다. 실제 서비스에서는 AI가 질문 상황에 맞춰 문장을 다시 씁니다.',
  ];
  const text = lines.join('\n');
  return {
    text,
    answerType: referral ? '연결형' : '근거답변',
    citations: {
      ...base,
      business_type: businessType,
      referral: referral ? '지역앵커센터' : null,
      qa: citedQa.map((q: Json) => ({
        qa_id: q.qa_id,
        category1: q.category1,
        category2: q.category2,
        question: q.question,
        answer: q.answer,
        referral_answer: q.referral_answer,
        is_referral: !!q.is_referral,
        review_status: q.review_status,
        change_history: q.change_history,
      })),
      guideline: citedGuide.map((c: Json) => ({ id: c.id, doc_name: c.doc_name, doc_kind: c.doc_kind, clause: c.clause, page: c.page, text: c.text })),
    },
    model: true,
    r,
    multi,
  };
}

// ----- 실제 AI 답변: 실서비스(server/chat.ts)와 같은 프롬프트·근거 형식·출력 규칙 -----
const clean = (s: string) => s.replace(/[|\]]/g, '/');
function buildContext(r: Json): string {
  // 근거 계층 순서대로: 1단계 지침 및 FAQ → 2단계 집행원리 → 3단계 표준답안 (서버와 같게)
  const parts: string[] = [];
  r.guideline.forEach((h: Json, i: number) => parts.push(`[지침 및 FAQ G${i + 1} | ${clean(h.doc.clause)} | 문서: ${clean(h.doc.doc_name)} | 쪽: ${h.doc.page ?? ''}]\n${h.doc.text}`));
  (r.principle ?? []).forEach((h: Json, i: number) => parts.push(principleContext(h.doc, i)));
  for (const h of r.qa) {
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
  return parts.join('\n\n');
}
function parseModelJson(text: string): Json | null {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}
const PERMANENT = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'];
const AI_ERROR: Record<string, string> = {
  rate_limited: 'AI 사용 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.',
  session_expired: 'claude.ai 로그인이 만료되었습니다. 다시 로그인해 주세요.',
  refused: 'AI가 이 질문에 대한 답변을 거절했습니다. 질문을 바꿔 주세요.',
  empty_completion: 'AI가 빈 답변을 돌려주었습니다. 다시 시도해 주세요.',
  prompt_too_large: '보낼 내용이 너무 깁니다.',
};

/** 근거 판정은 테스트 모델과 같고, 답을 만드는 단계만 실제 AI가 한다 */
/** 서버와 같은 보안 차단 답변 */
function blockedAnswer(reason: string, extra: Json = {}) {
  return {
    provider: 'demo',
    modelName: 'security-guard',
    latency: 30,
    ...extra,
    text: BLOCKED_TEXT,
    answerType: '답변범위외',
    citations: { business_type: null, referral: null, qa: [], guideline: [], out_of_scope: null, security: reason, retrieved: { mode: 'keyword', qa: [], guideline: [], principle: [] } },
  };
}

async function answerWithAi(history: Json[], businessType: string, question: string) {
  // 서버와 같은 1겹 방어: 대놓고 하는 공격 문구는 AI를 부르지 않는다
  const attack = detectInjection(question);
  if (attack) return blockedAnswer(attack);
  const t = generateAnswer(history, businessType, question);
  const testResult = { ...t, provider: 'demo', modelName: 'test-model', latency: 900 + Math.round(Math.random() * 600) };
  if (!t.model || !ai) return testResult;
  const r = t.r;
  const system = [settings.system_prompt, SECURITY_RULES, OUTPUT_INSTRUCTIONS]
    .filter(Boolean)
    .join('\n\n');
  let recent = history.slice(-6);
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
  const hist = recent.map((m) => `${m.role === 'user' ? '사용자' : '챗봇'}: ${stripDisclaimer(m.content)}`).join('\n\n');
  const input = `${system}\n\n# 이전 대화\n${hist || '(없음)'}\n\n<근거자료>\n${buildContext(r)}\n</근거자료>\n\n[사용자가 선택한 사업 유형: ${businessType}]\n\n${t.multi ? `${t.multi}\n\n` : ''}[질문]\n${question}`;
  const started = Date.now();
  let text: string;
  try {
    ({ text } = await ai(input, { cache: false, modelTier: settings.demo_model_tier }));
  } catch (e) {
    const code = (e as { code?: string })?.code ?? 'upstream_error';
    if (PERMANENT.includes(code)) {
      ai = null; // 이번 열람에서는 테스트 모델로
      return { ...testResult, text: `${testResult.text}\n\n_(실제 AI 사용이 허용되지 않아 테스트 모델로 답했습니다)_` };
    }
    throw new HttpError(502, AI_ERROR[code] ?? 'AI 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.', 'LLM_FAILED');
  }
  const latency = Date.now() - started;
  const usage = { provider: 'claude.ai', modelName: `Claude ${TIER_LABEL[settings.demo_model_tier] ?? ''}`, latency, inputTokens: Math.round(input.length / 1.5), outputTokens: Math.round(text.length / 1.5) };
  const json = parseModelJson(text);
  // 3겹: 답변에 내부 지시문이 섞이면 보여주지 않는다
  const shown = json && typeof json.answer_markdown === 'string' ? json.answer_markdown : text;
  // 서버와 같은 규칙: 관리자가 쓴 프롬프트는 그대로 쓰게 한 글(마무리 문구·예시)을 빼고 따로 본다
  if (leaksInstructions(shown, [SECURITY_RULES, OUTPUT_INSTRUCTIONS].join('\n'), settings.system_prompt)) {
    auditLogs.unshift({ id: nextId(), username: '챗봇(자동)', action: '답변 차단(지시문 노출 의심)', target: question.slice(0, 200), detail: shown.slice(0, 3000), created_at: ts() });
    return blockedAnswer(LEAK_REASON, { ...usage, model: true });
  }
  if (!json || typeof json.answer_markdown !== 'string' || !json.answer_markdown.trim()) {
    return { ...t, ...usage, text: text.trim(), answerType: '근거답변', citations: { ...t.citations, qa: [], guideline: [] } };
  }
  const citedQa = new Set((Array.isArray(json.cited_qa_ids) ? json.cited_qa_ids : []).map(String));
  const citedG = new Set((Array.isArray(json.cited_guideline) ? json.cited_guideline : []).map((g: Json) => String(g?.id ?? '')));
  let answerType = ['근거답변', '연결형', '답변범위외', '근거없음'].includes(json.answer_type) ? json.answer_type : '근거답변';
  let referral = ['지역앵커센터', '대학규정', 'e나라도움', '교육부', '담당자'].includes(json.referral) ? json.referral : null;
  const citedDocs = r.qa.filter((h: Json) => citedQa.has(h.doc.qa_id));
  if (answerType === '근거답변' && citedDocs.length && citedDocs.every((h: Json) => h.doc.is_referral)) answerType = '연결형';
  if (answerType === '근거답변') referral = null;
  else if (!referral) referral = answerType === '연결형' ? '지역앵커센터' : '담당자';
  return {
    ...usage,
    text: publicRefs(json.answer_markdown.trim(), r.guideline.map((h: Json) => h.doc.doc_kind)),
    answerType,
    model: true,
    r,
    citations: {
      ...t.citations,
      business_type: typeof json.business_type === 'string' ? json.business_type : null,
      referral,
      qa: citedDocs.map((h: Json) => ({
        qa_id: h.doc.qa_id,
        category1: h.doc.category1,
        category2: h.doc.category2,
        question: h.doc.question,
        answer: h.doc.answer,
        referral_answer: h.doc.referral_answer,
        is_referral: !!h.doc.is_referral,
        review_status: h.doc.review_status,
        change_history: h.doc.change_history,
      })),
      guideline: r.guideline
        .map((h: Json, i: number) => ({ h, id: `G${i + 1}` }))
        .filter(({ id }: Json) => citedG.has(id))
        .map(({ h, id }: Json) => ({ id, doc_name: h.doc.doc_name, doc_kind: h.doc.doc_kind, clause: h.doc.clause, page: h.doc.page, text: h.doc.text })),
    },
  };
}

const SEP = '\n\n---\n\n> ';
const stripDisclaimer = (c: string) => (c.lastIndexOf(SEP) >= 0 ? c.slice(0, c.lastIndexOf(SEP)) : c);

function storeAnswer(conv: Json, question: string, createdAt = ts(), given?: Json) {
  const history = messages.filter((m) => m.conversation_id === conv.id);
  const a = given ?? { ...generateAnswer(history, conv.business_type, question), provider: 'demo', modelName: 'test-model' };
  messages.push({ id: nextId(), conversation_id: conv.id, role: 'user', content: question, answer_type: null, citations: null, provider: null, model: null, input_tokens: null, output_tokens: null, latency_ms: null, created_at: createdAt });
  const msg = {
    id: nextId(),
    conversation_id: conv.id,
    role: 'assistant',
    content: `${a.text}${SEP}${settings.disclaimer}`,
    answer_type: a.answerType,
    citations: JSON.stringify(a.citations),
    provider: a.model ? a.provider : null,
    model: a.model ? a.modelName : null,
    input_tokens: a.model ? (a.inputTokens ?? 3500 + question.length * 2) : null,
    output_tokens: a.model ? (a.outputTokens ?? Math.round(a.text.length / 1.5)) : null,
    latency_ms: a.model ? (a.latency ?? 1000) : 40,
    created_at: createdAt,
  };
  messages.push(msg);
  conv.updated_at = createdAt;
  const source = a.citations?.security ? 'security' : a.answerType === '근거없음' ? 'no_evidence' : a.answerType === '답변범위외' ? 'out_of_scope' : null;
  if (a.citations?.security) audit('보안 의심 질문 차단', a.citations.security, question.slice(0, 100));
  if (source) reviewQueue.push({ id: nextId(), message_id: msg.id, source, status: 'pending', resolution: null, qa_id: null, note: '', resolved_by: null, created_at: createdAt, resolved_at: null });
  return msg;
}

function newConversation(userId: number, businessType: string, createdAt = ts()) {
  const c = { id: nextId(), user_id: userId, title: '새로운 대화', business_type: businessType, created_at: createdAt, updated_at: createdAt };
  conversations.push(c);
  return c;
}
const titleOf = (q: string) => {
  const s = q.replace(/\s+/g, ' ').trim();
  return s.length > 30 ? `${s.slice(0, 30)}…` : s;
};

// ----- 처음 화면이 비어 있지 않도록 예시 사용 기록을 만든다 -----
{
  // 예시 사용 기록: 기본 표준답안의 대표 질의 몇 개 + 근거 없음·범위 외 예시
  const samples = [
    ...PER_CATEGORY.slice(0, 6).map((q) => [q.question, '순수앵커']),
    ['사업단 워크숍 숙소 예약 방법은?', '순수앵커'],
    ['자체평가 실적으로 인정되나요?', '순수앵커'],
  ];
  const people = [user, ...others];
  for (let day = 13; day >= 0; day--) {
    const n = 2 + ((day * 7) % 5);
    for (let k = 0; k < n; k++) {
      const [q, bt] = samples[(day + k) % samples.length];
      const who = people[(day + k) % people.length];
      const at = ago(day * 1440 + 600 - k * 37);
      const c = newConversation(who.id, bt, at);
      c.title = titleOf(q);
      const m = storeAnswer(c, q, at);
      if ((day + k) % 6 === 0 && m.answer_type === '근거답변') {
        feedback.push({ id: nextId(), message_id: m.id, user_id: who.id, rating: 'bad', reason: '답이 부족', comment: '한도 설명이 더 있었으면 합니다', created_at: at });
        reviewQueue.push({ id: nextId(), message_id: m.id, source: 'bad', status: 'pending', resolution: null, qa_id: null, note: '', resolved_by: null, created_at: at, resolved_at: null });
      } else if ((day + k) % 3 === 0 && m.answer_type === '근거답변') {
        feedback.push({ id: nextId(), message_id: m.id, user_id: who.id, rating: 'good', reason: null, comment: '', created_at: at });
      }
    }
  }
  // 대기함이 너무 길지 않게 최근 것만 대기로 남긴다
  reviewQueue.sort((a, b) => b.id - a.id).slice(5).forEach((r) => Object.assign(r, { status: 'resolved', resolution: 'ignored', note: '(데모) 이전 처리 기록', resolved_at: r.created_at }));
  const mine = conversations.filter((c) => c.user_id === user.id).sort((a, b) => b.id - a.id)[0];
  inquiries.push({
    id: nextId(),
    user_id: user.id,
    conversation_id: mine?.id ?? null,
    attached_transcript: mine ? transcript(mine.id) : null,
    content: '(예시 문의) 보직수당 한도 계산 시 성과급 포함 여부를 다시 확인 부탁드립니다.',
    answer: null,
    answered_by: null,
    status: 'pending',
    created_at: ago(120),
    answered_at: null,
  });
}

function transcript(convId: number) {
  return messages
    .filter((m) => m.conversation_id === convId)
    .map((m) => `${m.role === 'user' ? '[질문]' : `[챗봇 답변 · ${m.answer_type}]`} ${m.created_at}\n${stripDisclaimer(m.content)}`)
    .join('\n\n');
}

// ================= 라우터 =================
type Handler = (p: { params: string[]; body: Json; query: URLSearchParams; me: Json }) => Json | Promise<Json>;
const routes: { method: string; re: RegExp; role: 'none' | 'user' | 'admin'; handler: Handler }[] = [];
const route = (method: string, path: string, role: 'none' | 'user' | 'admin', handler: Handler) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), role, handler });
const LEVEL = { none: 0, user: 1, admin: 3 } as const;
const pub = (u: Json) => {
  const { password: _p, ...rest } = u;
  return rest;
};
const byId = <T extends { id: number }>(list: T[], id: string | number) => list.find((x) => x.id === Number(id));

route('GET', '/api/meta', 'none', () => ({ org_types: ['재단', '지역앵커센터', '대학'], regions: REGIONS, business_types: BUSINESS_TYPES, test_mode: !ai, demo: true, demo_ai: !!ai }));
route('GET', '/api/health', 'none', () => ({ ok: true }));

// ----- 인증 -----
route('POST', '/api/auth/login', 'none', ({ body }) => {
  const u = users.find((x) => x.username === String(body.username ?? '').trim());
  if (!u || body.password !== DEMO_PASSWORD) throw new HttpError(401, '아이디 또는 비밀번호가 일치하지 않습니다. (데모 비밀번호: demo1234)');
  if (u.status !== 'approved') throw new HttpError(403, '관리자의 승인을 기다리는 계정입니다.');
  currentUserId = u.id;
  u.last_login_at = ts();
  return { user: pub(u) };
});
route('POST', '/api/auth/logout', 'none', () => {
  currentUserId = null;
  return { ok: true };
});
route('GET', '/api/auth/me', 'user', ({ me }) => ({ user: pub(me) }));
route('POST', '/api/auth/signup', 'none', ({ body }) => {
  if (!/^[A-Za-z0-9._-]{4,30}$/.test(String(body.username ?? ''))) throw new HttpError(400, '아이디는 영문·숫자·._- 조합 4~30자로 입력해 주세요.');
  if (users.some((u) => u.username === body.username)) throw new HttpError(409, '이미 사용 중인 아이디입니다.');
  if (!body.org_type || !body.org_name || !body.region || !body.business_type) throw new HttpError(400, '소속 정보를 모두 입력해 주세요.');
  addUser({ username: body.username, role: 'user', org_type: body.org_type, org_name: body.org_name, region: body.region, business_type: body.business_type, status: 'pending', last_login_at: null, created_at: ts() });
  return { ok: true, message: '가입 신청이 접수되었습니다. (데모) admin 계정으로 로그인해 승인해 보세요. 승인 후 비밀번호 demo1234로 로그인됩니다.' };
});
route('POST', '/api/auth/change-password', 'user', () => ({ ok: true }));
route('PATCH', '/api/auth/me', 'user', ({ me, body }) => {
  me.business_type = body.business_type;
  return { ok: true };
});
route('GET', '/api/usage', 'user', ({ me }) => usage(me));
function usage(me: Json) {
  const today = kstDate(ts());
  const mine = new Set(conversations.filter((c) => c.user_id === me.id).map((c) => c.id));
  return { used: messages.filter((m) => m.role === 'user' && mine.has(m.conversation_id) && kstDate(m.created_at) === today).length, limit: num('daily_limit_user') };
}

// ----- 대화 -----
route('GET', '/api/conversations', 'user', ({ me, query }) => {
  const q = (query.get('q') ?? '').trim();
  return conversations
    .filter((c) => c.user_id === me.id)
    .filter((c) => !q || c.title.includes(q) || messages.some((m) => m.conversation_id === c.id && m.content.includes(q)))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
});
route('POST', '/api/conversations', 'user', ({ me, body }) => newConversation(me.id, body.business_type || '순수앵커'));
const ownConv = (me: Json, id: string) => {
  const c = byId(conversations, id);
  if (!c || c.user_id !== me.id) throw new HttpError(404, '대화를 찾을 수 없습니다.');
  return c;
};
route('GET', '/api/conversations/:id', 'user', ({ me, params }) => {
  const c = ownConv(me, params[0]);
  const msgs = messages.filter((m) => m.conversation_id === c.id);
  return { conversation: c, messages: msgs, feedback: feedback.filter((f) => f.user_id === me.id && msgs.some((m) => m.id === f.message_id)) };
});
route('PATCH', '/api/conversations/:id', 'user', ({ me, params, body }) => {
  const c = ownConv(me, params[0]);
  if (body.title) c.title = body.title;
  if (body.business_type) c.business_type = body.business_type;
  return c;
});
route('DELETE', '/api/conversations/:id', 'user', ({ me, params }) => {
  const c = ownConv(me, params[0]);
  conversations.splice(conversations.indexOf(c), 1);
  return { ok: true };
});
route('POST', '/api/conversations/:id/messages', 'user', async ({ me, params, body }) => {
  const c = ownConv(me, params[0]);
  const raw = String(body.content ?? '').trim();
  if (!raw) throw new HttpError(400, '질문을 입력해 주세요.');
  const today = kstDate(ts());
  const strikes = reviewQueue.filter(
    (q) =>
      q.source === 'security' &&
      kstDate(q.created_at) === today &&
      byId(conversations, byId(messages, q.message_id)?.conversation_id)?.user_id === me.id &&
      // 답변 단계에서 막힌 것은 질문한 사람 탓이 아니므로 세지 않는다 (서버와 같게)
      !String(byId(messages, q.message_id)?.citations ?? '').includes(`"security":"${LEAK_REASON}"`),
  ).length;
  if (strikes >= SECURITY_DAILY_STRIKES) throw new HttpError(429, '보안 정책에 맞지 않는 요청이 반복되어 오늘은 질문할 수 없습니다. 필요하면 1:1 문의를 이용해 주세요.', 'DAILY_LIMIT');
  const u = usage(me);
  if (u.limit > 0 && u.used >= u.limit) throw new HttpError(429, `오늘 질문 가능 횟수(${u.limit}회)를 모두 사용했습니다. 내일 다시 이용하시거나 1:1 문의를 이용해 주세요.`, 'DAILY_LIMIT');
  const question = maskPii(raw);
  const first = !messages.some((m) => m.conversation_id === c.id);
  const a = await answerWithAi(messages.filter((m) => m.conversation_id === c.id), c.business_type, question);
  storeAnswer(c, question, ts(), a);
  if (first) c.title = titleOf(question);
  return { conversation: c, messages: messages.filter((m) => m.conversation_id === c.id), usage: usage(me) };
});
route('PUT', '/api/messages/:id/feedback', 'user', ({ me, params, body }) => {
  const m = byId(messages, params[0]);
  if (!m || byId(conversations, m.conversation_id)?.user_id !== me.id) throw new HttpError(404, '답변을 찾을 수 없습니다.');
  const existing = feedback.find((f) => f.message_id === m.id && f.user_id === me.id);
  const row = { message_id: m.id, user_id: me.id, rating: body.rating, reason: body.rating === 'bad' ? body.reason ?? null : null, comment: body.comment ?? '', created_at: ts() };
  if (existing) Object.assign(existing, row);
  else feedback.push({ id: nextId(), ...row });
  const q = reviewQueue.find((r) => r.message_id === m.id);
  if (body.rating === 'bad') {
    if (q) Object.assign(q, { source: 'bad', status: 'pending', resolution: null, resolved_at: null });
    else reviewQueue.push({ id: nextId(), message_id: m.id, source: 'bad', status: 'pending', resolution: null, qa_id: null, note: '', resolved_by: null, created_at: ts(), resolved_at: null });
  } else if (q && q.source === 'bad' && q.status === 'pending') reviewQueue.splice(reviewQueue.indexOf(q), 1);
  return { ok: true };
});
route('GET', '/api/notices', 'user', () => notices.filter((n) => n.active).slice(0, 3));

// ----- 1:1 문의 -----
const inquiryRow = (i: Json) => {
  const u = byId(users, i.user_id);
  return { ...i, username: u?.username, org_name: u?.org_name, region: u?.region, answered_by_name: i.answered_by ? byId(users, i.answered_by)?.username : null };
};
route('GET', '/api/inquiries', 'user', ({ me }) => {
  const mine = inquiries.filter((i) => i.user_id === me.id).sort((a, b) => b.id - a.id);
  const rows = mine.map(inquiryRow); // 이번 화면에서는 '새 답변'으로 보이고
  mine.forEach((i) => (i.user_unread = 0)); // 열고 나면 읽은 것으로
  return rows;
});
route('GET', '/api/inquiries/unread', 'user', ({ me }) => ({ count: inquiries.filter((i) => i.user_id === me.id && i.user_unread).length }));
route('POST', '/api/inquiries', 'user', ({ me, body }) => {
  if (!String(body.content ?? '').trim()) throw new HttpError(400, '문의 내용을 입력해 주세요.');
  // 서버와 같은 규칙: 챗봇 답변을 받은 대화에서만 재단에 문의할 수 있다
  const conv = body.conversation_id ? ownConv(me, String(body.conversation_id)) : null;
  if (!conv || !messages.some((m) => m.conversation_id === conv.id && m.role === 'assistant')) {
    throw new HttpError(400, "재단 문의는 챗봇에 먼저 질문한 뒤, 답변 아래 '재단에 문의하기'로 남길 수 있습니다.");
  }
  const row = { id: nextId(), user_id: me.id, conversation_id: conv.id, attached_transcript: transcript(conv.id), content: body.content, answer: null, answered_by: null, status: 'pending', created_at: ts(), answered_at: null };
  inquiries.push(row);
  return inquiryRow(row);
});
route('GET', '/api/manage/inquiries', 'admin', ({ query }) => {
  const s = query.get('status');
  return inquiries.filter((i) => !s || i.status === s).sort((a, b) => b.id - a.id).map(inquiryRow);
});
route('POST', '/api/manage/inquiries/:id/answer', 'admin', ({ me, params, body }) => {
  const i = byId(inquiries, params[0]);
  if (!i) throw new HttpError(404, '문의를 찾을 수 없습니다.');
  Object.assign(i, { answer: body.answer, answered_by: me.id, status: 'answered', answered_at: ts(), user_unread: 1 });
  return inquiryRow(i);
});
route('POST', '/api/manage/inquiries/:id/qa', 'admin', ({ params, body }) => {
  const i = byId(inquiries, params[0]);
  if (!i) throw new HttpError(404, '문의를 찾을 수 없습니다.');
  i.qa_id = String(body.qa_id ?? '');
  audit('문의 답변을 표준답안으로 등록', `문의 #${i.id}`, i.qa_id);
  return inquiryRow(i);
});

// ----- 검토 대기함·표준답안 편집 -----
route('GET', '/api/review/queue', 'admin', ({ query }) => {
  const done = query.get('status') === 'done';
  return reviewQueue
    .filter((r) => (done ? r.status !== 'pending' : r.status === 'pending'))
    .sort((a, b) => b.id - a.id)
    .map((r) => {
      const m = byId(messages, r.message_id)!;
      const c = byId(conversations, m.conversation_id)!;
      const u = byId(users, c.user_id)!;
      const cit = JSON.parse(m.citations ?? 'null');
      const q = messages.filter((x) => x.conversation_id === c.id && x.role === 'user' && x.id < m.id).at(-1);
      return {
        ...r,
        answer: stripDisclaimer(m.content),
        answer_type: m.answer_type,
        answered_at: m.created_at,
        conversation_id: c.id,
        business_type: c.business_type,
        username: u.username,
        org_name: u.org_name,
        region: u.region,
        resolved_by_name: r.resolved_by ? byId(users, r.resolved_by)?.username : r.status !== 'pending' ? 'admin' : null,
        question: q?.content ?? null,
        cited_qa_ids: cit?.qa?.map((x: Json) => x.qa_id) ?? [],
        retrieved_qa_ids: cit?.retrieved?.qa?.map((x: Json) => x.qa_id) ?? [],
        feedback: feedback.filter((f) => f.message_id === m.id && f.rating === 'bad'),
      };
    });
});
route('POST', '/api/review/queue/:id/resolve', 'admin', ({ me, params, body }) => {
  const r = byId(reviewQueue, params[0]);
  if (!r) throw new HttpError(404, '항목을 찾을 수 없습니다.');
  Object.assign(r, { status: body.action === 'ignored' ? 'ignored' : 'resolved', resolution: body.action, qa_id: body.qa_id ?? null, note: body.note ?? '', resolved_by: me.id, resolved_at: ts() });
  return { ok: true };
});
const activeVersion = () => qaVersions.find((v) => v.status === 'active');
route('GET', '/api/review/qa', 'admin', ({ query }) => {
  const v = activeVersion();
  if (!v) return { version_id: null, total: 0, items: [] };
  const q = query.get('q') ?? '';
  const items = qaItems.filter(
    (i) =>
      i.version_id === v.id &&
      (!q || [i.qa_id, i.question, i.checklist, i.answer].some((t) => t.includes(q))) &&
      (!query.get('category1') || i.category1 === query.get('category1')) &&
      (!query.get('category2') || i.category2 === query.get('category2')) &&
      (!query.get('review_status') || i.review_status === query.get('review_status')) &&
      (query.get('recheck') !== '1' || i.needs_recheck),
  );
  return { version_id: v.id, total: items.length, items: items.slice(0, 300) };
});
route('GET', '/api/review/qa/facets', 'admin', () => {
  const v = activeVersion();
  const items = qaItems.filter((i) => i.version_id === v?.id);
  const d = (k: string) => [...new Set(items.map((i) => i[k]).filter(Boolean))].sort();
  return { category1: d('category1'), category2: d('category2'), review_status: d('review_status') };
});
route('GET', '/api/review/qa/:qaId/revisions', 'admin', ({ params }) => qaRevisions.filter((r) => r.qa_id === decodeURIComponent(params[0])).sort((a, b) => b.id - a.id));
const QA_FIELDS = ['qa_id', 'category1', 'category2', 'category3', 'question', 'checklist', 'answer', 'referral_answer', 'review_status', 'change_history'];
const snap = (o: Json) => JSON.stringify(Object.fromEntries([...QA_FIELDS, 'is_referral'].map((k) => [k, k === 'is_referral' ? (o[k] ? 1 : 0) : o[k]])));
function readQa(body: Json) {
  const v: Json = Object.fromEntries(QA_FIELDS.map((k) => [k, String(body[k] ?? '').trim()]));
  if (!v.qa_id || !v.question || !v.answer) throw new HttpError(400, '통합번호·대표 질의·통합 답안은 비울 수 없습니다.');
  v.is_referral = body.is_referral ? 1 : 0;
  return v;
}
route('PUT', '/api/review/qa/:id', 'admin', ({ me, params, body }) => {
  const it = byId(qaItems, params[0]);
  if (!it) throw new HttpError(404, '표준답안을 찾을 수 없습니다.');
  const v = readQa(body);
  if (qaItems.some((x) => x.version_id === it.version_id && x.qa_id === v.qa_id && x.id !== it.id)) throw new HttpError(409, `통합번호 ${v.qa_id}가 이미 있습니다.`);
  qaRevisions.push({ id: nextId(), qa_id: v.qa_id, before_json: snap(it), after_json: snap(v), reason: body.reason ?? '', changed_by: me.username, created_at: ts() });
  Object.assign(it, v, { needs_recheck: 0 });
  audit('표준답안 수정', v.qa_id, body.reason ?? '');
  return it;
});
route('POST', '/api/review/qa', 'admin', ({ me, body }) => {
  const v = readQa(body);
  const ver = activeVersion();
  if (!ver) throw new HttpError(400, '서비스 중인 버전이 없습니다.');
  if (qaItems.some((x) => x.version_id === ver.id && x.qa_id === v.qa_id)) throw new HttpError(409, `통합번호 ${v.qa_id}가 이미 있습니다.`);
  const row = { id: nextId(), version_id: ver.id, needs_recheck: 0, ...v };
  qaItems.push(row);
  ver.item_count++;
  qaRevisions.push({ id: nextId(), qa_id: v.qa_id, before_json: null, after_json: snap(v), reason: body.reason || '새 표준답안 추가', changed_by: me.username, created_at: ts() });
  audit('표준답안 추가', v.qa_id, body.reason ?? '');
  return row;
});
route('DELETE', '/api/review/qa/:id', 'admin', ({ me, params, body }) => {
  const it = byId(qaItems, params[0]);
  if (!it) throw new HttpError(404, '표준답안을 찾을 수 없습니다.');
  qaItems = qaItems.filter((x) => x !== it);
  qaRevisions.push({ id: nextId(), qa_id: it.qa_id, before_json: snap(it), after_json: null, reason: body?.reason || '삭제', changed_by: me.username, created_at: ts() });
  audit('표준답안 삭제', it.qa_id, body?.reason ?? '');
  return { ok: true };
});

// ----- 관리: 사용자 -----
route('GET', '/api/admin/users', 'admin', () => [...users].sort((a, b) => (a.status === b.status ? b.id - a.id : a.status === 'pending' ? -1 : 1)).map(pub));
route('POST', '/api/admin/users', 'admin', ({ body }) => {
  if (users.some((u) => u.username === body.username)) throw new HttpError(409, '이미 사용 중인 아이디입니다.');
  addUser({ username: body.username, role: body.role, org_type: body.org_type, org_name: body.org_name, region: body.region, business_type: body.business_type, last_login_at: null, created_at: ts() });
  audit('계정 생성', body.username, `권한 ${body.role}`);
  return { ok: true, temp_password: DEMO_PASSWORD };
});
// 계정 일괄 등록: 실제 서버와 같은 양식·검사. 데모 계정의 비밀번호는 모두 demo1234
route('POST', '/api/admin/users/bulk', 'admin', async ({ body }) => {
  const f = await readFile(body, /\.xlsx$/i);
  let rows;
  try {
    rows = await parseAccountsWorkbook(asBuffer(f.buf));
  } catch (e) {
    throw bad(e);
  }
  if (!rows.length) throw new HttpError(400, '등록할 계정이 없습니다. 예시 행 아래에 계정을 적어 주세요.');
  const seen = new Set<string>();
  const results = rows.map(({ row, input }) => {
    const error = seen.has(input.username)
      ? '파일 안에 같은 아이디가 또 있습니다.'
      : (accountFieldProblem(input) ?? (users.some((u) => u.username === input.username) ? '이미 사용 중인 아이디입니다.' : null));
    seen.add(input.username);
    if (!error) addUser({ ...input, last_login_at: null, created_at: ts(), must_change_password: false });
    return { row, username: input.username, org_name: input.org_name, role: input.role, temp_password: error ? null : DEMO_PASSWORD, error };
  });
  const created = results.filter((r) => r.temp_password).length;
  audit('계정 일괄 등록', f.name, `${created}명 등록, ${results.length - created}명 실패`);
  return { created, failed: results.length - created, results };
});
const userOr404 = (id: string) => {
  const u = byId(users, id);
  if (!u) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
  return u;
};
route('POST', '/api/admin/users/:id/approve', 'admin', ({ params }) => {
  const u = userOr404(params[0]);
  u.status = 'approved';
  audit('가입 승인', u.username);
  return { ok: true };
});
route('PATCH', '/api/admin/users/:id', 'admin', ({ params, body }) => {
  const u = userOr404(params[0]);
  if (u.role === 'admin' && body.role !== 'admin' && !users.some((x) => x.id !== u.id && x.role === 'admin')) throw new HttpError(400, '마지막 관리자의 권한은 바꿀 수 없습니다.');
  audit('권한 변경', u.username, `${u.role} → ${body.role}`);
  u.role = body.role;
  return { ok: true };
});
route('POST', '/api/admin/users/:id/reset-password', 'admin', ({ params }) => {
  audit('비밀번호 초기화', userOr404(params[0]).username);
  return { ok: true, temp_password: DEMO_PASSWORD };
});
route('DELETE', '/api/admin/users/:id', 'admin', ({ me, params }) => {
  const u = userOr404(params[0]);
  if (u.id === me.id) throw new HttpError(400, '자기 자신은 삭제할 수 없습니다.');
  users.splice(users.indexOf(u), 1);
  audit(u.status === 'pending' ? '가입 거절' : '계정 삭제', u.username);
  return { ok: true };
});
route('GET', '/api/admin/users/:id/conversations', 'admin', ({ params }) =>
  conversations
    .filter((c) => c.user_id === Number(params[0]))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .map((c) => ({ ...c, message_count: messages.filter((m) => m.conversation_id === c.id).length })),
);
route('GET', '/api/admin/conversations/:id', 'admin', ({ params }) => {
  const c = byId(conversations, params[0]);
  if (!c) throw new HttpError(404, '대화를 찾을 수 없습니다.');
  return { conversation: c, messages: messages.filter((m) => m.conversation_id === c.id) };
});

// ----- 관리: 설정 -----
const revList = (key: string) => revisions.filter((r) => r.key === key).sort((a, b) => b.id - a.id);
route('GET', '/api/admin/settings/:key', 'admin', ({ params }) => {
  if (!(params[0] in settings)) throw new HttpError(404, '알 수 없는 설정입니다.');
  return { value: settings[params[0]], revisions: revList(params[0]) };
});
route('PUT', '/api/admin/settings/:key', 'admin', ({ me, params, body }) => {
  const key = params[0];
  const value = String(body.value ?? '').trim();
  if (!(key in settings)) throw new HttpError(404, '알 수 없는 설정입니다.');
  if (/^threshold/.test(key) && !(Number(value) >= 0 && Number(value) <= 1)) throw new HttpError(400, '0과 1 사이의 숫자를 입력하세요.');
  if (['system_prompt', 'disclaimer'].includes(key) && !value) throw new HttpError(400, '내용이 비어 있습니다.');
  settings[key] = value;
  revisions.push({ id: nextId(), key, value, changed_by: me.username, created_at: ts() });
  audit('설정 변경', key, value.length > 80 ? `${value.slice(0, 80)}…` : value);
  return { value, revisions: revList(key) };
});
route('POST', '/api/admin/settings/:key/revert', 'admin', ({ me, params, body }) => {
  const rev = revisions.find((r) => r.id === Number(body.revision_id) && r.key === params[0]);
  if (!rev) throw new HttpError(404, '해당 이력을 찾을 수 없습니다.');
  settings[params[0]] = rev.value;
  revisions.push({ id: nextId(), key: params[0], value: rev.value, changed_by: me.username, created_at: ts() });
  audit('설정 되돌리기', params[0], `이력 #${rev.id}`);
  return { value: rev.value, revisions: revList(params[0]) };
});
route('GET', '/api/demo/storage', 'user', () => storageStatus);
route('POST', '/api/demo/storage/reset', 'admin', async () => {
  if (!resetStorage) throw new HttpError(400, '저장 공간을 쓸 수 없는 화면입니다. 새로고침하면 처음 상태로 돌아갑니다.');
  await resetStorage();
  return { ok: true };
});
route('GET', '/api/admin/system', 'admin', () => ({
  llm: ai
    ? { provider: 'claude.ai (실제 AI)', model: `Claude ${TIER_LABEL[settings.demo_model_tier] ?? ''}`, history_messages: 6, demo_tiers: TIER_LABEL, demo_tier: settings.demo_model_tier }
    : { provider: 'demo', model: 'test-model (데모 테스트 모델)', history_messages: 6 },
  counts: {
    users: users.length,
    pending_users: users.filter((u) => u.status === 'pending').length,
    conversations: conversations.length,
    questions: messages.filter((m) => m.role === 'user').length,
    pending_inquiries: inquiries.filter((i) => i.status === 'pending').length,
  },
}));

// ----- 관리: 지식 데이터 -----
route('GET', '/api/admin/knowledge/status', 'admin', () => ({
  qa: activeQa().length,
  guideline: activeGuides().length,
  principle: activePrinciples().length,
  out_of_scope: outOfScope.length,
  semantic_model: null,
  semantic_ready: false,
  semantic_error: null,
  active_version: activeVersion() ?? null,
}));
const versionRow = (v: Json) => {
  const items = qaItems.filter((i) => i.version_id === v.id);
  return { ...v, item_count: items.length, confirmed_count: items.filter((i) => isConfirmed(i.review_status)).length, referral_count: items.filter((i) => i.is_referral).length };
};
route('GET', '/api/admin/knowledge/qa/versions', 'admin', () => [...qaVersions].sort((a, b) => b.id - a.id).map(versionRow));
route('POST', '/api/admin/knowledge/qa/versions/:id/activate', 'admin', ({ params }) => {
  const v = byId(qaVersions, params[0]);
  if (!v) throw new HttpError(404, '버전을 찾을 수 없습니다.');
  qaVersions.forEach((x) => x.status === 'active' && (x.status = 'archived'));
  Object.assign(v, { status: 'active', activated_at: ts() });
  qaVersionId = v.id;
  return { ok: true };
});
route('DELETE', '/api/admin/knowledge/qa/versions/:id', 'admin', ({ params }) => {
  const v = byId(qaVersions, params[0]);
  if (!v) throw new HttpError(404, '버전을 찾을 수 없습니다.');
  if (v.status === 'active') throw new HttpError(400, '서비스 중인 버전은 삭제할 수 없습니다.');
  qaVersions.splice(qaVersions.indexOf(v), 1);
  qaItems = qaItems.filter((i) => i.version_id !== v.id);
  return { ok: true };
});
route('GET', '/api/admin/knowledge/qa/versions/:id/items', 'admin', ({ params, query }) => {
  const q = query.get('q') ?? '';
  return qaItems.filter((i) => i.version_id === Number(params[0]) && (!q || [i.qa_id, i.question, i.checklist, i.answer].some((t) => t.includes(q)))).slice(0, 200);
});
// ----- 파일 올리기: 파일은 이 브라우저 안에서만 읽고, 어디에도 저장·전송하지 않는다 -----
async function readFile(body: Json, exts: RegExp) {
  const file = body instanceof FormData ? body.get('file') : null;
  if (!(file instanceof File)) throw new HttpError(400, '파일을 선택해 주세요.');
  if (!exts.test(file.name)) throw new HttpError(400, '지원하지 않는 파일 형식입니다.');
  if (file.size > 15 * 1024 * 1024) throw new HttpError(400, '파일이 너무 큽니다 (15MB 이하).');
  const field = (k: string) => String((body as FormData).get(k) ?? '');
  return { name: file.name, buf: await file.arrayBuffer(), field };
}
const asBuffer = (b: ArrayBuffer) => b as unknown as Parameters<typeof parseQaWorkbook>[0];
const bad = (e: unknown) => new HttpError(400, (e as Error).message);

route('POST', '/api/admin/knowledge/qa/upload', 'admin', async ({ body }) => {
  // 파트별로 나눈 여러 파일을 하나의 버전으로 합친다 (서버와 같은 규칙)
  const files = body instanceof FormData ? body.getAll('file').filter((x): x is File => x instanceof File) : [];
  if (!files.length) throw new HttpError(400, '파일을 선택해 주세요.');
  if (files.length > MAX_QA_FILES) throw new HttpError(400, `한 번에 ${MAX_QA_FILES}개 파일까지 올릴 수 있습니다.`);
  const results = [];
  for (const file of files) {
    if (!/\.(xlsx|md|markdown)$/i.test(file.name)) throw new HttpError(400, `지원하지 않는 파일 형식입니다: ${file.name}`);
    if (file.size > 15 * 1024 * 1024) throw new HttpError(400, `파일이 너무 큽니다 (파일마다 15MB 이하): ${file.name}`);
    const buf = await file.arrayBuffer();
    try {
      const r = isQaMarkdown(file.name) ? parseQaMarkdown(new Uint8Array(buf), file.name) : await parseQaWorkbook(asBuffer(buf));
      results.push({ name: file.name, items: r.items, warnings: r.warnings });
    } catch (e) {
      throw new HttpError(400, files.length > 1 ? `${file.name}: ${(e as Error).message}` : (e as Error).message);
    }
  }
  const parsed = combineQaFiles(results);
  const f = { name: parsed.filename };
  // 적용하지 않은 이전 미리보기는 지운다
  for (const v of qaVersions.filter((x) => x.status === 'draft')) qaItems = qaItems.filter((i) => i.version_id !== v.id);
  qaVersions.splice(0, qaVersions.length, ...qaVersions.filter((x) => x.status !== 'draft'));
  const v = { id: nextId(), filename: f.name, uploaded_by_name: users.find((u) => u.id === currentUserId)?.username, status: 'draft', item_count: parsed.items.length, warnings: parsed.warnings, created_at: ts(), activated_at: null };
  qaVersions.push(v);
  for (const it of parsed.items) {
    const { row: _row, ...rest } = it;
    qaItems.push({ id: nextId(), version_id: v.id, needs_recheck: 0, ...rest });
  }
  audit('표준 Q&A 업로드(미리보기)', `#${v.id} ${f.name}`, `${parsed.items.length}건`);
  return versionRow(v);
});
route('POST', '/api/admin/knowledge/guidelines/upload', 'admin', async ({ body }) => {
  const f = await readFile(body, /\.(pdf|txt|md|markdown)$/i);
  let chunks;
  try {
    chunks = /\.pdf$/i.test(f.name) ? chunkDocument(await extractPdfPages(asBuffer(f.buf)), true) : chunkTextFile(new Uint8Array(f.buf), f.name);
  } catch (e) {
    throw bad(e);
  }
  if (!chunks.length) throw new HttpError(400, '파일에서 글자를 찾지 못했습니다. 스캔 이미지 PDF는 지원하지 않습니다.');
  const doc = { id: nextId(), name: (f.field('name') || f.name.replace(/\.[^.]+$/, '')).slice(0, 100), kind: f.field('kind') === 'FAQ' ? 'FAQ' : '지침', filename: f.name, active: 1, uploaded_by_name: 'admin', created_at: ts() };
  guidelineDocs.push(doc);
  chunks.forEach((c, i) => guidelineChunks.push({ id: nextId(), doc_id: doc.id, seq: i, ...c }));
  audit('지침·FAQ 업로드', doc.name, `${chunks.length}개 조항`);
  return { ok: true, id: doc.id, chunk_count: chunks.length };
});
route('GET', '/api/admin/knowledge/guidelines', 'admin', () => guidelineDocs.map((d) => ({ ...d, chunk_count: guidelineChunks.filter((c) => c.doc_id === d.id).length })));
route('GET', '/api/admin/knowledge/guidelines/:id/chunks', 'admin', ({ params }) => guidelineChunks.filter((c) => c.doc_id === Number(params[0])));
route('PATCH', '/api/admin/knowledge/guidelines/:id', 'admin', ({ params, body }) => {
  const d = byId(guidelineDocs, params[0]);
  if (!d) throw new HttpError(404, '문서를 찾을 수 없습니다.');
  d.active = body.active ? 1 : 0;
  audit(d.active ? '지침 문서 사용' : '지침 문서 사용 중지', d.name);
  return { ok: true };
});
route('DELETE', '/api/admin/knowledge/guidelines/:id', 'admin', ({ params }) => {
  const d = byId(guidelineDocs, params[0]);
  if (!d) throw new HttpError(404, '문서를 찾을 수 없습니다.');
  guidelineDocs.splice(guidelineDocs.indexOf(d), 1);
  audit('지침 문서 삭제', d.name);
  return { ok: true };
});

// ----- 관리: 보안 차단 점검 (서버와 같은 함수) -----
route('POST', '/api/admin/prompt/guard-check', 'admin', ({ body }) => {
  const draft = String(body?.system_prompt ?? '').trim();
  const v = qaVersions.find((x) => x.status === 'active');
  const items = v ? qaItems.filter((i) => i.version_id === v.id) : [];
  const check = guardCheck(items, [SECURITY_RULES, OUTPUT_INSTRUCTIONS].join('\n'), draft || settings.system_prompt);
  const since = ago(30 * 1440);
  const recentMsgs = messages.filter((m) => m.role === 'assistant' && m.created_at >= since);
  const counts = new Map<string, number>();
  for (const m of recentMsgs) {
    let reason: string | null = null;
    try {
      reason = JSON.parse(m.citations ?? 'null')?.security ?? null;
    } catch {
      reason = null;
    }
    if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return {
    draft: !!draft,
    total: check.total,
    question_blocked: check.question_blocked.slice(0, 50),
    question_blocked_count: check.question_blocked.length,
    answer_blocked: check.answer_blocked.slice(0, 50),
    answer_blocked_count: check.answer_blocked.length,
    recent: { answers: recentMsgs.length, blocked: [...counts].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n) },
  };
});

// ----- 관리: 집행원리 (CSV) -----
route('GET', '/api/admin/knowledge/principles', 'admin', () => [...principleSets].sort((a, b) => b.id - a.id));
route('GET', '/api/admin/knowledge/principles/sets/:id/items', 'admin', ({ params, query }) => {
  const q = query.get('q') ?? '';
  return principles.filter((p) => p.set_id === Number(params[0]) && (!q || [p.code, p.category, p.subcategory, p.keywords, p.text, p.detail].some((t) => (t ?? '').includes(q)))).slice(0, 300);
});
route('POST', '/api/admin/knowledge/principles/upload', 'admin', async ({ body }) => {
  const f = await readFile(body, /\.csv$/i);
  let parsed;
  try {
    parsed = parsePrinciplesCsv(new Uint8Array(f.buf));
  } catch (e) {
    throw bad(e);
  }
  principleSets.forEach((x) => x.status === 'active' && (x.status = 'archived'));
  const set = { id: nextId(), filename: f.name, uploaded_by_name: users.find((u) => u.id === currentUserId)?.username ?? null, status: 'active', item_count: parsed.items.length, warnings: parsed.warnings, created_at: ts(), activated_at: ts() };
  principleSets.push(set);
  for (const { row: _row, ...p } of parsed.items) principles.push({ id: nextId(), set_id: set.id, ...p });
  audit('집행원리 업로드', `#${set.id} ${f.name}`, `${parsed.items.length}건`);
  return set;
});
route('POST', '/api/admin/knowledge/principles/sets/:id/activate', 'admin', ({ params }) => {
  const set = byId(principleSets, params[0]);
  if (!set) throw new HttpError(404, '묶음을 찾을 수 없습니다.');
  principleSets.forEach((x) => x.status === 'active' && (x.status = 'archived'));
  Object.assign(set, { status: 'active', activated_at: ts() });
  audit('집행원리 묶음 사용', `#${set.id} ${set.filename}`);
  return { ok: true };
});
route('DELETE', '/api/admin/knowledge/principles/sets/:id', 'admin', ({ params }) => {
  const set = byId(principleSets, params[0]);
  if (!set) throw new HttpError(404, '묶음을 찾을 수 없습니다.');
  if (set.status === 'active') throw new HttpError(400, '사용 중인 묶음은 삭제할 수 없습니다. 다른 묶음을 먼저 사용하세요.');
  principleSets.splice(principleSets.indexOf(set), 1);
  for (let i = principles.length - 1; i >= 0; i--) if (principles[i].set_id === set.id) principles.splice(i, 1);
  audit('집행원리 묶음 삭제', `#${set.id} ${set.filename}`);
  return { ok: true };
});

// ----- 관리: 통계·답변·공지·감사 -----
route('GET', '/api/admin/stats', 'admin', ({ query }) => {
  const days = Math.min(365, Math.max(1, Number(query.get('days')) || 30));
  const since = ago(days * 1440);
  const recent = messages.filter((m) => m.created_at >= since);
  const pin = num('price_input_per_mtok');
  const pout = num('price_output_per_mtok');
  const krw = num('usd_krw');
  const cost = (i: number, o: number) => ((i * pin + o * pout) / 1e6) * krw;
  const byDay = new Map<string, Json>();
  for (const m of recent) {
    const d = kstDate(m.created_at);
    const e = byDay.get(d) ?? { date: d, questions: 0, input_tokens: 0, output_tokens: 0, llm_calls: 0, cost_krw: 0 };
    if (m.role === 'user') e.questions++;
    e.input_tokens += m.input_tokens ?? 0;
    e.output_tokens += m.output_tokens ?? 0;
    if (m.role === 'assistant' && m.provider) e.llm_calls++;
    byDay.set(d, e);
  }
  const daily = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => ({ ...d, cost_krw: Math.round(cost(d.input_tokens, d.output_tokens)) }));
  const totals = daily.reduce(
    (t, d) => ({ questions: t.questions + d.questions, llm_calls: t.llm_calls + d.llm_calls, input_tokens: t.input_tokens + d.input_tokens, output_tokens: t.output_tokens + d.output_tokens, cost_krw: t.cost_krw + d.cost_krw }),
    { questions: 0, llm_calls: 0, input_tokens: 0, output_tokens: 0, cost_krw: 0 },
  );
  const orgs = new Map<string, Json>();
  for (const m of recent.filter((x) => x.role === 'user')) {
    const u = byId(users, byId(conversations, m.conversation_id)?.user_id ?? 0);
    if (!u) continue;
    const e = orgs.get(u.org_name) ?? { org_type: u.org_type, org_name: u.org_name, region: u.region, questions: 0, users: new Set() };
    e.questions++;
    e.users.add(u.id);
    orgs.set(u.org_name, e);
  }
  const types: Record<string, number> = {};
  for (const m of recent.filter((x) => x.role === 'assistant')) types[m.answer_type] = (types[m.answer_type] ?? 0) + 1;
  const fb = feedback.filter((f) => recent.some((m) => m.id === f.message_id));
  const reasons: Record<string, number> = {};
  for (const f of fb.filter((x) => x.rating === 'bad')) reasons[f.reason ?? '사유 없음'] = (reasons[f.reason ?? '사유 없음'] ?? 0) + 1;
  return {
    days,
    prices: { input_per_mtok: pin, output_per_mtok: pout, usd_krw: krw },
    totals: { ...totals, avg_latency_ms: 1150 },
    daily,
    by_org: [...orgs.values()].map((o) => ({ ...o, users: o.users.size })).sort((a, b) => b.questions - a.questions),
    answer_types: types,
    feedback: { good: fb.filter((f) => f.rating === 'good').length, bad: fb.filter((f) => f.rating === 'bad').length, bad_reasons: reasons },
  };
});
route('GET', '/api/admin/answers', 'admin', ({ query }) => {
  const f = query.get('filter');
  return messages
    .filter((m) => m.role === 'assistant')
    .filter((m) =>
      f === 'bad'
        ? feedback.some((x) => x.message_id === m.id && x.rating === 'bad')
        : f === 'referral'
          ? m.answer_type === '연결형'
          : f === 'no_evidence'
            ? m.answer_type === '근거없음'
            : f === 'out_of_scope'
              ? m.answer_type === '답변범위외'
              : f === 'security'
                ? String(m.citations ?? '').includes('"security":')
                : true,
    )
    .sort((a, b) => b.id - a.id)
    .slice(0, 200)
    .map((m) => {
      const c = byId(conversations, m.conversation_id)!;
      const u = byId(users, c.user_id)!;
      const bad = feedback.find((x) => x.message_id === m.id && x.rating === 'bad');
      return {
        id: m.id,
        conversation_id: c.id,
        answer_type: m.answer_type,
        security: (() => {
          try {
            return JSON.parse(m.citations ?? 'null')?.security ?? null;
          } catch {
            return null;
          }
        })(),
        content: stripDisclaimer(m.content),
        created_at: m.created_at,
        username: u.username,
        org_name: u.org_name,
        question: messages.filter((x) => x.conversation_id === c.id && x.role === 'user' && x.id < m.id).at(-1)?.content ?? null,
        bad_reason: bad ? `${bad.reason ?? ''}${bad.comment ? ` - ${bad.comment}` : ''}` : null,
      };
    });
});
route('GET', '/api/admin/notices', 'admin', () => [...notices].sort((a, b) => b.id - a.id));
route('POST', '/api/admin/notices', 'admin', ({ body }) => {
  if (!String(body.title ?? '').trim()) throw new HttpError(400, '공지 제목을 입력해 주세요.');
  notices.push({ id: nextId(), title: body.title, body: body.body ?? '', active: 1, created_at: ts() });
  const ids = String(body.recheck_qa_ids ?? '').split(/[,;\s]+/).filter(Boolean);
  let marked = 0;
  for (const i of qaItems.filter((x) => x.version_id === activeVersion()?.id)) {
    if (!i.needs_recheck && (ids.includes(i.qa_id) || (body.recheck_category && i.category2 === body.recheck_category))) {
      i.needs_recheck = 1;
      marked++;
    }
  }
  audit('공지 등록', body.title, marked ? `재검수 필요 표시 ${marked}건` : '');
  return { id: notices.at(-1).id, marked };
});
route('PATCH', '/api/admin/notices/:id', 'admin', ({ params, body }) => {
  const n = byId(notices, params[0]);
  if (n) n.active = body.active ? 1 : 0;
  return { ok: true };
});
route('DELETE', '/api/admin/notices/:id', 'admin', ({ params }) => {
  const n = byId(notices, params[0]);
  if (n) notices.splice(notices.indexOf(n), 1);
  return { ok: true };
});
route('GET', '/api/admin/audit', 'admin', ({ query }) => {
  const q = query.get('q') ?? '';
  return auditLogs.filter((l) => !q || [l.action, l.target, l.username ?? ''].some((t) => t.includes(q))).slice(0, 300);
});

// ================= 저장·불러오기 (새로고침해도 유지) =================
// 페이지 전용 저장 공간(install.ts)이 이 함수들로 상태를 통째로 저장하고 되살린다.
let notifyChange: () => void = () => undefined;
export function onStateChange(fn: () => void) {
  notifyChange = fn;
}
export interface StorageStatus {
  mode: 'off' | 'loading' | 'saved' | 'saving' | 'readonly' | 'error';
  savedAt: string | null;
  message: string;
}
let storageStatus: StorageStatus = { mode: 'off', savedAt: null, message: '이 화면에서는 저장 공간을 쓸 수 없어 새로고침하면 처음 상태로 돌아갑니다.' };
export function setStorageStatus(st: StorageStatus) {
  storageStatus = st;
}
let resetStorage: (() => Promise<void>) | null = null;
export function onResetStorage(fn: () => Promise<void>) {
  resetStorage = fn;
}

const LISTS = { revisions, users, qaVersions, qaRevisions, guidelineDocs, guidelineChunks, notices, auditLogs, conversations, messages, feedback, reviewQueue, inquiries, principleSets, principles };
export function exportState(): Json {
  return {
    v: 1,
    seq,
    settings,
    qaVersionId,
    qaItems,
    outOfScope,
    ...Object.fromEntries(Object.entries(LISTS).map(([k, v]) => [k, v])),
  };
}
export function importState(st: Json): void {
  if (!st || st.v !== 1) return;
  seq = Math.max(seq, Number(st.seq) || 0);
  Object.assign(settings, st.settings ?? {});
  qaVersionId = st.qaVersionId ?? qaVersionId;
  qaItems = st.qaItems ?? qaItems;
  for (const [k, list] of Object.entries(LISTS) as [string, Json[]][]) {
    if (Array.isArray(st[k])) list.splice(0, list.length, ...st[k]);
  }
  // 예전에 저장된 데이터에서도 데모 사용자의 기본 사업 유형은 '순수앵커'
  // 검수자 역할을 없앴다: 예전에 저장된 데모의 검수자 계정은 지운다 (권한은 관리자가 가짐)
  for (const u of users.filter((x) => x.role === 'reviewer')) users.splice(users.indexOf(u), 1);
  // 집행원리 열 형식을 바꿨다: 예전 형식으로 저장된 데모 집행원리는 비운다
  if (principles.some((p) => p.keywords === undefined)) {
    principles.splice(0, principles.length);
    principleSets.splice(0, principleSets.length);
  }
  const demoUser = users.find((u) => u.username === 'user');
  if (demoUser) demoUser.business_type = '순수앵커';
}

// ================= 요청 처리 =================
export async function handle(method: string, url: string, body: Json): Promise<{ status: number; data: Json }> {
  const u = new URL(url, 'http://demo.local');
  const r = routes.find((x) => x.method === method && x.re.test(u.pathname));
  if (!r) return { status: 404, data: { error: '없는 주소입니다.' } };
  const me = users.find((x) => x.id === currentUserId);
  if (LEVEL[r.role] > 0) {
    if (!me) return { status: 401, data: { error: '로그인이 필요합니다.' } };
    if (LEVEL[me.role as keyof typeof LEVEL] < LEVEL[r.role]) return { status: 403, data: { error: '권한이 없습니다.' } };
  }
  // 질문 답변은 실제처럼 잠깐 기다렸다 보낸다
  if (/\/messages$/.test(u.pathname) && method === 'POST' && !ai) await new Promise((res) => setTimeout(res, 700));
  try {
    const data = await r.handler({ params: u.pathname.match(r.re)!.slice(1), body: body ?? {}, query: u.searchParams, me });
    if (method !== 'GET' && !u.pathname.startsWith('/api/auth/') && !u.pathname.startsWith('/api/demo/')) notifyChange();
    return { status: 200, data };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, data: { error: e.message, code: e.code } };
    return { status: 500, data: { error: `데모 오류: ${(e as Error).message}` } };
  }
}

