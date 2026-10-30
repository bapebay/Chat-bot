/* 데모 페이지용 가짜 서버: 브라우저 메모리 안에서 실제 서버 API를 흉내 낸다.
   검색은 실제 서버의 키워드 검색 코드(server/knowledge)를 그대로 쓰고,
   AI 대신 '테스트 모델'이 검색된 표준답안으로 답을 만든다. 새로고침하면 처음 상태로 돌아간다. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Bm25 } from '../../../server/knowledge/bm25';
import { DEFAULT_SYSTEM_PROMPT, OUTPUT_INSTRUCTIONS } from '../../../server/defaults';
import { parseEvalWorkbook } from '../../../server/evaluation-excel';
import { parseOutOfScope, parsePrinciples, parseQaWorkbook } from '../../../server/knowledge/excel';
import { looksLikeFollowUp } from '../../../server/knowledge/followup';
import { chunkDocument, extractPdfPages } from '../../../server/knowledge/guideline';
import { maskPii, QUERY_STOP_TOKENS, tokenize } from '../../../server/knowledge/text';
import { DEMO_EVAL_ITEMS, DEMO_GUIDELINE_TEXT, DEMO_OUT_OF_SCOPE, DEMO_PRINCIPLES, DEMO_QA, REGIONS_17, type DemoQa } from './data';

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
  principles: DEMO_PRINCIPLES,
  include_unreviewed: 'false',
  threshold_keyword: '0.5',
  threshold_semantic: '0.83',
  top_k_qa: '6',
  top_k_guideline: '3',
  daily_limit_user: '50',
  daily_limit_total: '3000',
  eval_pass_hit_rate: '0.8',
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
    business_type: '모름',
    ...u,
  };
  users.push(row);
  return row;
}
const admin = addUser({ username: 'admin', role: 'admin', org_type: '재단', org_name: '중앙앵커센터', region: '해당없음' });
addUser({ username: 'reviewer', role: 'reviewer', org_type: '재단', org_name: '중앙앵커센터', region: '해당없음' });
const user = addUser({ username: 'user', role: 'user', org_type: '대학', org_name: '가상대학교 산학협력단', region: '부산', business_type: '글로컬' });
const others = [
  addUser({ username: 'center_daegu', role: 'user', org_type: '지역앵커센터', org_name: '대구 지역앵커센터(가상)', region: '대구' }),
  addUser({ username: 'univ_gw', role: 'user', org_type: '대학', org_name: '가상과학기술대학교', region: '강원', business_type: '순수앵커' }),
];
addUser({ username: 'univ_new', role: 'user', org_type: '대학', org_name: '가상국립대학교', region: '전남', business_type: '의대교육', status: 'pending', last_login_at: null, created_at: ago(90) });
const DEMO_PASSWORD = 'demo1234';
let currentUserId: number | null = null;

let qaVersionId = nextId();
const qaVersions: Json[] = [
  { id: qaVersionId, filename: '표준QA_통합질의_가상.xlsx', uploaded_by_name: 'admin', status: 'active', item_count: DEMO_QA.length, warnings: [], created_at: ago(60 * 24 * 3), activated_at: ago(60 * 24 * 3) },
];
let qaItems: Json[] = DEMO_QA.map((q) => ({ id: nextId(), version_id: qaVersionId, needs_recheck: 0, ...q }));
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
let outOfScope = DEMO_OUT_OF_SCOPE.map((o) => ({ id: nextId(), ...o }));

const referralContacts: Json[] = [
  ...REGIONS_17.map((r, i) => ({ id: nextId(), target: '지역앵커센터', region: r, name: `${r} 지역앵커센터`, contact: r === '부산' ? '051-000-0000 (예시 번호)' : '', note: '', sort_order: i })),
  { id: nextId(), target: 'e나라도움', region: null, name: 'e나라도움 콜센터', contact: '', note: '', sort_order: 100 },
  { id: nextId(), target: '교육부', region: null, name: '교육부 담당 부서', contact: '', note: '', sort_order: 101 },
  { id: nextId(), target: '대학규정', region: null, name: '소속 대학 산학협력단', contact: '', note: '소속 대학의 사업비 관리 규정을 확인하세요.', sort_order: 102 },
  { id: nextId(), target: '담당자', region: null, name: '중앙앵커센터(한국연구재단)', contact: '', note: '챗봇의 ‘담당자에게 문의’로 남겨 주시면 확인 후 답변드립니다.', sort_order: 103 },
];

const notices: Json[] = [{ id: nextId(), title: '[데모] 사업비 지침 개정 안내 (가상)', body: '보직수당 1인당 한도 기준이 변경되었습니다. 관련 답안은 재검수 중입니다.', active: 1, created_at: ago(60 * 24) }];
const auditLogs: Json[] = [];
function audit(action: string, target = '', detail = '') {
  const u = users.find((x) => x.id === currentUserId);
  auditLogs.unshift({ id: nextId(), username: u?.username ?? null, action, target, detail, created_at: ts() });
}
auditLogs.push(
  { id: nextId(), username: 'admin', action: '표준 Q&A 서비스 적용', target: `#${qaVersionId}`, detail: '', created_at: ago(60 * 24 * 3) },
  { id: nextId(), username: 'admin', action: '권한 변경', target: 'reviewer', detail: 'user → reviewer', created_at: ago(60 * 24 * 5) },
);

const conversations: Json[] = [];
const messages: Json[] = [];
const feedback: Json[] = [];
const reviewQueue: Json[] = [];
const inquiries: Json[] = [];
const evalSets: Json[] = [];
const evalItems: Json[] = [];
const evalRuns: Json[] = [];
const evalResults: Json[] = [];

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
  const oos = rank(outOfScope, outOfScope.map((o) => o.question), query, tk).sort((a, b) => b.score - a.score)[0];
  return {
    qa: qaHits,
    guideline: gHits,
    outOfScope: oos && oos.relevant ? oos : null,
    passed: qaHits.some((h) => h.relevant) || gHits.some((h) => h.relevant),
    mode: 'keyword' as const,
  };
}

/** 이번 질문의 낱말이 찾은 근거 안에 들어 있는지 (서버와 같은 규칙) */
function overlapsEvidence(query: string, r: Json): boolean {
  const tokens = new Set(tokenize(query).filter((t) => !QUERY_STOP_TOKENS.has(t)));
  const texts = [
    ...r.qa.filter((h: Json) => h.relevant).map((h: Json) => `${qaText(h.doc)}\n${h.doc.answer}`),
    ...r.guideline.filter((h: Json) => h.relevant).map((h: Json) => `${h.doc.clause}\n${h.doc.text}`),
  ];
  return texts.some((t: string) => tokenize(t).some((tok) => tokens.has(tok)));
}

// ================= 테스트 모델 답변 =================
/** AI 대신 검색된 표준답안 내용으로 답을 만든다 (서버의 근거 판정·유형 규칙은 같게) */
function generateAnswer(history: Json[], businessType: string, question: string) {
  const query = question.replace(/\[(?:전화번호|이메일|주민등록번호|계좌번호)\]/g, ' ');
  let r = search(query, businessType);
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
  };
  const base = { business_type: null, referral: null as string | null, qa: [] as Json[], guideline: [] as Json[], out_of_scope: null as Json, retrieved };
  const best = Math.max(r.qa.find((h: Json) => h.relevant)?.keyword ?? 0, r.guideline.find((h: Json) => h.relevant)?.keyword ?? 0);
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
      text: '**답변 요약**: 등록된 지침과 표준답안에서 이 질문의 근거를 찾지 못했습니다.\n\n추측으로 안내하지 않기 위해 답변을 드리지 않습니다. 질문을 조금 더 구체적으로(사업 유형, 비목, 상황) 바꿔 다시 물어보시거나, 아래 **담당자에게 문의**로 남겨 주시면 담당자가 확인합니다.',
      answerType: '근거없음',
      citations: { ...base, referral: '담당자' },
      model: false,
      r,
    };
  }
  const relQa = r.qa.filter((h: Json) => h.relevant);
  const top = relQa[0];
  const referral = top?.doc.is_referral;
  const citedQa = (referral ? relQa.slice(0, 1) : relQa.slice(0, 2)).map((h: Json) => h.doc);
  const g = r.guideline.findIndex((h: Json) => h.relevant);
  const citedGuide = g >= 0 ? [{ ...r.guideline[g].doc, id: `G${g + 1}` }] : [];
  const lines = [
    `**질의 요약**: ${question.slice(0, 100)}`,
    '',
    referral
      ? `**답변 요약**: 지역앵커센터 확인이 필요한 사항입니다. 아래 원칙을 참고하세요.`
      : `**답변 요약**: ${citedQa.length ? `표준답안 ${citedQa.map((q: Json) => q.qa_id).join(', ')}` : '지침 조항'}에 근거해 안내합니다.`,
    '',
    '**상세 안내**',
    ...citedQa.map((q: Json) => `- ${q.answer}`),
    ...(citedQa.length ? [] : citedGuide.map((c: Json) => `- ${c.text.split('\n').slice(1).join(' ')}`)),
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
  };
}

// ----- 실제 AI 답변: 실서비스(server/chat.ts)와 같은 프롬프트·근거 형식·출력 규칙 -----
const clean = (s: string) => s.replace(/[|\]]/g, '/');
function buildContext(r: Json): string {
  const parts: string[] = [];
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
  r.guideline.forEach((h: Json, i: number) => parts.push(`[지침 G${i + 1} | ${clean(h.doc.clause)} | 문서: ${clean(h.doc.doc_name)} | 쪽: ${h.doc.page ?? ''}]\n${h.doc.text}`));
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
async function answerWithAi(history: Json[], businessType: string, question: string) {
  const t = generateAnswer(history, businessType, question);
  const testResult = { ...t, provider: 'demo', modelName: 'test-model', latency: 900 + Math.round(Math.random() * 600) };
  if (!t.model || !ai) return testResult;
  const r = t.r;
  const principles = settings.principles.trim();
  const system = [settings.system_prompt, principles ? `# 답변 원칙 (담당자가 검수하며 정한 기준, 항상 지킨다)\n${principles}` : '', OUTPUT_INSTRUCTIONS]
    .filter(Boolean)
    .join('\n\n');
  let recent = history.slice(-6);
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
  const hist = recent.map((m) => `${m.role === 'user' ? '사용자' : '챗봇'}: ${stripDisclaimer(m.content)}`).join('\n\n');
  const input = `${system}\n\n# 이전 대화\n${hist || '(없음)'}\n\n[근거 자료]\n${buildContext(r)}\n\n[사용자가 선택한 사업 유형: ${businessType}]\n\n[질문]\n${question}`;
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
    text: json.answer_markdown.trim(),
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
  const source = a.answerType === '근거없음' ? 'no_evidence' : a.answerType === '답변범위외' ? 'out_of_scope' : null;
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
  const samples = [
    ['글로컬 사업단장에게 보직수당 지급 가능한가요?', '글로컬'],
    ['사업비 이월 가능한가요?', '모름'],
    ['정산보고서 언제까지 내야 하나요?', '모름'],
    ['1억원 이상 장비 구입 승인 절차는?', '모름'],
    ['순수앵커 보직수당 기준 알려주세요', '순수앵커'],
    ['사업단 워크숍 숙소 예약 방법은?', '모름'],
    ['선결제 가능한가요?', '모름'],
    ['자체평가 실적으로 인정되나요?', '모름'],
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

// ================= 평가 =================
function runEval(setId: number, label: string) {
  const items = evalItems.filter((i) => i.set_id === setId);
  const run: Json = {
    id: nextId(),
    set_id: setId,
    label,
    status: 'running',
    total: items.length,
    done: 0,
    config: {
      provider: 'demo',
      model: 'test-model',
      qa_version: `#${qaVersions.find((v) => v.status === 'active')?.id ?? '-'} ${qaVersions.find((v) => v.status === 'active')?.filename ?? '없음'}`,
      prompt: revisions.filter((r) => r.key === 'system_prompt').length ? `이력 #${revisions.filter((r) => r.key === 'system_prompt').at(-1)!.id}` : '기본값',
      prompt_hash: '-',
      include_unreviewed: settings.include_unreviewed === 'true',
      threshold_keyword: num('threshold_keyword'),
      threshold_semantic: num('threshold_semantic'),
      search_mode: '키워드',
    },
    summary: null,
    error: null,
    started_by_name: users.find((u) => u.id === currentUserId)?.username ?? 'admin',
    started_at: ts(),
    finished_at: null,
  };
  evalRuns.push(run);
  if (ai) {
    void runEvalWithAi(run, items);
    return run;
  }
  for (const it of items) {
    const a = generateAnswer([], it.business_type, it.question);
    const cited = a.citations.qa.map((q: Json) => q.qa_id);
    const retrieved = a.citations.retrieved.qa.map((q: Json) => q.qa_id);
    const exp = it.expected_qa_ids as string[];
    evalResults.push({
      id: nextId(),
      run_id: run.id,
      item_id: it.id,
      answer_type: a.answerType,
      answer: a.text,
      cited_qa_ids: cited,
      retrieved_qa_ids: retrieved,
      cite_hit: exp.length ? Number(exp.some((x) => cited.includes(x))) : null,
      retrieve_hit: exp.length ? Number(exp.some((x) => retrieved.includes(x))) : null,
      type_match: it.expected_type ? Number(it.expected_type === a.answerType) : null,
      input_tokens: a.model ? 3600 : null,
      output_tokens: a.model ? 300 : null,
      latency_ms: a.model ? 1100 : 30,
      error: null,
      verdict: null,
      verdict_note: '',
    });
  }
  // 진행 막대가 움직이도록 조금씩 완료 처리
  const timer = setInterval(() => {
    run.done = Math.min(run.total, run.done + 1);
    if (run.done >= run.total || run.status !== 'running') {
      clearInterval(timer);
      if (run.status === 'running') run.status = 'done';
      run.finished_at = ts();
      run.summary = summarize(run.id);
    }
  }, 350);
  return run;
}

function evalRow(run: Json, it: Json, a: Json, error: string | null = null) {
  const cited = a ? a.citations.qa.map((q: Json) => q.qa_id) : [];
  const retrieved = a ? a.citations.retrieved.qa.map((q: Json) => q.qa_id) : [];
  const exp = it.expected_qa_ids as string[];
  return {
    id: nextId(),
    run_id: run.id,
    item_id: it.id,
    answer_type: a?.answerType ?? null,
    answer: a?.text ?? '',
    cited_qa_ids: cited,
    retrieved_qa_ids: retrieved,
    cite_hit: exp.length ? Number(exp.some((x) => cited.includes(x))) : null,
    retrieve_hit: exp.length ? Number(exp.some((x) => retrieved.includes(x))) : null,
    type_match: it.expected_type ? Number(!!a && it.expected_type === a.answerType) : null,
    input_tokens: a?.inputTokens ?? null,
    output_tokens: a?.outputTokens ?? null,
    latency_ms: a?.latency ?? null,
    error,
    verdict: null,
    verdict_note: '',
  };
}

/** 실제 AI로 평가: 한 문항씩 차례로 부른다 (한꺼번에 부르면 사용 한도에 걸림) */
async function runEvalWithAi(run: Json, items: Json[]) {
  run.config.provider = 'claude.ai';
  run.config.model = `Claude ${TIER_LABEL[settings.demo_model_tier] ?? ''}`;
  for (const it of items) {
    if (run.status !== 'running') break;
    try {
      evalResults.push(evalRow(run, it, await answerWithAi([], it.business_type, it.question)));
    } catch (e) {
      evalResults.push(evalRow(run, it, null, (e as Error).message));
    }
    run.done++;
  }
  if (run.status === 'running') run.status = 'done';
  run.finished_at = ts();
  run.summary = summarize(run.id);
}

function summarize(runId: number) {
  const rows = evalResults.filter((r) => r.run_id === runId).map((r) => ({ ...r, expected_type: evalItems.find((i) => i.id === r.item_id)?.expected_type }));
  const rate = (n: number, d: number) => (d ? round(n / d) : null);
  const cite = rows.filter((r) => r.cite_hit !== null);
  const retr = rows.filter((r) => r.retrieve_hit !== null);
  const typed = rows.filter((r) => r.type_match !== null);
  const refer = typed.filter((r) => r.expected_type && r.expected_type !== '근거답변');
  const citeRate = rate(cite.filter((r) => r.cite_hit).length, cite.length);
  const wrong = rows.filter((r) => r.verdict === 'wrong').length;
  const unreviewed = rows.filter((r) => r.answer_type === '근거답변' && !r.verdict).length;
  const passHit = num('eval_pass_hit_rate');
  const scoreOk = citeRate !== null && citeRate >= passHit && wrong === 0 && rows.every((r) => !r.error);
  return {
    total: rows.length,
    errors: rows.filter((r) => r.error).length,
    cite_hit_rate: citeRate,
    cite_hit: cite.filter((r) => r.cite_hit).length,
    cite_total: cite.length,
    retrieve_hit_rate: rate(retr.filter((r) => r.retrieve_hit).length, retr.length),
    type_accuracy: rate(typed.filter((r) => r.type_match).length, typed.length),
    type_match: typed.filter((r) => r.type_match).length,
    type_total: typed.length,
    referral_accuracy: rate(refer.filter((r) => r.type_match).length, refer.length),
    wrong,
    unreviewed,
    input_tokens: rows.reduce((s, r) => s + (r.input_tokens ?? 0), 0),
    output_tokens: rows.reduce((s, r) => s + (r.output_tokens ?? 0), 0),
    avg_latency_ms: 800,
    pass_hit_rate: passHit,
    awaiting_review: scoreOk && unreviewed > 0,
    passed: scoreOk && unreviewed === 0,
  };
}

{
  const set = { id: nextId(), name: '시범운영 평가 질문집 (가상)', filename: '평가질문집_가상.xlsx', created_at: ago(60 * 24 * 2) };
  evalSets.push(set);
  DEMO_EVAL_ITEMS.forEach((e, i) =>
    evalItems.push({ id: nextId(), set_id: set.id, seq: i + 1, question: e.question, business_type: e.business_type, expected_qa_ids: e.expected, expected_type: e.type, note: '' }),
  );
  const r = runEval(set.id, '기준선');
  r.done = r.total;
  r.status = 'done';
  r.started_at = ago(60 * 24);
  r.finished_at = ago(60 * 24 - 2);
  r.summary = summarize(r.id);
}

// ================= 라우터 =================
type Handler = (p: { params: string[]; body: Json; query: URLSearchParams; me: Json }) => Json | Promise<Json>;
const routes: { method: string; re: RegExp; role: 'none' | 'user' | 'reviewer' | 'admin'; handler: Handler }[] = [];
const route = (method: string, path: string, role: 'none' | 'user' | 'reviewer' | 'admin', handler: Handler) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), role, handler });
const LEVEL = { none: 0, user: 1, reviewer: 2, admin: 3 } as const;
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
route('POST', '/api/conversations', 'user', ({ me, body }) => newConversation(me.id, body.business_type || me.business_type));
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
route('GET', '/api/suggestions', 'user', () => {
  const seen = new Map<string, string>();
  for (const q of activeQa()) if (q.category2 && !seen.has(q.category2) && q.question.length <= 60) seen.set(q.category2, q.question);
  return [...seen.entries()].slice(0, 8).map(([category, question]) => ({ category, question }));
});
route('GET', '/api/notices', 'user', () => notices.filter((n) => n.active).slice(0, 3));
route('GET', '/api/referral-contacts', 'user', ({ me }) =>
  referralContacts.filter((r) => (r.contact || r.note) && (r.target !== '지역앵커센터' || me.region === '해당없음' || r.region === me.region)),
);

// ----- 1:1 문의 -----
const inquiryRow = (i: Json) => {
  const u = byId(users, i.user_id);
  return { ...i, username: u?.username, org_name: u?.org_name, region: u?.region, answered_by_name: i.answered_by ? byId(users, i.answered_by)?.username : null };
};
route('GET', '/api/inquiries', 'user', ({ me }) => inquiries.filter((i) => i.user_id === me.id).sort((a, b) => b.id - a.id).map(inquiryRow));
route('POST', '/api/inquiries', 'user', ({ me, body }) => {
  if (!String(body.content ?? '').trim()) throw new HttpError(400, '문의 내용을 입력해 주세요.');
  const conv = body.conversation_id ? ownConv(me, String(body.conversation_id)) : null;
  const row = { id: nextId(), user_id: me.id, conversation_id: conv?.id ?? null, attached_transcript: conv ? transcript(conv.id) : null, content: body.content, answer: null, answered_by: null, status: 'pending', created_at: ts(), answered_at: null };
  inquiries.push(row);
  return inquiryRow(row);
});
route('GET', '/api/manage/inquiries', 'reviewer', ({ query }) => {
  const s = query.get('status');
  return inquiries.filter((i) => !s || i.status === s).sort((a, b) => b.id - a.id).map(inquiryRow);
});
route('POST', '/api/manage/inquiries/:id/answer', 'reviewer', ({ me, params, body }) => {
  const i = byId(inquiries, params[0]);
  if (!i) throw new HttpError(404, '문의를 찾을 수 없습니다.');
  Object.assign(i, { answer: body.answer, answered_by: me.id, status: 'answered', answered_at: ts() });
  return inquiryRow(i);
});

// ----- 검토 대기함·표준답안 편집 -----
route('GET', '/api/review/queue', 'reviewer', ({ query }) => {
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
        resolved_by_name: r.resolved_by ? byId(users, r.resolved_by)?.username : r.status !== 'pending' ? 'reviewer' : null,
        question: q?.content ?? null,
        cited_qa_ids: cit?.qa?.map((x: Json) => x.qa_id) ?? [],
        retrieved_qa_ids: cit?.retrieved?.qa?.map((x: Json) => x.qa_id) ?? [],
        feedback: feedback.filter((f) => f.message_id === m.id && f.rating === 'bad'),
      };
    });
});
route('POST', '/api/review/queue/:id/resolve', 'reviewer', ({ me, params, body }) => {
  const r = byId(reviewQueue, params[0]);
  if (!r) throw new HttpError(404, '항목을 찾을 수 없습니다.');
  Object.assign(r, { status: body.action === 'ignored' ? 'ignored' : 'resolved', resolution: body.action, qa_id: body.qa_id ?? null, note: body.note ?? '', resolved_by: me.id, resolved_at: ts() });
  return { ok: true };
});
const activeVersion = () => qaVersions.find((v) => v.status === 'active');
route('GET', '/api/review/qa', 'reviewer', ({ query }) => {
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
route('GET', '/api/review/qa/facets', 'reviewer', () => {
  const v = activeVersion();
  const items = qaItems.filter((i) => i.version_id === v?.id);
  const d = (k: string) => [...new Set(items.map((i) => i[k]).filter(Boolean))].sort();
  return { category1: d('category1'), category2: d('category2'), review_status: d('review_status') };
});
route('GET', '/api/review/qa/:qaId/revisions', 'reviewer', ({ params }) => qaRevisions.filter((r) => r.qa_id === decodeURIComponent(params[0])).sort((a, b) => b.id - a.id));
const QA_FIELDS = ['qa_id', 'category1', 'category2', 'category3', 'question', 'checklist', 'answer', 'referral_answer', 'review_status', 'change_history'];
const snap = (o: Json) => JSON.stringify(Object.fromEntries([...QA_FIELDS, 'is_referral'].map((k) => [k, k === 'is_referral' ? (o[k] ? 1 : 0) : o[k]])));
function readQa(body: Json) {
  const v: Json = Object.fromEntries(QA_FIELDS.map((k) => [k, String(body[k] ?? '').trim()]));
  if (!v.qa_id || !v.question || !v.answer) throw new HttpError(400, '통합번호·대표 질의·통합 답안은 비울 수 없습니다.');
  v.is_referral = body.is_referral ? 1 : 0;
  return v;
}
route('PUT', '/api/review/qa/:id', 'reviewer', ({ me, params, body }) => {
  const it = byId(qaItems, params[0]);
  if (!it) throw new HttpError(404, '표준답안을 찾을 수 없습니다.');
  const v = readQa(body);
  if (qaItems.some((x) => x.version_id === it.version_id && x.qa_id === v.qa_id && x.id !== it.id)) throw new HttpError(409, `통합번호 ${v.qa_id}가 이미 있습니다.`);
  qaRevisions.push({ id: nextId(), qa_id: v.qa_id, before_json: snap(it), after_json: snap(v), reason: body.reason ?? '', changed_by: me.username, created_at: ts() });
  Object.assign(it, v, { needs_recheck: 0 });
  audit('표준답안 수정', v.qa_id, body.reason ?? '');
  return it;
});
route('POST', '/api/review/qa', 'reviewer', ({ me, body }) => {
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
route('DELETE', '/api/review/qa/:id', 'reviewer', ({ me, params, body }) => {
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
route('POST', '/api/admin/users/:id/unlock', 'admin', ({ params }) => {
  Object.assign(userOr404(params[0]), { locked: false, failed_attempts: 0 });
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
  if (/^(threshold|eval_pass)/.test(key) && !(Number(value) >= 0 && Number(value) <= 1)) throw new HttpError(400, '0과 1 사이의 숫자를 입력하세요.');
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
route('GET', '/api/admin/knowledge/qa/versions/:id/items', 'reviewer', ({ params, query }) => {
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
const textOf = (b: ArrayBuffer) => new TextDecoder('utf-8').decode(b);

route('POST', '/api/admin/knowledge/qa/upload', 'admin', async ({ body }) => {
  const f = await readFile(body, /\.xlsx$/i);
  let parsed;
  try {
    parsed = await parseQaWorkbook(asBuffer(f.buf));
  } catch (e) {
    throw bad(e);
  }
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
  const f = await readFile(body, /\.(pdf|txt|md)$/i);
  let chunks;
  try {
    chunks = /\.pdf$/i.test(f.name) ? chunkDocument(await extractPdfPages(asBuffer(f.buf)), true) : chunkDocument([textOf(f.buf)], false);
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
route('POST', '/api/admin/knowledge/out-of-scope/upload', 'admin', async ({ body }) => {
  const f = await readFile(body, /\.(xlsx|txt|md|csv)$/i);
  let items;
  try {
    items = /\.xlsx$/i.test(f.name)
      ? await parseOutOfScope(asBuffer(f.buf), f.name)
      : textOf(f.buf).split(/\r?\n/).map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean).map((question) => ({ question, guidance: '', department: '' }));
  } catch (e) {
    throw bad(e);
  }
  outOfScope = items.map((o) => ({ id: nextId(), ...o }));
  audit('답변범위 외 목록 교체', f.name, `${items.length}건`);
  return { ok: true, count: items.length };
});
route('POST', '/api/admin/knowledge/principles/parse', 'admin', async ({ body }) => {
  const f = await readFile(body, /\.(xlsx|txt|md)$/i);
  try {
    return { text: /\.xlsx$/i.test(f.name) ? await parsePrinciples(asBuffer(f.buf), f.name) : textOf(f.buf).trim() };
  } catch (e) {
    throw bad(e);
  }
});
route('POST', '/api/admin/eval/sets', 'admin', async ({ body }) => {
  const f = await readFile(body, /\.xlsx$/i);
  let parsed;
  try {
    parsed = await parseEvalWorkbook(asBuffer(f.buf));
  } catch (e) {
    throw bad(e);
  }
  const set = { id: nextId(), name: (f.field('name') || f.name.replace(/\.[^.]+$/, '')).slice(0, 100), filename: f.name, created_at: ts() };
  evalSets.push(set);
  parsed.items.forEach((e, i) =>
    evalItems.push({ id: nextId(), set_id: set.id, seq: i + 1, question: e.question, business_type: e.business_type, expected_qa_ids: e.expected_qa_ids, expected_type: e.expected_type, note: e.note }),
  );
  return { id: set.id, count: parsed.items.length, warnings: parsed.warnings };
});
route('GET', '/api/admin/knowledge/out-of-scope', 'admin', () => outOfScope);
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
route('POST', '/api/admin/knowledge/search-test', 'reviewer', ({ body }) => {
  const r = search(String(body.query ?? ''), body.business_type || '모름');
  const f = (h: Json) => ({ keyword: round(h.keyword), semantic: null, relevant: h.relevant });
  return {
    mode: r.mode,
    passed: r.passed,
    qa: r.qa.map((h: Json) => ({ ...f(h), qa_id: h.doc.qa_id, category1: h.doc.category1, question: h.doc.question })),
    guideline: r.guideline.map((h: Json) => ({ ...f(h), doc_name: h.doc.doc_name, clause: h.doc.clause, page: h.doc.page })),
    out_of_scope: r.outOfScope ? { ...f(r.outOfScope), question: r.outOfScope.doc.question } : null,
  };
});

// ----- 관리: 연결 연락처 -----
route('GET', '/api/admin/referral-contacts', 'admin', () => [...referralContacts].sort((a, b) => a.sort_order - b.sort_order));
route('POST', '/api/admin/referral-contacts', 'admin', ({ body }) => {
  if (!body.name) throw new HttpError(400, '이름을 입력해 주세요.');
  const row = { id: nextId(), target: body.target, region: body.target === '지역앵커센터' ? body.region : null, name: body.name, contact: body.contact ?? '', note: body.note ?? '', sort_order: Number(body.sort_order) || 0 };
  referralContacts.push(row);
  audit('연결 연락처 추가', row.name);
  return row;
});
route('PUT', '/api/admin/referral-contacts/:id', 'admin', ({ params, body }) => {
  const r = byId(referralContacts, params[0]);
  if (!r) throw new HttpError(404, '연락처를 찾을 수 없습니다.');
  Object.assign(r, { target: body.target, region: body.target === '지역앵커센터' ? body.region : null, name: body.name, contact: body.contact ?? '', note: body.note ?? '' });
  audit('연결 연락처 수정', r.name, r.contact);
  return r;
});
route('DELETE', '/api/admin/referral-contacts/:id', 'admin', ({ params }) => {
  const r = byId(referralContacts, params[0]);
  if (r) referralContacts.splice(referralContacts.indexOf(r), 1);
  return { ok: true };
});

// ----- 관리: 평가 -----
route('GET', '/api/admin/eval/sets', 'admin', () =>
  evalSets.map((s) => ({ ...s, item_count: evalItems.filter((i) => i.set_id === s.id).length, run_count: evalRuns.filter((r) => r.set_id === s.id).length })),
);
route('DELETE', '/api/admin/eval/sets/:id', 'admin', ({ params }) => {
  const set = byId(evalSets, params[0]);
  if (!set) throw new HttpError(404, '평가 질문집을 찾을 수 없습니다.');
  if (evalRuns.some((r) => r.set_id === set.id && r.status === 'running')) throw new HttpError(409, '평가가 실행 중입니다.');
  evalSets.splice(evalSets.indexOf(set), 1);
  return { ok: true };
});
route('POST', '/api/admin/eval/sets/:id/runs', 'admin', ({ params, body }) => {
  if (evalRuns.some((r) => r.status === 'running')) throw new HttpError(409, '이미 실행 중인 평가가 있습니다.');
  return runEval(Number(params[0]), body.label || '데모 실행');
});
route('GET', '/api/admin/eval/runs', 'admin', () => [...evalRuns].sort((a, b) => b.id - a.id));
route('GET', '/api/admin/eval/runs/:id', 'admin', ({ params }) => {
  const run = byId(evalRuns, params[0]);
  if (!run) throw new HttpError(404, '평가 실행을 찾을 수 없습니다.');
  const items = evalItems.filter((i) => i.set_id === run.set_id).sort((a, b) => a.seq - b.seq);
  const results = items
    .slice(0, run.done)
    .map((i) => ({ i, r: evalResults.find((x) => x.run_id === run.id && x.item_id === i.id) }))
    .filter(({ r }) => r)
    .map(({ i, r }) => ({ ...r, seq: i.seq, question: i.question, business_type: i.business_type, expected_qa_ids: i.expected_qa_ids, expected_type: i.expected_type, note: i.note }));
  return { run: { ...run, summary: run.status === 'running' ? summarize(run.id) : run.summary }, results };
});
route('POST', '/api/admin/eval/runs/:id/cancel', 'admin', ({ params }) => {
  const r = byId(evalRuns, params[0]);
  if (r?.status === 'running') r.status = 'cancelled';
  return { ok: true };
});
route('DELETE', '/api/admin/eval/runs/:id', 'admin', ({ params }) => {
  const r = byId(evalRuns, params[0]);
  if (r) evalRuns.splice(evalRuns.indexOf(r), 1);
  return { ok: true };
});
route('PATCH', '/api/admin/eval/results/:id', 'admin', ({ params, body }) => {
  const r = byId(evalResults, params[0]);
  if (!r) throw new HttpError(404, '결과를 찾을 수 없습니다.');
  r.verdict = body.verdict === 'ok' || body.verdict === 'wrong' ? body.verdict : null;
  r.verdict_note = body.note ?? '';
  const run = byId(evalRuns, r.run_id)!;
  const summary = summarize(run.id);
  if (run.status !== 'running') run.summary = summary;
  return { ok: true, summary };
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
    return { status: 200, data: await r.handler({ params: u.pathname.match(r.re)!.slice(1), body: body ?? {}, query: u.searchParams, me }) };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, data: { error: e.message, code: e.code } };
    return { status: 500, data: { error: `데모 오류: ${(e as Error).message}` } };
  }
}

