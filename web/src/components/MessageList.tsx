import { BookOpen, Bot, ChevronDown, FileText, MessageSquareQuote, Phone, Share2, ThumbsDown, ThumbsUp, User as UserIcon } from 'lucide-react';
import { useState } from 'react';
import { parseCitations, type AnswerType, type Citations, type Message, type ReferralContact } from '../api';
import { Markdown } from './ui';

export interface Feedback {
  rating: 'good' | 'bad';
  reason?: string | null;
  comment?: string;
}

const BAD_REASONS = ['틀린 내용', '답이 부족', '근거가 엉뚱함', '연결이 부적절'];

/** 답변 평가: 좋아요 / 아쉬워요(사유 + 의견) */
function FeedbackButtons({ current, onSubmit }: { current?: Feedback; onSubmit: (f: Feedback) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(current?.reason ?? '');
  const [comment, setComment] = useState(current?.comment ?? '');
  const [sent, setSent] = useState(false);
  const active = current?.rating;
  return (
    <span className="relative flex items-center gap-1">
      <button
        type="button"
        title="도움이 됐어요"
        onClick={() => onSubmit({ rating: 'good' }).then(() => setOpen(false))}
        className={`rounded p-1 hover:text-green-600 ${active === 'good' ? 'text-green-600' : ''}`}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title="아쉬워요"
        onClick={() => setOpen(!open)}
        className={`rounded p-1 hover:text-red-500 ${active === 'bad' ? 'text-red-500' : ''}`}
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
      {sent && <span className="text-green-600">평가 감사합니다</span>}
      {open && (
        <span className="card absolute left-0 top-7 z-10 block w-72 space-y-2 p-3 text-xs text-slate-700 shadow-lg dark:text-slate-200">
          <span className="block font-semibold">어떤 점이 아쉬웠나요?</span>
          <span className="flex flex-wrap gap-1">
            {BAD_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={`rounded-full border px-2 py-0.5 ${reason === r ? 'border-red-500 bg-red-500 text-white' : 'border-slate-300 dark:border-slate-600'}`}
              >
                {r}
              </button>
            ))}
          </span>
          <textarea
            className="input h-16 resize-none text-xs"
            placeholder="의견 (선택, 개인정보는 적지 마세요)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <span className="flex justify-end gap-1">
            <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setOpen(false)}>
              취소
            </button>
            <button
              type="button"
              className="btn-primary px-2 py-1 text-xs"
              disabled={!reason}
              onClick={() =>
                onSubmit({ rating: 'bad', reason, comment }).then(() => {
                  setOpen(false);
                  setSent(true);
                })
              }
            >
              보내기
            </button>
          </span>
        </span>
      )}
    </span>
  );
}

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
  contacts = [],
  feedback = {},
  onFeedback,
}: {
  messages: Message[];
  onAskStaff?: () => void;
  showUsage?: boolean;
  /** 이 사용자에게 보여줄 연결 대상 연락처 (내 지역 앵커센터 등) */
  contacts?: ReferralContact[];
  /** 답변 id → 내가 남긴 평가 */
  feedback?: Record<number, Feedback>;
  onFeedback?: (messageId: number, f: Feedback) => Promise<void>;
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
          <AssistantMessage key={m.id} m={m} onAskStaff={onAskStaff} showUsage={showUsage} contacts={contacts} feedback={feedback[m.id]} onFeedback={onFeedback} />
        ),
      )}
    </>
  );
}

function AssistantMessage({
  m,
  onAskStaff,
  showUsage,
  contacts,
  feedback,
  onFeedback,
}: {
  m: Message;
  onAskStaff?: () => void;
  showUsage: boolean;
  contacts: ReferralContact[];
  feedback?: Feedback;
  onFeedback?: (messageId: number, f: Feedback) => Promise<void>;
}) {
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
          {c && m.answer_type && m.answer_type !== '근거답변' && (
            <ReferralBox type={m.answer_type} c={c} contacts={contacts} onAskStaff={onAskStaff} />
          )}
          {disclaimer && <p className="mt-3 border-t border-slate-200 pt-2 text-[11px] leading-relaxed text-slate-500 dark:border-slate-700 dark:text-slate-400">{disclaimer}</p>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 px-1 text-xs text-slate-400">
          {onFeedback && <FeedbackButtons current={feedback} onSubmit={(f) => onFeedback(m.id, f)} />}
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

const TARGET_LABEL: Record<string, string> = {
  지역앵커센터: '지역앵커센터',
  대학규정: '소속 대학의 사업비 관리 규정',
  e나라도움: 'e나라도움 콜센터',
  교육부: '교육부',
  담당자: '중앙앵커센터 담당자',
};

function ContactLine({ c }: { c: ReferralContact }) {
  const isUrl = /^https?:\/\//.test(c.contact);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-semibold">{c.name}</span>
      {c.contact &&
        (isUrl ? (
          <a href={c.contact} target="_blank" rel="noreferrer" className="break-all text-indigo-600 underline dark:text-indigo-400">
            {c.contact}
          </a>
        ) : (
          <span className="flex items-center gap-1">
            <Phone className="h-3 w-3" /> {c.contact}
          </span>
        ))}
      {c.note && <span className="text-slate-500 dark:text-slate-400">{c.note}</span>}
    </li>
  );
}

/** 연결형·범위 외·근거 없음 답변 아래: 어디에 확인하면 되는지와 담당자 문의 버튼 */
function ReferralBox({
  type,
  c,
  contacts,
  onAskStaff,
}: {
  type: AnswerType;
  c: Citations;
  contacts: ReferralContact[];
  onAskStaff?: () => void;
}) {
  const target = c.referral ?? (type === '연결형' ? '지역앵커센터' : '담당자');
  const shown = contacts.filter((x) => x.target === target);
  const heading =
    type === '연결형'
      ? `확인이 필요한 사항입니다. ${TARGET_LABEL[target] ?? target}에 확인해 주세요.`
      : type === '답변범위외'
        ? '사업비 지침 챗봇의 답변 범위가 아닙니다.'
        : '근거를 찾지 못해 담당자 확인이 필요합니다.';
  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-slate-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-slate-200">
      <div className="mb-1.5 flex items-center gap-1.5 font-bold text-amber-800 dark:text-amber-300">
        <Share2 className="h-3.5 w-3.5" /> {heading}
      </div>
      {type === '답변범위외' && c.out_of_scope?.department && (
        <p className="mb-1">
          담당 부서: <b>{c.out_of_scope.department}</b>
        </p>
      )}
      {shown.length > 0 && <ul className="space-y-1">{shown.map((x) => <ContactLine key={x.id} c={x} />)}</ul>}
      {target === '대학규정' && shown.length === 0 && <p>소속 대학(산학협력단)의 사업비 관리 규정을 확인해 주세요.</p>}
      {onAskStaff && (
        <button type="button" onClick={onAskStaff} className="btn-primary mt-2.5 px-3 py-1.5 text-xs">
          <MessageSquareQuote className="h-3.5 w-3.5" /> 담당자에게 문의 (대화 자동 첨부)
        </button>
      )}
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
