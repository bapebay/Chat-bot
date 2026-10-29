// 지침·FAQ 원문을 조항 단위로 쪼갠다. 쪽수와 조항 번호를 함께 저장해 근거 카드에 표시한다.

export interface Chunk {
  clause: string;
  page: number | null;
  text: string;
}

const MAX_CHUNK = 1500;

// 조항 머리로 보는 줄
// 조문 머리(제3조, 제2장, 제3조의2)는 본문이 같은 줄에 이어져도 항상 조항 시작으로 본다
const ARTICLE_PATTERN = /^제\s*\d+\s*[장절조](?:의\s*\d+)?(?:\s|\(|$)/;
const HEADING_PATTERNS = [
  /^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.\s]/, // Ⅰ. 개요
  /^\d{1,2}(?:-\d{1,2})*[.)]\s*\S/, // 1. 적용 범위, 3-1) 인건비
  /^[가-하][.)]\s*\S/, // 가. 세부 기준
  /^[□■◇◆○●▶]\s*\S/, // □ 사업비 관리
];
const FAQ_PATTERN = /^(?:[-*·]\s*)?(?:Q\s*\d*\s*[.:)]|질문\s*\d*\s*[.:)]|문\s*\d+\s*[.:)])/i;

function isHeading(line: string): boolean {
  if (FAQ_PATTERN.test(line) || ARTICLE_PATTERN.test(line)) return true;
  if (line.length > 60) return false;
  if (/(?:다|요|함|음)\.?$/.test(line) && line.length > 25) return false; // 문장으로 끝나면 본문
  return HEADING_PATTERNS.some((re) => re.test(line));
}

function label(line: string): string {
  const s = line.replace(/^[-*·]\s*/, '').replace(/\s+/g, ' ').trim();
  // "제1조(목적) 이 지침은 …" → "제1조(목적)"
  const article = s.match(/^제\s*\d+\s*[장절조](?:의\s*\d+)?(?:\s*\([^)]{1,40}\))?/);
  if (article) return article[0];
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/**
 * pages: 쪽별 텍스트 (PDF). 텍스트 파일은 쪽 정보 없이 한 덩어리로 넣는다(pageNumbers=false).
 */
export function chunkDocument(pages: string[], pageNumbers: boolean): Chunk[] {
  const chunks: Chunk[] = [];
  let current: { clause: string; page: number | null; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    if (body) {
      // 너무 긴 조항은 문단 단위로 나눈다
      const parts: string[] = [];
      let buf = '';
      for (const para of body.split(/\n(?=\S)/)) {
        if (buf && buf.length + para.length > MAX_CHUNK) {
          parts.push(buf);
          buf = '';
        }
        buf = buf ? `${buf}\n${para}` : para;
      }
      if (buf) parts.push(buf);
      parts.forEach((p, i) =>
        chunks.push({ clause: i === 0 ? current!.clause : `${current!.clause} (계속)`, page: current!.page, text: p.slice(0, MAX_CHUNK * 2) }),
      );
    }
    current = null;
  };

  pages.forEach((pageText, pi) => {
    const page = pageNumbers ? pi + 1 : null;
    for (const raw of pageText.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^-?\s*\d{1,4}\s*-?$/.test(line)) continue; // 쪽 번호만 있는 줄
      if (isHeading(line)) {
        flush();
        current = { clause: label(line), page, lines: [line] };
      } else {
        if (!current) current = { clause: '머리말', page, lines: [] };
        current.lines.push(line);
      }
    }
  });
  flush();
  return chunks;
}

export async function extractPdfPages(buffer: Buffer): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    return text as string[];
  } catch {
    throw new Error('PDF에서 글자를 읽지 못했습니다. 스캔 이미지 PDF라면 글자가 들어 있는 PDF로 다시 저장해 주세요.');
  }
}

export async function chunkUpload(buffer: Buffer, filename: string): Promise<Chunk[]> {
  if (/\.pdf$/i.test(filename)) {
    const pages = await extractPdfPages(buffer);
    const chunks = chunkDocument(pages, true);
    if (!chunks.length) throw new Error('PDF에서 글자를 찾지 못했습니다. 스캔 이미지 PDF는 지원하지 않습니다.');
    return chunks;
  }
  if (/\.(txt|md)$/i.test(filename)) {
    const chunks = chunkDocument([buffer.toString('utf8')], false);
    if (!chunks.length) throw new Error('파일이 비어 있습니다.');
    return chunks;
  }
  throw new Error('PDF, TXT, MD 파일만 올릴 수 있습니다. 한글(HWP) 파일은 PDF로 저장해 올려 주세요.');
}
