import { AlertTriangle, CheckCircle2, Download, FileText, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, formatTime } from '../api';
import { Notice, Select } from '../components/ui';
import { QaPanel } from './ReviewView';

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
  principle: number;
  out_of_scope: number;
  semantic_model: string | null;
  semantic_ready: boolean;
  semantic_error: string | null;
  active_version: QaVersion | null;
}

type Section = 'qa' | 'qa-edit' | 'guideline' | 'principle' | 'search';

const STATUS_LABEL = { draft: '미리보기', active: '서비스 중', archived: '보관' };

function errorText(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

export function FilePicker({ accept, label, busy, onFile }: { accept: string; label: string; busy?: boolean; onFile: (f: File) => void }) {
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

export function KnowledgeTab() {
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
    { key: 'qa', label: '표준 Q&A 엑셀' },
    { key: 'qa-edit', label: '표준답안 관리' },
    { key: 'guideline', label: '지침·FAQ 원문' },
    { key: 'principle', label: '집행원리' },
    { key: 'search', label: '검색 설정' },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      {status && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="지침·FAQ 조항" value={status.guideline} />
          <Stat label="집행원리" value={status.principle ?? 0} />
          <Stat label="검색 중인 표준답안" value={status.qa} />
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
      {section === 'qa-edit' && <QaPanel isAdmin />}
      {section === 'principle' && <PrincipleSection onChanged={loadStatus} />}
      {section === 'search' && <SearchSection status={status} onChanged={loadStatus} />}
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

function SearchSection({ status, onChanged }: { status: Status | null; onChanged: () => void }) {
  const [unreviewed, setUnreviewed] = useState('');
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    api<{ value: string }>('/api/admin/settings/include_unreviewed').then((r) => setUnreviewed(r.value));
  }, []);

  async function save(value: string) {
    setMessage(null);
    try {
      await api('/api/admin/settings/include_unreviewed', { method: 'PUT', body: { value } });
      setUnreviewed(value);
      setMessage({ kind: 'success', text: '저장했습니다. 다음 질문부터 적용됩니다.' });
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '저장에 실패했습니다.') });
    }
  }

  return (
    <section className="card space-y-4 p-4">
      <h3 className="font-bold text-slate-800 dark:text-slate-100">검색 설정</h3>
      <label className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
        <input type="checkbox" className="h-4 w-4" checked={unreviewed === 'true'} onChange={(e) => save(e.target.checked ? 'true' : 'false')} />
        <span className="text-slate-700 dark:text-slate-200">
          <b>미검수 표준답안도 사용</b>
          <span className="block text-xs text-slate-500 dark:text-slate-400">1단계(재단 내부) 시범운영에서만 켜세요. 끄면 검수상태 ‘확정’만 씁니다.</span>
        </span>
      </label>
      <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
        <b>의미 검색</b>:{' '}
        {status?.semantic_model
          ? `${status.semantic_model} ${status.semantic_ready ? '사용 중' : '색인 계산 중'}`
          : '모델 파일이 없어 키워드 검색만 사용 중입니다. 서버에서 `npm run download-model` 을 한 번 실행하고 다시 시작하면 켜집니다.'}
        {status?.semantic_error && <span className="text-red-600"> (오류: {status.semantic_error})</span>}
      </div>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
    </section>
  );
}

// ================= 집행원리 (근거 2단계) =================

interface PrincipleSet {
  id: number;
  filename: string;
  uploaded_by_name: string | null;
  status: 'active' | 'archived';
  item_count: number;
  warnings: string[];
  created_at: string;
}

interface PrincipleItem {
  id: number;
  code: string;
  category: string;
  funding: string;
  period: string;
  text: string;
  note: string;
}

function PrincipleSection({ onChanged }: { onChanged: () => void }) {
  const [sets, setSets] = useState<PrincipleSet[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string; warnings?: string[] } | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => setSets(await api<PrincipleSet[]>('/api/admin/knowledge/principles')), []);
  useEffect(() => {
    load();
  }, [load]);

  async function upload(f: File) {
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    form.append('file', f);
    try {
      const r = await api<{ id: number; item_count: number; warnings: string[] }>('/api/admin/knowledge/principles/upload', { body: form });
      setMessage({ kind: 'success', text: `집행원리 ${r.item_count}건을 올려 바로 사용합니다. 이전 묶음은 아래 목록에 보관됩니다.`, warnings: r.warnings });
      setOpenId(r.id);
      await load();
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '업로드에 실패했습니다.') });
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>, done: string) {
    setMessage(null);
    try {
      await fn();
      setMessage({ kind: 'success', text: done });
      await load();
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '처리하지 못했습니다.') });
    }
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3 p-4">
        <h3 className="font-bold text-slate-800 dark:text-slate-100">집행원리 올리기 (CSV)</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          그간 질의응답 사례에서 뽑은 일반 집행 기준입니다. 근거 순서는 <b>지침 및 FAQ → 집행원리 → 표준답안</b>이며, 질문마다 관련 집행원리를 찾아 AI에 <code>[집행원리]</code> 꼬리표로 함께 넘깁니다. 사용자 화면에는 번호를 보여주지 않습니다.
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          첫 줄 머리글: 번호 · 분야 · 재원 · 적용시기 · <b>집행원리</b>(필수) · 비고. 엑셀에서 ‘CSV(쉼표로 분리)’로 저장한 파일도 그대로 올리면 됩니다. 올리면 이전 묶음을 대신해 바로 쓰이고, 이전 묶음은 되돌릴 수 있게 보관됩니다.
        </p>
        <div className="flex flex-wrap gap-2">
          <a className="btn-secondary" href="/api/admin/knowledge/principles/template">
            <Download className="h-4 w-4" /> 양식 받기
          </a>
          <FilePicker accept=".csv" label="CSV 올리기" busy={busy} onFile={upload} />
        </div>
        {message && (
          <Notice kind={message.kind}>
            {message.text}
            {!!message.warnings?.length && (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {message.warnings.slice(0, 20).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </Notice>
        )}
      </section>

      <section className="card overflow-hidden">
        <h3 className="border-b border-slate-200 p-4 font-bold text-slate-800 dark:border-slate-700 dark:text-slate-100">올린 묶음</h3>
        {sets.length === 0 && <p className="p-6 text-center text-sm text-slate-400">아직 올린 집행원리가 없습니다.</p>}
        <div className="divide-y divide-slate-100 dark:divide-slate-700">
          {sets.map((st) => (
            <div key={st.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-slate-700 dark:text-slate-200">
                  {st.status === 'active' && (
                    <span className="mr-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700 dark:bg-green-950 dark:text-green-300">사용 중</span>
                  )}
                  <b>{st.filename}</b> · {st.item_count}건
                  <span className="ml-2 text-xs text-slate-400">
                    {formatTime(st.created_at)} · {st.uploaded_by_name ?? '-'}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setOpenId(openId === st.id ? null : st.id)}>
                    {openId === st.id ? '접기' : '내용 보기'}
                  </button>
                  {st.status !== 'active' && (
                    <>
                      <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => act(() => api(`/api/admin/knowledge/principles/sets/${st.id}/activate`, { body: {} }), '이 묶음을 사용합니다.')}>
                        이 묶음 사용
                      </button>
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-xs"
                        onClick={() => confirm(`'${st.filename}' 묶음을 삭제할까요?`) && act(() => api(`/api/admin/knowledge/principles/sets/${st.id}`, { method: 'DELETE' }), '삭제했습니다.')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
              {openId === st.id && <PrincipleItems setId={st.id} />}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function PrincipleItems({ setId }: { setId: number }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PrincipleItem[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      api<PrincipleItem[]>(`/api/admin/knowledge/principles/sets/${setId}/items?q=${encodeURIComponent(q)}`).then(setItems);
    }, 250);
    return () => clearTimeout(t);
  }, [setId, q]);
  return (
    <div className="mt-3 space-y-2">
      <input className="input" placeholder="번호·분야·내용 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="max-h-96 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-left text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="px-2 py-1.5">번호</th>
              <th className="px-2 py-1.5">분야</th>
              <th className="px-2 py-1.5">재원</th>
              <th className="px-2 py-1.5">적용시기</th>
              <th className="px-2 py-1.5">집행원리</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
            {items.map((p) => (
              <tr key={p.id} className="align-top text-slate-700 dark:text-slate-200">
                <td className="whitespace-nowrap px-2 py-1.5 font-mono">{p.code}</td>
                <td className="px-2 py-1.5">{p.category}</td>
                <td className="px-2 py-1.5">{p.funding}</td>
                <td className="whitespace-nowrap px-2 py-1.5">{p.period}</td>
                <td className="px-2 py-1.5">
                  {p.text}
                  {p.note && <span className="block text-slate-400">비고: {p.note}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <p className="p-4 text-center text-xs text-slate-400">해당하는 집행원리가 없습니다.</p>}
      </div>
    </div>
  );
}
