// 평가 질문집 엑셀 읽기·양식 (서버와 데모 페이지가 함께 쓴다)
import ExcelJS from 'exceljs';
import { ANSWER_TYPES, BUSINESS_TYPES, type AnswerType } from './constants.js';


export interface ParsedEvalItem {
  question: string;
  business_type: string;
  expected_qa_ids: string[];
  expected_type: AnswerType | null;
  note: string;
}

const HEADERS: Record<keyof ParsedEvalItem, string[]> = {
  question: ['질문', '평가질문', '질의', '대표질의'],
  business_type: ['사업유형', '사업'],
  expected_qa_ids: ['기대통합번호', '정답통합번호', '통합번호', '기대번호'],
  expected_type: ['기대유형', '정답유형', '답변유형', '유형'],
  note: ['비고', '메모'],
};

/** "근거 답변", "연결", "범위 외" 같은 표기를 4가지 유형으로 맞춘다 */
export function normalizeAnswerType(raw: string): AnswerType | null {
  const s = raw.replace(/\s/g, '');
  if (!s) return null;
  if (s.startsWith('근거답') || s === '답변' || s === '근거') return '근거답변';
  if (s.startsWith('연결')) return '연결형';
  if (s.includes('범위')) return '답변범위외';
  if (s.startsWith('근거없') || s.includes('없음')) return '근거없음';
  return (ANSWER_TYPES as readonly string[]).includes(s) ? (s as AnswerType) : null;
}

const norm = (s: string) => s.replace(/\(.*?\)/g, '').replace(/\s/g, '').toLowerCase();

export async function parseEvalWorkbook(buffer: Buffer): Promise<{ items: ParsedEvalItem[]; warnings: string[] }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new Error('엑셀(.xlsx) 파일을 읽을 수 없습니다.');
  }
  for (const sheet of wb.worksheets) {
    for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
      const cols: Partial<Record<keyof ParsedEvalItem, number>> = {};
      sheet.getRow(r).eachCell((cell, c) => {
        const h = norm(cell.text ?? '');
        for (const [field, aliases] of Object.entries(HEADERS) as [keyof ParsedEvalItem, string[]][]) {
          if (cols[field] === undefined && aliases.includes(h)) cols[field] = c;
        }
      });
      if (!cols.question) continue;

      const items: ParsedEvalItem[] = [];
      const warnings: string[] = [];
      for (let i = r + 1; i <= sheet.rowCount; i++) {
        const row = sheet.getRow(i);
        const get = (f: keyof ParsedEvalItem) => (cols[f] ? (row.getCell(cols[f]!).text ?? '').trim() : '');
        const question = get('question');
        if (!question) continue;
        const bt = get('business_type').replace(/\s/g, '');
        const typeRaw = get('expected_type');
        const expectedType = normalizeAnswerType(typeRaw);
        if (typeRaw && !expectedType) warnings.push(`${i}행: 기대 유형 '${typeRaw}'을(를) 알 수 없어 비워 둡니다.`);
        if (bt && !(BUSINESS_TYPES as readonly string[]).includes(bt)) warnings.push(`${i}행: 사업 유형 '${bt}'을(를) 알 수 없어 '모름'으로 둡니다.`);
        items.push({
          question,
          business_type: (BUSINESS_TYPES as readonly string[]).includes(bt) ? bt : '모름',
          expected_qa_ids: get('expected_qa_ids')
            .split(/[,;/\n]+/)
            .map((x) => x.trim())
            .filter(Boolean),
          expected_type: expectedType,
          note: get('note'),
        });
      }
      if (!items.length) throw new Error('평가 질문이 한 건도 없습니다.');
      return { items, warnings };
    }
  }
  throw new Error('‘질문’ 머리글이 있는 시트를 찾지 못했습니다. (머리글: 질문 · 사업 유형 · 기대 통합번호 · 기대 유형 · 비고)');
}

export async function buildEvalTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('평가질문');
  s.columns = [
    { header: '질문', key: 'q', width: 60 },
    { header: '사업 유형', key: 'bt', width: 12 },
    { header: '기대 통합번호', key: 'ids', width: 20 },
    { header: '기대 유형', key: 't', width: 12 },
    { header: '비고', key: 'n', width: 30 },
  ];
  s.addRow({ q: '(예시) 글로컬 사업단장에게 보직수당을 줄 수 있나요?', bt: '글로컬', ids: 'B4-01-a', t: '근거답변', n: '여러 개면 쉼표로 구분' });
  s.addRow({ q: '(예시) 이 장비 구입은 인정되나요?', bt: '순수앵커', ids: '', t: '연결형', n: '개별 인정 판단 → 연결' });
  s.addRow({ q: '(예시) 자체평가 실적으로 인정되나요?', bt: '모름', ids: '', t: '답변범위외', n: '' });
  s.getRow(1).font = { bold: true };
  const guide = wb.addWorksheet('작성 안내');
  [
    '질문: 실제 사용자가 물을 법한 문장 그대로',
    '사업 유형: 순수앵커 / 글로컬 / 의대교육 / 초광역 / 기타 / 모름 (비우면 모름)',
    '기대 통합번호: 이 질문에 인용되어야 하는 표준답안 번호. 여러 개면 쉼표로 구분 (하나라도 인용되면 적중)',
    '기대 유형: 근거답변 / 연결형 / 답변범위외 / 근거없음',
  ].forEach((t) => guide.addRow([t]));
  guide.getColumn(1).width = 100;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

