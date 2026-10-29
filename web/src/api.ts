export type Role = 'user' | 'reviewer' | 'admin';

export interface User {
  id: number;
  username: string;
  org_type: string;
  org_name: string;
  region: string;
  business_type: string;
  role: Role;
  status: 'pending' | 'approved';
  locked: boolean;
  failed_attempts: number;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface Meta {
  org_types: string[];
  regions: string[];
  business_types: string[];
  test_mode: boolean;
}

export interface Conversation {
  id: number;
  user_id: number;
  title: string;
  business_type: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant';
  content: string;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

export interface Inquiry {
  id: number;
  user_id: number;
  username: string;
  org_name: string;
  region: string;
  conversation_id: number | null;
  attached_transcript: string | null;
  content: string;
  answer: string | null;
  answered_by_name: string | null;
  status: 'pending' | 'answered';
  created_at: string;
  answered_at: string | null;
}

export interface SettingRevision {
  id: number;
  value: string;
  created_at: string;
  changed_by: string | null;
}

export const ROLE_LABELS: Record<Role, string> = { user: '사용자', reviewer: '검수자', admin: '관리자' };

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

/** 서버 API 호출. 실패하면 서버가 준 한국어 메시지로 ApiError를 던진다 */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(data.error || `요청에 실패했습니다 (${res.status})`, res.status, data.code);
  }
  return data as T;
}

/** SQLite의 UTC 시각 문자열을 한국 시간으로 표시 */
export function formatTime(utc: string | null): string {
  if (!utc) return '-';
  const d = new Date(utc.replace(' ', 'T') + 'Z');
  return d.toLocaleString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
