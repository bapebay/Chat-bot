import { config } from '../config.js';
import { createClaudeClient } from './claude.js';
import { createGeminiClient } from './gemini.js';
import type { LlmClient, LlmRequest } from './types.js';

export * from './types.js';

/**
 * API 키 없이 화면 동작을 확인하기 위한 가짜 모델.
 * 근거 자료에 들어 있는 첫 표준답안·지침 조항을 인용한 것처럼 답한다.
 */
function createMockClient(): LlmClient {
  return {
    provider: 'mock',
    model: 'mock',
    async generate(req: LlmRequest) {
      const last = req.messages[req.messages.length - 1]?.content ?? '';
      const question = (last.split('[질문]\n')[1] ?? last).trim();
      const qaIds = [...last.matchAll(/\[표준답안 통합번호: ([^\]|]+?)(?: \||\])/g)].map((m) => m[1].trim()).slice(0, 2);
      const guide = [...last.matchAll(/\[지침 (G\d+) \| ([^|\]]*)(?:\| [^|\]]*)?\| 쪽: ([^\]]*)\]/g)].slice(0, 1);
      await new Promise((r) => setTimeout(r, 400));
      const body = [
        `**질의 요약**: ${question.slice(0, 80)}`,
        '',
        '**답변 요약**: (테스트 모드) 실제 AI 모델이 연결되지 않아 예시 답변을 보여드립니다.',
        '',
        '**상세 안내**',
        `- 검색된 근거: 표준답안 ${qaIds.length}건, 지침 조항 ${guide.length}건`,
        '- `.env` 파일의 `LLM_PROVIDER`를 `gemini` 또는 `claude`로 바꾸고 API 키를 넣으면 실제 답변이 나옵니다.',
      ].join('\n');
      const text = req.jsonSchema
        ? JSON.stringify({
            answer_type: '근거답변',
            business_type: '공통',
            answer_markdown: body,
            cited_qa_ids: qaIds,
            cited_guideline: guide.map((g) => ({ id: g[1], clause: g[2].trim(), page: g[3].trim() })),
            referral: '없음',
          })
        : body;
      return {
        text,
        provider: 'mock',
        model: 'mock',
        inputTokens: Math.ceil((req.system.length + last.length) / 2),
        outputTokens: Math.ceil(text.length / 2),
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
