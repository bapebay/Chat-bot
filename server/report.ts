import ExcelJS from 'exceljs';
import type { DB } from './db.js';
import { getNumberSetting } from './settings.js';

/** 'YYYY-MM' 한 달을 한국 시간 기준 DB 시각(UTC) 범위로 */
export function monthRangeUtc(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const utc = (yy: number, mm: number) => new Date(Date.UTC(yy, mm - 1, 1) - 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  return { from: utc(y, mo), to: mo === 12 ? utc(y + 1, 1) : utc(y, mo + 1) };
}

const KST = (col: string) => `datetime(${col}, '+9 hours')`;

/**
 * 월간 운영 보고서 (엑셀). 내부 보고용으로 한 달의 이용 현황을 시트별로 정리한다.
 * 요약 · 일별 · 지역·소속별 · 많이 묻는 주제 · 근거 없음 질문 · 1대1 문의 (시트 이름에는 ':'를 쓸 수 없다)
 */
export async function buildMonthlyReport(db: DB, month: string): Promise<Buffer> {
  const range = monthRangeUtc(month);
  if (!range) throw new Error('월을 YYYY-MM 형식으로 지정해 주세요.');
  const { from, to } = range;
  const inMonth = (col: string) => `${col} >= @from AND ${col} < @to`;
  const p = { from, to };
  const one = <T>(sql: string) => db.prepare(sql).get(p) as T;
  const all = <T>(sql: string) => db.prepare(sql).all(p) as T[];

  const priceIn = getNumberSetting(db, 'price_input_per_mtok');
  const priceOut = getNumberSetting(db, 'price_output_per_mtok');
  const krw = getNumberSetting(db, 'usd_krw');

  const q = one<{ n: number; users: number }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT c.user_id) AS users FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.role = 'user' AND ${inMonth('m.created_at')}`,
  );
  const tokens = one<{ inp: number; out: number; calls: number }>(
    `SELECT COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(output_tokens), 0) AS out, SUM(provider IS NOT NULL) AS calls
     FROM messages m WHERE role = 'assistant' AND ${inMonth('m.created_at')}`,
  );
  const types = all<{ type: string; n: number }>(
    `SELECT answer_type AS type, COUNT(*) AS n FROM messages m WHERE role = 'assistant' AND answer_type IS NOT NULL AND ${inMonth('m.created_at')} GROUP BY 1`,
  );
  const typeN = (t: string) => types.find((x) => x.type === t)?.n ?? 0;
  const answers = types.reduce((s, x) => s + x.n, 0);
  const fb = all<{ rating: string; n: number }>(
    `SELECT f.rating, COUNT(*) AS n FROM feedback f JOIN messages m ON m.id = f.message_id WHERE ${inMonth('m.created_at')} GROUP BY 1`,
  );
  const security = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM review_queue rq JOIN messages m ON m.id = rq.message_id WHERE rq.source = 'security' AND ${inMonth('m.created_at')}`,
  ).n;
  const inq = one<{ n: number; answered: number; hours: number | null }>(
    `SELECT COUNT(*) AS n, SUM(status = 'answered') AS answered,
       AVG(CASE WHEN answered_at IS NOT NULL THEN (julianday(answered_at) - julianday(created_at)) * 24 END) AS hours
     FROM inquiries i WHERE ${inMonth('i.created_at')}`,
  );
  const newUsers = one<{ n: number }>(`SELECT COUNT(*) AS n FROM users u WHERE ${inMonth('u.created_at')}`).n;
  const pct = (n: number) => (answers ? `${Math.round((n / answers) * 1000) / 10}%` : '-');

  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, cols: [string, number][]) => {
    const s = wb.addWorksheet(name);
    s.columns = cols.map(([header, width]) => ({ header, width }));
    s.getRow(1).font = { bold: true };
    return s;
  };

  const sum = sheet('요약', [['항목', 34], ['값', 24], ['비고', 50]]);
  [
    ['기간', `${month} (한국 시간)`, ''],
    ['질문 수', q.n, ''],
    ['질문한 사용자 수', q.users, ''],
    ['새 계정', newUsers, '가입 신청·직접 생성 포함'],
    ['근거 답변', typeN('근거답변'), pct(typeN('근거답변'))],
    ['확인 필요(연결형)', typeN('연결형'), pct(typeN('연결형'))],
    ['답변 범위 아님', typeN('답변범위외'), pct(typeN('답변범위외'))],
    ['근거 없음', typeN('근거없음'), `${pct(typeN('근거없음'))} · 표준답안 보완 후보`],
    ['👍 Good', fb.find((f) => f.rating === 'good')?.n ?? 0, ''],
    ['👎 Bad', fb.find((f) => f.rating === 'bad')?.n ?? 0, ''],
    ['1:1 문의 접수', inq.n, ''],
    ['1:1 문의 답변 완료', inq.answered ?? 0, inq.hours != null ? `평균 ${Math.round(inq.hours * 10) / 10}시간 만에 답변` : ''],
    ['보안 의심 질문 차단', security, '검토 대기함 ‘보안 의심’'],
    ['AI 호출 수', tokens.calls ?? 0, ''],
    ['추정 AI 비용(원)', Math.round(((tokens.inp * priceIn + tokens.out * priceOut) / 1_000_000) * krw), '관리 → 사용량·비용의 단가 기준'],
  ].forEach((r) => sum.addRow(r));

  const daily = sheet('일별', [['날짜', 14], ['질문 수', 10], ['근거 없음', 10], ['AI 호출', 10]]);
  all<{ d: string; q: number; none: number; calls: number }>(
    `SELECT date(${KST('m.created_at')}) AS d, SUM(m.role = 'user') AS q, SUM(m.answer_type = '근거없음') AS none,
       SUM(m.role = 'assistant' AND m.provider IS NOT NULL) AS calls
     FROM messages m WHERE ${inMonth('m.created_at')} GROUP BY 1 ORDER BY 1`,
  ).forEach((r) => daily.addRow([r.d, r.q, r.none, r.calls]));

  const org = sheet('지역·소속별', [['지역', 10], ['소속 구분', 14], ['기관 수', 10], ['사용자 수', 10], ['질문 수', 10]]);
  all<{ region: string; org_type: string; orgs: number; users: number; q: number }>(
    `SELECT u.region, u.org_type, COUNT(DISTINCT u.org_name) AS orgs, COUNT(DISTINCT u.id) AS users, COUNT(*) AS q
     FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN users u ON u.id = c.user_id
     WHERE m.role = 'user' AND ${inMonth('m.created_at')} GROUP BY 1, 2 ORDER BY q DESC`,
  ).forEach((r) => org.addRow([r.region, r.org_type, r.orgs, r.users, r.q]));

  // 많이 묻는 주제: 답변이 인용한 표준답안의 중분류
  const topics = new Map<string, { n: number; ids: Map<string, number> }>();
  for (const r of all<{ citations: string }>(
    `SELECT citations FROM messages m WHERE role = 'assistant' AND citations IS NOT NULL AND ${inMonth('m.created_at')}`,
  )) {
    let qa: { qa_id: string; category1: string; category2: string }[] = [];
    try {
      qa = (JSON.parse(r.citations) as { qa?: typeof qa }).qa ?? [];
    } catch {
      continue;
    }
    for (const c of qa) {
      const key = [c.category1, c.category2].filter(Boolean).join(' · ') || '(분류 없음)';
      const t = topics.get(key) ?? { n: 0, ids: new Map() };
      t.n++;
      t.ids.set(c.qa_id, (t.ids.get(c.qa_id) ?? 0) + 1);
      topics.set(key, t);
    }
  }
  const topic = sheet('많이 묻는 주제', [['주제(대분류 · 중분류)', 40], ['인용 횟수', 10], ['많이 인용된 표준답안', 40]]);
  [...topics.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 50)
    .forEach(([k, t]) => topic.addRow([k, t.n, [...t.ids.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => `${id}(${n})`).join(', ')]));

  const none = sheet('근거 없음 질문', [['일시', 18], ['지역', 8], ['기관', 26], ['질문', 80]]);
  all<{ at: string; region: string; org_name: string; question: string }>(
    `SELECT ${KST('a.created_at')} AS at, u.region, u.org_name,
       (SELECT q.content FROM messages q WHERE q.conversation_id = a.conversation_id AND q.role = 'user' AND q.id < a.id ORDER BY q.id DESC LIMIT 1) AS question
     FROM messages a JOIN conversations c ON c.id = a.conversation_id JOIN users u ON u.id = c.user_id
     WHERE a.role = 'assistant' AND a.answer_type = '근거없음' AND ${inMonth('a.created_at')} ORDER BY a.id LIMIT 1000`,
  ).forEach((r) => none.addRow([r.at, r.region, r.org_name, r.question]));

  const inqs = sheet('1대1 문의', [['접수', 18], ['지역', 8], ['기관', 26], ['문의 내용', 70], ['상태', 10], ['답변', 18]]);
  all<{ at: string; region: string; org_name: string; content: string; status: string; answered: string | null }>(
    `SELECT ${KST('i.created_at')} AS at, u.region, u.org_name, i.content, i.status,
       CASE WHEN i.answered_at IS NULL THEN NULL ELSE ${KST('i.answered_at')} END AS answered
     FROM inquiries i JOIN users u ON u.id = i.user_id WHERE ${inMonth('i.created_at')} ORDER BY i.id`,
  ).forEach((r) => inqs.addRow([r.at, r.region, r.org_name, r.content.slice(0, 300), r.status === 'answered' ? '답변 완료' : '대기', r.answered ?? '']));

  for (const s of wb.worksheets) s.eachRow((row) => (row.alignment = { vertical: 'top', wrapText: true }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
