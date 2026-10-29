import { Megaphone, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, formatTime } from '../api';
import { Markdown, Notice } from '../components/ui';

const errorText = (err: unknown, fb: string) => (err instanceof ApiError ? err.message : fb);
const won = (n: number) => `${Math.round(n).toLocaleString()}원`;

// ================= 사용량·비용 =================

interface Stats {
  days: number;
  prices: { input_per_mtok: number; output_per_mtok: number; usd_krw: number };
  totals: { questions: number; llm_calls: number; input_tokens: number; output_tokens: number; cost_krw: number; avg_latency_ms: number | null };
  daily: { date: string; questions: number; input_tokens: number; output_tokens: number; llm_calls: number; cost_krw: number }[];
  by_org: { org_type: string; org_name: string; region: string; questions: number; users: number }[];
  answer_types: Record<string, number>;
  feedback: { good: number; bad: number; bad_reasons: Record<string, number> };
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-800 dark:text-slate-100">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{sub}</div>}
    </div>
  );
}

/** 일별 질문 수 막대 (한 계열이라 범례 없이 제목으로 이름을 붙인다) */
function DailyBars({ daily, days }: { daily: Stats['daily']; days: number }) {
  // 질문이 없는 날도 0으로 채워 날짜 간격을 일정하게
  const map = new Map(daily.map((d) => [d.date, d]));
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() + 9 * 3600_000 - i * 86400_000);
    dates.push(d.toISOString().slice(0, 10));
  }
  const max = Math.max(1, ...daily.map((d) => d.questions));
  const [hover, setHover] = useState<string | null>(null);
  const h = hover ? map.get(hover) : null;
  return (
    <div className="card p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100">일별 질문 수</h4>
        <span className="h-4 text-xs text-slate-500 dark:text-slate-400">
          {hover && `${hover} · 질문 ${h?.questions ?? 0}건 · AI 호출 ${h?.llm_calls ?? 0}회 · ${won(h?.cost_krw ?? 0)}`}
        </span>
      </div>
      <div className="relative mt-2 flex h-40 items-end gap-[2px] border-b border-slate-300 dark:border-slate-600" onMouseLeave={() => setHover(null)}>
        <span className="absolute -top-1 left-0 text-[10px] text-slate-400">{max}</span>
        {dates.map((d) => {
          const v = map.get(d)?.questions ?? 0;
          return (
            <div key={d} className="flex h-full flex-1 cursor-default items-end" onMouseEnter={() => setHover(d)} title={`${d}: ${v}건`}>
              <div
                className={`w-full rounded-t ${hover === d ? 'bg-indigo-700 dark:bg-indigo-300' : 'bg-indigo-500 dark:bg-indigo-400'}`}
                style={{ height: `${(v / max) * 100}%`, minHeight: v ? 2 : 0 }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{dates[0]}</span>
        <span>{dates[dates.length - 1]}</span>
      </div>
    </div>
  );
}

const TYPE_ORDER = ['근거답변', '연결형', '답변범위외', '근거없음'];
const TYPE_LABEL: Record<string, string> = { 근거답변: '근거 답변', 연결형: '확인 필요(연결)', 답변범위외: '범위 아님', 근거없음: '근거 없음' };

function RatioBars({ title, rows }: { title: string; rows: { label: string; n: number }[] }) {
  const total = rows.reduce((s, r) => s + r.n, 0);
  return (
    <div className="card p-4">
      <h4 className="mb-3 text-sm font-bold text-slate-800 dark:text-slate-100">{title}</h4>
      {total === 0 && <p className="text-xs text-slate-400">자료 없음</p>}
      <div className="space-y-2">
        {total > 0 &&
          rows.map((r) => (
            <div key={r.label} className="text-xs" title={`${r.label}: ${r.n}건`}>
              <div className="mb-0.5 flex justify-between text-slate-600 dark:text-slate-300">
                <span>{r.label}</span>
                <span>
                  {r.n}건 · {Math.round((r.n / total) * 100)}%
                </span>
              </div>
              <div className="h-2 rounded bg-slate-100 dark:bg-slate-700">
                <div className="h-2 rounded bg-indigo-500 dark:bg-indigo-400" style={{ width: `${(r.n / total) * 100}%` }} />
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

export function StatsTab() {
  const [days, setDays] = useState(30);
  const [s, setS] = useState<Stats | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => setS(await api<Stats>(`/api/admin/stats?days=${days}`)), [days]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    Promise.all(['price_input_per_mtok', 'price_output_per_mtok', 'usd_krw'].map((k) => api<{ value: string }>(`/api/admin/settings/${k}`).then((r) => [k, r.value] as const))).then(
      (p) => setPrices(Object.fromEntries(p)),
    );
  }, []);

  async function savePrices() {
    setMsg(null);
    try {
      for (const [k, v] of Object.entries(prices)) await api(`/api/admin/settings/${k}`, { method: 'PUT', body: { value: v } });
      setMsg({ kind: 'success', text: '단가를 저장했습니다. 추정 비용을 다시 계산합니다.' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: errorText(err, '저장하지 못했습니다.') });
    }
  }

  if (!s) return null;
  const answered = TYPE_ORDER.map((t) => ({ label: TYPE_LABEL[t], n: s.answer_types[t] ?? 0 }));
  const fbTotal = s.feedback.good + s.feedback.bad;
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">사용량·비용</h3>
        <div className="flex gap-1 rounded-lg bg-slate-200 p-1 text-sm dark:bg-slate-800">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-md px-3 py-1 font-medium ${days === d ? 'bg-white text-indigo-700 shadow dark:bg-slate-700 dark:text-white' : 'text-slate-600 dark:text-slate-300'}`}
            >
              최근 {d}일
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="질문 수" value={s.totals.questions.toLocaleString()} sub={`AI 호출 ${s.totals.llm_calls.toLocaleString()}회 (나머지는 근거 없음·범위 외로 호출 안 함)`} />
        <Tile label="추정 비용" value={won(s.totals.cost_krw)} sub={`질문당 ${s.totals.questions ? won(s.totals.cost_krw / s.totals.questions) : '-'}`} />
        <Tile
          label="토큰"
          value={`${((s.totals.input_tokens + s.totals.output_tokens) / 1000).toFixed(1)}K`}
          sub={`입력 ${(s.totals.input_tokens / 1000).toFixed(1)}K · 출력 ${(s.totals.output_tokens / 1000).toFixed(1)}K`}
        />
        <Tile
          label="평가 (Good / Bad)"
          value={fbTotal ? `${Math.round((s.feedback.good / fbTotal) * 100)}% 긍정` : '-'}
          sub={`Good ${s.feedback.good} · Bad ${s.feedback.bad} · 평균 응답 ${s.totals.avg_latency_ms != null ? `${(s.totals.avg_latency_ms / 1000).toFixed(1)}초` : '-'}`}
        />
      </div>
      <DailyBars daily={s.daily} days={days} />
      <div className="grid gap-3 md:grid-cols-2">
        <RatioBars title="답변 유형 비율" rows={answered} />
        <RatioBars title="Bad 평가 사유" rows={Object.entries(s.feedback.bad_reasons).map(([label, n]) => ({ label, n }))} />
      </div>
      <div className="card overflow-x-auto">
        <h4 className="border-b border-slate-200 p-3 text-sm font-bold text-slate-800 dark:border-slate-700 dark:text-slate-100">기관별 사용량</h4>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2">기관</th>
              <th className="px-3 py-2">구분</th>
              <th className="px-3 py-2">지역</th>
              <th className="px-3 py-2 text-right">사용자</th>
              <th className="px-3 py-2 text-right">질문</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700 dark:divide-slate-700 dark:text-slate-200">
            {s.by_org.map((o) => (
              <tr key={`${o.org_name}-${o.region}`}>
                <td className="px-3 py-1.5">{o.org_name}</td>
                <td className="px-3 py-1.5">{o.org_type}</td>
                <td className="px-3 py-1.5">{o.region}</td>
                <td className="px-3 py-1.5 text-right">{o.users}</td>
                <td className="px-3 py-1.5 text-right font-semibold">{o.questions}</td>
              </tr>
            ))}
            {s.by_org.length === 0 && (
              <tr>
                <td colSpan={5} className="p-3 text-center text-xs text-slate-400">
                  자료 없음
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <section className="card space-y-2 p-4 text-sm">
        <h4 className="font-bold text-slate-800 dark:text-slate-100">비용 계산 단가</h4>
        <p className="text-xs text-slate-500 dark:text-slate-400">쓰고 있는 AI 모델의 공시 단가(USD, 100만 토큰당)를 넣으세요. 모델을 바꾸면 여기도 바꿔야 비용이 맞게 나옵니다.</p>
        <div className="flex flex-wrap items-end gap-3">
          {(
            [
              ['price_input_per_mtok', '입력 단가 ($/100만)'],
              ['price_output_per_mtok', '출력 단가 ($/100만)'],
              ['usd_krw', '환율 (원/$)'],
            ] as const
          ).map(([k, label]) => (
            <div key={k}>
              <label className="label">{label}</label>
              <input className="input w-32" value={prices[k] ?? ''} onChange={(e) => setPrices((p) => ({ ...p, [k]: e.target.value }))} />
            </div>
          ))}
          <button type="button" className="btn-secondary" onClick={savePrices}>
            저장
          </button>
        </div>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      </section>
    </div>
  );
}

// ================= 답변 모아보기 =================

export function AnswersBrowser() {
  const [filter, setFilter] = useState('bad');
  const [rows, setRows] = useState<
    { id: number; answer_type: string; content: string; created_at: string; username: string; org_name: string; question: string | null; bad_reason: string | null }[]
  >([]);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    api<typeof rows>(`/api/admin/answers?filter=${filter}`).then(setRows);
  }, [filter]);
  const filters = [
    ['bad', 'Bad 평가'],
    ['referral', '연결형'],
    ['no_evidence', '근거 없음'],
    ['out_of_scope', '범위 외'],
    ['all', '전체'],
  ];
  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold text-slate-800 dark:text-slate-100">답변 모아보기 (최근 200건)</h3>
        <div className="flex gap-1 rounded-lg bg-slate-200 p-1 text-xs dark:bg-slate-800">
          {filters.map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={`rounded-md px-3 py-1 font-medium ${filter === k ? 'bg-white text-indigo-700 shadow dark:bg-slate-700 dark:text-white' : 'text-slate-600 dark:text-slate-300'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="card divide-y divide-slate-100 dark:divide-slate-700">
        {rows.length === 0 && <p className="p-4 text-center text-sm text-slate-400">해당 답변이 없습니다.</p>}
        {rows.map((r) => (
          <div key={r.id} className="p-3 text-sm">
            <button type="button" className="w-full text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <div className="text-slate-800 dark:text-slate-100">Q. {r.question}</div>
              <div className="text-xs text-slate-500">
                {r.answer_type} · {r.username} ({r.org_name}) · {formatTime(r.created_at)} {r.bad_reason && <span className="text-red-600">· Bad: {r.bad_reason}</span>}
              </div>
            </button>
            {open === r.id && (
              <div className="mt-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
                <Markdown text={r.content} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ================= 공지 =================

export function NoticeTab() {
  const [rows, setRows] = useState<{ id: number; title: string; body: string; active: number; created_at: string }[]>([]);
  const [f, setF] = useState({ title: '', body: '', recheck_qa_ids: '', recheck_category: '' });
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const load = useCallback(async () => setRows(await api('/api/admin/notices')), []);
  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setMsg(null);
    try {
      const r = await api<{ marked: number }>('/api/admin/notices', { body: f });
      setMsg({ kind: 'success', text: `공지를 게시했습니다.${r.marked ? ` 관련 표준답안 ${r.marked}건을 ‘재검수 필요’로 표시했습니다 (검수 → 표준답안 관리에서 확인).` : ''}` });
      setF({ title: '', body: '', recheck_qa_ids: '', recheck_category: '' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: errorText(err, '게시하지 못했습니다.') });
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <section className="card space-y-3 p-4">
        <h3 className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-100">
          <Megaphone className="h-4 w-4" /> 지침 개정 공지
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">게시한 공지는 챗봇 첫 화면 위쪽 배너로 보입니다 (최근 3건, 사용자가 닫을 수 있음).</p>
        <input className="input" placeholder="제목 (예: 사업비 지침 2차 개정 안내)" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <textarea className="input h-24 resize-y" placeholder="변경 조항 요약" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="mb-2 text-xs font-bold text-slate-600 dark:text-slate-300">개정으로 영향을 받는 표준답안을 ‘재검수 필요’로 표시 (선택)</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="input" placeholder="통합번호 (쉼표로 구분, 예: B4-01-a, C2-03-a)" value={f.recheck_qa_ids} onChange={(e) => setF({ ...f, recheck_qa_ids: e.target.value })} />
            <input className="input" placeholder="또는 중분류 전체 (예: 수당)" value={f.recheck_category} onChange={(e) => setF({ ...f, recheck_category: e.target.value })} />
          </div>
          <p className="mt-1 text-[11px] text-slate-500">표시만 할 뿐 챗봇 검색에서 빠지지는 않습니다. 검수자가 편집기에서 확인·저장하면 표시가 사라집니다.</p>
        </div>
        <button type="button" className="btn-primary" disabled={!f.title.trim()} onClick={create}>
          게시
        </button>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      </section>
      <section className="card divide-y divide-slate-100 dark:divide-slate-700">
        {rows.length === 0 && <p className="p-4 text-center text-sm text-slate-400">공지가 없습니다.</p>}
        {rows.map((n) => (
          <div key={n.id} className="flex flex-wrap items-start justify-between gap-2 p-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className={`font-semibold ${n.active ? 'text-slate-800 dark:text-slate-100' : 'text-slate-400 line-through'}`}>{n.title}</div>
              {n.body && <div className="whitespace-pre-wrap text-xs text-slate-500">{n.body}</div>}
              <div className="text-[11px] text-slate-400">{formatTime(n.created_at)}</div>
            </div>
            <div className="flex gap-1">
              <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => api(`/api/admin/notices/${n.id}`, { method: 'PATCH', body: { active: !n.active } }).then(load)}>
                {n.active ? '내리기' : '다시 게시'}
              </button>
              <button
                type="button"
                className="btn-secondary px-2 py-1 text-xs text-red-600"
                onClick={() => confirm('공지를 삭제할까요?') && api(`/api/admin/notices/${n.id}`, { method: 'DELETE' }).then(load)}
                title="삭제"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

// ================= 감사 로그 =================

export function AuditTab() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<{ id: number; username: string | null; action: string; target: string; detail: string; created_at: string }[]>([]);
  useEffect(() => {
    const t = setTimeout(() => api<typeof rows>(`/api/admin/audit?q=${encodeURIComponent(q)}`).then(setRows), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold text-slate-800 dark:text-slate-100">감사 로그 (최근 300건)</h3>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input className="input w-64 pl-8" placeholder="작업·대상·사용자 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">권한 변경, 계정 처리, 데이터 교체, 프롬프트·설정 수정, 표준답안 편집, 공지 등 관리 작업이 기록됩니다.</p>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2">일시</th>
              <th className="px-3 py-2">사용자</th>
              <th className="px-3 py-2">작업</th>
              <th className="px-3 py-2">대상</th>
              <th className="px-3 py-2">내용</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700 dark:divide-slate-700 dark:text-slate-200">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-3 py-1.5 text-xs text-slate-500">{formatTime(r.created_at)}</td>
                <td className="px-3 py-1.5">{r.username ?? '-'}</td>
                <td className="px-3 py-1.5 font-medium">{r.action}</td>
                <td className="px-3 py-1.5">{r.target}</td>
                <td className="max-w-md truncate px-3 py-1.5 text-xs text-slate-500" title={r.detail}>
                  {r.detail}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-xs text-slate-400">
                  기록이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
