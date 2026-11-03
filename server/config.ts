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

/**
 * 앞단 웹서버(프록시) 신뢰: 같은 서버나 내부망(사설 IP)에 있는 웹서버만 믿고 실제 접속자 IP를 읽는다.
 * 설정 없이 동작하도록 고정 (점검표 결정). 외부에서 보낸 X-Forwarded-For 는 믿지 않는다.
 */
export const TRUST_PROXY = 'loopback, linklocal, uniquelocal';

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
    rateLimit: process.env.RATE_LIMIT !== 'off',
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
