import 'dotenv/config';

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 0을 허용하는 정수 (0 = 끄기) */
function intOrZero(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** 쉼표로 구분한 목록 */
function list(name: string): string[] {
  return (process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** 앞단 웹서버(프록시) 신뢰 설정: 비우면 끔, true, 거칠 프록시 수(숫자), 또는 프록시 IP·대역 목록 */
export type TrustProxy = boolean | string | ((addr: string, hop: number) => boolean);

function trustProxy(): TrustProxy {
  const v = (process.env.TRUST_PROXY || '').trim();
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_addr: string, hop: number) => hop < hops;
  }
  return v;
}

export type LlmProvider = 'gemini' | 'claude' | 'openai' | 'mock';

function provider(): LlmProvider {
  const p = (process.env.LLM_PROVIDER || 'mock').toLowerCase();
  if (p === 'gemini' || p === 'claude' || p === 'openai' || p === 'mock') return p;
  throw new Error(`LLM_PROVIDER 값이 올바르지 않습니다: ${p} (gemini | claude | openai | mock)`);
}

export const config = {
  port: int('PORT', 3000),
  isProduction: process.env.NODE_ENV === 'production',
  databasePath: process.env.DATABASE_PATH || './data/chatbot.db',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD || '',
  sessionHours: int('SESSION_HOURS', 8),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  security: {
    trustProxy: trustProxy(),
    rateLimit: process.env.RATE_LIMIT !== 'off',
    /** 관리자 메뉴를 쓸 수 있는 IP·대역 (비우면 제한 없음) */
    staffAllowedIps: list('ADMIN_ALLOWED_IPS'),
  },
  backup: {
    dir: process.env.BACKUP_DIR || './backups',
    /** 자동 백업 간격(시간, 0 = 끄기) */
    intervalHours: intOrZero('BACKUP_INTERVAL_HOURS', 24),
    keep: int('BACKUP_KEEP', 14),
  },
  llm: {
    provider: provider(),
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    claudeModel: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
    claudeEffort: process.env.CLAUDE_EFFORT || '',
    // OpenAI 호환 방식: OpenAI, 국내 클라우드 AI, 기관 내부 설치 모델(vLLM·Ollama 등)
    openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || '',
    openaiJsonMode: process.env.OPENAI_JSON_MODE || 'json_object',
    maxOutputTokens: int('LLM_MAX_OUTPUT_TOKENS', 4096),
    historyMessages: int('LLM_HISTORY_MESSAGES', 6),
  },
};
