import ExcelJS from 'exceljs';
import { findPii } from './text.js';

export interface ParsedQaItem {
  row: number;
  qa_id: string;
  category1: string;
  category2: string;
  category3: string;
  question: string;
  checklist: string;
  answer: string;
  referral_answer: string;
  is_referral: number;
  review_status: string;
  change_history: string;
}

export interface UploadWarning {
  row: number | null;
  qa_id?: string;
  message: string;
}

type Field = Exclude<keyof ParsedQaItem, 'row' | 'is_referral' | 'referral_answer'> | 'referral';

// 엑셀 머리글(공백·괄호 무시) → 필드
const QA_HEADERS: Record<Field, string[]> = {
  qa_id: ['통합번호', '번호', 'id'],
  category1: ['대분류', '사업유형'],
  category2: ['중분류'],
  category3: ['소분류', '소분류코드'],
  question: ['대표질의', '대표질문', '질의'],
  checklist: ['요지체크리스트', '요지', '체크리스트'],
  answer: ['통합답안', '표준답안', '답안'],
  referral: ['연결형답변', '연결형', '연결형여부'],
  review_status: ['검수상태', '검수'],
  change_history: ['답변변경이력', '변경이력'],
};

function normHeader(s: string): string {
  return s.replace(/\(.*?\)/g, '').replace(/\s/g, '').toLowerCase();
}

export function cellText(cell: ExcelJS.Cell): string {
  return (cell.text ?? '').replace(/\r\n/g, '\n').trim();
}

/** 머리글 행(처음 10행 안)을 찾아 열 번호를 정한다 */
export function findColumns<F extends string>(sheet: ExcelJS.Worksheet, headers: Record<F, string[]>, required: NoInfer<F>[]) {
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    const cols = {} as Partial<Record<F, number>>;
    row.eachCell((cell, col) => {
      const h = normHeader(cellText(cell));
      if (!h) return;
      for (const [field, aliases] of Object.entries(headers) as [F, string[]][]) {
        if (cols[field] === undefined && aliases.some((a) => h === a)) cols[field] = col;
      }
    });
    if (required.every((f) => cols[f] !== undefined)) return { headerRow: r, cols };
  }
  return null;
}

const REFERRAL_YES = ['y', 'yes', 'o', '○', '●', 'v', '예', '연결', '연결형', 'true', '1', '해당'];
const REFERRAL_NO = ['n', 'no', 'x', '-', '아니오', '아님', '해당없음', 'false', '0'];

function parseReferral(raw: string): { is_referral: number; referral_answer: string } {
  const v = raw.trim();
  const low = v.toLowerCase();
  if (!v || REFERRAL_NO.includes(low)) return { is_referral: 0, referral_answer: '' };
  if (REFERRAL_YES.includes(low)) return { is_referral: 1, referral_answer: '' };
  // 짧은 표시가 아니라 문장이 들어 있으면 연결형 답변 문구로 본다
  return { is_referral: 1, referral_answer: v };
}

export async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new Error('엑셀(.xlsx) 파일을 읽을 수 없습니다. 엑셀에서 “다른 이름으로 저장 → Excel 통합 문서(.xlsx)”로 저장해 주세요.');
  }
  return wb;
}

function maskSample(s: string): string {
  return s.length <= 4 ? '****' : `${s.slice(0, 3)}${'*'.repeat(Math.min(8, s.length - 3))}`;
}

/** 표준 Q&A 엑셀('통합질의' 시트)을 읽는다 */
export async function parseQaWorkbook(buffer: Buffer): Promise<{ items: ParsedQaItem[]; warnings: UploadWarning[]; sheetName: string }> {
  const wb = await loadWorkbook(buffer);
  const sheet = wb.worksheets.find((s) => s.name.replace(/\s/g, '') === '통합질의') ?? wb.worksheets[0];
  if (!sheet) throw new Error('엑셀에 시트가 없습니다.');
  const found = findColumns(sheet, QA_HEADERS, ['qa_id', 'question', 'answer']);
  if (!found) {
    throw new Error(`'${sheet.name}' 시트에서 머리글(통합번호·대표 질의·통합 답안)을 찾지 못했습니다. ‘통합질의’ 시트 형식을 확인해 주세요.`);
  }
  const { headerRow, cols } = found;
  const items: ParsedQaItem[] = [];
  const warnings: UploadWarning[] = [];
  const seen = new Set<string>();

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const get = (f: Field) => (cols[f] ? cellText(row.getCell(cols[f]!)) : '');
    const qa_id = get('qa_id');
    const question = get('question');
    const answer = get('answer');
    if (!qa_id && !question && !answer) continue; // 빈 행
    if (!qa_id || !question || !answer) {
      warnings.push({ row: r, qa_id, message: '통합번호·대표 질의·통합 답안 중 빈 칸이 있어 제외했습니다.' });
      continue;
    }
    if (seen.has(qa_id)) warnings.push({ row: r, qa_id, message: `통합번호 ${qa_id}가 중복됩니다.` });
    seen.add(qa_id);

    const item: ParsedQaItem = {
      row: r,
      qa_id,
      category1: get('category1'),
      category2: get('category2'),
      category3: get('category3'),
      question,
      checklist: get('checklist'),
      answer,
      ...parseReferral(get('referral')),
      review_status: get('review_status'),
      change_history: get('change_history'),
    };
    for (const text of [item.question, item.checklist, item.answer, item.referral_answer]) {
      for (const m of findPii(text)) {
        warnings.push({ row: r, qa_id, message: `${m.kind}로 보이는 값이 있습니다: ${maskSample(m.text)}` });
      }
    }
    items.push(item);
  }
  if (!items.length) throw new Error('읽을 수 있는 표준답안 행이 없습니다.');
  return { items, warnings, sheetName: sheet.name };
}

export interface ParsedOutOfScope {
  question: string;
  guidance: string;
  department: string;
}

/** 답변범위 외 목록 (엑셀: 대표 질의 / 안내 문구 / 담당 부서, 또는 텍스트: 한 줄에 질의 하나) */
export async function parseOutOfScope(buffer: Buffer, filename: string): Promise<ParsedOutOfScope[]> {
  if (/\.(txt|md|csv)$/i.test(filename)) {
    return buffer
      .toString('utf8')
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
      .filter(Boolean)
      .map((question) => ({ question, guidance: '', department: '' }));
  }
  const wb = await loadWorkbook(buffer);
  for (const sheet of wb.worksheets) {
    const found = findColumns(
      sheet,
      {
        question: ['대표질의', '대표질문', '질의', '질문'],
        guidance: ['안내문구', '안내', '답변'],
        department: ['담당부서', '부서', '담당'],
      },
      ['question'],
    );
    if (!found) continue;
    const out: ParsedOutOfScope[] = [];
    for (let r = found.headerRow + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const get = (c?: number) => (c ? cellText(row.getCell(c)) : '');
      const question = get(found.cols.question);
      if (question) out.push({ question, guidance: get(found.cols.guidance), department: get(found.cols.department) });
    }
    if (out.length) return out;
  }
  throw new Error('‘대표 질의’ 머리글이 있는 시트를 찾지 못했습니다.');
}

/** 답변 원칙 (엑셀: ‘원칙’ 또는 ‘내용’ 열, 텍스트: 그대로). 한 줄에 한 항목으로 돌려준다 */
export async function parsePrinciples(buffer: Buffer, filename: string): Promise<string> {
  if (/\.(txt|md)$/i.test(filename)) return buffer.toString('utf8').trim();
  const wb = await loadWorkbook(buffer);
  for (const sheet of wb.worksheets) {
    const found = findColumns(sheet, { content: ['원칙', '내용', '답변원칙'], no: ['번호', '원칙번호', 'no'] }, ['content']);
    if (!found) continue;
    const lines: string[] = [];
    for (let r = found.headerRow + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const content = cellText(row.getCell(found.cols.content!)).replace(/\n+/g, ' ');
      if (!content) continue;
      const no = found.cols.no ? cellText(row.getCell(found.cols.no)) : '';
      lines.push(no ? `${no}. ${content}` : `- ${content}`);
    }
    if (lines.length) return lines.join('\n');
  }
  throw new Error('‘원칙’ 또는 ‘내용’ 머리글이 있는 시트를 찾지 못했습니다.');
}

/** 표준 Q&A를 업로드 양식과 같은 형식의 엑셀로 내보낸다 */
export async function buildQaWorkbook(items: Omit<ParsedQaItem, 'row'>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('통합질의');
  sheet.columns = [
    { header: '통합번호', key: 'qa_id', width: 12 },
    { header: '대분류', key: 'category1', width: 12 },
    { header: '중분류', key: 'category2', width: 14 },
    { header: '소분류', key: 'category3', width: 12 },
    { header: '대표 질의', key: 'question', width: 50 },
    { header: '요지 체크리스트', key: 'checklist', width: 40 },
    { header: '통합 답안', key: 'answer', width: 80 },
    { header: '연결형 답변', key: 'referral', width: 20 },
    { header: '검수상태', key: 'review_status', width: 10 },
    { header: '답변 변경 이력', key: 'change_history', width: 30 },
  ];
  for (const it of items) {
    sheet.addRow({ ...it, referral: it.referral_answer || (it.is_referral ? 'Y' : '') });
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
