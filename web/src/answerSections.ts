// 답변 본문에서 '■ 세부내용' 단락을 따로 떼어 낸다 (화면에서 접어서 보여 주려고).
// 단락은 다음 '■' 제목이나 '※' 마무리 문구 앞까지. 제목 모양이 조금 달라도(굵게, '세부 내용', '###') 알아본다.

const DETAIL_HEADING = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*■?[ \t]*세부[ \t]*내용[ \t]*(?:\*\*)?[ \t:]*$/m;
const NEXT_SECTION = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*(?:■|※)/m;

export interface AnswerParts {
  /** 세부내용 앞 (질문요지·답변) */
  before: string;
  /** 세부내용 본문 (제목 줄 제외). 없으면 빈 문자열 */
  detail: string;
  /** 세부내용 뒤 (다른 ■ 단락, ※ 마무리 문구) */
  after: string;
}

export function splitDetail(body: string): AnswerParts {
  const m = DETAIL_HEADING.exec(body);
  if (!m) return { before: body, detail: '', after: '' };
  const start = m.index + m[0].length;
  const rest = body.slice(start);
  const next = NEXT_SECTION.exec(rest);
  const detail = (next ? rest.slice(0, next.index) : rest).trim();
  const after = next ? rest.slice(next.index).trim() : '';
  return { before: body.slice(0, m.index).trimEnd(), detail, after };
}
