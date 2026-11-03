import { Bot, Check, Copy, MessageSquareQuote, ThumbsDown, ThumbsUp, User as UserIcon } from 'lucide-react';
import { useState } from 'react';
import { parseCitations, type Citations, type Message } from '../api';
import { Markdown } from './ui';

export interface Feedback {
  rating: 'good' | 'bad';
  reason?: string | null;
  comment?: string;
}

const BAD_REASONS = ['틀린 내용', '답이 부족', '근거가 엉뚱함', '연결이 부적절'];

/** 마크다운 기호를 빼서 메일·공문에 붙여 넣기 좋은 글로 */
function plainText(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1($2)')
    .trim();
}

/** 지역센터가 대학에 회신할 때 그대로 붙여 쓰도록: 본문 + 마무리 안내 + 면책 문구 (근거 카드는 없앰) */
function copyText(body: string, closing: string, disclaimer: string): string {
  const parts = [plainText(body)];
  if (closing) parts.push(closing);
  if (disclaimer) parts.push(disclaimer.trim());
  return parts.join('\n\n');
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 클립보드 권한이 없는 환경: 숨긴 입력칸으로 복사
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 2000);
  }
  return (
    <button type="button" onClick={copy} className="flex items-center gap-1 hover:text-indigo-600 dark:hover:text-indigo-300" title="근거 번호와 면책 문구까지 함께 복사합니다">
      {done ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />} {done ? '복사했습니다' : '답변 복사'}
    </button>
  );
}

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

export function MessageList({
  messages,
  onAskStaff,
  showUsage = false,
  feedback = {},
  onFeedback,
}: {
  messages: Message[];
  onAskStaff?: () => void;
  showUsage?: boolean;
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
          <AssistantMessage key={m.id} m={m} onAskStaff={onAskStaff} showUsage={showUsage} feedback={feedback[m.id]} onFeedback={onFeedback} />
        ),
      )}
    </>
  );
}

function AssistantMessage({
  m,
  onAskStaff,
  showUsage,
  feedback,
  onFeedback,
}: {
  m: Message;
  onAskStaff?: () => void;
  showUsage: boolean;
  feedback?: Feedback;
  onFeedback?: (messageId: number, f: Feedback) => Promise<void>;
}) {
  const c = parseCitations(m);
  // 서버가 본문 뒤에 붙인 면책 문구를 떼어 근거 카드 아래에 보여준다
  const sep = m.content.lastIndexOf(DISCLAIMER_SEPARATOR);
  const body = sep >= 0 ? m.content.slice(0, sep) : m.content;
  const disclaimer = sep >= 0 ? m.content.slice(sep + DISCLAIMER_SEPARATOR.length) : '';
  const closing = c && m.answer_type === '연결형' && !c.security ? closingLine(body, c.referral) : '';
  return (
    <div className="flex justify-start">
      <div className="mr-2 mt-1 hidden h-8 w-8 shrink-0 items-center justify-center rounded-full border border-indigo-200 bg-indigo-100 sm:flex dark:border-indigo-800 dark:bg-indigo-950">
        <Bot className="h-5 w-5 text-indigo-600 dark:text-indigo-300" />
      </div>
      <div className="min-w-0 max-w-[92%] sm:max-w-[80%]">
        <div className="card rounded-tl-sm p-4">
          <Markdown text={body} />
          {closing && <p className="mt-2 text-sm font-semibold text-slate-800 dark:text-slate-100">{closing}</p>}
          {disclaimer && <p className="mt-3 border-t border-slate-200 pt-2 text-[11px] leading-relaxed text-slate-500 dark:border-slate-700 dark:text-slate-400">{disclaimer}</p>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 px-1 text-xs text-slate-400">
          {onFeedback && <FeedbackButtons current={feedback} onSubmit={(f) => onFeedback(m.id, f)} />}
          {!c?.security && <CopyButton text={copyText(body, closing, disclaimer)} />}
          {onAskStaff && !c?.security && (
            <button type="button" onClick={onAskStaff} className="flex items-center gap-1 hover:text-indigo-600 dark:hover:text-indigo-300" title="이 답변으로 해결되지 않으면 대화 기록을 첨부해 재단에 문의합니다">
              <MessageSquareQuote className="h-3.5 w-3.5" /> 재단에 문의하기
            </button>
          )}
          {showUsage && (
            <span>
              {m.provider ? `${m.provider}/${m.model} · 입력 ${m.input_tokens ?? '-'} · 출력 ${m.output_tokens ?? '-'} 토큰 · ` : 'AI 호출 없음 · '}
              {m.latency_ms != null ? `${(m.latency_ms / 1000).toFixed(1)}초` : '-'}
              {c?.retrieved && <RetrievedLine r={c.retrieved} />}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 관리자 대화 열람용: AI에 넘긴 근거를 근거 계층 순서(지침 및 FAQ → 집행원리 → 표준답안)로 보여 준다.
 * '?'는 기준에 조금 못 미쳐 참고로만 넘긴 항목.
 */
function RetrievedLine({ r }: { r: NonNullable<Citations['retrieved']> }) {
  const mark = (relevant: boolean) => (relevant ? '' : '?');
  const parts = [
    ['지침 및 FAQ', r.guideline.map((g) => `${g.clause}${mark(g.relevant)}`)],
    ['집행원리', (r.principle ?? []).map((p) => `${p.code}${mark(p.relevant)}`)],
    ['표준답안', r.qa.map((q) => `${q.qa_id}${mark(q.relevant)}`)],
  ] as const;
  return (
    <span className="block w-full">
      검색({r.mode === 'hybrid' ? '혼합' : '키워드'}) →{' '}
      {parts.map(([label, list], i) => (
        <span key={label}>
          {i > 0 && ' · '}
          <b className="font-semibold">{label}</b> {list.length ? list.join(', ') : '없음'}
        </span>
      ))}
    </span>
  );
}

/** 연결형 답변의 마무리 문장. 연락처나 별도 상자 없이 어디에 문의할지만 한 줄로 알린다 */
const TARGET_GUIDE: Record<string, string> = {
  지역앵커센터: '지역앵커센터에 문의하시기 바랍니다.',
  대학규정: '소속 대학(산학협력단)의 사업비 관리 규정을 확인하시기 바랍니다.',
  e나라도움: 'e나라도움 콜센터에 문의하시기 바랍니다.',
  교육부: '교육부에 문의하시기 바랍니다.',
  담당자: '중앙앵커센터에 문의하시기 바랍니다.',
};
const TARGET_WORD: Record<string, RegExp> = {
  지역앵커센터: /지역\s*(앵커|RISE)\s*센터/,
  대학규정: /대학[^.]{0,20}규정/,
  e나라도움: /e나라도움/,
  교육부: /교육부/,
  담당자: /중앙앵커센터/,
};

/** 본문 끝부분이 이미 같은 곳으로 안내하고 있으면 마무리 문장을 덧붙이지 않는다 */
function closingLine(body: string, referral: string | null): string {
  const target = referral && TARGET_GUIDE[referral] ? referral : '지역앵커센터';
  const tail = body.slice(-120);
  return TARGET_WORD[target].test(tail) && /(문의|확인|협의)/.test(tail) ? '' : TARGET_GUIDE[target];
}

