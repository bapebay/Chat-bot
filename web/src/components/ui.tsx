import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900">
          <h3 className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-100">{title}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="닫기">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Notice({ kind = 'error', children }: { kind?: 'error' | 'success' | 'info'; children: ReactNode }) {
  if (!children) return null;
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
    success: 'border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300',
    info: 'border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200',
  }[kind];
  return <div className={`rounded-lg border p-3 text-sm ${styles}`}>{children}</div>;
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  className = 'input',
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  placeholder?: string;
  className?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
