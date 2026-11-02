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
  /** 브라우저 안 가짜 서버로 도는 데모 페이지 */
  demo?: boolean;
  /** 데모 페이지에서 실제 AI(claude.ai)가 연결되었는지 */
  demo_ai?: boolean;
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
  answer_type: AnswerType | null;
  /** JSON 문자열 (Citations) */
  citations: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

export type AnswerType = '근거답변' | '연결형' | '답변범위외' | '근거없음';

export interface Citations {
  business_type: string | null;
  referral: string | null;
  qa: {
    qa_id: string;
    category1: string;
    category2: string;
    question: string;
    answer: string;
    referral_answer: string;
    is_referral: boolean;
    review_status: string;
    change_history: string;
  }[];
  guideline: { id: string; doc_name: string; doc_kind: string; clause: string; page: number | null; text: string }[];
  out_of_scope: { question: string; guidance: string; department: string } | null;
  /** 보안 의심으로 막은 경우 그 종류 */
  security?: string;
  retrieved?: {
    mode: 'hybrid' | 'keyword';
    qa: { qa_id: string; keyword: number; semantic: number | null; relevant: boolean }[];
    guideline: { id: string; clause: string; keyword: number; semantic: number | null; relevant: boolean }[];
  };
}

export function parseCitations(m: Message): Citations | null {
  if (!m.citations) return null;
  try {
    return JSON.parse(m.citations) as Citations;
  } catch {
    return null;
  }
}

export interface Usage {
  used: number;
  limit: number;
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
  const isForm = opts.body instanceof FormData;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: opts.body === undefined || isForm ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
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
