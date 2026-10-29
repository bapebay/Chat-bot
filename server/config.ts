import 'dotenv/config';

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export type LlmProvider = 'gemini' | 'claude' | 'mock';

function provider(): LlmProvider {
  const p = (process.env.LLM_PROVIDER || 'mock').toLowerCase();
  if (p === 'gemini' || p === 'claude' || p === 'mock') return p;
  throw new Error(`LLM_PROVIDER 값이 올바르지 않습니다: ${p} (gemini | claude | mock)`);
}

export const config = {
  port: int('PORT', 3000),
  isProduction: process.env.NODE_ENV === 'production',
  databasePath: process.env.DATABASE_PATH || './data/chatbot.db',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD || '',
  sessionHours: int('SESSION_HOURS', 8),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  llm: {
    provider: provider(),
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    claudeModel: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
    claudeEffort: process.env.CLAUDE_EFFORT || '',
    maxOutputTokens: int('LLM_MAX_OUTPUT_TOKENS', 4096),
    historyMessages: int('LLM_HISTORY_MESSAGES', 6),
  },
};
