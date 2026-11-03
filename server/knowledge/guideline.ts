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

// ----- 마크다운(MD) -----
// '# 제목'은 조항 머리로, 표·굵은 글씨·링크 같은 꾸밈 기호는 걷어 내고 글자만 남긴다.
// PDF·한글 문서를 MD로 바꾼 파일에 흔한 쪽 표시(<!-- page 3 -->, <!-- 3쪽 -->)가 있으면 쪽수로 쓴다.

/** 줄 안의 마크다운 꾸밈을 걷어 낸다 */
export function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 그림
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 링크 → 글자만
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '') // HTML 태그
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])[*_](?=\S)([^*_]*?\S)[*_](?=[\s).,]|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\\([\\`*_{}\[\]()#+\-.!|~<>])/g, '$1')
    .replace(/&(#\d{1,6}|#x[0-9a-f]{1,6}|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (e[0] !== '#') return named[e.toLowerCase()];
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/[ \t]+/g, ' ')
    .trim();
}

interface MdLine {
  text: string;
  /** '#' 제목 줄 */
  heading: boolean;
  /** 표의 한 행 (조항 머리로 보지 않는다) */
  table: boolean;
}

/** 마크다운을 쪽별 줄 목록으로 바꾼다. 쪽 표시가 없으면 쪽은 하나(null) */
function parseMarkdown(md: string): { pages: { page: number | null; lines: MdLine[] }[] } {
  let text = md.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  text = text.replace(/^---\n[\s\S]*?\n---\n/, ''); // 머리 정보(front matter)
  const pages: { page: number | null; lines: MdLine[] }[] = [{ page: null, lines: [] }];
  let fence = false;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    // 쪽 표시: <!-- page 3 -->, <!-- 3쪽 -->, <!-- p.3 -->
    const pageMark = !fence && line.match(/^<!--\s*(?:page|p\.?|쪽)?\s*(\d{1,4})\s*(?:쪽|page)?\s*-->$/i);
    if (pageMark) {
      const n = Number(pageMark[1]);
      if (pages.at(-1)!.lines.length || pages.at(-1)!.page !== null) pages.push({ page: n, lines: [] });
      else pages.at(-1)!.page = n;
      continue;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!line) continue;
    if (fence) {
      pages.at(-1)!.lines.push({ text: line, heading: false, table: false });
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(line)) continue; // 가로줄
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) continue; // 표 구분선
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*$/);
    if (h) {
      const t = stripInlineMarkdown(h[1]);
      if (t) pages.at(-1)!.lines.push({ text: t, heading: true, table: false });
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split(/(?<!\\)\|/).map((c) => stripInlineMarkdown(c)).filter(Boolean);
      if (cells.length) pages.at(-1)!.lines.push({ text: cells.join(' · '), heading: false, table: true });
      continue;
    }
    line = line.replace(/^(>\s*)+/, ''); // 인용
    line = line.replace(/^[-*+]\s+\[[ xX]\]\s+/, '- ').replace(/^[*+]\s+/, '- '); // 목록 기호는 '-'로
    const t = stripInlineMarkdown(line);
    if (t) pages.at(-1)!.lines.push({ text: t, heading: false, table: false });
  }
  return { pages: pages.filter((p) => p.lines.length) };
}

/**
 * 마크다운 문서를 조항 단위로 나눈다.
 * '#' 제목이 있으면 제목과 조문 머리(제N조)·FAQ 문항(Q1.)만 조항 시작으로 보고,
 * 본문 속 번호 목록(1. 2. 가. 나.)은 그 조항의 본문으로 둔다. 제목이 하나도 없으면 일반 글처럼 나눈다.
 */
export function chunkMarkdown(md: string): Chunk[] {
  const { pages } = parseMarkdown(md);
  const hasHeadings = pages.some((p) => p.lines.some((l) => l.heading));
  return chunkLines(
    pages.map((p) => ({
      page: p.page,
      lines: p.lines.map((l) => ({
        text: l.text,
        heading: l.table ? false : l.heading || (hasHeadings ? FAQ_PATTERN.test(l.text) || ARTICLE_PATTERN.test(l.text) : isHeading(l.text)),
      })),
    })),
  );
}

/** TXT·MD 파일 글자 읽기: UTF-8이 아니면 한글 윈도 기본(CP949)으로 읽는다 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}

/** TXT·MD 파일을 조항으로 나눈다 (서버와 데모 페이지가 함께 쓴다) */
export function chunkTextFile(bytes: Uint8Array, filename: string): Chunk[] {
  const text = decodeText(bytes);
  return /\.(md|markdown)$/i.test(filename) ? chunkMarkdown(text) : chunkDocument([text], false);
}

/**
 * pages: 쪽별 텍스트 (PDF). 텍스트 파일은 쪽 정보 없이 한 덩어리로 넣는다(pageNumbers=false).
 */
export function chunkDocument(pages: string[], pageNumbers: boolean): Chunk[] {
  return chunkLines(
    pages.map((pageText, pi) => ({
      page: pageNumbers ? pi + 1 : null,
      lines: pageText
        .split(/\r?\n/)
        .map((raw) => raw.trim())
        .filter((line) => line && !/^-?\s*\d{1,4}\s*-?$/.test(line)) // 쪽 번호만 있는 줄
        .map((line) => ({ text: line, heading: isHeading(line) })),
    })),
  );
}

function chunkLines(pages: { page: number | null; lines: { text: string; heading: boolean }[] }[]): Chunk[] {
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

  pages.forEach(({ page, lines }) => {
    for (const { text: line, heading } of lines) {
      if (heading) {
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
  if (/\.(txt|md|markdown)$/i.test(filename)) {
    const chunks = chunkTextFile(new Uint8Array(buffer), filename);
    if (!chunks.length) throw new Error('파일이 비어 있습니다.');
    return chunks;
  }
  throw new Error('PDF, TXT, MD 파일만 올릴 수 있습니다. 한글(HWP) 파일은 PDF로 저장해 올려 주세요.');
}
