import ExcelJS from 'exceljs';
import { BUSINESS_TYPES, ORG_TYPES, REGIONS, ROLES, type Role } from './constants.js';
import { cellText, findColumns, loadWorkbook } from './knowledge/excel.js';

// 계정 일괄 등록 엑셀 읽기·양식 (비밀번호 처리는 accounts.ts. 데모 페이지도 이 파일을 쓴다)

export interface AccountInput {
  username: string;
  org_type: string;
  org_name: string;
  region: string;
  business_type: string;
  role: string;
}

const ROLE_WORDS: Record<string, Role> = { 사용자: 'user', 검수자: 'reviewer', 관리자: 'admin', user: 'user', reviewer: 'reviewer', admin: 'admin' };

/** 아이디·소속·지역·사업 유형·권한 형식 확인 (중복 확인은 accounts.ts). 문제가 없으면 null */
export function accountFieldProblem(a: AccountInput): string | null {
  if (!/^[A-Za-z0-9._-]{4,30}$/.test(a.username)) return '아이디는 영문·숫자·._- 조합 4~30자로 입력해 주세요.';
  if (!ROLES.includes(a.role as Role)) return '권한을 선택해 주세요.';
  if (!(ORG_TYPES as readonly string[]).includes(a.org_type)) return '소속 구분을 선택해 주세요.';
  if (!a.org_name) return '기관명을 입력해 주세요.';
  if (!(REGIONS as readonly string[]).includes(a.region)) return '지역을 선택해 주세요.';
  if (!(BUSINESS_TYPES as readonly string[]).includes(a.business_type)) return '사업 유형을 선택해 주세요.';
  return null;
}

const HEADERS = {
  username: ['아이디', 'id', 'username'],
  org_type: ['소속구분', '소속'],
  org_name: ['기관명', '기관'],
  region: ['지역', '시도'],
  business_type: ['사업유형', '사업'],
  role: ['권한', '역할'],
};

export const MAX_BULK_ACCOUNTS = 500;

/** 계정 일괄 등록 엑셀을 읽는다. 사업 유형·권한이 비어 있으면 '모름'·'사용자' */
export async function parseAccountsWorkbook(buffer: Buffer): Promise<{ row: number; input: AccountInput }[]> {
  const wb = await loadWorkbook(buffer);
  for (const sheet of wb.worksheets) {
    const found = findColumns(sheet, HEADERS, ['username', 'org_type', 'org_name', 'region']);
    if (!found) continue;
    const { headerRow, cols } = found;
    const get = (row: ExcelJS.Row, col?: number) => (col ? cellText(row.getCell(col)) : '');
    const out: { row: number; input: AccountInput }[] = [];
    for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const username = get(row, cols.username);
      if (!username || username.startsWith('(예시)')) continue;
      const roleRaw = get(row, cols.role);
      out.push({
        row: r,
        input: {
          username,
          org_type: get(row, cols.org_type),
          org_name: get(row, cols.org_name),
          region: get(row, cols.region),
          business_type: get(row, cols.business_type) || '모름',
          role: roleRaw ? (ROLE_WORDS[roleRaw] ?? roleRaw) : 'user',
        },
      });
    }
    if (out.length > MAX_BULK_ACCOUNTS) throw new Error(`한 번에 ${MAX_BULK_ACCOUNTS}명까지 등록할 수 있습니다. 파일을 나눠 올려 주세요.`);
    return out;
  }
  throw new Error('‘아이디·소속 구분·기관명·지역’ 머리글이 있는 시트를 찾지 못했습니다. 양식을 내려받아 사용해 주세요.');
}

/** 계정 일괄 등록 양식 */
export async function buildAccountsTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('계정');
  s.columns = [
    { header: '아이디', key: 'u', width: 18 },
    { header: '소속 구분', key: 'o', width: 14 },
    { header: '기관명', key: 'n', width: 28 },
    { header: '지역', key: 'r', width: 10 },
    { header: '사업 유형', key: 'b', width: 12 },
    { header: '권한', key: 'p', width: 10 },
  ];
  s.getRow(1).font = { bold: true };
  s.addRow({ u: '(예시) busan_univ01', o: '대학', n: '○○대학교 산학협력단', r: '부산', b: '모름', p: '사용자' });
  const help = wb.addWorksheet('작성 안내');
  [
    '아이디: 영문·숫자·._- 조합 4~30자. 이름이나 연락처 등 개인정보는 넣지 않습니다.',
    `소속 구분: ${ORG_TYPES.join(' / ')}`,
    `지역: ${REGIONS.join(' / ')}`,
    `사업 유형: ${BUSINESS_TYPES.join(' / ')} (비우면 모름)`,
    '권한: 사용자 / 검수자 / 관리자 (비우면 사용자)',
    '‘(예시)’로 시작하는 행은 읽지 않습니다. 한 번에 500명까지 올릴 수 있습니다.',
    '등록하면 계정마다 임시 비밀번호가 나옵니다. 첫 로그인 때 비밀번호를 바꿔야 합니다.',
  ].forEach((t) => help.addRow([t]));
  help.getColumn(1).width = 100;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
