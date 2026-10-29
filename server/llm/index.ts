import { config } from '../config.js';
import { createClaudeClient } from './claude.js';
import { createGeminiClient } from './gemini.js';
import type { LlmClient, LlmRequest } from './types.js';

export * from './types.js';

/** API 키 없이 화면 동작을 확인하기 위한 가짜 모델 */
function createMockClient(): LlmClient {
  return {
    provider: 'mock',
    model: 'mock',
    async generate(req: LlmRequest) {
      const question = (req.messages[req.messages.length - 1]?.content ?? '').replace(/^\[선택한 사업 유형: [^\]]*\]\n/, '');
      await new Promise((r) => setTimeout(r, 600));
      return {
        text: [
          '**질의 요약**: ' + question.slice(0, 80),
          '',
          '**답변 요약**: (테스트 모드) 실제 AI 모델이 연결되지 않아 예시 답변을 보여드립니다.',
          '',
          '**상세 안내**',
          '- `.env` 파일의 `LLM_PROVIDER`를 `gemini` 또는 `claude`로 바꾸고 API 키를 넣으면 실제 답변이 나옵니다.',
          '',
          '**유의사항**: 테스트 모드에서는 토큰 비용이 발생하지 않습니다.',
        ].join('\n'),
        provider: 'mock',
        model: 'mock',
        inputTokens: Math.ceil((req.system.length + question.length) / 2),
        outputTokens: 100,
      };
    },
  };
}

export function createLlmClient(): LlmClient {
  const c = config.llm;
  if (c.provider === 'gemini') {
    if (!c.geminiApiKey) throw new Error('LLM_PROVIDER=gemini 인데 GEMINI_API_KEY 가 비어 있습니다.');
    return createGeminiClient(c.geminiApiKey, c.geminiModel, c.maxOutputTokens);
  }
  if (c.provider === 'claude') {
    if (!c.anthropicApiKey) throw new Error('LLM_PROVIDER=claude 인데 ANTHROPIC_API_KEY 가 비어 있습니다.');
    return createClaudeClient(c.anthropicApiKey, c.claudeModel, c.maxOutputTokens, c.claudeEffort);
  }
  return createMockClient();
}
