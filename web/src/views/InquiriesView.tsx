import { CheckSquare, CornerDownRight, Inbox, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, formatTime, type Inquiry, type User } from '../api';
import { InquiryModal } from '../components/InquiryModal';
import { Notice } from '../components/ui';

type Tab = 'mine' | 'pending' | 'answered' | 'all';

export function InquiriesView({ user, onChanged }: { user: User; onChanged: () => void }) {
  const canManage = user.role !== 'user';
  const [tab, setTab] = useState<Tab>(canManage ? 'pending' : 'mine');
  const [items, setItems] = useState<Inquiry[]>([]);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const url = tab === 'mine' ? '/api/inquiries' : `/api/manage/inquiries${tab === 'all' ? '' : `?status=${tab}`}`;
      setItems(await api<Inquiry[]>(url));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '목록을 불러오지 못했습니다.');
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  const tabs: { key: Tab; label: string }[] = canManage
    ? [
        { key: 'pending', label: '답변 대기' },
        { key: 'answered', label: '답변 완료' },
        { key: 'all', label: '전체' },
        { key: 'mine', label: '내 문의' },
      ]
    : [{ key: 'mine', label: '내 문의' }];

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900">
      <div className="mx-auto max-w-4xl space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800 dark:text-slate-100">
            <Inbox className="h-5 w-5 text-indigo-500" /> 1:1 문의함
          </h2>
          <button type="button" className="btn-primary" onClick={() => setWriting(true)}>
            <Plus className="h-4 w-4" /> 새 문의
          </button>
        </div>
        {tabs.length > 1 && (
          <div className="flex gap-1 rounded-lg bg-slate-200 p-1 dark:bg-slate-800">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${tab === t.key ? 'bg-white text-indigo-700 shadow dark:bg-slate-700 dark:text-white' : 'text-slate-600 dark:text-slate-300'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <Notice>{error}</Notice>
        {items.length === 0 && !error && <p className="py-10 text-center text-sm text-slate-400">문의가 없습니다.</p>}
        {items.map((i) => (
          <InquiryCard key={i.id} item={i} canAnswer={canManage && tab !== 'mine'} onAnswered={() => { load(); onChanged(); }} />
        ))}
      </div>
      {writing && (
        <InquiryModal
          conversationId={null}
          onClose={() => setWriting(false)}
          onSent={() => {
            setWriting(false);
            setTab('mine');
            load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function InquiryCard({ item, canAnswer, onAnswered }: { item: Inquiry; canAnswer: boolean; onAnswered: () => void }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [answer, setAnswer] = useState(item.answer ?? '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/manage/inquiries/${item.id}/answer`, { body: { answer } });
      setEditing(false);
      onAnswered();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '저장에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span
          className={`rounded-full px-2 py-0.5 font-semibold ${item.status === 'answered' ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'}`}
        >
          {item.status === 'answered' ? '답변 완료' : '답변 대기'}
        </span>
        <span>
          {item.username} · {item.org_name} ({item.region})
        </span>
        <span>{formatTime(item.created_at)}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">{item.content}</p>
      {item.attached_transcript && (
        <div className="mt-2">
          <button type="button" className="text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setShowTranscript(!showTranscript)}>
            {showTranscript ? '첨부된 대화 접기' : '첨부된 대화 보기'}
          </button>
          {showTranscript && (
            <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-100 p-3 font-sans text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-300">
              {item.attached_transcript}
            </pre>
          )}
        </div>
      )}
      {item.answer && !editing && (
        <div className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50 p-3 dark:border-indigo-900 dark:bg-indigo-950">
          <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
            <CornerDownRight className="h-3.5 w-3.5" /> 답변 ({item.answered_by_name ?? '-'} · {formatTime(item.answered_at)})
          </div>
          <p className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">{item.answer}</p>
        </div>
      )}
      {canAnswer && (editing || !item.answer) && (
        <div className="mt-3 space-y-2">
          <textarea className="input h-28 resize-none" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="답변을 입력하세요" />
          <Notice>{error}</Notice>
          <div className="flex justify-end gap-2">
            {editing && (
              <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>
                취소
              </button>
            )}
            <button type="button" className="btn-primary" onClick={submit} disabled={busy || !answer.trim()}>
              <CheckSquare className="h-4 w-4" /> 답변 등록
            </button>
          </div>
        </div>
      )}
      {canAnswer && item.answer && !editing && (
        <div className="mt-2 text-right">
          <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => setEditing(true)}>
            답변 수정
          </button>
        </div>
      )}
    </div>
  );
}
