import { Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Modal, Notice } from './ui';

/** 1:1 문의 작성. conversationId가 있으면 그 대화 기록을 자동 첨부한다 */
export function InquiryModal({
  conversationId,
  initialText = '',
  onClose,
  onSent,
}: {
  conversationId: number | null;
  initialText?: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [content, setContent] = useState(initialText);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/inquiries', { body: { content, conversation_id: conversationId } });
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '문의 등록에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="담당자에게 문의" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {conversationId && <Notice kind="info">현재 대화 내용이 문의에 자동으로 첨부됩니다.</Notice>}
        <div>
          <label className="label">문의 내용</label>
          <textarea
            className="input h-36 resize-none"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="확인이 필요한 내용을 적어 주세요. 이름·연락처 등 개인정보는 적지 마세요."
            required
          />
        </div>
        <Notice>{error}</Notice>
        <button type="submit" className="btn-primary w-full py-2.5" disabled={busy || !content.trim()}>
          <Send className="h-4 w-4" /> {busy ? '등록 중…' : '문의 등록'}
        </button>
      </form>
    </Modal>
  );
}
