import { BookOpen, Bot, ChevronDown, FileText, MessageSquareQuote, User as UserIcon } from 'lucide-react';
import { useState } from 'react';
import { parseCitations, type AnswerType, type Citations, type Message } from '../api';
import { Markdown } from './ui';

const DISCLAIMER_SEPARATOR = '\n\n---\n\n> ';

const ANSWER_TYPE_STYLE: Record<AnswerType, { label: string; cls: string }> = {
  근거답변: { label: '근거 답변', cls: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300' },
  연결형: { label: '확인 필요(연결)', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  답변범위외: { label: '답변 범위 아님', cls: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200' },
  근거없음: { label: '근거 없음', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
};

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
          <AssistantMessage key={m.id} m={m} onAskStaff={onAskStaff} showUsage={showUsage} />
        ),
      )}
    </>
  );
}

function AssistantMessage({ m, onAskStaff, showUsage }: { m: Message; onAskStaff?: () => void; showUsage: boolean }) {
  const c = parseCitations(m);
  const type = m.answer_type ? ANSWER_TYPE_STYLE[m.answer_type] : null;
  // 서버가 본문 뒤에 붙인 면책 문구를 떼어 근거 카드 아래에 보여준다
  const sep = m.content.lastIndexOf(DISCLAIMER_SEPARATOR);
  const body = sep >= 0 ? m.content.slice(0, sep) : m.content;
  const disclaimer = sep >= 0 ? m.content.slice(sep + DISCLAIMER_SEPARATOR.length) : '';
  return (
    <div className="flex justify-start">
      <div className="mr-2 mt-1 hidden h-8 w-8 shrink-0 items-center justify-center rounded-full border border-indigo-200 bg-indigo-100 sm:flex dark:border-indigo-800 dark:bg-indigo-950">
        <Bot className="h-5 w-5 text-indigo-600 dark:text-indigo-300" />
      </div>
      <div className="min-w-0 max-w-[92%] sm:max-w-[80%]">
        <div className="card rounded-tl-sm p-4">
          {type && <span className={`mb-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${type.cls}`}>{type.label}</span>}
          <Markdown text={body} />
          {c && <Evidence c={c} />}
          {disclaimer && <p className="mt-3 border-t border-slate-200 pt-2 text-[11px] leading-relaxed text-slate-500 dark:border-slate-700 dark:text-slate-400">{disclaimer}</p>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 px-1 text-xs text-slate-400">
          {onAskStaff && (
            <button type="button" onClick={onAskStaff} className="flex items-center gap-1 hover:text-indigo-600 dark:hover:text-indigo-300">
              <MessageSquareQuote className="h-3.5 w-3.5" /> 담당자에게 문의
            </button>
          )}
          {showUsage && (
            <span>
              {m.provider ? `${m.provider}/${m.model} · 입력 ${m.input_tokens ?? '-'} · 출력 ${m.output_tokens ?? '-'} 토큰 · ` : 'AI 호출 없음 · '}
              {m.latency_ms != null ? `${(m.latency_ms / 1000).toFixed(1)}초` : '-'}
              {c?.retrieved && ` · 검색(${c.retrieved.mode === 'hybrid' ? '혼합' : '키워드'}): ${c.retrieved.qa.map((q) => `${q.qa_id}${q.relevant ? '' : '?'}`).join(', ') || '없음'}`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Evidence({ c }: { c: Citations }) {
  const count = c.qa.length + c.guideline.length;
  if (!count) return null;
  return (
    <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-700">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-500 dark:text-slate-400">
        <BookOpen className="h-3.5 w-3.5" /> 참고한 근거 ({count})
      </div>
      <div className="space-y-2">
        {c.qa.map((q) => (
          <EvidenceCard
            key={q.qa_id}
            icon={<MessageSquareQuote className="h-4 w-4 shrink-0 text-indigo-500" />}
            title={
              <>
                <span className="mr-1.5 rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[11px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                  {q.qa_id}
                </span>
                {q.question}
              </>
            }
            meta={[q.category1, q.category2, q.is_referral ? '연결형' : ''].filter(Boolean).join(' · ')}
          >
            <p className="whitespace-pre-wrap">{q.answer}</p>
            {q.referral_answer && <p className="mt-2 whitespace-pre-wrap text-amber-700 dark:text-amber-300">연결형 답변: {q.referral_answer}</p>}
            {q.change_history && <p className="mt-2 text-slate-500">답변 변경 이력: {q.change_history}</p>}
          </EvidenceCard>
        ))}
        {c.guideline.map((g) => (
          <EvidenceCard
            key={g.id}
            icon={<FileText className="h-4 w-4 shrink-0 text-emerald-600" />}
            title={g.clause}
            meta={[g.doc_kind, g.doc_name, g.page ? `${g.page}쪽` : ''].filter(Boolean).join(' · ')}
          >
            <p className="whitespace-pre-wrap">{g.text}</p>
          </EvidenceCard>
        ))}
      </div>
    </div>
  );
}

function EvidenceCard({ icon, title, meta, children }: { icon: React.ReactNode; title: React.ReactNode; meta: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 p-2.5 text-left">
        <span className="mt-0.5">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-slate-800 dark:text-slate-100">{title}</span>
          {meta && <span className="block text-[11px] text-slate-500 dark:text-slate-400">{meta}</span>}
        </span>
        <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="border-t border-slate-200 p-3 text-xs leading-relaxed text-slate-700 dark:border-slate-700 dark:text-slate-300">{children}</div>}
    </div>
  );
}
