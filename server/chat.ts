import { config } from './config.js';
import type { DB } from './db.js';
import { TEMPORARY_KNOWLEDGE } from './defaults.js';
import type { ChatTurn, LlmClient } from './llm/index.js';
import { getSetting } from './settings.js';

export interface MessageRow {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant';
  content: string;
  answer_type: string | null;
  citations: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

export const DISCLAIMER_SEPARATOR = '\n\n---\n\n> ';

/**
 * 시스템 프롬프트는 매 질문 같은 내용이어야 캐시가 된다.
 * 질문마다 바뀌는 사업 유형은 사용자 메시지 쪽에 붙인다.
 */
export function buildSystemPrompt(db: DB): string {
  return `${getSetting(db, 'system_prompt')}\n\n# 참고 자료\n${TEMPORARY_KNOWLEDGE}`;
}

/** 모델에 보낼 최근 대화. 첫 메시지는 항상 사용자 질문이 되도록 자른다 */
export function recentHistory(rows: MessageRow[], limit: number): ChatTurn[] {
  let recent = rows.slice(-limit);
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
  return recent.map((m) => ({ role: m.role, content: stripDisclaimer(m.content) }));
}

export function stripDisclaimer(content: string): string {
  const i = content.lastIndexOf(DISCLAIMER_SEPARATOR);
  return i >= 0 ? content.slice(0, i) : content;
}

export function listMessages(db: DB, conversationId: number): MessageRow[] {
  return db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id')
    .all(conversationId) as MessageRow[];
}

export async function answerQuestion(
  db: DB,
  llm: LlmClient,
  conversationId: number,
  businessType: string,
  question: string,
): Promise<MessageRow> {
  const history = recentHistory(listMessages(db, conversationId), config.llm.historyMessages);
  const turns: ChatTurn[] = [...history, { role: 'user', content: `[선택한 사업 유형: ${businessType}]\n${question}` }];

  const started = Date.now();
  const result = await llm.generate({ system: buildSystemPrompt(db), messages: turns });
  const latency = Date.now() - started;
  const content = `${result.text.trim()}${DISCLAIMER_SEPARATOR}${getSetting(db, 'disclaimer')}`;

  // 질문과 답변을 한 번에 저장한다. 모델 호출이 실패하면 아무것도 남지 않는다.
  return db.transaction(() => {
    db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`).run(conversationId, question);
    const info = db
      .prepare(
        `INSERT INTO messages (conversation_id, role, content, provider, model, input_tokens, output_tokens, latency_ms)
         VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, content, result.provider, result.model, result.inputTokens, result.outputTokens, latency);
    db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conversationId);
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid) as MessageRow;
  })();
}

/** 1:1 문의에 첨부할 대화 기록 텍스트 */
export function formatTranscript(rows: MessageRow[]): string {
  return rows
    .map((m) => `${m.role === 'user' ? '[질문]' : '[챗봇 답변]'} ${m.created_at}\n${stripDisclaimer(m.content)}`)
    .join('\n\n');
}

/** 첫 질문으로 대화 제목을 만든다 */
export function titleFromQuestion(q: string): string {
  const oneLine = q.replace(/\s+/g, ' ').trim();
  return oneLine.length > 30 ? `${oneLine.slice(0, 30)}…` : oneLine || '새로운 대화';
}
