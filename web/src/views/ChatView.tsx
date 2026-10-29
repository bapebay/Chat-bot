import { AlertCircle, Bot, Loader2, PlusCircle, Search, Send, Sidebar, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, ApiError, formatTime, type Conversation, type Message, type Meta, type User } from '../api';
import { InquiryModal } from '../components/InquiryModal';
import { MessageList } from '../components/MessageList';
import { Notice, Select } from '../components/ui';

export function ChatView({ user, meta, onInquirySent }: { user: User; meta: Meta; onInquirySent: () => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newBusinessType, setNewBusinessType] = useState(user.business_type);
  const [input, setInput] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState('');
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [inquiryFor, setInquiryFor] = useState<{ conversationId: number | null; text: string } | null>(null);
  const [inquiryDone, setInquiryDone] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async (q = '') => {
    try {
      setConversations(await api<Conversation[]>(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`));
    } catch {
      /* 목록 오류는 무시하고 기존 목록 유지 */
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => loadList(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search, loadList]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingQuestion]);

  async function openConversation(c: Conversation) {
    setError('');
    const res = await api<{ conversation: Conversation; messages: Message[] }>(`/api/conversations/${c.id}`);
    setCurrent(res.conversation);
    setMessages(res.messages);
    if (window.innerWidth < 768) setSidebarOpen(false);
  }

  function startNew() {
    setCurrent(null);
    setMessages([]);
    setError('');
    setNewBusinessType(user.business_type);
  }

  async function removeConversation(c: Conversation) {
    if (!confirm(`'${c.title}' 대화를 삭제할까요?`)) return;
    await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
    if (current?.id === c.id) startNew();
    loadList(search.trim());
  }

  async function changeBusinessType(v: string) {
    if (!current) return setNewBusinessType(v);
    const updated = await api<Conversation>(`/api/conversations/${current.id}`, { method: 'PATCH', body: { business_type: v } });
    setCurrent(updated);
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const question = input.trim();
    if (!question || pendingQuestion) return;
    setError('');
    setPendingQuestion(question);
    setInput('');
    let conv = current;
    try {
      if (!conv) {
        conv = await api<Conversation>('/api/conversations', { body: { business_type: newBusinessType } });
        setCurrent(conv);
      }
      const res = await api<{ conversation: Conversation; messages: Message[] }>(`/api/conversations/${conv.id}/messages`, {
        body: { content: question },
      });
      setCurrent(res.conversation);
      setMessages(res.messages);
      loadList(search.trim());
    } catch (err) {
      setInput(question);
      setError(err instanceof ApiError ? err.message : '답변을 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setPendingQuestion('');
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const businessType = current ? current.business_type : newBusinessType;

  return (
    <div className="relative flex flex-1 overflow-hidden">
      {/* 대화 목록 */}
      <aside
        className={`${sidebarOpen ? 'w-72' : 'w-0'} absolute inset-y-0 left-0 z-20 flex shrink-0 flex-col overflow-hidden bg-slate-900 text-white transition-all duration-300 md:static`}
      >
        <div className="space-y-2 border-b border-slate-700 p-3">
          <button type="button" onClick={startNew} className="btn w-full bg-indigo-600 text-white hover:bg-indigo-500">
            <PlusCircle className="h-4 w-4" /> 새 대화
          </button>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="대화 검색"
              className="w-full rounded-lg bg-slate-800 py-2 pl-8 pr-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center rounded-lg ${current?.id === c.id ? 'bg-indigo-600' : 'hover:bg-slate-800'}`}
            >
              <button type="button" onClick={() => openConversation(c)} className="min-w-0 flex-1 px-3 py-2 text-left">
                <div className={`truncate text-sm ${current?.id === c.id ? 'font-semibold text-white' : 'text-slate-300'}`}>{c.title}</div>
                <div className="text-[11px] text-slate-400">
                  {c.business_type} · {formatTime(c.updated_at)}
                </div>
              </button>
              <button
                type="button"
                onClick={() => removeConversation(c)}
                className="mr-1 p-1.5 text-slate-400 opacity-0 hover:text-red-400 group-hover:opacity-100"
                title="삭제"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <p className="mt-6 text-center text-xs text-slate-500">{search ? '검색 결과가 없습니다.' : '이전 대화가 없습니다.'}</p>
          )}
        </div>
      </aside>
      {sidebarOpen && <div className="absolute inset-0 z-10 bg-black/30 md:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* 대화 화면 */}
      <section className="flex min-w-0 flex-1 flex-col bg-slate-50 dark:bg-slate-900">
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
          <button type="button" onClick={() => setSidebarOpen(!sidebarOpen)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700" title="대화 목록">
            <Sidebar className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700 dark:text-slate-200">{current?.title ?? '새 대화'}</div>
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="hidden sm:inline">사업 유형</span>
            <Select
              value={businessType}
              onChange={changeBusinessType}
              options={meta.business_types}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
        </div>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
            {messages.length === 0 && !pendingQuestion && (
              <div className="card mt-6 p-6 text-center">
                <Bot className="mx-auto mb-3 h-10 w-10 text-indigo-500" />
                <h2 className="mb-2 text-lg font-bold text-slate-800 dark:text-slate-100">무엇을 도와드릴까요?</h2>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  앵커 사업비 집행 및 관리 지침, FAQ, 재단 기존 답변을 근거로 안내합니다.
                  <br />
                  위에서 <b>사업 유형</b>을 확인한 뒤 질문해 주세요.
                </p>
                <p className="mt-3 text-xs text-slate-400">
                  법령 해석, 개별 집행 건의 인정 여부, 성과관리는 답변 범위가 아닙니다. 이름·연락처 등 개인정보는 입력하지 마세요.
                </p>
              </div>
            )}
            <MessageList messages={messages} onAskStaff={() => setInquiryFor({ conversationId: current?.id ?? null, text: '' })} />
            {pendingQuestion && (
              <>
                <div className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-indigo-600 p-3.5 text-sm text-white opacity-80 sm:max-w-[75%]">
                    {pendingQuestion}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> 지침을 확인하며 답변을 작성하고 있습니다…
                </div>
              </>
            )}
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertCircle className="h-4 w-4" /> {error}
                </div>
                <div className="mt-3 flex gap-2">
                  <button type="button" className="btn-secondary" onClick={() => send()}>
                    다시 시도
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setInquiryFor({ conversationId: current?.id ?? null, text: input })}>
                    담당자에게 문의
                  </button>
                </div>
              </div>
            )}
            {inquiryDone && <Notice kind="success">문의가 등록되었습니다. 답변은 상단 ‘1:1 문의’ 메뉴에서 확인할 수 있습니다.</Notice>}
            <div ref={endRef} />
          </div>
        </main>

        <form onSubmit={send} className="border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
          <div className="mx-auto flex max-w-4xl items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              maxLength={3000}
              placeholder="질문을 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)"
              className="input flex-1 resize-none"
              disabled={!!pendingQuestion}
            />
            <button type="submit" className="btn-primary h-[60px] w-14 shrink-0" disabled={!input.trim() || !!pendingQuestion} title="보내기">
              <Send className="h-5 w-5" />
            </button>
          </div>
        </form>
      </section>

      {inquiryFor && (
        <InquiryModal
          conversationId={inquiryFor.conversationId}
          initialText={inquiryFor.text}
          onClose={() => setInquiryFor(null)}
          onSent={() => {
            setInquiryFor(null);
            setInquiryDone(true);
            setTimeout(() => setInquiryDone(false), 6000);
            onInquirySent();
          }}
        />
      )}
    </div>
  );
}
