export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: ChatTurn[];
  /** 주면 모델이 이 JSON 스키마에 맞는 JSON만 출력하도록 요청한다 */
  jsonSchema?: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmClient {
  provider: string;
  model: string;
  generate(req: LlmRequest): Promise<LlmResult>;
}

/** 사용자에게 그대로 보여줘도 되는 오류 */
export class LlmError extends Error {}
