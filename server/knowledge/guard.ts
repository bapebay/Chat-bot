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

/**
 * 답변에 AI 지시문(시스템 프롬프트)의 문장이 그대로 들어 있으면 true.
 * 지시문에서 길고 특징적인 줄(공백 제외 25자 이상) 하나가 통째로 답변에 나오면 새어 나온 것으로 본다.
 */
export function leaksInstructions(answer: string, instructions: string): boolean {
  const a = squash(answer);
  if (a.includes('"answer_type"') || a.includes('cited_qa_ids')) return true;
  return instructions
    .split('\n')
    .map((l) => squash(l.replace(/^[-#*\d.\s]+/, '')))
    .filter((l) => l.length >= 25)
    .some((l) => a.includes(l));
}

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
