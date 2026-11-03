import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from './types.js';

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function isRetryable(status: number) {
  return status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * OpenAI 호환 방식(/chat/completions). OpenAI뿐 아니라 국내 클라우드 AI,
 * 기관 안에 설치한 모델(vLLM·Ollama 등)도 이 방식으로 연결한다.
 * jsonMode: json_schema(지원하는 곳만) | json_object(대부분 지원) | none(프롬프트로만 요청)
 */
export function createOpenAiClient(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  jsonMode: string;
}): LlmClient {
  const url = `${opts.baseUrl}/chat/completions`;

  function responseFormat(req: LlmRequest) {
    if (!req.jsonSchema || opts.jsonMode === 'none') return {};
    if (opts.jsonMode === 'json_schema') {
      return { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: req.jsonSchema } } };
    }
    return { response_format: { type: 'json_object' } };
  }

  async function generate(req: LlmRequest): Promise<LlmResult> {
    const body = JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxOutputTokens,
      messages: [{ role: 'system', content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
      ...responseFormat(req),
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

    // 지수 백오프 재시도 (1s, 2s, 4s, 8s)
    let lastError = '';
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        lastError = `네트워크 오류: ${(e as Error).message}`;
        if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (res.ok) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string | null; refusal?: string | null } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const msg = data.choices?.[0]?.message;
        if (msg?.refusal) {
          throw new LlmError('AI 모델이 이 질문에 대한 답변을 거절했습니다. 질문을 바꾸거나 답변 아래 ‘재단에 문의하기’를 이용해 주세요.');
        }
        const text = msg?.content ?? '';
        if (!text) throw new LlmError('AI 모델이 빈 답변을 돌려주었습니다.');
        return {
          text,
          provider: 'openai',
          model: opts.model,
          inputTokens: data.usage?.prompt_tokens ?? null,
          outputTokens: data.usage?.completion_tokens ?? null,
        };
      }
      lastError = `AI 응답 오류 (상태 코드 ${res.status}): ${(await res.text()).slice(0, 300)}`;
      if (!isRetryable(res.status)) break;
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
    }
    throw new Error(lastError);
  }

  return { provider: 'openai', model: opts.model, generate };
}
