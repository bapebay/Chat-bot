import { Bot, MessageSquareQuote, User as UserIcon } from 'lucide-react';
import type { Message } from '../api';
import { Markdown } from './ui';

export function MessageList({
  messages,
  onAskStaff,
  showUsage = false,
}: {
  messages: Message[];
  onAskStaff?: () => void;
  showUsage?: boolean;
}) {
  return (
    <>
      {messages.map((m) =>
        m.role === 'user' ? (
          <div key={m.id} className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-indigo-600 p-3.5 text-sm text-white shadow-sm sm:max-w-[75%] sm:text-[15px]">
              {m.content}
            </div>
            <div className="ml-2 mt-1 hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 sm:flex dark:bg-slate-700">
              <UserIcon className="h-5 w-5 text-slate-600 dark:text-slate-300" />
            </div>
          </div>
        ) : (
          <div key={m.id} className="flex justify-start">
            <div className="mr-2 mt-1 hidden h-8 w-8 shrink-0 items-center justify-center rounded-full border border-indigo-200 bg-indigo-100 sm:flex dark:border-indigo-800 dark:bg-indigo-950">
              <Bot className="h-5 w-5 text-indigo-600 dark:text-indigo-300" />
            </div>
            <div className="max-w-[92%] sm:max-w-[80%]">
              <div className="card rounded-tl-sm p-4">
                <Markdown text={m.content} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 px-1 text-xs text-slate-400">
                {onAskStaff && (
                  <button type="button" onClick={onAskStaff} className="flex items-center gap-1 hover:text-indigo-600 dark:hover:text-indigo-300">
                    <MessageSquareQuote className="h-3.5 w-3.5" /> 담당자에게 문의
                  </button>
                )}
                {showUsage && (
                  <span>
                    {m.provider}/{m.model} · 입력 {m.input_tokens ?? '-'} · 출력 {m.output_tokens ?? '-'} 토큰 ·{' '}
                    {m.latency_ms != null ? `${(m.latency_ms / 1000).toFixed(1)}초` : '-'}
                  </span>
                )}
              </div>
            </div>
          </div>
        ),
      )}
    </>
  );
}
