// 대화에서 앞 질문을 이어 묻는 말인지 판단한다 (서버와 데모 페이지가 함께 쓴다)

// 앞 질문을 받는 말: "그럼 …", "그 경우 …", "만약 …", "…은요?" 등
const FOLLOW_UP_START = /^(그럼|그러면|그렇다면|그런데|근데|그건|그것|그거|그 경우|이 경우|그때|그리고|또|또한|추가로|만약|혹시|아까|앞서|방금|위의?|해당)/;
const FOLLOW_UP_ANY = /더 |자세히|예시|예를|다시|이어서|그 경우|이 경우|위 내용|앞의|그 금액|그 기준|그 한도/;
// "성과급은요?"처럼 주어만 바꿔 묻는 꼴 ("가능한가요?" 같은 일반 어미는 제외)
const FOLLOW_UP_END = /[은는도]요\?*$|어때요\?*$|어떻게요\?*$/;

export function looksLikeFollowUp(query: string): boolean {
  const q = query.trim();
  const len = q.replace(/\s/g, '').length;
  if (len <= 8) return true;
  if (len > 40) return false;
  return FOLLOW_UP_START.test(q) || FOLLOW_UP_ANY.test(q) || (len <= 20 && FOLLOW_UP_END.test(q));
}
