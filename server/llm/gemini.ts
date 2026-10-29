import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from './types.js';

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function isRetryable(status: number) {
  return status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createGeminiClient(apiKey: string, model: string, maxOutputTokens: number): LlmClient {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  async function generate(req: LlmRequest): Promise<LlmResult> {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens },
    });

    // 지수 백오프 재시도 (1s, 2s, 4s, 8s)
    let lastError = '';
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body,
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e) {
        lastError = `네트워크 오류: ${(e as Error).message}`;
        if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };
        const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
        if (!text) throw new LlmError('AI 모델이 빈 답변을 돌려주었습니다.');
        return {
          text,
          provider: 'gemini',
          model,
          inputTokens: data.usageMetadata?.promptTokenCount ?? null,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
        };
      }
      lastError = `Gemini 응답 오류 (상태 코드 ${res.status}): ${(await res.text()).slice(0, 300)}`;
      if (!isRetryable(res.status)) break;
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
    }
    throw new Error(lastError);
  }

  return { provider: 'gemini', model, generate };
}
