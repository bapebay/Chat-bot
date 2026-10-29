// 화면과 서버가 함께 쓰는 선택지 값

export const ORG_TYPES = ['재단', '지역앵커센터', '대학'] as const;

export const REGIONS = [
  '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기',
  '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '해당없음',
] as const;

export const BUSINESS_TYPES = ['순수앵커', '글로컬', '의대교육', '초광역', '기타', '모름'] as const;

export const ROLES = ['user', 'reviewer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const MAX_LOGIN_FAILURES = 10;
