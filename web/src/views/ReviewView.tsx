import { AlertTriangle, ClipboardList, Download, History, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, formatTime, type User } from '../api';
import { Markdown, Modal, Notice } from '../components/ui';

export interface QaItem {
  id: number;
  version_id: number;
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
  needs_recheck: number;
}

interface QueueItem {
  id: number;
  message_id: number;
  source: 'bad' | 'no_evidence' | 'out_of_scope' | 'security';
  status: string;
  resolution: string | null;
  qa_id: string | null;
  note: string;
  question: string | null;
  answer: string;
  answer_type: string | null;
  business_type: string;
  username: string;
  org_name: string;
  region: string;
  answered_at: string;
  resolved_at: string | null;
  resolved_by_name: string | null;
  cited_qa_ids: string[];
  retrieved_qa_ids: string[];
  feedback: { reason: string | null; comment: string }[];
}

const SOURCE_LABEL: Record<QueueItem['source'], string> = { bad: 'Bad 평가', no_evidence: '근거 없음', out_of_scope: '범위 외 판정', security: '보안 의심' };
const RESOLUTION_LABEL: Record<string, string> = { edited: '기존 답안 수정', added: '새 답안 추가', ignored: '무시' };
const errorText = (err: unknown, fb: string) => (err instanceof ApiError ? err.message : fb);

export function ReviewView({ user }: { user: User }) {
  const [tab, setTab] = useState<'queue' | 'qa'>('queue');
  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-slate-50 dark:bg-slate-900">
      <nav className="flex gap-1 border-b border-slate-200 bg-white px-3 pt-2 dark:border-slate-700 dark:bg-slate-800">
        {(
          [
            ['queue', '검토 대기함'],
            ['qa', '표준답안 관리'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400'}`}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto">{tab === 'queue' ? <QueuePanel /> : <QaPanel isAdmin={user.role === 'admin'} />}</div>
    </div>
  );
}

// ================= 검토 대기함 =================

function QueuePanel() {
  const [status, setStatus] = useState<'pending' | 'done'>('pending');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [editing, setEditing] = useState<{ item: QueueItem; mode: 'edit' | 'add' } | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => setItems(await api<QueueItem[]>(`/api/review/queue?status=${status}`)), [status]);
  useEffect(() => {
    load();
  }, [load]);

  async function resolve(item: QueueItem, action: 'edited' | 'added' | 'ignored', qaId?: string) {
    let note = '';
    if (action === 'ignored') {
      const n = prompt('무시하는 이유를 남겨 주세요 (선택)', '');
      if (n === null) return;
      note = n;
    }
    await api(`/api/review/queue/${item.id}/resolve`, { body: { action, qa_id: qaId, note } });
    setMessage({ kind: 'success', text: `처리했습니다: ${RESOLUTION_LABEL[action]}${qaId ? ` (${qaId})` : ''}. 표준답안 변경은 다음 질문부터 바로 반영됩니다.` });
    await load();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800 dark:text-slate-100">
          <ClipboardList className="h-5 w-5 text-indigo-500" /> 검토 대기함
        </h2>
        <div className="flex gap-1 rounded-lg bg-slate-200 p-1 text-sm dark:bg-slate-800">
          {(
            [
              ['pending', '처리 대기'],
              ['done', '처리 완료'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setStatus(k)}
              className={`rounded-md px-3 py-1 font-medium ${status === k ? 'bg-white text-indigo-700 shadow dark:bg-slate-700 dark:text-white' : 'text-slate-600 dark:text-slate-300'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        사용자가 ‘아쉬워요’를 누른 답변, 근거를 찾지 못한 질문, 범위 외로 판정된 질문이 자동으로 모입니다. ① 기존 표준답안을 고치거나 ② 새 표준답안을 추가하거나 ③ 무시하세요.
      </p>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {items.length === 0 && <p className="py-10 text-center text-sm text-slate-400">{status === 'pending' ? '처리할 항목이 없습니다.' : '처리한 항목이 없습니다.'}</p>}
      {items.map((it) => (
        <div key={it.id} className="card space-y-2 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span
              className={`rounded-full px-2 py-0.5 font-bold ${it.source === 'bad' || it.source === 'security' ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'}`}
            >
              {SOURCE_LABEL[it.source]}
            </span>
            <span>
              {it.org_name} ({it.region}) · {it.business_type} · {formatTime(it.answered_at)}
            </span>
            {it.resolution && (
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                {RESOLUTION_LABEL[it.resolution]} {it.qa_id ?? ''} · {it.resolved_by_name} {formatTime(it.resolved_at)} {it.note && `· ${it.note}`}
              </span>
            )}
          </div>
          <div className="font-semibold text-slate-800 dark:text-slate-100">Q. {it.question ?? '(질문 없음)'}</div>
          {it.feedback.map((f, i) => (
            <div key={i} className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
              사용자 의견: {f.reason ?? ''} {f.comment && `- ${f.comment}`}
            </div>
          ))}
          <details className="rounded-lg bg-slate-50 p-2 dark:bg-slate-900">
            <summary className="cursor-pointer text-xs text-slate-500">
              챗봇 답변 ({it.answer_type}) · 인용 {it.cited_qa_ids.join(', ') || '없음'} · 검색 {it.retrieved_qa_ids.join(', ') || '없음'}
            </summary>
            <div className="mt-2">
              <Markdown text={it.answer} />
            </div>
          </details>
          {status === 'pending' && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setEditing({ item: it, mode: 'edit' })}>
                <Pencil className="h-3.5 w-3.5" /> ① 기존 답안 수정
              </button>
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setEditing({ item: it, mode: 'add' })}>
                <Plus className="h-3.5 w-3.5" /> ② 새 답안 추가
              </button>
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => resolve(it, 'ignored')}>
                ③ 무시
              </button>
            </div>
          )}
        </div>
      ))}

      {editing?.mode === 'edit' && (
        <PickAndEdit
          initialQuery={editing.item.cited_qa_ids[0] ?? editing.item.retrieved_qa_ids[0] ?? ''}
          onClose={() => setEditing(null)}
          onSaved={(qa) => {
            const it = editing.item;
            setEditing(null);
            resolve(it, 'edited', qa.qa_id);
          }}
        />
      )}
      {editing?.mode === 'add' && (
        <QaEditorModal
          initial={{ question: editing.item.question ?? '', review_status: '확정' }}
          onClose={() => setEditing(null)}
          onSaved={(qa) => {
            const it = editing.item;
            setEditing(null);
            resolve(it, 'added', qa.qa_id);
          }}
        />
      )}
    </div>
  );
}

/** 고칠 표준답안을 찾아 고른 뒤 편집 */
function PickAndEdit({ initialQuery, onClose, onSaved }: { initialQuery: string; onClose: () => void; onSaved: (qa: QaItem) => void }) {
  const [q, setQ] = useState(initialQuery);
  const [items, setItems] = useState<QaItem[]>([]);
  const [picked, setPicked] = useState<QaItem | null>(null);
  useEffect(() => {
    const t = setTimeout(() => api<{ items: QaItem[] }>(`/api/review/qa?q=${encodeURIComponent(q)}`).then((r) => setItems(r.items.slice(0, 20))), 250);
    return () => clearTimeout(t);
  }, [q]);
  if (picked) return <QaEditorModal initial={picked} onClose={onClose} onSaved={onSaved} />;
  return (
    <Modal title="고칠 표준답안 고르기" onClose={onClose}>
      <input className="input mb-3" value={q} onChange={(e) => setQ(e.target.value)} placeholder="통합번호·질의·답안 검색" autoFocus />
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {items.map((it) => (
          <button key={it.id} type="button" onClick={() => setPicked(it)} className="w-full rounded-lg border border-slate-200 p-2 text-left text-sm hover:bg-indigo-50 dark:border-slate-700 dark:hover:bg-indigo-950">
            <span className="mr-1.5 font-mono text-xs font-bold text-indigo-600">{it.qa_id}</span>
            {it.question}
          </button>
        ))}
        {items.length === 0 && <p className="text-center text-xs text-slate-400">찾은 표준답안이 없습니다.</p>}
      </div>
    </Modal>
  );
}

// ================= 표준답안 편집 창 =================

export function QaEditorModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: Partial<QaItem>;
  onClose: () => void;
  onSaved: (qa: QaItem) => void;
}) {
  const isNew = !initial.id;
  const [f, setF] = useState({
    qa_id: initial.qa_id ?? '',
    category1: initial.category1 ?? '',
    category2: initial.category2 ?? '',
    category3: initial.category3 ?? '',
    question: initial.question ?? '',
    checklist: initial.checklist ?? '',
    answer: initial.answer ?? '',
    referral_answer: initial.referral_answer ?? '',
    is_referral: !!initial.is_referral,
    review_status: initial.review_status ?? '확정',
    change_history: initial.change_history ?? '',
  });
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    setError('');
    try {
      const body = { ...f, reason };
      const qa = isNew ? await api<QaItem>('/api/review/qa', { body }) : await api<QaItem>(`/api/review/qa/${initial.id}`, { method: 'PUT', body });
      onSaved(qa);
    } catch (err) {
      setError(errorText(err, '저장하지 못했습니다.'));
    }
  }

  const text = (k: keyof typeof f, label: string, rows = 1, placeholder = '') => (
    <div>
      <label className="label">{label}</label>
      {rows > 1 ? (
        <textarea className="input resize-y" rows={rows} value={String(f[k])} onChange={(e) => set(k)(e.target.value)} placeholder={placeholder} />
      ) : (
        <input className="input" value={String(f[k])} onChange={(e) => set(k)(e.target.value)} placeholder={placeholder} />
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card max-h-[92vh] w-full max-w-3xl overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 font-bold text-slate-800 dark:text-slate-100">{isNew ? '새 표준답안 추가' : `표준답안 수정 · ${initial.qa_id}`}</h3>
        {initial.needs_recheck ? <Notice kind="info">지침 개정으로 ‘재검수 필요’ 표시된 답안입니다. 확인 후 저장하면 표시가 해제됩니다.</Notice> : null}
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          {text('qa_id', '통합번호', 1, '예: B4-01-a')}
          {text('category1', '대분류(사업 유형)', 1, '예: 글로컬 / 공통')}
          {text('category2', '중분류', 1, '예: 수당')}
          {text('category3', '소분류')}
        </div>
        <div className="mt-3 space-y-3">
          {text('question', '대표 질의', 2)}
          {text('checklist', '요지 체크리스트 (검색에 쓰임)', 2, '질문의 핵심 요지를 / 로 구분해 적으면 검색이 잘 됩니다')}
          {text('answer', '통합 답안', 8)}
          <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
            <label className="flex items-center gap-2 pt-6 text-sm text-slate-700 dark:text-slate-200">
              <input type="checkbox" checked={f.is_referral} onChange={(e) => set('is_referral')(e.target.checked)} /> 연결형 답안
            </label>
            {text('referral_answer', '연결형 답변 문구 (선택)')}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">검수상태</label>
              <select className="input" value={f.review_status} onChange={(e) => set('review_status')(e.target.value)}>
                {['확정', '미검수', '보류', ...(['확정', '미검수', '보류'].includes(f.review_status) ? [] : [f.review_status])].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">‘확정’만 챗봇이 씁니다 (미검수 사용 설정이 꺼져 있을 때).</p>
            </div>
            {text('change_history', '답변 변경 이력', 1, '예: 2026.3. 한도 기준 변경')}
          </div>
        </div>
        <div className="mt-3">
          <label className="label">수정 사유 (이력에 남음)</label>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: Bad 평가 반영, 한도 문구 보완" />
        </div>
        {error && (
          <div className="mt-3">
            <Notice>{error}</Notice>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            취소
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={!f.qa_id.trim() || !f.question.trim() || !f.answer.trim()}>
            저장 (바로 반영)
          </button>
        </div>
      </div>
    </div>
  );
}

// ================= 표준답안 관리 =================

function QaPanel({ isAdmin }: { isAdmin: boolean }) {
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ category1: '', category2: '', review_status: '', recheck: false });
  const [facets, setFacets] = useState<{ category1: string[]; category2: string[]; review_status: string[] }>({ category1: [], category2: [], review_status: [] });
  const [data, setData] = useState<{ version_id: number | null; total: number; items: QaItem[] }>({ version_id: null, total: 0, items: [] });
  const [editing, setEditing] = useState<Partial<QaItem> | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ q, category1: filters.category1, category2: filters.category2, review_status: filters.review_status });
    if (filters.recheck) params.set('recheck', '1');
    setData(await api(`/api/review/qa?${params}`));
  }, [q, filters]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    api<typeof facets>('/api/review/qa/facets').then(setFacets);
  }, [data.version_id]);

  async function remove(it: QaItem) {
    const reason = prompt(`[${it.qa_id}] 표준답안을 삭제할까요? 삭제 사유를 적어 주세요.`, '');
    if (reason === null) return;
    try {
      await api(`/api/review/qa/${it.id}`, { method: 'DELETE', body: { reason } });
      setMessage({ kind: 'success', text: `${it.qa_id}를 삭제했습니다.` });
      await load();
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err, '삭제하지 못했습니다.') });
    }
  }

  const sel = (k: 'category1' | 'category2' | 'review_status', label: string) => (
    <select className="input w-auto" value={filters[k]} onChange={(e) => setFilters((p) => ({ ...p, [k]: e.target.value }))}>
      <option value="">{label} 전체</option>
      {facets[k].map((v) => (
        <option key={v}>{v}</option>
      ))}
    </select>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">표준답안 관리 (서비스 중인 버전)</h2>
        <div className="flex gap-2">
          {isAdmin && data.version_id && (
            <a className="btn-secondary" href={`/api/admin/knowledge/qa/versions/${data.version_id}/export`}>
              <Download className="h-4 w-4" /> 엑셀 내보내기
            </a>
          )}
          <button type="button" className="btn-primary" onClick={() => setEditing({})}>
            <Plus className="h-4 w-4" /> 새 표준답안
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        여기서 고친 내용은 저장하는 즉시 챗봇 검색에 반영되고 수정 이력이 남습니다. 엑셀로 다시 올릴 계획이라면 <b>먼저 [엑셀 내보내기]로 최신본을 받아 고친 뒤</b> 올리세요 (새 엑셀을 적용하면 화면에서 고친 내용은 그 버전에 없습니다).
      </p>
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input className="input pl-8" placeholder="통합번호·질의·답안 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {sel('category1', '대분류')}
        {sel('category2', '중분류')}
        {sel('review_status', '검수상태')}
        <label className="flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={filters.recheck} onChange={(e) => setFilters((p) => ({ ...p, recheck: e.target.checked }))} /> 재검수 필요만
        </label>
      </div>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {!data.version_id && <Notice kind="info">서비스 중인 표준 Q&A가 없습니다. 관리 → 지식 데이터에서 엑셀을 올려 적용하거나, [새 표준답안]으로 직접 작성하세요.</Notice>}
      <div className="card divide-y divide-slate-100 dark:divide-slate-700">
        <div className="px-3 py-2 text-xs text-slate-500">
          {data.total}건{data.total > data.items.length ? ` 중 ${data.items.length}건 표시 (검색어나 필터로 좁혀 주세요)` : ''}
        </div>
        {data.items.map((it) => (
          <div key={it.id} className="flex flex-wrap items-start gap-2 p-3 text-sm">
            <span className="shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[11px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">{it.qa_id}</span>
            <div className="min-w-0 flex-1">
              <div className="text-slate-800 dark:text-slate-100">{it.question}</div>
              <div className="text-xs text-slate-500">
                {[it.category1, it.category2, it.category3].filter(Boolean).join(' > ')} · {it.review_status || '-'}
                {it.is_referral ? ' · 연결형' : ''}
                {it.change_history && ` · 변경: ${it.change_history}`}
              </div>
            </div>
            {it.needs_recheck ? (
              <span className="flex shrink-0 items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                <AlertTriangle className="h-3 w-3" /> 재검수 필요
              </span>
            ) : null}
            <div className="flex shrink-0 gap-1">
              <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setEditing(it)}>
                <Pencil className="h-3.5 w-3.5" /> 편집
              </button>
              <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setHistory(it.qa_id)} title="수정 이력">
                <History className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="btn-secondary px-2 py-1 text-xs text-red-600" onClick={() => remove(it)} title="삭제">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <QaEditorModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(qa) => {
            setEditing(null);
            setMessage({ kind: 'success', text: `${qa.qa_id}를 저장했습니다. 다음 질문부터 반영됩니다.` });
            load();
          }}
        />
      )}
      {history && <RevisionModal qaId={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = {
  qa_id: '통합번호',
  category1: '대분류',
  category2: '중분류',
  category3: '소분류',
  question: '대표 질의',
  checklist: '요지',
  answer: '통합 답안',
  referral_answer: '연결형 답변',
  review_status: '검수상태',
  change_history: '변경 이력',
  is_referral: '연결형',
};

function RevisionModal({ qaId, onClose }: { qaId: string; onClose: () => void }) {
  const [revs, setRevs] = useState<{ id: number; before_json: string | null; after_json: string | null; reason: string; created_at: string; changed_by: string | null }[]>([]);
  useEffect(() => {
    api<typeof revs>(`/api/review/qa/${encodeURIComponent(qaId)}/revisions`).then(setRevs);
  }, [qaId]);
  return (
    <Modal title={<><History className="h-4 w-4" /> {qaId} 수정 이력</>} onClose={onClose}>
      <div className="max-h-[60vh] space-y-3 overflow-y-auto text-xs">
        {revs.length === 0 && <p className="text-slate-400">화면에서 수정한 이력이 없습니다.</p>}
        {revs.map((r) => {
          const before = r.before_json ? JSON.parse(r.before_json) : null;
          const after = r.after_json ? JSON.parse(r.after_json) : null;
          const changed = Object.keys(FIELD_LABEL).filter((k) => String(before?.[k] ?? '') !== String(after?.[k] ?? ''));
          return (
            <div key={r.id} className="rounded-lg border border-slate-200 p-2 dark:border-slate-700">
              <div className="mb-1 font-semibold text-slate-700 dark:text-slate-200">
                {formatTime(r.created_at)} · {r.changed_by ?? '-'} · {!before ? '추가' : !after ? '삭제' : '수정'} {r.reason && `· ${r.reason}`}
              </div>
              {before && after &&
                changed.map((k) => (
                  <div key={k} className="mt-1">
                    <b>{FIELD_LABEL[k]}</b>
                    <div className="whitespace-pre-wrap text-red-600 line-through">{String(before[k] ?? '')}</div>
                    <div className="whitespace-pre-wrap text-green-700 dark:text-green-400">{String(after[k] ?? '')}</div>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
