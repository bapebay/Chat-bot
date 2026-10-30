import { Layers } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, ApiError, type Meta, type User } from '../api';
import { Notice, Select } from '../components/ui';

export function AuthPage({ meta, onLogin }: { meta: Meta; onLogin: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [notice, setNotice] = useState('');

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="card w-full max-w-md p-8">
        <div className="mb-6 text-center">
          <Layers className="mx-auto mb-3 h-12 w-12 text-indigo-600 dark:text-indigo-400" />
          <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">앵커 사업비 챗봇</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">사업비 집행 및 관리 지침 안내</p>
        </div>
        {notice && (
          <div className="mb-4">
            <Notice kind="success">{notice}</Notice>
          </div>
        )}
        {meta.demo && mode === 'login' && <DemoLogin onLogin={onLogin} />}
        {mode === 'login' ? (
          <LoginForm onLogin={onLogin} />
        ) : (
          <SignupForm
            meta={meta}
            onDone={(msg) => {
              setNotice(msg);
              setMode('login');
            }}
          />
        )}
        <div className="mt-6 text-center text-sm">
          <button
            type="button"
            className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
            onClick={() => {
              setNotice('');
              setMode(mode === 'login' ? 'signup' : 'login');
            }}
          >
            {mode === 'login' ? '계정이 없으신가요? 가입 신청' : '로그인으로 돌아가기'}
          </button>
        </div>
      </div>
    </div>
  );
}

function LoginForm({ onLogin }: { onLogin: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { user } = await api<{ user: User }>('/api/auth/login', { body: { username, password } });
      onLogin(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '로그인에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label">아이디</label>
        <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" />
      </div>
      <div>
        <label className="label">비밀번호</label>
        <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
      </div>
      <Notice>{error}</Notice>
      <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
        {busy ? '로그인 중…' : '로그인'}
      </button>
      <p className="text-center text-xs text-slate-500 dark:text-slate-400">비밀번호를 잊으셨다면 관리자에게 초기화를 요청하세요.</p>
    </form>
  );
}

function SignupForm({ meta, onDone }: { meta: Meta; onDone: (msg: string) => void }) {
  const [f, setF] = useState({ username: '', password: '', confirm: '', org_type: '', org_name: '', region: '', business_type: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (f.password !== f.confirm) return setError('비밀번호가 서로 일치하지 않습니다.');
    setBusy(true);
    try {
      const { confirm: _c, ...body } = f;
      const res = await api<{ message: string }>('/api/auth/signup', { body });
      onDone(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '가입 신청에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Notice kind="info">이름·연락처 등 개인정보는 받지 않습니다. 소속 정보만 입력해 주세요.</Notice>
      <div>
        <label className="label">아이디 (영문·숫자 4~30자)</label>
        <input className="input" value={f.username} onChange={(e) => set('username')(e.target.value)} required autoComplete="username" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">비밀번호</label>
          <input type="password" className="input" value={f.password} onChange={(e) => set('password')(e.target.value)} required minLength={8} autoComplete="new-password" />
        </div>
        <div>
          <label className="label">비밀번호 확인</label>
          <input type="password" className="input" value={f.confirm} onChange={(e) => set('confirm')(e.target.value)} required autoComplete="new-password" />
        </div>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">비밀번호는 8자 이상, 영문과 숫자를 포함해야 합니다.</p>
      <div className="grid grid-cols-2 gap-3">
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
        <input className="input" value={f.org_name} onChange={(e) => set('org_name')(e.target.value)} required placeholder="예: ○○대학교 산학협력단" />
      </div>
      <div>
        <label className="label">주로 문의할 사업 유형</label>
        <Select value={f.business_type} onChange={set('business_type')} options={meta.business_types} placeholder="선택" />
      </div>
      <Notice>{error}</Notice>
      <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
        {busy ? '신청 중…' : '가입 신청'}
      </button>
    </form>
  );
}

/** 데모 페이지: 역할별로 바로 로그인 */
function DemoLogin({ onLogin }: { onLogin: (u: User) => void }) {
  const roles = [
    { username: 'user', label: '사용자', desc: '대학 담당자로 질문하기' },
    { username: 'reviewer', label: '검수자', desc: '검토 대기함·표준답안 고치기' },
    { username: 'admin', label: '관리자', desc: '데이터·평가·통계 둘러보기' },
  ];
  return (
    <div className="mb-6 space-y-2 rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900 dark:bg-indigo-950/40">
      <p className="text-sm font-bold text-indigo-900 dark:text-indigo-200">데모 페이지 · 가상 데이터와 테스트 모델로 동작합니다</p>
      <p className="text-xs text-indigo-800 dark:text-indigo-300">역할을 골라 바로 들어가 보세요. 새로고침하면 처음 상태로 돌아갑니다.</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {roles.map((r) => (
          <button
            key={r.username}
            type="button"
            className="rounded-lg border border-indigo-200 bg-white p-2.5 text-left hover:border-indigo-400 dark:border-indigo-800 dark:bg-slate-900"
            onClick={async () => {
              const { user } = await api<{ user: User }>('/api/auth/login', { body: { username: r.username, password: 'demo1234' } });
              onLogin(user);
            }}
          >
            <span className="block text-sm font-bold text-slate-800 dark:text-slate-100">{r.label}</span>
            <span className="block text-[11px] text-slate-500 dark:text-slate-400">{r.desc}</span>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-indigo-700 dark:text-indigo-300">직접 입력할 때: 아이디 user / reviewer / admin, 비밀번호 demo1234</p>
    </div>
  );
}
