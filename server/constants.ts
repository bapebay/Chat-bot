// 화면과 서버가 함께 쓰는 선택지 값

export const ORG_TYPES = ['재단', '지역앵커센터', '대학'] as const;

export const REGIONS = [
  '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기',
  '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '해당없음',
] as const;

export const BUSINESS_TYPES = ['순수앵커', '글로컬', '의대교육', '초광역', '기타', '모름'] as const;
/** 새 대화의 기본 사업 유형. 가입 때 고른 유형과 관계없이 모든 사용자에게 같다 (대화마다 바꿀 수는 있음) */
export const DEFAULT_BUSINESS_TYPE = '순수앵커';

export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const MAX_LOGIN_FAILURES = 10;
/** 로그인을 연속으로 틀렸을 때 잠시 막는 시간(분). 지나면 저절로 풀린다 (관리자 해제 불필요) */
export const LOGIN_LOCK_MINUTES = 15;

export const ANSWER_TYPES = ['근거답변', '연결형', '답변범위외', '근거없음'] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];
