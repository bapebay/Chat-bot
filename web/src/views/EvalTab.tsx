import { CheckCircle2, ChevronDown, Download, GitCompare, Play, Square, Trash2, Upload, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, formatTime } from '../api';
import { Markdown, Notice } from '../components/ui';

interface EvalSet {
  id: number;
  name: string;
  filename: string;
  item_count: number;
  run_count: number;
  created_at: string;
}

interface Summary {
  total: number;
  errors: number;
  cite_hit_rate: number | null;
  cite_hit: number;
  cite_total: number;
  retrieve_hit_rate: number | null;
  type_accuracy: number | null;
  type_match: number;
  type_total: number;
  referral_accuracy: number | null;
  wrong: number;
  unreviewed: number;
  input_tokens: number;
  output_tokens: number;
  avg_latency_ms: number | null;
  pass_hit_rate: number;
  awaiting_review: boolean;
  passed: boolean;
}

interface Run {
  id: number;
  set_id: number;
  label: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  total: number;
  done: number;
  config: {
    provider: string;
    model: string;
    qa_version: string;
    prompt: string;
    prompt_hash: string;
    include_unreviewed: boolean;
    threshold_keyword: number;
    threshold_semantic: number;
    search_mode: string;
  };
  summary: Summary | null;
  error: string | null;
  started_by_name: string | null;
  started_at: string;
  finished_at: string | null;
}

interface Result {
  id: number;
  item_id: number;
  seq: number;
  question: string;
  business_type: string;
  expected_qa_ids: string[];
  expected_type: string | null;
  note: string;
  answer_type: string | null;
  answer: string;
  cited_qa_ids: string[];
  retrieved_qa_ids: string[];
  cite_hit: number | null;
  retrieve_hit: number | null;
  type_match: number | null;
  latency_ms: number | null;
  error: string | null;
  verdict: 'ok' | 'wrong' | null;
  verdict_note: string;
}

const STATUS_LABEL: Record<Run['status'], string> = { running: '실행 중', done: '완료', failed: '실패', cancelled: '취소됨' };
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${Math.round(v * 1000) / 10}%`);
const errorText = (err: unknown, fb: string) => (err instanceof ApiError ? err.message : fb);

export function EvalTab() {
  const [sets, setSets] = useState<EvalSet[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [message, setMessage] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [compare, setCompare] = useState<number[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([api<EvalSet[]>('/api/admin/eval/sets'), api<Run[]>('/api/admin/eval/runs')]);
    setSets(s);
    setRuns(r);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 실행 중인 평가가 있으면 2초마다 진행 상황을 다시 읽는다
  const running = runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [running, load]);

  async function upload(f: File) {
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    form.append('name', name || f.name.replace(/\.[^.]+$/, ''));
    form.append('file', f);
    try {
      const r = await api<{ count: number; warnings: string[] }>('/api/admin/eval/sets', { body: form });
      setMessage({
        kind: r.warnings.length ? 'info' : 'success',
        text: `평가 질문 ${r.count}건을 등록했습니다.${r.warnings.length ? ` (확인 필요: ${r.warnings.join(' / ')})` : ''}`,
      });
      setName('');
      await load();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '등록에 실패했습니다.') });
    } finally {
      setBusy(false);
    }
  }

  async function startRun(s: EvalSet) {
    const label = prompt(
      `‘${s.name}’ ${s.item_count}건을 실행합니다.\n근거가 있는 질문마다 AI를 1번씩 부르므로 최대 ${s.item_count}회 호출(비용 발생)됩니다.\n\n이번 실행을 알아볼 이름을 적어 주세요 (예: 프롬프트 수정 전).`,
      '',
    );
    if (label === null) return;
    try {
      await api(`/api/admin/eval/sets/${s.id}/runs`, { body: { label } });
      await load();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '실행하지 못했습니다.') });
    }
  }

  async function removeSet(s: EvalSet) {
    if (!confirm(`‘${s.name}’ 질문집과 실행 결과를 모두 삭제할까요?`)) return;
    try {
      await api(`/api/admin/eval/sets/${s.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '삭제하지 못했습니다.') });
    }
  }

  async function removeRun(r: Run) {
    if (!confirm(`#${r.id} 실행 결과를 삭제할까요?`)) return;
    try {
      await api(`/api/admin/eval/runs/${r.id}`, { method: 'DELETE' });
      if (openRun === r.id) setOpenRun(null);
      setCompare((c) => c.filter((x) => x !== r.id));
      await load();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '삭제하지 못했습니다.') });
    }
  }

  const setName_ = (id: number) => sets.find((s) => s.id === id)?.name ?? `#${id}`;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <PassCriteria onChanged={load} />

      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold text-slate-800 dark:text-slate-100">평가 질문집</h3>
          <div className="flex flex-wrap gap-2">
            <input className="input w-56" placeholder="질문집 이름 (선택)" value={name} onChange={(e) => setName(e.target.value)} />
            <a className="btn-secondary" href="/api/admin/eval/template">
              <Download className="h-4 w-4" /> 양식 받기
            </a>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) upload(f);
              }}
            />
            <button type="button" className="btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4" /> {busy ? '등록 중…' : '엑셀 올리기'}
            </button>
          </div>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          머리글: 질문 · 사업 유형 · 기대 통합번호(여러 개면 쉼표) · 기대 유형(근거답변/연결형/답변범위외/근거없음) · 비고. 질문집을 실행하면 지금의 프롬프트·표준답안·기준값으로 모든 질문에 답해 보고 점수를 냅니다. 대화 기록과 하루 질문 수에는 포함되지 않습니다.
        </p>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {sets.length === 0 && <p className="p-4 text-center text-sm text-slate-400">등록된 평가 질문집이 없습니다.</p>}
          {sets.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
              <div className="text-slate-700 dark:text-slate-200">
                <b>{s.name}</b>
                <span className="ml-2 text-xs text-slate-500">
                  질문 {s.item_count}건 · 실행 {s.run_count}회 · {formatTime(s.created_at)}
                </span>
              </div>
              <div className="flex gap-1.5">
                <button type="button" className="btn-primary px-2.5 py-1 text-xs" disabled={running} onClick={() => startRun(s)}>
                  <Play className="h-3.5 w-3.5" /> 실행
                </button>
                <button type="button" className="btn-secondary px-2 py-1 text-xs text-red-600" onClick={() => removeSet(s)} title="삭제">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4 dark:border-slate-700">
          <h3 className="font-bold text-slate-800 dark:text-slate-100">실행 결과</h3>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            <GitCompare className="mr-1 inline h-3.5 w-3.5" />
            비교할 실행 2개를 체크하세요 {compare.length > 0 && `(${compare.length}/2)`}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2">실행</th>
                <th className="px-3 py-2">조건</th>
                <th className="px-3 py-2 text-right">인용 적중</th>
                <th className="px-3 py-2 text-right">검색 적중</th>
                <th className="px-3 py-2 text-right">유형 정확</th>
                <th className="px-3 py-2 text-right">연결 정확</th>
                <th className="px-3 py-2 text-right">잘못된 결론</th>
                <th className="px-3 py-2">판정</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {runs.length === 0 && (
                <tr>
                  <td colSpan={10} className="p-4 text-center text-sm text-slate-400">
                    아직 실행한 평가가 없습니다.
                  </td>
                </tr>
              )}
              {runs.map((r) => (
                <tr key={r.id} className={`align-top text-slate-700 dark:text-slate-200 ${openRun === r.id ? 'bg-indigo-50/50 dark:bg-indigo-950/30' : ''}`}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      disabled={r.status === 'running' || (!compare.includes(r.id) && compare.length >= 2)}
                      checked={compare.includes(r.id)}
                      onChange={(e) => setCompare((c) => (e.target.checked ? [...c, r.id] : c.filter((x) => x !== r.id)))}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-semibold">
                      #{r.id} {r.label}
                    </div>
                    <div className="text-xs text-slate-500">
                      {setName_(r.set_id)} · {formatTime(r.started_at)}
                    </div>
                    {r.status === 'running' ? (
                      <div className="mt-1 w-40">
                        <div className="h-1.5 rounded bg-slate-200 dark:bg-slate-700">
                          <div className="h-1.5 rounded bg-indigo-500" style={{ width: `${(r.done / Math.max(1, r.total)) * 100}%` }} />
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {r.done}/{r.total} 진행 중…
                        </div>
                      </div>
                    ) : (
                      r.status !== 'done' && <div className="text-xs text-red-600">{STATUS_LABEL[r.status]} {r.error ?? ''}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    <div>
                      {r.config.provider}/{r.config.model}
                    </div>
                    <div>표준답안 {r.config.qa_version}</div>
                    <div>
                      프롬프트 {r.config.prompt} · {r.config.search_mode} · 기준 {r.config.threshold_keyword}
                      {r.config.include_unreviewed ? ' · 미검수 포함' : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">
                    {pct(r.summary?.cite_hit_rate)}
                    {r.summary && <div className="text-[11px] font-normal text-slate-500">{r.summary.cite_hit}/{r.summary.cite_total}</div>}
                  </td>
                  <td className="px-3 py-2 text-right">{pct(r.summary?.retrieve_hit_rate)}</td>
                  <td className="px-3 py-2 text-right">{pct(r.summary?.type_accuracy)}</td>
                  <td className="px-3 py-2 text-right">{pct(r.summary?.referral_accuracy)}</td>
                  <td className="px-3 py-2 text-right">
                    {r.summary ? r.summary.wrong : '-'}
                    {r.summary && r.summary.unreviewed > 0 && <div className="text-[11px] text-slate-500">미검수 {r.summary.unreviewed}</div>}
                  </td>
                  <td className="px-3 py-2">
                    {r.status === 'done' && r.summary?.awaiting_review && (
                      <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        검수 대기
                      </span>
                    )}
                    {r.status === 'done' && r.summary && !r.summary.awaiting_review && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${r.summary.passed ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'}`}
                      >
                        {r.summary.passed ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                        {r.summary.passed ? '통과' : '미달'}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                        {openRun === r.id ? '닫기' : '결과 보기'}
                      </button>
                      {r.status === 'running' ? (
                        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => api(`/api/admin/eval/runs/${r.id}/cancel`, { body: {} }).then(load)}>
                          <Square className="h-3.5 w-3.5" /> 중지
                        </button>
                      ) : (
                        <>
                          <a className="btn-secondary px-2 py-1 text-xs" href={`/api/admin/eval/runs/${r.id}/export`} title="엑셀로 받기">
                            <Download className="h-3.5 w-3.5" />
                          </a>
                          <button type="button" className="btn-secondary px-2 py-1 text-xs text-red-600" onClick={() => removeRun(r)} title="삭제">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-200 p-3 text-[11px] leading-relaxed text-slate-500 dark:border-slate-700 dark:text-slate-400">
          <b>인용 적중</b>: 기대 통합번호를 답변 근거로 인용한 비율 · <b>검색 적중</b>: 기대 통합번호가 검색 결과에라도 들어간 비율 (인용 적중보다 크게 높으면 모델 쪽, 둘 다 낮으면 검색·데이터 쪽 문제) ·{' '}
          <b>유형 정확</b>: 답변 유형이 기대와 같은 비율 · <b>연결 정확</b>: 답하면 안 되는 질문(연결형·범위 외·근거 없음)을 맞게 걸러낸 비율 · <b>잘못된 결론</b>: 결과 보기에서 관리자가 표시한 건수
        </p>
      </section>

      {compare.length === 2 && <CompareView ids={compare} onClose={() => setCompare([])} />}
      {openRun && <RunDetail key={openRun} runId={openRun} onChanged={load} live={runs.find((r) => r.id === openRun)?.status === 'running'} />}
    </div>
  );
}

function PassCriteria({ onChanged }: { onChanged: () => void }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    api<{ value: string }>('/api/admin/settings/eval_pass_hit_rate').then((r) => {
      setValue(r.value);
      setSaved(r.value);
    });
  }, []);
  async function save() {
    await api('/api/admin/settings/eval_pass_hit_rate', { method: 'PUT', body: { value } });
    setSaved(value);
    onChanged();
  }
  return (
    <section className="card flex flex-wrap items-center gap-3 p-4 text-sm text-slate-700 dark:text-slate-200">
      <b>시범운영 통과 기준</b>
      <span>인용 적중률</span>
      <input className="input w-20" value={value} onChange={(e) => setValue(e.target.value)} />
      <span>이상 (0~1, 예: 0.8 = 80%) + 근거답변 전부 검수 + 잘못된 결론 0건 + 오류 0건</span>
      <button type="button" className="btn-secondary" disabled={value === saved} onClick={save}>
        저장
      </button>
    </section>
  );
}

const OX = ({ v }: { v: number | null }) =>
  v === null ? <span className="text-slate-400">-</span> : v ? <span className="font-bold text-green-600">O</span> : <span className="font-bold text-red-600">X</span>;

function RunDetail({ runId, onChanged, live }: { runId: number; onChanged: () => void; live: boolean }) {
  const [data, setData] = useState<{ run: Run; results: Result[] } | null>(null);
  const [filter, setFilter] = useState<'all' | 'miss' | 'review'>('all');
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => setData(await api(`/api/admin/eval/runs/${runId}`)), [runId]);
  useEffect(() => {
    load();
    if (!live) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load, live]);

  async function judge(r: Result, verdict: 'ok' | 'wrong' | null) {
    let note = r.verdict_note;
    if (verdict === 'wrong') {
      const n = prompt('무엇이 잘못되었는지 메모를 남겨 주세요 (선택)', r.verdict_note);
      if (n === null) return;
      note = n;
    }
    await api(`/api/admin/eval/results/${r.id}`, { method: 'PATCH', body: { verdict, note } });
    await load();
    onChanged();
  }

  if (!data) return null;
  const rows = data.results.filter((r) =>
    filter === 'miss' ? r.cite_hit === 0 || r.type_match === 0 || r.error : filter === 'review' ? r.answer_type === '근거답변' && !r.verdict : true,
  );
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4 dark:border-slate-700">
        <h3 className="font-bold text-slate-800 dark:text-slate-100">
          #{data.run.id} {data.run.label} 결과
        </h3>
        <div className="flex gap-1 rounded-lg bg-slate-200 p-1 text-xs dark:bg-slate-800">
          {(
            [
              ['all', `전체 ${data.results.length}`],
              ['miss', '틀린 것만'],
              ['review', '검수 필요'],
            ] as const
          ).map(([k, label]) => (
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
      <p className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
        ‘근거답변’은 내용을 펼쳐 읽고 <b>적절</b> 또는 <b>잘못된 결론</b>으로 판정해 주세요. 잘못된 결론이 1건이라도 있으면 통과하지 못합니다.
      </p>
      <div className="divide-y divide-slate-100 dark:divide-slate-700">
        {rows.map((r) => (
          <div key={r.id} className="p-3 text-sm">
            <div className="flex flex-wrap items-start gap-3">
              <span className="w-8 shrink-0 text-xs text-slate-400">{r.seq}</span>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <div className="flex items-center gap-1 text-slate-800 dark:text-slate-100">
                  {r.question}
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition ${open === r.id ? 'rotate-180' : ''}`} />
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {r.business_type} · 기대 [{r.expected_qa_ids.join(', ') || '-'}] {r.expected_type ?? ''} → 인용 [{r.cited_qa_ids.join(', ') || '-'}]{' '}
                  {r.answer_type ?? '오류'}
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-3 text-xs">
                <span title="인용 적중">
                  인용 <OX v={r.cite_hit} />
                </span>
                <span title="검색 적중">
                  검색 <OX v={r.retrieve_hit} />
                </span>
                <span title="유형 일치">
                  유형 <OX v={r.type_match} />
                </span>
                {r.answer_type === '근거답변' && (
                  <span className="inline-flex gap-1">
                    <button
                      type="button"
                      className={`rounded border px-2 py-0.5 ${r.verdict === 'ok' ? 'border-green-600 bg-green-600 text-white' : 'border-slate-300 dark:border-slate-600'}`}
                      onClick={() => judge(r, r.verdict === 'ok' ? null : 'ok')}
                    >
                      적절
                    </button>
                    <button
                      type="button"
                      className={`rounded border px-2 py-0.5 ${r.verdict === 'wrong' ? 'border-red-600 bg-red-600 text-white' : 'border-slate-300 dark:border-slate-600'}`}
                      onClick={() => judge(r, r.verdict === 'wrong' ? null : 'wrong')}
                    >
                      잘못된 결론
                    </button>
                  </span>
                )}
              </div>
            </div>
            {r.verdict_note && <div className="ml-11 mt-1 text-xs text-red-600">메모: {r.verdict_note}</div>}
            {open === r.id && (
              <div className="ml-11 mt-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
                {r.error ? <p className="text-xs text-red-600">오류: {r.error}</p> : <Markdown text={r.answer} />}
                <p className="mt-2 text-[11px] text-slate-500">
                  검색된 표준답안: {r.retrieved_qa_ids.join(', ') || '없음'} {r.latency_ms != null && `· ${(r.latency_ms / 1000).toFixed(1)}초`}
                  {r.note && ` · 비고: ${r.note}`}
                </p>
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && <p className="p-4 text-center text-sm text-slate-400">해당하는 문항이 없습니다.</p>}
      </div>
    </section>
  );
}

function CompareView({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const [a, setA] = useState<{ run: Run; results: Result[] } | null>(null);
  const [b, setB] = useState<{ run: Run; results: Result[] } | null>(null);
  const [first, second] = [...ids].sort((x, y) => x - y);

  useEffect(() => {
    api<{ run: Run; results: Result[] }>(`/api/admin/eval/runs/${first}`).then(setA);
    api<{ run: Run; results: Result[] }>(`/api/admin/eval/runs/${second}`).then(setB);
  }, [first, second]);

  if (!a || !b) return null;
  if (a.run.set_id !== b.run.set_id) {
    return (
      <Notice kind="info">
        서로 다른 질문집의 실행은 문항별로 비교할 수 없습니다. 같은 질문집의 실행 2개를 골라 주세요.{' '}
        <button type="button" className="underline" onClick={onClose}>
          선택 해제
        </button>
      </Notice>
    );
  }
  const byItem = new Map(a.results.map((r) => [r.item_id, r]));
  const changed = b.results
    .map((rb) => ({ ra: byItem.get(rb.item_id), rb }))
    .filter(({ ra, rb }) => ra && (ra.cite_hit !== rb.cite_hit || ra.type_match !== rb.type_match || ra.answer_type !== rb.answer_type));

  const metric = (label: string, va: number | null | undefined, vb: number | null | undefined, pctFmt = true) => {
    const diff = va != null && vb != null ? vb - va : null;
    return (
      <tr>
        <td className="px-3 py-1.5 text-slate-500">{label}</td>
        <td className="px-3 py-1.5 text-right">{pctFmt ? pct(va) : (va ?? '-')}</td>
        <td className="px-3 py-1.5 text-right">{pctFmt ? pct(vb) : (vb ?? '-')}</td>
        <td className={`px-3 py-1.5 text-right font-semibold ${diff === null || diff === 0 ? 'text-slate-400' : (diff > 0) === (label !== '잘못된 결론') ? 'text-green-600' : 'text-red-600'}`}>
          {diff === null ? '-' : `${diff > 0 ? '+' : ''}${pctFmt ? `${Math.round(diff * 1000) / 10}%p` : diff}`}
        </td>
      </tr>
    );
  };

  const cfgDiff = (Object.keys(a.run.config) as (keyof Run['config'])[]).filter((k) => JSON.stringify(a.run.config[k]) !== JSON.stringify(b.run.config[k]));

  return (
    <section className="card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-100">
          <GitCompare className="h-4 w-4" /> 비교: #{a.run.id} {a.run.label} → #{b.run.id} {b.run.label}
        </h3>
        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={onClose}>
          닫기
        </button>
      </div>
      <p className="text-xs text-slate-500">
        바뀐 조건: {cfgDiff.length ? cfgDiff.map((k) => `${k} (${String(a.run.config[k])} → ${String(b.run.config[k])})`).join(', ') : '없음 (같은 조건에서 다시 실행)'}
      </p>
      <table className="text-sm text-slate-700 dark:text-slate-200">
        <thead className="text-xs text-slate-500">
          <tr>
            <th />
            <th className="px-3 py-1 text-right">#{a.run.id}</th>
            <th className="px-3 py-1 text-right">#{b.run.id}</th>
            <th className="px-3 py-1 text-right">변화</th>
          </tr>
        </thead>
        <tbody>
          {metric('인용 적중', a.run.summary?.cite_hit_rate, b.run.summary?.cite_hit_rate)}
          {metric('검색 적중', a.run.summary?.retrieve_hit_rate, b.run.summary?.retrieve_hit_rate)}
          {metric('유형 정확', a.run.summary?.type_accuracy, b.run.summary?.type_accuracy)}
          {metric('연결 정확', a.run.summary?.referral_accuracy, b.run.summary?.referral_accuracy)}
          {metric('잘못된 결론', a.run.summary?.wrong, b.run.summary?.wrong, false)}
        </tbody>
      </table>
      <div>
        <div className="mb-1 text-xs font-bold text-slate-500">결과가 달라진 문항 {changed.length}건</div>
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm dark:divide-slate-700 dark:border-slate-700">
          {changed.map(({ ra, rb }) => (
            <div key={rb.item_id} className="flex flex-wrap items-center gap-3 p-2.5">
              <span className="w-8 text-xs text-slate-400">{rb.seq}</span>
              <span className="min-w-0 flex-1 text-slate-800 dark:text-slate-100">{rb.question}</span>
              <span className="text-xs text-slate-500">
                인용 <OX v={ra!.cite_hit} />→<OX v={rb.cite_hit} /> · 유형 {ra!.answer_type ?? '-'}→{rb.answer_type ?? '-'}
              </span>
            </div>
          ))}
          {changed.length === 0 && <p className="p-3 text-center text-xs text-slate-400">달라진 문항이 없습니다.</p>}
        </div>
      </div>
    </section>
  );
}
