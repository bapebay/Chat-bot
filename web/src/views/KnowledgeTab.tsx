import { AlertTriangle, CheckCircle2, Download, FileText, Search, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, formatTime, type Meta } from '../api';
import { Notice, Select } from '../components/ui';
import { SettingEditor } from './AdminView';

interface UploadWarning {
  row: number | null;
  qa_id?: string;
  message: string;
}

interface QaVersion {
  id: number;
  filename: string;
  uploaded_by_name: string | null;
  status: 'draft' | 'active' | 'archived';
  item_count: number;
  confirmed_count: number;
  referral_count: number;
  warnings: UploadWarning[];
  created_at: string;
  activated_at: string | null;
}

interface QaItem {
  id: number;
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

interface Status {
  qa: number;
  guideline: number;
  out_of_scope: number;
  semantic_model: string | null;
  semantic_ready: boolean;
  semantic_error: string | null;
  active_version: QaVersion | null;
}

type Section = 'qa' | 'guideline' | 'principles' | 'oos' | 'search';

const STATUS_LABEL = { draft: '미리보기', active: '서비스 중', archived: '보관' };

function errorText(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

function FilePicker({ accept, label, busy, onFile }: { accept: string; label: string; busy?: boolean; onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
      <button type="button" className="btn-primary" disabled={busy} onClick={() => ref.current?.click()}>
        <Upload className="h-4 w-4" /> {busy ? '처리 중…' : label}
      </button>
    </>
  );
}

export function KnowledgeTab({ meta }: { meta: Meta }) {
  const [section, setSection] = useState<Section>('qa');
  const [status, setStatus] = useState<Status | null>(null);

  const loadStatus = useCallback(() => {
    api<Status>('/api/admin/knowledge/status').then(setStatus).catch(() => undefined);
  }, []);
  useEffect(() => {
    loadStatus();
    // 의미 색인 계산 중이면 상태를 잠시 후 다시 읽는다
    const t = setInterval(loadStatus, 5000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const sections: { key: Section; label: string }[] = [
    { key: 'qa', label: '표준 Q&A' },
    { key: 'guideline', label: '지침·FAQ 원문' },
    { key: 'principles', label: '답변 원칙' },
    { key: 'oos', label: '답변범위 외 목록' },
    { key: 'search', label: '검색 설정·시험' },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      {status && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="검색 중인 표준답안" value={status.qa} />
          <Stat label="지침·FAQ 조항" value={status.guideline} />
          <Stat label="답변범위 외 질의" value={status.out_of_scope} />
          <div className="card p-3 text-center">
            <div className={`text-sm font-bold ${status.semantic_ready ? 'text-green-600 dark:text-green-400' : 'text-slate-500'}`}>
              {status.semantic_model ? (status.semantic_ready ? '키워드 + 의미' : '의미 색인 계산 중…') : '키워드만'}
            </div>
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">검색 방식</div>
          </div>
        </div>
      )}
      <div className="flex gap-1 overflow-x-auto rounded-lg bg-slate-200 p-1 dark:bg-slate-800">
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSection(s.key)}
            className={`shrink-0 flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${section === s.key ? 'bg-white text-indigo-700 shadow dark:bg-slate-700 dark:text-white' : 'text-slate-600 dark:text-slate-300'}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'qa' && <QaSection onChanged={loadStatus} />}
      {section === 'guideline' && <GuidelineSection onChanged={loadStatus} />}
      {section === 'principles' && <PrinciplesSection />}
      {section === 'oos' && <OutOfScopeSection onChanged={loadStatus} />}
      {section === 'search' && <SearchSection meta={meta} status={status} onChanged={loadStatus} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-3 text-center">
      <div className="text-xl font-bold text-indigo-600 dark:text-indigo-400">{value.toLocaleString()}</div>
      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{label}</div>
    </div>
  );
}

// ================= 표준 Q&A =================

function QaSection({ onChanged }: { onChanged: () => void }) {
  const [versions, setVersions] = useState<QaVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [viewing, setViewing] = useState<QaVersion | null>(null);

  const load = useCallback(async () => setVersions(await api<QaVersion[]>('/api/admin/knowledge/qa/versions')), []);
  useEffect(() => {
    load();
  }, [load]);

  async function upload(f: File) {
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    form.append('file', f);
    try {
      const v = await api<QaVersion>('/api/admin/knowledge/qa/upload', { body: form });
      setMessage({ kind: 'success', text: `읽기 완료: ${v.item_count}건. 아래 ‘미리보기’ 버전을 확인한 뒤 [서비스에 적용]을 누르세요.` });
      await load();
      setViewing(v);
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '업로드에 실패했습니다.') });
    } finally {
      setBusy(false);
    }
  }

  async function activate(v: QaVersion) {
    const msg = v.status === 'archived' ? `이전 버전(#${v.id})으로 되돌릴까요?` : `#${v.id} 버전을 서비스에 적용할까요?`;
    if (!confirm(msg)) return;
    try {
      await api(`/api/admin/knowledge/qa/versions/${v.id}/activate`, { body: {} });
      setMessage({ kind: 'success', text: `#${v.id} 버전이 서비스에 적용되었습니다. 다음 질문부터 바로 반영됩니다.` });
      await load();
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '적용에 실패했습니다.') });
    }
  }

  async function remove(v: QaVersion) {
    if (!confirm(`#${v.id} 버전을 삭제할까요?`)) return;
    try {
      await api(`/api/admin/knowledge/qa/versions/${v.id}`, { method: 'DELETE' });
      if (viewing?.id === v.id) setViewing(null);
      await load();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '삭제에 실패했습니다.') });
    }
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold text-slate-800 dark:text-slate-100">표준 Q&A 엑셀 업로드</h3>
          <div className="flex gap-2">
            <a className="btn-secondary" href="/api/admin/knowledge/qa/template">
              <Download className="h-4 w-4" /> 양식 받기
            </a>
            <FilePicker accept=".xlsx" label="엑셀 올리기" busy={busy} onFile={upload} />
          </div>
        </div>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-500 dark:text-slate-400">
          <li>‘통합질의’ 시트를 읽습니다. 머리글: 통합번호 · 대분류 · 중분류 · 소분류 · 대표 질의 · 요지 체크리스트 · 통합 답안 · 연결형 답변 · 검수상태 (· 답변 변경 이력)</li>
          <li>올리면 먼저 ‘미리보기’로 저장됩니다. 건수·경고를 확인한 뒤 [서비스에 적용]을 눌러야 챗봇에 반영됩니다.</li>
          <li>검수상태가 ‘확정’인 행만 씁니다. 미검수 사용 여부는 ‘검색 설정·시험’에서 바꿀 수 있습니다.</li>
          <li>개인정보는 비식별 처리된 데이터만 올려 주세요. 전화번호·이메일 등이 보이면 경고합니다.</li>
        </ul>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
      </section>

      <section className="card overflow-hidden">
        <h3 className="border-b border-slate-200 p-4 font-bold text-slate-800 dark:border-slate-700 dark:text-slate-100">버전 목록</h3>
        <div className="divide-y divide-slate-100 dark:divide-slate-700">
          {versions.length === 0 && <p className="p-6 text-center text-sm text-slate-400">아직 올린 표준 Q&A가 없습니다.</p>}
          {versions.map((v) => (
            <div key={v.id} className={`p-4 ${v.status === 'draft' ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-slate-700 dark:text-slate-200">
                  <span
                    className={`mr-2 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                      v.status === 'active'
                        ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
                        : v.status === 'draft'
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                          : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {STATUS_LABEL[v.status]}
                  </span>
                  <b>#{v.id}</b> {v.filename}
                  <span className="ml-2 text-xs text-slate-500">
                    {formatTime(v.created_at)} · {v.uploaded_by_name ?? '-'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setViewing(viewing?.id === v.id ? null : v)}>
                    {viewing?.id === v.id ? '닫기' : '내용 보기'}
                  </button>
                  <a className="btn-secondary px-2 py-1 text-xs" href={`/api/admin/knowledge/qa/versions/${v.id}/export`}>
                    <Download className="h-3.5 w-3.5" /> 엑셀
                  </a>
                  {v.status !== 'active' && (
                    <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => activate(v)}>
                      {v.status === 'draft' ? '서비스에 적용' : '이 버전으로 되돌리기'}
                    </button>
                  )}
                  {v.status !== 'active' && (
                    <button type="button" className="btn-secondary px-2 py-1 text-xs text-red-600" onClick={() => remove(v)} title="삭제">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                <span>전체 {v.item_count}건</span>
                <span className="text-green-700 dark:text-green-400">확정 {v.confirmed_count}건</span>
                <span>미검수 등 {v.item_count - v.confirmed_count}건</span>
                <span>연결형 {v.referral_count}건</span>
                {v.warnings.length > 0 && (
                  <span className="flex items-center gap-1 font-semibold text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" /> 경고 {v.warnings.length}건
                  </span>
                )}
              </div>
              {viewing?.id === v.id && <VersionDetail version={v} />}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function VersionDetail({ version }: { version: QaVersion }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<QaItem[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<QaItem[]>(`/api/admin/knowledge/qa/versions/${version.id}/items?q=${encodeURIComponent(q)}`).then(setItems);
    }, 250);
    return () => clearTimeout(t);
  }, [version.id, q]);

  return (
    <div className="mt-3 space-y-3">
      {version.warnings.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="mb-1 font-bold">업로드 경고 (엑셀에서 고친 뒤 다시 올리는 것을 권합니다)</div>
          {version.warnings.map((w, i) => (
            <div key={i}>
              {w.row ? `${w.row}행` : ''} {w.qa_id ? `[${w.qa_id}]` : ''} {w.message}
            </div>
          ))}
        </div>
      )}
      <input className="input" placeholder="통합번호·질의·답안 검색 (최대 200건 표시)" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="max-h-[480px] divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
        {items.map((it) => (
          <div key={it.id} className="p-2.5 text-sm">
            <button type="button" className="flex w-full items-start gap-2 text-left" onClick={() => setOpen(open === it.id ? null : it.id)}>
              <span className="shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[11px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">{it.qa_id}</span>
              <span className="min-w-0 flex-1 text-slate-800 dark:text-slate-100">{it.question}</span>
              <span className="shrink-0 text-[11px] text-slate-500">
                {it.category1} · {it.review_status || '-'}
                {it.is_referral ? ' · 연결형' : ''}
              </span>
            </button>
            {open === it.id && (
              <div className="mt-2 space-y-1 rounded bg-slate-50 p-2.5 text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-300">
                <div>
                  <b>분류</b>: {[it.category1, it.category2, it.category3].filter(Boolean).join(' > ')}
                </div>
                {it.checklist && (
                  <div className="whitespace-pre-wrap">
                    <b>요지</b>: {it.checklist}
                  </div>
                )}
                <div className="whitespace-pre-wrap">
                  <b>통합 답안</b>: {it.answer}
                </div>
                {it.referral_answer && (
                  <div className="whitespace-pre-wrap">
                    <b>연결형 답변</b>: {it.referral_answer}
                  </div>
                )}
                {it.change_history && (
                  <div>
                    <b>변경 이력</b>: {it.change_history}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {items.length === 0 && <p className="p-4 text-center text-xs text-slate-400">항목이 없습니다.</p>}
      </div>
    </div>
  );
}

// ================= 지침·FAQ 원문 =================

interface GuidelineDocRow {
  id: number;
  name: string;
  kind: string;
  filename: string;
  active: number;
  chunk_count: number;
  uploaded_by_name: string | null;
  created_at: string;
}

function GuidelineSection({ onChanged }: { onChanged: () => void }) {
  const [docs, setDocs] = useState<GuidelineDocRow[]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('지침');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [chunksOf, setChunksOf] = useState<number | null>(null);
  const [chunks, setChunks] = useState<{ id: number; clause: string; page: number | null; text: string }[]>([]);

  const load = useCallback(async () => setDocs(await api<GuidelineDocRow[]>('/api/admin/knowledge/guidelines')), []);
  useEffect(() => {
    load();
  }, [load]);

  async function upload(f: File) {
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    form.append('name', name || f.name.replace(/\.[^.]+$/, ''));
    form.append('kind', kind);
    form.append('file', f);
    try {
      const r = await api<{ chunk_count: number }>('/api/admin/knowledge/guidelines/upload', { body: form });
      setMessage({ kind: 'success', text: `${r.chunk_count}개 조항으로 나눠 저장했습니다. ‘조항 보기’로 나뉜 결과를 확인하세요.` });
      setName('');
      await load();
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '업로드에 실패했습니다.') });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(d: GuidelineDocRow) {
    await api(`/api/admin/knowledge/guidelines/${d.id}`, { method: 'PATCH', body: { active: !d.active } });
    await load();
    onChanged();
  }

  async function remove(d: GuidelineDocRow) {
    if (!confirm(`'${d.name}' 문서를 삭제할까요?`)) return;
    await api(`/api/admin/knowledge/guidelines/${d.id}`, { method: 'DELETE' });
    if (chunksOf === d.id) setChunksOf(null);
    await load();
    onChanged();
  }

  async function showChunks(d: GuidelineDocRow) {
    if (chunksOf === d.id) return setChunksOf(null);
    setChunks(await api(`/api/admin/knowledge/guidelines/${d.id}/chunks`));
    setChunksOf(d.id);
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3 p-4">
        <h3 className="font-bold text-slate-800 dark:text-slate-100">지침·FAQ 원문 올리기</h3>
        <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto]">
          <input className="input" placeholder="문서 이름 (예: 앵커 사업비 집행 및 관리 지침 2026.3.)" value={name} onChange={(e) => setName(e.target.value)} />
          <Select value={kind} onChange={setKind} options={['지침', 'FAQ']} />
          <FilePicker accept=".pdf,.txt,.md" label="파일 올리기" busy={busy} onFile={upload} />
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          PDF·TXT·MD (15MB 이하). 한글(HWP) 파일은 PDF로 저장해 올려 주세요. ‘제N조’, ‘1.’, ‘가.’, ‘Q.’ 같은 머리를 기준으로 조항을 나누고 쪽수를 함께 저장합니다. 개정판을 올리면 이전 판은 ‘사용 중지’해 두세요.
        </p>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
      </section>
      <section className="card divide-y divide-slate-100 dark:divide-slate-700">
        {docs.length === 0 && <p className="p-6 text-center text-sm text-slate-400">올린 문서가 없습니다.</p>}
        {docs.map((d) => (
          <div key={d.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <FileText className={`h-4 w-4 ${d.active ? 'text-emerald-600' : 'text-slate-400'}`} />
                <span className={d.active ? '' : 'text-slate-400 line-through'}>{d.name}</span>
                <span className="text-xs text-slate-500">
                  {d.kind} · 조항 {d.chunk_count}개 · {formatTime(d.created_at)}
                </span>
              </div>
              <div className="flex gap-1.5">
                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => showChunks(d)}>
                  {chunksOf === d.id ? '닫기' : '조항 보기'}
                </button>
                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => toggle(d)}>
                  {d.active ? '사용 중지' : '다시 사용'}
                </button>
                <button type="button" className="btn-secondary px-2 py-1 text-xs text-red-600" onClick={() => remove(d)} title="삭제">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            {chunksOf === d.id && (
              <div className="mt-3 max-h-[480px] space-y-2 overflow-y-auto">
                {chunks.map((c) => (
                  <details key={c.id} className="rounded-lg border border-slate-200 p-2 text-sm dark:border-slate-700">
                    <summary className="cursor-pointer text-slate-700 dark:text-slate-200">
                      {c.clause} {c.page ? <span className="text-xs text-slate-500">· {c.page}쪽</span> : null}
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-slate-600 dark:text-slate-300">{c.text}</pre>
                  </details>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

// ================= 답변 원칙 =================

function PrinciplesSection() {
  const [fill, setFill] = useState<{ text: string; n: number } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function parse(f: File) {
    setBusy(true);
    setMessage('');
    const form = new FormData();
    form.append('file', f);
    try {
      const r = await api<{ text: string }>('/api/admin/knowledge/principles/parse', { body: form });
      setFill({ text: r.text, n: Date.now() });
    } catch (err) {
      setMessage(errorText(err, '파일을 읽지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center justify-between gap-2 p-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          답변 원칙 문서(엑셀의 ‘원칙’ 열, 또는 TXT)를 불러오면 아래 편집기에 채워집니다. 내용을 확인하고 [저장]을 눌러야 반영됩니다.
        </p>
        <FilePicker accept=".xlsx,.txt,.md" label="파일에서 불러오기" busy={busy} onFile={parse} />
      </div>
      <Notice>{message}</Notice>
      <SettingEditor
        key={fill?.n ?? 0}
        settingKey="principles"
        title="답변 원칙 (매 질문마다 모델에 함께 전달)"
        help="담당자가 검수하며 정한 반복 기준(범위, 연결 규칙, 인건비·수당·이월·정산 등). 한 줄에 한 항목으로 적습니다."
        rows={20}
        initialDraft={fill?.text}
        allowEmpty
      />
    </div>
  );
}

// ================= 답변범위 외 목록 =================

function OutOfScopeSection({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<{ id: number; question: string; guidance: string; department: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => setItems(await api('/api/admin/knowledge/out-of-scope')), []);
  useEffect(() => {
    load();
  }, [load]);

  async function upload(f: File) {
    if (items.length && !confirm('기존 목록을 새 파일 내용으로 바꿉니다. 계속할까요?')) return;
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    form.append('file', f);
    try {
      const r = await api<{ count: number }>('/api/admin/knowledge/out-of-scope/upload', { body: form });
      setMessage({ kind: 'success', text: `${r.count}건으로 바꿨습니다.` });
      await load();
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '업로드에 실패했습니다.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold text-slate-800 dark:text-slate-100">답변범위 외 목록 ({items.length})</h3>
          <FilePicker accept=".xlsx,.txt,.csv" label="파일로 바꾸기" busy={busy} onFile={upload} />
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          엑셀 머리글: 대표 질의 · 안내 문구 · 담당 부서 (텍스트 파일은 한 줄에 질의 하나). 질문이 여기에 가까우면 모델을 부르지 않고 ‘답변 범위가 아닙니다’로 안내합니다.
        </p>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
      </section>
      <section className="card divide-y divide-slate-100 dark:divide-slate-700">
        {items.map((it) => (
          <div key={it.id} className="p-3 text-sm text-slate-700 dark:text-slate-200">
            <div className="font-medium">{it.question}</div>
            {(it.guidance || it.department) && (
              <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {it.guidance} {it.department && `· 담당: ${it.department}`}
              </div>
            )}
          </div>
        ))}
        {items.length === 0 && <p className="p-6 text-center text-sm text-slate-400">등록된 항목이 없습니다.</p>}
      </section>
    </div>
  );
}

// ================= 검색 설정·시험 =================

interface SearchTestResult {
  mode: 'hybrid' | 'keyword';
  passed: boolean;
  qa: { qa_id: string; category1: string; question: string; keyword: number; semantic: number | null; relevant: boolean }[];
  guideline: { doc_name: string; clause: string; page: number | null; keyword: number; semantic: number | null; relevant: boolean }[];
  out_of_scope: { question: string; keyword: number; semantic: number | null } | null;
}

const NUMERIC_SETTINGS = [
  { key: 'threshold_keyword', label: '키워드 기준값 (0~1)', help: '질문 핵심어가 근거에 들어 있는 비율. 높이면 더 엄격해집니다.' },
  { key: 'threshold_semantic', label: '의미 기준값 (0~1)', help: '의미 검색을 쓸 때 문장 유사도 기준.' },
  { key: 'top_k_qa', label: '표준답안 최대 건수', help: '모델에 넘기는 표준답안 수 (1~10).' },
  { key: 'top_k_guideline', label: '지침 조항 최대 건수', help: '모델에 넘기는 지침 조항 수 (1~10).' },
];

function SearchSection({ meta, status, onChanged }: { meta: Meta; status: Status | null; onChanged: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [query, setQuery] = useState('');
  const [bt, setBt] = useState('모름');
  const [result, setResult] = useState<SearchTestResult | null>(null);

  useEffect(() => {
    const keys = ['include_unreviewed', ...NUMERIC_SETTINGS.map((s) => s.key)];
    Promise.all(keys.map((k) => api<{ value: string }>(`/api/admin/settings/${k}`).then((r) => [k, r.value] as const))).then((pairs) => {
      const v = Object.fromEntries(pairs);
      setValues(v);
      setSaved(v);
    });
  }, []);

  async function save(key: string, value: string) {
    setMessage(null);
    try {
      await api(`/api/admin/settings/${key}`, { method: 'PUT', body: { value } });
      setSaved((p) => ({ ...p, [key]: value }));
      setValues((p) => ({ ...p, [key]: value }));
      setMessage({ kind: 'success', text: '저장했습니다. 다음 질문부터 적용됩니다.' });
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '저장에 실패했습니다.') });
    }
  }

  async function test() {
    if (!query.trim()) return;
    try {
      setResult(await api<SearchTestResult>('/api/admin/knowledge/search-test', { body: { query, business_type: bt } }));
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '검색에 실패했습니다.') });
    }
  }

  const score = (h: { keyword: number; semantic: number | null }) =>
    `키워드 ${h.keyword.toFixed(2)}${h.semantic !== null ? ` · 의미 ${h.semantic.toFixed(2)}` : ''}`;

  return (
    <div className="space-y-4">
      <section className="card space-y-4 p-4">
        <h3 className="font-bold text-slate-800 dark:text-slate-100">검색 설정</h3>
        <label className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={values.include_unreviewed === 'true'}
            onChange={(e) => save('include_unreviewed', e.target.checked ? 'true' : 'false')}
          />
          <span className="text-slate-700 dark:text-slate-200">
            <b>미검수 표준답안도 사용</b>
            <span className="block text-xs text-slate-500 dark:text-slate-400">1단계(재단 내부) 시범운영에서만 켜세요. 끄면 검수상태 ‘확정’만 씁니다.</span>
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {NUMERIC_SETTINGS.map((s) => (
            <div key={s.key}>
              <label className="label">{s.label}</label>
              <div className="flex gap-2">
                <input className="input" value={values[s.key] ?? ''} onChange={(e) => setValues((p) => ({ ...p, [s.key]: e.target.value }))} />
                <button type="button" className="btn-secondary shrink-0" disabled={values[s.key] === saved[s.key]} onClick={() => save(s.key, values[s.key])}>
                  저장
                </button>
              </div>
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{s.help}</p>
            </div>
          ))}
        </div>
        <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
          <b>의미 검색</b>:{' '}
          {status?.semantic_model
            ? `${status.semantic_model} ${status.semantic_ready ? '사용 중' : '색인 계산 중'}`
            : '모델 파일이 없어 키워드 검색만 사용 중입니다. 서버에서 `npm run download-model` 을 한 번 실행하고 다시 시작하면 켜집니다.'}
          {status?.semantic_error && <span className="text-red-600"> (오류: {status.semantic_error})</span>}
        </div>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
      </section>

      <section className="card space-y-3 p-4">
        <h3 className="font-bold text-slate-800 dark:text-slate-100">검색 시험</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">질문을 넣으면 AI를 부르지 않고 어떤 근거가 몇 점으로 찾아지는지만 보여줍니다. 기준값을 정할 때 쓰세요.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className="input flex-1" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && test()} placeholder="예: 글로컬 사업단장 보직수당 지급 가능한가요?" />
          <Select value={bt} onChange={setBt} options={meta.business_types} className="input sm:w-32" />
          <button type="button" className="btn-primary shrink-0" onClick={test}>
            <Search className="h-4 w-4" /> 검색
          </button>
        </div>
        {result && (
          <div className="space-y-3 text-sm">
            <div className={`flex items-center gap-2 font-semibold ${result.passed ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {result.passed ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              {result.passed ? '근거 있음 → AI가 답변을 만듭니다' : '근거 없음 → AI를 부르지 않고 ‘담당자 문의’를 안내합니다'}
              <span className="text-xs font-normal text-slate-500">({result.mode === 'hybrid' ? '키워드+의미' : '키워드'} 검색)</span>
            </div>
            {result.out_of_scope && (
              <Notice kind="info">
                답변범위 외 목록과 비슷함: “{result.out_of_scope.question}” ({score(result.out_of_scope)})
              </Notice>
            )}
            <ResultList
              title="표준답안"
              rows={result.qa.map((h) => ({ key: h.qa_id, label: `[${h.qa_id}] ${h.question}`, sub: h.category1, relevant: h.relevant, score: score(h) }))}
            />
            <ResultList
              title="지침 조항"
              rows={result.guideline.map((h, i) => ({
                key: String(i),
                label: h.clause,
                sub: `${h.doc_name}${h.page ? ` · ${h.page}쪽` : ''}`,
                relevant: h.relevant,
                score: score(h),
              }))}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function ResultList({ title, rows }: { title: string; rows: { key: string; label: string; sub: string; relevant: boolean; score: string }[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-bold text-slate-500">{title}</div>
      {rows.length === 0 && <p className="text-xs text-slate-400">찾은 항목 없음</p>}
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-start gap-2 rounded border border-slate-200 p-2 dark:border-slate-700">
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${r.relevant ? 'bg-green-500' : 'bg-slate-300'}`} title={r.relevant ? '기준 통과' : '기준 미달(참고용)'} />
            <div className="min-w-0 flex-1">
              <div className="text-slate-800 dark:text-slate-100">{r.label}</div>
              <div className="text-[11px] text-slate-500">
                {r.sub} · {r.score}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
