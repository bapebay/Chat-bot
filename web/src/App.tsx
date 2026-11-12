import { ClipboardList, Inbox, KeyRound, Layers, Loader2, LogOut, MessageSquare, Moon, Settings, Sun, User as UserIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, ROLE_LABELS, type Meta, type User } from './api';
import { PasswordForm } from './components/PasswordForm';
import { Modal, Notice } from './components/ui';
import { AdminView } from './views/AdminView';
import { AuthPage } from './views/AuthPage';
import { ChatView } from './views/ChatView';
import { InquiriesView } from './views/InquiriesView';
import { ReviewView } from './views/ReviewView';

type View = 'chat' | 'inquiries' | 'review' | 'admin';

/** 휴대폰·태블릿 접속인지 (모바일 이용은 막는다: AI 사용량 과다 우려, 점검표 결정) */
function isMobileDevice(): boolean {
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobi/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function useDarkMode() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light');
    } catch {
      /* 저장 실패해도 화면은 정상 동작 */
    }
  }, [dark]);
  return [dark, setDark] as const;
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<View>('chat');
  const [dark, setDark] = useDarkMode();
  const [showPw, setShowPw] = useState(false);
  const [badges, setBadges] = useState({ inquiries: 0, users: 0, review: 0 });

  const refreshMe = useCallback(async () => {
    try {
      const { user } = await api<{ user: User }>('/api/auth/me');
      setUser(user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    Promise.all([api<Meta>('/api/meta').then(setMeta), refreshMe()])
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : '서버에 연결할 수 없습니다.'))
      .finally(() => setLoading(false));
    const onExpired = () => setUser(null);
    window.addEventListener('session-expired', onExpired);
    return () => window.removeEventListener('session-expired', onExpired);
  }, [refreshMe]);

  const refreshBadges = useCallback(async () => {
    if (!user || user.must_change_password) return;
    try {
      if (user.role === 'user') {
        // 사용자: 아직 확인하지 않은 1:1 문의 답변 수
        const { count } = await api<{ count: number }>('/api/inquiries/unread');
        setBadges({ inquiries: count, users: 0, review: 0 });
        return;
      }
      const review = (await api<unknown[]>('/api/review/queue')).length;
      if (user.role === 'admin') {
        const s = await api<{ counts: Record<string, number> }>('/api/admin/system');
        setBadges({ inquiries: s.counts.pending_inquiries, users: s.counts.pending_users, review });
      } else {
        const list = await api<unknown[]>('/api/manage/inquiries?status=pending');
        setBadges({ inquiries: list.length, users: 0, review });
      }
    } catch {
      /* 배지는 실패해도 무시 */
    }
  }, [user]);

  useEffect(() => {
    refreshBadges();
    const t = setInterval(refreshBadges, 60_000);
    return () => clearInterval(t);
  }, [refreshBadges]);

  async function logout() {
    await api('/api/auth/logout', { body: {} }).catch(() => undefined);
    setUser(null);
    setView('chat');
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (!meta) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Notice>{loadError || '서버에 연결할 수 없습니다.'}</Notice>
      </div>
    );
  }
  // 데모 페이지는 휴대폰에서도 둘러볼 수 있게 둔다
  if (!meta.demo && isMobileDevice()) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="card max-w-sm p-6 text-center">
          <Layers className="mx-auto mb-3 h-10 w-10 text-indigo-600 dark:text-indigo-400" />
          <h1 className="text-lg font-bold text-slate-800 dark:text-slate-100">PC에서 이용해 주세요</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">앵커 사업비 챗봇은 PC(컴퓨터) 웹 브라우저에서만 이용할 수 있습니다.</p>
        </div>
      </div>
    );
  }
  if (!user) return <AuthPage meta={meta} onLogin={(u) => { setUser(u); setView('chat'); }} />;

  if (user.must_change_password) {
    return (
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="card w-full max-w-md p-8">
          <h2 className="mb-2 flex items-center gap-2 text-lg font-bold text-slate-800 dark:text-slate-100">
            <KeyRound className="h-5 w-5 text-indigo-500" /> 비밀번호 변경이 필요합니다
          </h2>
          <p className="mb-5 text-sm text-slate-500 dark:text-slate-400">임시 비밀번호로 로그인했습니다. 계속하려면 새 비밀번호를 설정하세요.</p>
          <PasswordForm onDone={refreshMe} />
          <button type="button" onClick={logout} className="mt-4 w-full text-center text-sm text-slate-500 hover:underline">
            로그아웃
          </button>
        </div>
      </div>
    );
  }

  const navButton = (key: View, label: string, Icon: typeof Inbox, badge = 0) => (
    <button
      type="button"
      onClick={() => {
        setView(key);
        refreshBadges();
      }}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${view === key ? 'bg-indigo-600 text-white shadow' : 'text-slate-300 hover:text-white'}`}
    >
      <Icon className="h-4 w-4" />
      <span className="hidden sm:inline">{label}</span>
      {badge > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-pink-500 px-1 text-[10px] text-white">{badge}</span>}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="z-30 flex shrink-0 items-center justify-between gap-2 bg-slate-800 px-3 py-2.5 text-white shadow-md dark:bg-slate-950">
        <div className="flex min-w-0 items-center gap-2">
          <Layers className="h-6 w-6 shrink-0 text-indigo-400" />
          <h1 className="truncate text-base font-bold sm:text-lg">앵커 사업비 챗봇</h1>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          <nav className="flex rounded-lg bg-slate-700 p-1 dark:bg-slate-800">
            {navButton('chat', '챗봇', MessageSquare)}
            {/* 공개 테스트(데모)의 테스터 문의는 저장되지 않아 담당자에게 닿지 않으므로 숨긴다 */}
            {!(meta.demo && user.role === 'user') && navButton('inquiries', user.role === 'user' ? '1:1 문의' : '문의 관리', Inbox, badges.inquiries)}
            {user.role !== 'user' && navButton('review', '검수', ClipboardList, badges.review)}
            {user.role === 'admin' && navButton('admin', '관리', Settings, badges.users)}
          </nav>
          <div className="flex items-center gap-3 text-sm text-slate-300">
            <button type="button" onClick={() => setDark(!dark)} className="hover:text-indigo-300" title={dark ? '라이트 모드' : '다크 모드'}>
              {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            <span className="hidden items-center gap-1 lg:flex" title={`${user.org_name} · ${ROLE_LABELS[user.role]}`}>
              <UserIcon className="h-4 w-4" /> {user.username}
              <span className="rounded bg-slate-700 px-1.5 text-[11px]">{ROLE_LABELS[user.role]}</span>
            </span>
            <button type="button" onClick={() => setShowPw(true)} className="hover:text-indigo-300" title="비밀번호 변경">
              <KeyRound className="h-5 w-5" />
            </button>
            <button type="button" onClick={logout} className="hover:text-red-400" title="로그아웃">
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>
      {(meta.test_mode || meta.demo) && (
        <div className="shrink-0 bg-amber-100 px-3 py-1.5 text-center text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {meta.demo
            ? user.role === 'user'
              ? '테스트 화면입니다. 대화는 저장되지 않으니, 확인이 필요한 답변은 답변 아래 「의견 남기기」로 복사해 안내받은 설문·메일에 보내 주세요.'
              : meta.demo_ai
              ? '데모 페이지: 실제 AI(Claude, 보는 사람의 claude.ai 사용량 사용). 올린 데이터는 자동 저장되며 관리 → 시스템 정보에서 저장 상태를 볼 수 있습니다.'
              : '데모 페이지: 가상 데이터와 테스트 모델로 동작합니다. 새로고침하면 처음 상태로 돌아갑니다.'
            : '테스트 모드: 실제 AI 모델이 연결되지 않아 예시 답변이 표시됩니다. (.env 의 LLM_PROVIDER 설정)'}
        </div>
      )}

      {view === 'chat' && <ChatView user={user} meta={meta} onInquirySent={refreshBadges} />}
      {view === 'inquiries' && <InquiriesView user={user} onChanged={refreshBadges} />}
      {view === 'review' && user.role !== 'user' && <ReviewView />}
      {view === 'admin' && user.role === 'admin' && <AdminView me={user} meta={meta} onUsersChanged={refreshBadges} />}

      {showPw && (
        <Modal title={<><KeyRound className="h-4 w-4" /> 비밀번호 변경</>} onClose={() => setShowPw(false)}>
          <PasswordForm
            onDone={() => {
              setShowPw(false);
              alert('비밀번호를 변경했습니다.');
            }}
          />
        </Modal>
      )}
    </div>
  );
}
