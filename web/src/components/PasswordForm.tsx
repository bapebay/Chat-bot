import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Notice } from './ui';

/** 비밀번호 변경 폼. 일반 변경과 초기화 후 강제 변경에서 함께 쓴다 */
export function PasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (next !== confirm) return setError('새 비밀번호가 서로 일치하지 않습니다.');
    setBusy(true);
    try {
      await api('/api/auth/change-password', { body: { current_password: current, new_password: next } });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '변경에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label">현재(임시) 비밀번호</label>
        <input type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
      </div>
      <div>
        <label className="label">새 비밀번호 (8자 이상, 영문+숫자)</label>
        <input type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" />
      </div>
      <div>
        <label className="label">새 비밀번호 확인</label>
        <input type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
      </div>
      <Notice>{error}</Notice>
      <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
        {busy ? '변경 중…' : '비밀번호 변경'}
      </button>
    </form>
  );
}
