import { BarChart3, ClipboardCheck, Database, Eye, FileSignature, History, Info, KeyRound, Lock, Megaphone, ScrollText, Share2, Trash2, UserCheck, UserPlus, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  formatTime,
  ROLE_LABELS,
  type Conversation,
  type Message,
  type Meta,
  type Role,
  type SettingRevision,
  type User,
} from '../api';
import { MessageList } from '../components/MessageList';
import { Modal, Notice, Select } from '../components/ui';
import { EvalTab } from './EvalTab';
import { KnowledgeTab } from './KnowledgeTab';
import { AnswersBrowser, AuditTab, NoticeTab, StatsTab } from './OpsTabs';
import { ReferralTab } from './ReferralTab';

type Tab = 'stats' | 'users' | 'knowledge' | 'referrals' | 'eval' | 'conversations' | 'answers' | 'prompt' | 'notices' | 'audit' | 'system';

export function AdminView({ me, meta, onUsersChanged }: { me: User; meta: Meta; onUsersChanged: () => void }) {
  const [tab, setTab] = useState<Tab>('stats');
  const [viewUser, setViewUser] = useState<User | null>(null);
  const tabs: { key: Tab; label: string; icon: typeof Users }[] = [
    { key: 'stats', label: '사용량·비용', icon: BarChart3 },
    { key: 'users', label: '사용자·권한', icon: Users },
    { key: 'knowledge', label: '지식 데이터', icon: Database },
    { key: 'referrals', label: '연결 연락처', icon: Share2 },
    { key: 'eval', label: '평가', icon: ClipboardCheck },
    { key: 'conversations', label: '대화 열람', icon: Eye },
    { key: 'answers', label: '답변 모아보기', icon: ClipboardCheck },
    { key: 'prompt', label: '프롬프트·면책 문구', icon: FileSignature },
    { key: 'notices', label: '공지', icon: Megaphone },
    { key: 'audit', label: '감사 로그', icon: ScrollText },
    { key: 'system', label: '시스템 정보', icon: Info },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-slate-50 dark:bg-slate-900">
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 pt-2 dark:border-slate-700 dark:bg-slate-800">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${tab === t.key ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto">
        {tab === 'users' && (
          <UsersTab
            me={me}
            meta={meta}
            onChanged={onUsersChanged}
            onViewConversations={(u) => {
              setViewUser(u);
              setTab('conversations');
            }}
          />
        )}
        {tab === 'knowledge' && <KnowledgeTab meta={meta} />}
        {tab === 'referrals' && <ReferralTab meta={meta} />}
        {tab === 'eval' && <EvalTab />}
        {tab === 'stats' && <StatsTab />}
        {tab === 'answers' && <AnswersBrowser />}
        {tab === 'notices' && <NoticeTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'conversations' && <ConversationsTab initialUser={viewUser} />}
        {tab === 'prompt' && <PromptTab />}
        {tab === 'system' && <SystemTab />}
      </div>
    </div>
  );
}

// ================= 사용자·권한 =================

function UsersTab({
  me,
  meta,
  onChanged,
  onViewConversations,
}: {
  me: User;
  meta: Meta;
  onChanged: () => void;
  onViewConversations: (u: User) => void;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setUsers(await api<User[]>('/api/admin/users'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<unknown>, success: string) {
    setMessage(null);
    try {
      await action();
      setMessage({ kind: 'success', text: success });
      await load();
      onChanged();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : '처리에 실패했습니다.' });
    }
  }

  async function resetPassword(u: User) {
    if (!confirm(`'${u.username}'의 비밀번호를 초기화할까요? 임시 비밀번호가 발급됩니다.`)) return;
    try {
      const res = await api<{ temp_password: string }>(`/api/admin/users/${u.id}/reset-password`, { body: {} });
      setTempPassword({ username: u.username, password: res.temp_password });
      load();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : '초기화에 실패했습니다.' });
    }
  }

  const pending = users.filter((u) => u.status === 'pending');
  const q = filter.trim();
  const approved = users.filter(
    (u) => u.status === 'approved' && (!q || u.username.includes(q) || u.org_name.includes(q) || u.region.includes(q)),
  );

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      {pending.length > 0 && (
        <section className="card border-amber-300 p-4 dark:border-amber-800">
          <h3 className="mb-3 flex items-center gap-2 font-bold text-amber-800 dark:text-amber-300">
            <UserCheck className="h-5 w-5" /> 가입 승인 대기 ({pending.length})
          </h3>
          <div className="space-y-2">
            {pending.map((u) => (
              <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
                <div className="text-slate-700 dark:text-slate-200">
                  <b>{u.username}</b> · {u.org_type} · {u.org_name} · {u.region} · {u.business_type}
                  <span className="ml-2 text-xs text-slate-400">{formatTime(u.created_at)}</span>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn-primary" onClick={() => run(() => api(`/api/admin/users/${u.id}/approve`, { body: {} }), `'${u.username}' 가입을 승인했습니다.`)}>
                    승인
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => confirm(`'${u.username}' 가입 신청을 거절(삭제)할까요?`) && run(() => api(`/api/admin/users/${u.id}`, { method: 'DELETE' }), '가입 신청을 거절했습니다.')}
                  >
                    거절
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4 dark:border-slate-700">
          <h3 className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-100">
            <Users className="h-5 w-5 text-indigo-500" /> 사용자 ({approved.length})
          </h3>
          <div className="flex gap-2">
            <input className="input w-48" placeholder="아이디·기관·지역 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button type="button" className="btn-primary shrink-0" onClick={() => setCreating(true)}>
              <UserPlus className="h-4 w-4" /> 계정 생성
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">아이디</th>
                <th className="px-3 py-2">소속</th>
                <th className="px-3 py-2">지역</th>
                <th className="px-3 py-2">사업 유형</th>
                <th className="px-3 py-2">권한</th>
                <th className="px-3 py-2">최근 로그인</th>
                <th className="px-3 py-2 text-right">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {approved.map((u) => (
                <tr key={u.id} className="text-slate-700 dark:text-slate-200">
                  <td className="px-3 py-2 font-semibold">
                    {u.username}
                    {u.locked && (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700 dark:bg-red-950 dark:text-red-300">
                        <Lock className="h-3 w-3" /> 잠김
                      </span>
                    )}
                    {u.must_change_password && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-300">비번 변경 필요</span>}
                  </td>
                  <td className="px-3 py-2">
                    {u.org_type} · {u.org_name}
                  </td>
                  <td className="px-3 py-2">{u.region}</td>
                  <td className="px-3 py-2">{u.business_type}</td>
                  <td className="px-3 py-2">
                    <select
                      value={u.role}
                      disabled={u.id === me.id}
                      onChange={(e) => run(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }), `'${u.username}'의 권한을 바꿨습니다.`)}
                      className="rounded border border-slate-300 bg-white px-1.5 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
                    >
                      {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{formatTime(u.last_login_at)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      {u.locked && (
                        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => run(() => api(`/api/admin/users/${u.id}/unlock`, { body: {} }), `'${u.username}' 잠금을 해제했습니다.`)}>
                          잠금 해제
                        </button>
                      )}
                      <button type="button" className="btn-secondary px-2 py-1 text-xs" title="대화 열람" onClick={() => onViewConversations(u)}>
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" className="btn-secondary px-2 py-1 text-xs" title="비밀번호 초기화" onClick={() => resetPassword(u)}>
                        <KeyRound className="h-3.5 w-3.5" />
                      </button>
                      {u.id !== me.id && (
                        <button
                          type="button"
                          className="btn-secondary px-2 py-1 text-xs text-red-600"
                          title="삭제"
                          onClick={() => confirm(`'${u.username}' 계정과 대화 기록을 모두 삭제할까요?`) && run(() => api(`/api/admin/users/${u.id}`, { method: 'DELETE' }), '계정을 삭제했습니다.')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-200 p-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
          권한: <b>사용자</b>(질문) · <b>검수자</b>(1:1 문의 답변, 이후 단계에서 표준답안 검수) · <b>관리자</b>(전체)
        </p>
      </section>

      {creating && (
        <CreateUserModal
          meta={meta}
          onClose={() => setCreating(false)}
          onCreated={(username, password) => {
            setCreating(false);
            setTempPassword({ username, password });
            load();
          }}
        />
      )}
      {tempPassword && (
        <Modal title={<><KeyRound className="h-4 w-4" /> 임시 비밀번호 발급</>} onClose={() => setTempPassword(null)}>
          <p className="text-sm text-slate-700 dark:text-slate-200">
            <b>{tempPassword.username}</b> 계정의 임시 비밀번호입니다. 이 창을 닫으면 다시 볼 수 없으니 사용자에게 안전하게 전달하세요. 첫 로그인 때 비밀번호를 바꾸게 됩니다.
          </p>
          <div className="mt-4 select-all rounded-lg bg-slate-100 p-3 text-center font-mono text-lg font-bold tracking-wider text-slate-800 dark:bg-slate-900 dark:text-slate-100">
            {tempPassword.password}
          </div>
        </Modal>
      )}
    </div>
  );
}

function CreateUserModal({ meta, onClose, onCreated }: { meta: Meta; onClose: () => void; onCreated: (u: string, p: string) => void }) {
  const [f, setF] = useState({ username: '', role: 'user', org_type: '', org_name: '', region: '', business_type: '모름' });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const res = await api<{ temp_password: string }>('/api/admin/users', { body: f });
      onCreated(f.username, res.temp_password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '생성에 실패했습니다.');
    }
  }

  return (
    <Modal title={<><UserPlus className="h-4 w-4" /> 계정 직접 생성</>} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">아이디</label>
            <input className="input" value={f.username} onChange={(e) => set('username')(e.target.value)} required />
          </div>
          <div>
            <label className="label">권한</label>
            <select className="input" value={f.role} onChange={(e) => set('role')(e.target.value)}>
              {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">소속 구분</label>
            <Select value={f.org_type} onChange={set('org_type')} options={meta.org_types} placeholder="선택" />
          </div>
          <div>
            <label className="label">지역</label>
            <Select value={f.region} onChange={set('region')} options={meta.regions} placeholder="선택" />
          </div>
        </div>
        <div>
          <label className="label">기관명</label>
          <input className="input" value={f.org_name} onChange={(e) => set('org_name')(e.target.value)} required />
        </div>
        <div>
          <label className="label">기본 사업 유형</label>
          <Select value={f.business_type} onChange={set('business_type')} options={meta.business_types} />
        </div>
        <Notice>{error}</Notice>
        <button type="submit" className="btn-primary w-full py-2.5">
          생성 (임시 비밀번호 발급)
        </button>
      </form>
    </Modal>
  );
}

// ================= 대화 열람 (읽기 전용) =================

function ConversationsTab({ initialUser }: { initialUser: User | null }) {
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState<number | null>(initialUser?.id ?? null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<{ conversation: Conversation; messages: Message[] } | null>(null);

  useEffect(() => {
    api<User[]>('/api/admin/users').then((list) => setUsers(list.filter((u) => u.status === 'approved')));
  }, []);

  useEffect(() => {
    setSelected(null);
    if (!userId) return setConversations([]);
    api<Conversation[]>(`/api/admin/users/${userId}/conversations`).then(setConversations);
  }, [userId]);

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-3 p-4 md:flex-row">
      <div className="card flex shrink-0 flex-col md:w-72">
        <div className="border-b border-slate-200 p-3 dark:border-slate-700">
          <label className="label">사용자 선택</label>
          <select className="input" value={userId ?? ''} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">선택하세요</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username} ({u.org_name})
              </option>
            ))}
          </select>
        </div>
        <div className="max-h-72 flex-1 space-y-1 overflow-y-auto p-2 md:max-h-none">
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => api<{ conversation: Conversation; messages: Message[] }>(`/api/admin/conversations/${c.id}`).then(setSelected)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selected?.conversation.id === c.id ? 'bg-indigo-600 text-white' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700'}`}
            >
              <div className="truncate font-medium">{c.title}</div>
              <div className={`text-[11px] ${selected?.conversation.id === c.id ? 'text-indigo-100' : 'text-slate-400'}`}>
                {c.business_type} · 메시지 {c.message_count} · {formatTime(c.updated_at)}
              </div>
            </button>
          ))}
          {userId && conversations.length === 0 && <p className="py-6 text-center text-xs text-slate-400">대화가 없습니다.</p>}
        </div>
      </div>
      <div className="card flex min-h-[300px] flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-slate-200 bg-indigo-50 p-3 text-sm font-semibold text-indigo-700 dark:border-slate-700 dark:bg-indigo-950 dark:text-indigo-300">
          <Eye className="h-4 w-4" /> 읽기 전용 열람{selected ? ` · ${selected.conversation.title} (${selected.conversation.business_type})` : ''}
        </div>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          {selected ? (
            <MessageList messages={selected.messages} showUsage />
          ) : (
            <p className="m-auto text-sm text-slate-400">왼쪽에서 사용자와 대화를 선택하세요.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ================= 프롬프트·면책 문구 =================

function PromptTab() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4">
      <SettingEditor
        settingKey="system_prompt"
        title="시스템 프롬프트 (답변 원칙)"
        help="매 질문마다 AI 모델에 전달되는 기본 지시문입니다. 저장하면 다음 질문부터 바로 적용되며, 이전 버전으로 되돌릴 수 있습니다."
        rows={22}
      />
      <SettingEditor
        settingKey="disclaimer"
        title="고정 면책 문구"
        help="모든 답변 끝에 자동으로 붙는 문구입니다."
        rows={3}
      />
    </div>
  );
}

export function SettingEditor({
  settingKey,
  title,
  help,
  rows,
  initialDraft,
  allowEmpty = false,
}: {
  settingKey: string;
  title: string;
  help: string;
  rows: number;
  /** 파일에서 불러온 내용처럼, 저장 전 편집기에 미리 채워 둘 값 */
  initialDraft?: string;
  allowEmpty?: boolean;
}) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [revisions, setRevisions] = useState<SettingRevision[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const apply = (res: { value: string; revisions: SettingRevision[] }) => {
    setValue(res.value);
    setSaved(res.value);
    setRevisions(res.revisions);
  };

  useEffect(() => {
    api<{ value: string; revisions: SettingRevision[] }>(`/api/admin/settings/${settingKey}`).then((res) => {
      apply(res);
      if (initialDraft !== undefined) setValue(initialDraft);
    });
  }, [settingKey, initialDraft]);

  async function save() {
    try {
      apply(await api(`/api/admin/settings/${settingKey}`, { method: 'PUT', body: { value } }));
      setMessage({ kind: 'success', text: '저장했습니다. 다음 질문부터 적용됩니다.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : '저장에 실패했습니다.' });
    }
  }

  async function revert(rev: SettingRevision) {
    if (!confirm(`${formatTime(rev.created_at)} 버전으로 되돌릴까요?`)) return;
    try {
      apply(await api(`/api/admin/settings/${settingKey}/revert`, { body: { revision_id: rev.id } }));
      setMessage({ kind: 'success', text: '선택한 버전으로 되돌렸습니다.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : '되돌리기에 실패했습니다.' });
    }
  }

  return (
    <section className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold text-slate-800 dark:text-slate-100">{title}</h3>
        <button type="button" className="btn-secondary text-xs" onClick={() => setShowHistory(!showHistory)}>
          <History className="h-4 w-4" /> 변경 이력 ({revisions.length})
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{help}</p>
      <textarea className="input font-mono text-[13px]" rows={rows} value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex-1">{message && <Notice kind={message.kind}>{message.text}</Notice>}</div>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" disabled={value === saved} onClick={() => setValue(saved)}>
            취소
          </button>
          <button type="button" className="btn-primary" disabled={value === saved || (!allowEmpty && !value.trim())} onClick={save}>
            저장
          </button>
        </div>
      </div>
      {showHistory && (
        <div className="mt-4 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
          {revisions.length === 0 && <p className="text-xs text-slate-400">아직 변경 이력이 없습니다. (현재 기본값 사용 중)</p>}
          {revisions.map((r, i) => (
            <details key={r.id} className="rounded-lg border border-slate-200 p-2 text-sm dark:border-slate-700">
              <summary className="flex cursor-pointer items-center justify-between gap-2 text-slate-700 dark:text-slate-200">
                <span>
                  {formatTime(r.created_at)} · {r.changed_by ?? '-'} {i === 0 && <b className="text-indigo-600 dark:text-indigo-400">(현재)</b>}
                </span>
                {i !== 0 && (
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={(e) => { e.preventDefault(); revert(r); }}>
                    이 버전으로 되돌리기
                  </button>
                )}
              </summary>
              <pre className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-slate-600 dark:text-slate-300">{r.value}</pre>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

// ================= 시스템 정보 =================

type BackupInfo = { interval_hours: number; keep: number; count: number; latest: { name: string; size: number; created_at: string } | null };

/** DB 백업 현황과 외부 공개용 보안 설정 상태 */
function BackupSecurity({ backup, security }: { backup: BackupInfo; security: { rate_limit: boolean; staff_ip_limited: boolean; https_cookie: boolean } }) {
  const [latest, setLatest] = useState(backup.latest);
  const [count, setCount] = useState(backup.count);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const onOff = (on: boolean, yes: string, no: string) => (
    <span className={on ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>{on ? yes : no}</span>
  );
  return (
    <section className="card p-4">
      <h3 className="mb-3 font-bold text-slate-800 dark:text-slate-100">백업·보안</h3>
      <dl className="grid grid-cols-2 gap-2 text-sm text-slate-700 sm:grid-cols-3 dark:text-slate-200">
        <dt className="text-slate-500">자동 백업</dt>
        <dd className="sm:col-span-2">{backup.interval_hours ? `${backup.interval_hours}시간마다, 최근 ${backup.keep}개 보관` : onOff(false, '', '꺼짐 (BACKUP_INTERVAL_HOURS=0)')}</dd>
        <dt className="text-slate-500">마지막 백업</dt>
        <dd className="sm:col-span-2">
          {latest ? `${new Date(latest.created_at).toLocaleString('ko-KR')} · ${(latest.size / 1024 / 1024).toFixed(1)}MB · 보관 ${count}개` : '아직 없음'}
        </dd>
        <dt className="text-slate-500">요청 횟수 제한</dt>
        <dd className="sm:col-span-2">{onOff(security.rate_limit, '켜짐', '꺼짐 (외부 공개 시 켜야 합니다)')}</dd>
        <dt className="text-slate-500">관리 메뉴 접근</dt>
        <dd className="sm:col-span-2">{onOff(security.staff_ip_limited, '허용한 IP에서만', '어디서나 (ADMIN_ALLOWED_IPS 로 제한 가능)')}</dd>
        <dt className="text-slate-500">HTTPS 전용 쿠키</dt>
        <dd className="sm:col-span-2">{onOff(security.https_cookie, '켜짐', '꺼짐 (HTTPS 적용 후 COOKIE_SECURE=true)')}</dd>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg('');
            try {
              const r = await api<{ latest: BackupInfo['latest'] }>('/api/admin/backup', { body: {} });
              setLatest(r.latest);
              setCount((c) => Math.min(c + 1, backup.keep));
              setMsg('백업을 만들었습니다.');
            } catch (e) {
              setMsg(e instanceof Error ? e.message : '백업하지 못했습니다.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '백업 중…' : '지금 백업'}
        </button>
        <span className="text-xs text-slate-500 dark:text-slate-400">{msg || '서버 이전·업데이트 전에 한 번 눌러 두세요. 백업 파일은 서버의 백업 폴더에 저장됩니다.'}</span>
      </div>
    </section>
  );
}

function SystemTab() {
  const [info, setInfo] = useState<{
    llm: { provider: string; model: string; history_messages: number; demo_tiers?: Record<string, string>; demo_tier?: string };
    counts: Record<string, number>;
    backup?: BackupInfo;
    security?: { rate_limit: boolean; staff_ip_limited: boolean; https_cookie: boolean };
  } | null>(null);

  useEffect(() => {
    api<typeof info>('/api/admin/system').then(setInfo);
  }, []);

  if (!info) return null;
  const labels: Record<string, string> = {
    users: '전체 계정',
    pending_users: '승인 대기',
    conversations: '대화',
    questions: '누적 질문',
    pending_inquiries: '답변 대기 문의',
  };
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <section className="card p-4">
        <h3 className="mb-3 font-bold text-slate-800 dark:text-slate-100">AI 모델</h3>
        <dl className="grid grid-cols-2 gap-2 text-sm text-slate-700 sm:grid-cols-3 dark:text-slate-200">
          <dt className="text-slate-500">제공사</dt>
          <dd className="sm:col-span-2">{info.llm.provider === 'mock' ? '테스트 모드 (실제 AI 미연결)' : info.llm.provider}</dd>
          <dt className="text-slate-500">모델</dt>
          <dd className="sm:col-span-2">{info.llm.model}</dd>
          <dt className="text-slate-500">함께 보내는 최근 대화</dt>
          <dd className="sm:col-span-2">{info.llm.history_messages}개 메시지</dd>
        </dl>
        {info.llm.demo_tiers ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-600 dark:text-slate-300">데모 AI 등급</span>
            <select
              className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
              value={info.llm.demo_tier}
              onChange={async (e) => {
                await api('/api/admin/settings/demo_model_tier', { method: 'PUT', body: { value: e.target.value } });
                setInfo(await api('/api/admin/system'));
              }}
            >
              {Object.entries(info.llm.demo_tiers).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <span className="text-xs text-slate-500 dark:text-slate-400">실서비스 기본값은 경량 모델이라 ‘빠름’과 비슷합니다.</span>
          </div>
        ) : (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">모델과 API 키는 보안을 위해 서버의 .env 파일에서만 바꿀 수 있습니다. 바꾼 뒤 서버를 다시 시작하세요.</p>
        )}
      </section>
      {info.llm.demo_tiers !== undefined || info.llm.provider === 'demo' ? <DemoStorage /> : null}
      {info.backup && info.security && <BackupSecurity backup={info.backup} security={info.security} />}
      <LimitSettings />
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Object.entries(info.counts).map(([k, v]) => (
          <div key={k} className="card p-4 text-center">
            <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{v.toLocaleString()}</div>
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{labels[k] ?? k}</div>
          </div>
        ))}
      </section>
    </div>
  );
}

function LimitSettings() {
  const keys = [
    { key: 'daily_limit_user', label: '사용자 1명당 하루 질문 수' },
    { key: 'daily_limit_total', label: '전체 하루 질문 수' },
    { key: 'retention_days', label: '대화 보관 기간(일, 0 = 삭제 안 함)' },
  ];
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    Promise.all(keys.map((k) => api<{ value: string }>(`/api/admin/settings/${k.key}`).then((r) => [k.key, r.value] as const))).then((pairs) => {
      const v = Object.fromEntries(pairs);
      setValues(v);
      setSaved(v);
    });
  }, []);

  async function save(key: string) {
    setMessage(null);
    try {
      await api(`/api/admin/settings/${key}`, { method: 'PUT', body: { value: values[key] } });
      setSaved((p) => ({ ...p, [key]: values[key] }));
      setMessage({ kind: 'success', text: '저장했습니다.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : '저장에 실패했습니다.' });
    }
  }

  return (
    <section className="card space-y-3 p-4">
      <h3 className="font-bold text-slate-800 dark:text-slate-100">질문 상한·대화 보관 기간</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {keys.map((k) => (
          <div key={k.key}>
            <label className="label">{k.label}</label>
            <div className="flex gap-2">
              <input className="input" value={values[k.key] ?? ''} onChange={(e) => setValues((p) => ({ ...p, [k.key]: e.target.value }))} />
              <button type="button" className="btn-secondary shrink-0" disabled={values[k.key] === saved[k.key]} onClick={() => save(k.key)}>
                저장
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">질문 상한은 한국 시간 0시에 초기화되며 0이면 제한하지 않습니다 (AI를 부르지 않은 질문도 포함). 보관 기간이 지난 대화는 서버가 6시간마다 자동 삭제합니다 (1:1 문의에 첨부된 대화 사본은 남음).</p>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
    </section>
  );
}

/** 데모 페이지 전용: 저장 상태와 초기화 */
function DemoStorage() {
  const [st, setSt] = useState<{ mode: string; savedAt: string | null; message: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    const load = () => api<typeof st>('/api/demo/storage').then(setSt).catch(() => undefined);
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  if (!st) return null;
  return (
    <section className="card space-y-2 p-4 text-sm">
      <h3 className="font-bold text-slate-800 dark:text-slate-100">데모 데이터 저장</h3>
      <p className={st.mode === 'error' || st.mode === 'readonly' ? 'text-amber-700 dark:text-amber-300' : 'text-slate-600 dark:text-slate-300'}>{st.message}</p>
      {st.mode !== 'off' &&
        (confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-red-600">올린 표준답안·지침·대화·평가 결과를 모두 지우고 처음 상태로 돌아갑니다.</span>
            <button type="button" className="btn-danger px-2.5 py-1 text-xs" onClick={() => api('/api/demo/storage/reset', { body: {} })}>
              지우기
            </button>
            <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setConfirming(false)}>
              취소
            </button>
          </div>
        ) : (
          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setConfirming(true)}>
            저장된 데이터 지우고 처음 상태로
          </button>
        ))}
    </section>
  );
}
