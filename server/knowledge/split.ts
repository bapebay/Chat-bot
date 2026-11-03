// 한 번에 여러 가지를 묻는 질문 처리 (서버와 데모 페이지가 함께 쓴다).
// 검색은 "질문 낱말의 절반 이상을 담은 표준답안"을 근거로 인정하는데, 두 질문을 붙이면 어떤 답안도
// 절반을 담지 못해 근거가 탈락한다. 그래서 질문을 나눠 각각 찾은 뒤 결과를 합친다.

/** 질문으로 끝나는 말 (이게 없는 문장은 뒤 질문의 배경 설명으로 본다) */
const QUESTION_END =
  /(\?|？|나요|까요|가요|는지|인지|은지|던지|한지|지요|죠|니까|습니까|ㅂ니까|는가|는데요|싶습니다|궁금합니다|궁금해요|문의드립니다|문의합니다|여쭙니다|알려\s*주세요|알려\s*줘|알려주십시오|여부|주세요|주십시오|줘|줄래요?|바랍니다|부탁드립니다|부탁해요|되나|될까|있나|없나|하나|인가)\s*[.,!~]*$/;

/** 두 질문을 잇는 말 (문장 중간에 따로 떨어져 있을 때만) */
const JOINERS = /\s(?:그리고|또한|아울러|추가로|덧붙여|더불어|또)\s/g;

/** 번호 매긴 목록: '1.', '2)', '(3)', '①', '가.' 등 */
const NUMBERED = /(?:^|\s)(?:\d{1,2}[.)]|\(\d{1,2}\)|[①-⑩]|[가-하][.)])\s+/g;

const MAX_PARTS = 4;
/** '궁금합니다', '여부를 알려 주세요', '확인 부탁드립니다'처럼 묻는 말만 있고 내용이 없는 조각인지 */
const FILLER = /(여부|궁금|합니다|해요|알려|주세요|주십시오|줘|문의|드립니다|드려요|확인|부탁|싶습니다|가능|불가능|한지|인지|는지|은지|하는|해도|되는|되나요|나요|까요|요|를|을|이|가|에|도|대해|대하여|관련|좀|감사)/g;
const hasContent = (s: string) => s.replace(FILLER, '').replace(/[\s\p{P}\p{S}]/gu, '').length >= 4;
const meaningful = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, '').length >= 6;

/**
 * 한 메시지에 담긴 질문들을 나눈다. 질문이 하나면 [원문] 그대로.
 * 질문으로 끝나지 않는 문장(배경 설명)은 바로 뒤 질문에 붙인다.
 */
export function splitQuestions(text: string): string[] {
  const t = text.trim();
  if (!t) return [t];
  const pieces = t
    .replace(NUMBERED, '\n')
    .replace(JOINERS, '\n')
    // 문장 끝(물음표, 마침표·느낌표 뒤 띄어쓰기). 숫자 사이 마침표(1.5)는 자르지 않는다
    .replace(/([?？!])\s*/g, '$1\n')
    // '…할 수 있는지, …'·'…인지 산학공동…'처럼 질문 끝말 뒤에 다른 말이 이어지면 자른다
    // (자른 뒤 '궁금합니다'·'확인 부탁드립니다'처럼 내용 없는 조각은 아래에서 앞 질문에 다시 붙인다)
    .replace(/(는지|인지|은지|한지|나요|까요|가요|습니까|니까)(?:,\s*|\s+)(?=\S)/g, '$1\n')
    .replace(/(?<!\d)\.\s+/g, '.\n')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(meaningful);

  const parts: string[] = [];
  let context = '';
  for (const p of pieces) {
    // 내용 없는 꼬리말은 앞 질문에 붙인다
    if (!hasContent(p) && parts.length && !context) {
      parts[parts.length - 1] = `${parts[parts.length - 1]} ${p}`;
      continue;
    }
    if (QUESTION_END.test(p)) {
      parts.push(context ? `${context} ${p}` : p);
      context = '';
    } else {
      context = context ? `${context} ${p}` : p;
    }
  }
  if (context) {
    // 질문 꼴이 아닌 문장만 남았으면 마지막 질문에 붙이거나, 질문이 없으면 그대로 하나로 본다
    if (parts.length) parts[parts.length - 1] = `${parts[parts.length - 1]} ${context}`;
    else parts.push(context);
  }
  if (parts.length <= 1) return [t];
  if (parts.length > MAX_PARTS) return [...parts.slice(0, MAX_PARTS - 1), parts.slice(MAX_PARTS - 1).join(' ')];
  return parts;
}

/**
 * 원문으로 근거를 못 찾았을 때만 쓰는 두 번째 나누기: 'A랑 B', 'A하고 B', 'A와 B', 'A 및 B'.
 * ('인건비 및 수당'처럼 한 주제인 경우가 많아 평소에는 나누지 않는다)
 */
export function splitByAnd(text: string): string[] {
  const parts = text
    .split(/(?:이랑|랑|하고|과|와)\s+|\s및\s|,\s*/)
    .map((s) => s.trim())
    .filter((s) => hasContent(s));
  return parts.length > 1 && parts.length <= MAX_PARTS ? parts : [text];
}

interface HitLike {
  relevant: boolean;
  score: number;
}
interface ResultLike {
  qa: HitLike[];
  guideline: HitLike[];
  principle?: HitLike[];
  passed: boolean;
}

/**
 * 원문 전체로 찾은 결과에, 나눈 질문마다 찾은 근거를 더한다.
 * 원문 결과의 근거도 모두 함께 넣으므로 나누지 않았을 때보다 나빠지지 않는다.
 * 질문마다 근거를 최대 perPart개씩 보태고, 전체는 maxQa·maxGuide개까지.
 */
export function mergeSearchResults<R extends ResultLike>(
  whole: R,
  parts: R[],
  key: {
    qa: (h: R['qa'][number]) => string | number;
    guideline: (h: R['guideline'][number]) => string | number;
    principle?: (h: NonNullable<R['principle']>[number]) => string | number;
  },
  limits: { perPart: number; maxQa: number; maxGuide: number; maxPrinciple?: number },
): R {
  // 질문마다 1순위 근거부터 번갈아 넣어, 한 질문의 근거가 자리를 다 차지하지 않게 한다
  const merge = <H extends HitLike>(first: H[], lists: H[][], k: (h: H) => string | number, max: number) => {
    const seen = new Set<string | number>();
    const out: H[] = [];
    const add = (h: H) => {
      if (out.length >= max || seen.has(k(h))) return;
      seen.add(k(h));
      out.push(h);
    };
    // 원문 전체로 찾은 1순위를 맨 앞에 (질문이 하나인데 잘게 나뉜 경우 순위가 바뀌지 않게)
    const best = first.find((h) => h.relevant);
    if (best) add(best);
    const relevant = lists.map((l) => l.filter((h) => h.relevant).slice(0, limits.perPart));
    for (let i = 0; i < limits.perPart; i++) for (const l of relevant) if (l[i]) add(l[i]);
    first.filter((h) => h.relevant).forEach(add);
    // 남는 자리는 기준에 가까운 항목으로 (원문 결과 순서대로)
    first.filter((h) => !h.relevant).forEach(add);
    return out;
  };
  const qa = merge(whole.qa, parts.map((p) => p.qa), key.qa, limits.maxQa);
  const guideline = merge(whole.guideline, parts.map((p) => p.guideline), key.guideline, limits.maxGuide);
  const principle =
    whole.principle && key.principle
      ? merge(whole.principle, parts.map((p) => p.principle ?? []), key.principle, limits.maxPrinciple ?? whole.principle.length)
      : whole.principle;
  return { ...whole, qa, guideline, principle, passed: whole.passed || parts.some((p) => p.passed) };
}

/** 여러 질문일 때 AI에게 붙이는 안내 */
export function multiQuestionNote(parts: string[], answered: boolean[]): string {
  const list = parts.map((p, i) => `${i + 1}) ${p}${answered[i] ? '' : ' ← 근거 자료를 찾지 못함'}`).join('\n');
  return `[이 메시지에는 질문이 ${parts.length}개 있다. 번호를 매겨 각각 답하고, 근거 자료로 답할 수 없는 질문은 그 질문만 담당자 확인이 필요하다고 안내한다]\n${list}`;
}
