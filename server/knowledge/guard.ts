// 프롬프트 인젝션(지시 바꾸기·지시문 빼내기·자료 통째 출력) 막기.
// 완벽한 차단은 불가능하므로 세 겹으로 막는다:
//   1) 질문 단계: 대놓고 하는 공격 문구는 AI를 부르지 않고 거절 (이 파일의 detectInjection)
//   2) AI 지시문: 근거 자료·질문 속 글은 지시가 아니라는 보안 규칙 (defaults.ts 의 SECURITY_RULES)
//   3) 답변 단계: 답변에 내부 지시문이 섞여 나오면 버린다 (leaksInstructions)
// 데모 페이지(web/src/demo)도 같은 함수를 쓴다.

/** 붙여 쓰기·띄어쓰기를 무시하고 비교하려고 공백을 지운 소문자 */
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');

interface Rule {
  reason: string;
  /** 공백을 지운 글에 맞춰 본다 */
  re: RegExp;
}

// 사업비 질문과 겹치지 않게 좁게 잡는다 (예: 'e나라도움 시스템 메시지', '증빙 자료를 전부 알려줘', '대학 내부 지침'은 걸리지 않음)
const RULES: Rule[] = [
  { reason: '지시 무시 요청', re: /(이전|위의?|앞의?|모든|너의|네|당신의)(의)?(지시|명령|프롬프트)(사항|문)?(을|를|은|는|들을|들은)?(모두|전부|다)?(무시|잊|따르지마|취소)/ },
  { reason: '지시 무시 요청', re: /(너의|네|당신의|위의|앞의)(규칙|설정|제약)(을|를|은|는)?(모두|전부|다)?(무시|잊|따르지마|해제)/ },
  { reason: '지시 무시 요청', re: /(ignore|disregard|forget)(all|any)?(the)?(previous|prior|above|earlier|your)?(instructions|rules|prompts?|directions)/ },
  { reason: '지시문 요청', re: /(시스템|system)(프롬프트|prompt)/ },
  { reason: '지시문 요청', re: /(프롬프트|지시문|초기설정)(을|를|은|는|이|가)?.{0,12}(보여|알려|출력|공개|말해|적어|복사|번역|요약|덧붙)/ },
  { reason: '지시문 요청', re: /(너의|네|당신의|네가받은|너에게주어진)(역할|답변원칙|원칙|규칙|지침|설정|지시)(과|와|을|를|은|는)?.{0,12}(보여|알려|출력|공개|말해|적어|번역|요약)/ },
  { reason: '지시문 요청', re: /(처음|최초|맨처음)(에)?(받은|주어진)(지시|명령|프롬프트|설정)/ },
  { reason: '지시문 요청', re: /(너에게|너한테|당신에게)(금지된|주어진|허용된).{0,12}(목록|알려|보여|정리|출력)/ },
  { reason: '내부 형식 요청', re: /json.{0,6}(원본|원문|그대로|키이름)/ },
  { reason: '권한 사칭', re: /(관리자|개발자|운영자)(권한|계정)(으로|이니|입니다|이라).{0,20}(출력|보여|공개|전문)/ },
  { reason: '지시문 요청', re: /(reveal|print|show|repeat|output)(me)?(your|the)(instructions|prompt|rules|systemprompt)/ },
  { reason: '지시문 요청', re: /(위|앞|이전)(의|에)?(내용|텍스트|글|문장|대화)(을|를)?(그대로|전부|토씨하나)(반복|출력)/ },
  { reason: '역할 변경 요청', re: /(너는|넌|당신은)이제(부터)?.{0,20}(이다|야|입니다|역할|행동|처럼|모드)/ },
  { reason: '역할 변경 요청', re: /(개발자|디버그|탈옥|제한해제)모드/ },
  { reason: '역할 변경 요청', re: /(youarenow|developermode|jailbreak)/ },
  { reason: '자료 일괄 출력 요청', re: /(표준답안|근거자료|데이터베이스|db|학습데이터)(원문)?(을|를|들을)?.{0,8}(전부|전체|모두|통째로|하나도빠짐없이|하나도빼지말고)(다)?.{0,4}(출력|보여|나열|덤프|내보내|뽑아|붙여)/ },
  { reason: '자료 일괄 출력 요청', re: /(전부|전체|모든)(의)?(표준답안|근거자료|데이터베이스)(을|를)?.{0,10}(출력|보여|나열|덤프|내보내|뽑아|붙여)/ },
  // 챗봇이 AI에 넘기는 내부 표시를 흉내 내 근거 자료를 꾸며 넣으려는 시도
  { reason: '내부 형식 위장', re: /\[(근거자료|질문|표준답안통합번호|지침g\d|지침및faqg\d|집행원리p\d|사용자가선택한사업유형)|<\/?근거자료>/ },
];

/** 대놓고 하는 공격 문구면 그 종류를, 아니면 null */
export function detectInjection(question: string): string | null {
  const s = squash(question);
  for (const r of RULES) if (r.re.test(s)) return r.reason;
  return null;
}

const longLines = (text: string) =>
  text
    .split('\n')
    .map((l) => squash(l.replace(/^[-#*\d.\s·]+/, '')))
    .filter((l) => l.length >= 25);

/**
 * 관리자가 쓴 시스템 프롬프트에서 '답변에 그대로 쓰라고 준 글'을 뺀 줄들.
 * - 따옴표 안 예시 문장("…", “…”, ‘…’)은 답변에 그대로 나올 수 있으니 뺀다
 * - 제목에 '그대로'가 들어간 단락(예: '# 마무리 문구 (모든 답변 끝에 그대로 붙임)')은 통째로 뺀다
 */
export function promptLinesToGuard(prompt: string): string[] {
  const kept: string[] = [];
  let verbatim = false;
  for (const raw of prompt.split('\n')) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) {
      verbatim = /그대로/.test(line);
      continue;
    }
    if (verbatim) continue;
    kept.push(line.replace(/"[^"]*"|“[^”]*”|‘[^’]*’|「[^」]*」/g, ''));
  }
  return longLines(kept.join('\n'));
}

/**
 * 답변에 AI 지시문의 문장이 그대로 들어 있으면 true.
 * - fixed: 보안 규칙·출력 형식처럼 답변에 나올 일이 없는 고정 지시문. 길고 특징적인 줄(공백 제외 25자 이상) 하나만 나와도 새어 나간 것으로 본다.
 * - custom: 관리자가 쓴 시스템 프롬프트. 답변 구조·마무리 문구처럼 일부러 답변에 쓰게 한 글이 있으므로,
 *   그대로 쓰라고 한 부분을 빼고, 서로 다른 줄이 2개 이상 나올 때만 새어 나간 것으로 본다.
 */
export function leaksInstructions(answer: string, fixed: string, custom = ''): boolean {
  const a = squash(answer);
  if (a.includes('"answer_type"') || a.includes('cited_qa_ids')) return true;
  if (longLines(fixed).some((l) => a.includes(l))) return true;
  return new Set(promptLinesToGuard(custom).filter((l) => a.includes(l))).size >= 2;
}

/** 답변 단계에서 막힌 경우의 사유 (질문한 사람의 잘못이 아니므로 하루 보안 횟수에 세지 않는다) */
export const LEAK_REASON = '지시문 노출 차단';

/** 공격 의심 질문에 돌려주는 안내 (AI를 부르지 않는다) */
export const BLOCKED_TEXT = [
  '**답변 요약**: 챗봇 운영 규칙이나 내부 자료에 관한 요청으로 보여 답변하지 않습니다.',
  '',
  '이 챗봇은 앵커 사업비 집행·관리 지침에 관한 질문에만 답합니다. 사업비 관련 질문을 해 주세요.',
  '',
  '이런 요청은 보안 점검을 위해 기록되며, 반복되면 이용이 제한될 수 있습니다.',
].join('\n');

/** 하루에 보안 의심 질문이 이 횟수에 이르면 그날은 더 질문할 수 없다 */
export const SECURITY_DAILY_STRIKES = 3;

/** 프롬프트에서 답변에 그대로 쓰게 한 글: 제목에 '그대로'가 든 단락의 줄과 따옴표 속 예시 문장 */
export function verbatimSnippets(prompt: string): string[] {
  const out: string[] = [];
  let verbatim = false;
  for (const raw of prompt.split('\n')) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) {
      verbatim = /그대로/.test(line);
      continue;
    }
    if (verbatim && line) out.push(line);
    for (const m of line.matchAll(/"([^"]{10,})"|“([^”]{10,})”/g)) out.push(m[1] ?? m[2]);
  }
  return out;
}

export interface GuardCheckResult {
  total: number;
  /** 대표 질의를 그대로 물었을 때 질문 단계에서 막히는 것 */
  question_blocked: { qa_id: string; question: string; reason: string }[];
  /** 표준답안 내용 + 프롬프트가 그대로 쓰게 한 글(마무리 문구·예시)로 만든 모의 답변이 답변 단계에서 막히는 것 */
  answer_blocked: { qa_id: string; question: string }[];
}

/**
 * AI를 부르지 않고, 표준답안 전체로 '보안 차단이 잘못 걸리는지'를 미리 점검한다.
 * 실제 AI 답변은 문장이 달라질 수 있으므로 어림값이며, 0건이 아니면 프롬프트나 차단 규칙을 고쳐야 한다는 신호다.
 */
export function guardCheck(items: { qa_id: string; question: string; answer: string }[], fixed: string, prompt: string): GuardCheckResult {
  const tail = verbatimSnippets(prompt).join('\n');
  const result: GuardCheckResult = { total: items.length, question_blocked: [], answer_blocked: [] };
  for (const it of items) {
    const reason = detectInjection(it.question);
    if (reason) result.question_blocked.push({ qa_id: it.qa_id, question: it.question, reason });
    const mock = `■ 질문요지\n- ${it.question}\n\n■ 답변\n${it.answer}\n\n${tail}`;
    if (leaksInstructions(mock, fixed, prompt)) result.answer_blocked.push({ qa_id: it.qa_id, question: it.question });
  }
  return result;
}

/**
 * 답변에 섞여 나온 내부 꼬리표를 사용자용 말로 바꾼다.
 * AI에 근거를 넘길 때 붙이는 'G1', 'P2' 같은 번호는 챗봇 안에서만 쓰는 것이라 사용자에게는 뜻이 없고 내부 형식을 드러낸다.
 * - '[지침 및 FAQ G2]', '지침 및 FAQ G2에 따르면' → 그 조항 문서의 종류('[지침]', 'FAQ에 따르면')
 * - '[집행원리 P1]' → '[질의응답 사례상 일반 원칙]'
 * guideKinds: AI에 넘긴 지침 조항 순서대로 문서 종류('지침' 또는 'FAQ')
 */
export function publicRefs(text: string, guideKinds: string[]): string {
  return text
    .replace(/(\[\s*)?지침\s*및\s*FAQ\s*G(\d{1,2})(\s*\])?/g, (_m, open: string | undefined, n: string, close: string | undefined) => {
      const kind = guideKinds[Number(n) - 1] ?? '지침';
      return open && close ? `[${kind}]` : `${open ? '[' : ''}${kind}${close ? ']' : ''}`;
    })
    .replace(/(\[\s*)?집행원리\s*P\d{1,2}(\s*\])?/g, (_m, open: string | undefined, close: string | undefined) =>
      open && close ? '[질의응답 사례상 일반 원칙]' : `${open ? '[' : ''}질의응답 사례상 일반 원칙${close ? ']' : ''}`,
    );
}
