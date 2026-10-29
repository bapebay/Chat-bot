import { Plus, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Meta, type ReferralContact } from '../api';
import { Notice } from '../components/ui';

const TARGETS: ReferralContact['target'][] = ['지역앵커센터', 'e나라도움', '교육부', '대학규정', '담당자'];

/** 연결 대상 연락처 관리 (지역앵커센터 17곳 + 기타). 연락처나 안내 문구가 입력된 항목만 사용자에게 보인다 */
export function ReferralTab({ meta }: { meta: Meta }) {
  const [rows, setRows] = useState<ReferralContact[]>([]);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => setRows(await api<ReferralContact[]>('/api/admin/referral-contacts')), []);
  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<unknown>, success: string) {
    setMessage(null);
    try {
      await action();
      setMessage({ kind: 'success', text: success });
      await load();
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : '저장에 실패했습니다.' });
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="card space-y-2 p-4 text-sm text-slate-600 dark:text-slate-300">
        <h3 className="font-bold text-slate-800 dark:text-slate-100">연결 대상 연락처</h3>
        <p>
          챗봇이 ‘확인 필요(연결)’, ‘범위 아님’, ‘근거 없음’으로 답할 때 답변 아래에 보여주는 연락처입니다. 사용자에게는 <b>자기 지역</b>의 앵커센터와 공통 대상만 보이고,
          <b> 연락처나 안내 문구가 비어 있는 항목은 보이지 않습니다.</b>
        </p>
        <p className="text-xs text-slate-500">연락처 칸에는 대표 번호, 게시판 주소(https://…) 등 공개해도 되는 정보만 입력하세요.</p>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2">연결 대상</th>
              <th className="px-3 py-2">지역</th>
              <th className="px-3 py-2">이름</th>
              <th className="px-3 py-2">연락처</th>
              <th className="px-3 py-2">안내 문구</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
            {rows.map((r) => (
              <ContactRow
                key={r.id}
                row={r}
                meta={meta}
                onSave={(v) => run(() => api(`/api/admin/referral-contacts/${r.id}`, { method: 'PUT', body: v }), `'${v.name}'을(를) 저장했습니다.`)}
                onDelete={() =>
                  confirm(`'${r.name}'을(를) 삭제할까요?`) &&
                  run(() => api(`/api/admin/referral-contacts/${r.id}`, { method: 'DELETE' }), '삭제했습니다.')
                }
              />
            ))}
            <ContactRow
              key={`new-${rows.length}`}
              row={{ id: 0, target: '담당자', region: null, name: '', contact: '', note: '', sort_order: 200 }}
              meta={meta}
              isNew
              onSave={(v) => run(() => api('/api/admin/referral-contacts', { body: v }), '추가했습니다.')}
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ContactRow({
  row,
  meta,
  isNew = false,
  onSave,
  onDelete,
}: {
  row: ReferralContact;
  meta: Meta;
  isNew?: boolean;
  onSave: (v: ReferralContact) => void;
  onDelete?: () => void;
}) {
  const [v, setV] = useState(row);
  const dirty = JSON.stringify(v) !== JSON.stringify(row);
  const cell = 'rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900';
  const regions = meta.regions.filter((r) => r !== '해당없음');
  return (
    <tr className={isNew ? 'bg-slate-50/60 dark:bg-slate-900/40' : ''}>
      <td className="px-3 py-1.5">
        <select className={cell} value={v.target} onChange={(e) => setV({ ...v, target: e.target.value as ReferralContact['target'] })}>
          {TARGETS.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-1.5">
        {v.target === '지역앵커센터' ? (
          <select className={cell} value={v.region ?? ''} onChange={(e) => setV({ ...v, region: e.target.value })}>
            <option value="">선택</option>
            {regions.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-slate-400">공통</span>
        )}
      </td>
      <td className="px-3 py-1.5">
        <input className={`${cell} w-full`} value={v.name} placeholder={isNew ? '새 연락처 이름' : ''} onChange={(e) => setV({ ...v, name: e.target.value })} />
      </td>
      <td className="px-3 py-1.5">
        <input className={`${cell} w-full`} value={v.contact} placeholder="예: 051-000-0000" onChange={(e) => setV({ ...v, contact: e.target.value })} />
      </td>
      <td className="px-3 py-1.5">
        <input className={`${cell} w-full`} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right">
        <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={!dirty || !v.name.trim()} onClick={() => onSave(v)} title={isNew ? '추가' : '저장'}>
          {isNew ? <Plus className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
        </button>
        {onDelete && (
          <button type="button" className="btn-secondary ml-1 px-2 py-1 text-xs text-red-600" onClick={onDelete} title="삭제">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </td>
    </tr>
  );
}
