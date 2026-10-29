import Anthropic from '@anthropic-ai/sdk';
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from './types.js';

type Effort = 'low' | 'medium' | 'high';

export function createClaudeClient(
  apiKey: string,
  model: string,
  maxOutputTokens: number,
  effort: string,
): LlmClient {
  // SDK가 429·5xx·네트워크 오류를 지수 백오프로 재시도한다
  const client = new Anthropic({ apiKey, maxRetries: 4, timeout: 120_000 });
  const effortValue: Effort | undefined = ['low', 'medium', 'high'].includes(effort)
    ? (effort as Effort)
    : undefined;

  async function generate(req: LlmRequest): Promise<LlmResult> {
    const response = await client.messages.create({
      model,
      max_tokens: maxOutputTokens,
      // 시스템 프롬프트는 매번 같으므로 캐시해 입력 비용을 줄인다
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: {
        ...(effortValue ? { effort: effortValue } : {}),
        ...(req.jsonSchema ? { format: { type: 'json_schema' as const, schema: req.jsonSchema } } : {}),
      },
    });

    if (response.stop_reason === 'refusal') {
      throw new LlmError('AI 모델이 이 질문에 대한 답변을 거절했습니다. 질문을 바꾸거나 담당자에게 문의해 주세요.');
    }
    const text = response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    if (!text) throw new LlmError('AI 모델이 빈 답변을 돌려주었습니다.');

    const u = response.usage;
    return {
      text,
      provider: 'claude',
      model,
      inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens,
    };
  }

  return { provider: 'claude', model, generate };
}
