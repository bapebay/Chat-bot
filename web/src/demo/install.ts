// 데모 모드: 실제 서버 대신 브라우저 안의 가짜 서버(server.ts)로 요청을 보낸다.
import { principlesTemplateCsv } from '../../../server/knowledge/principles';
import { exportState, handle, importState, onResetStorage, onStateChange, setAi, setStorageStatus } from './server';

/** claude.ai 화면 안에서 열렸으면 실제 AI(sample 기능)를 가져온다. 아니면 null */
async function loadSample(): Promise<Parameters<typeof setAi>[0]> {
  const c = (window as unknown as { claude?: { use?: (name: string) => Promise<unknown> } }).claude;
  if (!c?.use) return null;
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), 5000));
  const fn = await Promise.race([c.use('sample').catch(() => null), timeout]);
  return (fn as Parameters<typeof setAi>[0]) ?? null;
}

export async function installDemo(): Promise<void> {
  const [sample] = await Promise.all([loadSample(), setupStorage()]);
  setAi(sample);
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(location.origin, '');
    if (!path.startsWith('/api/')) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = undefined;
    if (init?.body instanceof FormData) body = init.body; // 파일은 브라우저 안에서만 읽는다
    else if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = {};
      }
    }
    const { status, data } = await handle(method, path, body);
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };

  // 데모가 열리는 화면에서는 브라우저 기본 대화상자가 막혀 있으므로 대신 처리한다
  window.confirm = () => true;
  window.prompt = (_msg?: string, def?: string) => def ?? '';
  window.alert = (msg?: unknown) => toast(String(msg ?? ''));

  // 엑셀 받기 링크는 데모에서 쓸 수 없음을 알린다
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as HTMLElement).closest?.('a[href^="/api/"]');
      if (a) {
        e.preventDefault();
        // 집행원리 CSV 양식은 브라우저 안에서 만들어 바로 내려받게 한다
        if (a.getAttribute('href') === '/api/admin/knowledge/principles/template') {
          const url = URL.createObjectURL(new Blob([principlesTemplateCsv()], { type: 'text/csv;charset=utf-8' }));
          const link = Object.assign(document.createElement('a'), { href: url, download: '집행원리_양식.csv' });
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          return;
        }
        toast('데모 페이지에서는 파일 내려받기를 지원하지 않습니다. 실제 서비스에서는 이 버튼으로 파일을 받습니다.');
      }
    },
    true,
  );
}

let toastTimer: number | undefined;
export function toast(text: string): void {
  let el = document.getElementById('demo-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'demo-toast';
    el.setAttribute('role', 'status');
    el.className =
      'fixed left-1/2 z-[100] max-w-[90vw] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900';
    el.style.bottom = 'calc(24px + env(safe-area-inset-bottom, 0px))';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el && (el.hidden = true), 4000);
}

// ================= 페이지 전용 저장 공간 (claude.ai 아티팩트 db) =================
// 데모 상태 전체를 JSON으로 만들어 조각(문서 1개당 256KiB 제한)으로 나눠 저장한다.
// 다시 열면 불러와서 이어서 쓴다. 소유자만 저장할 수 있다.
type DbDoc = { get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>; set(d: Record<string, unknown>): Promise<void>; delete(): Promise<void> };
type Db = { doc(path: string): DbDoc };

const CHUNK_CHARS = 60_000; // 한글 3바이트 기준으로도 문서 한 개 한도(256KiB) 안
const kst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');

async function setupStorage(): Promise<void> {
  const c = (window as unknown as { claude?: { use?: (name: string) => Promise<unknown> } }).claude;
  if (!c?.use) return;
  // 계정 정보도 저장 데이터에 있으므로, 다 불러올 때까지 로그인은 '불러오는 중'으로 막는다
  setStorageStatus({ mode: 'loading', savedAt: null, message: '저장된 데이터를 불러오는 중입니다.' });
  const db = (await Promise.race([c.use('db').catch(() => null), new Promise((r) => setTimeout(() => r(null), 20000))])) as Db | null;
  if (!db) {
    setStorageStatus({ mode: 'error', savedAt: null, message: '저장 공간에 연결하지 못했습니다. 새로고침해 주세요.' });
    return;
  }

  let chunkCount = 0;
  let lastChunks: string[] = [];
  try {
    const meta = await db.doc('demo/meta').get();
    if (meta.exists) {
      const m = meta.data() as { chunks: number; savedAt: string };
      const parts = await Promise.all(Array.from({ length: m.chunks }, (_, i) => db.doc(`demo_chunks/c${i}`).get()));
      lastChunks = parts.map((p) => String(p.data()?.text ?? ''));
      importState(JSON.parse(lastChunks.join('')));
      chunkCount = m.chunks;
      setStorageStatus({ mode: 'saved', savedAt: m.savedAt, message: `저장된 데이터를 불러왔습니다 (마지막 저장 ${m.savedAt}).` });
    } else {
      setStorageStatus({ mode: 'saved', savedAt: null, message: '아직 저장된 데이터가 없습니다. 데이터를 올리거나 바꾸면 자동으로 저장됩니다.' });
    }
  } catch {
    setStorageStatus({ mode: 'error', savedAt: null, message: '저장된 데이터를 불러오지 못했습니다. 처음 상태로 시작합니다.' });
  }

  let timer: number | undefined;
  let saving = false;
  let again = false;
  let readonly = false;
  const save = async () => {
    if (readonly) return;
    if (saving) {
      again = true;
      return;
    }
    saving = true;
    setStorageStatus({ mode: 'saving', savedAt: null, message: '저장 중…' });
    try {
      const json = JSON.stringify(exportState());
      const chunks: string[] = [];
      for (let i = 0; i < json.length; i += CHUNK_CHARS) chunks.push(json.slice(i, i + CHUNK_CHARS));
      // 바뀐 조각만 다시 쓴다
      for (let i = 0; i < chunks.length; i++) if (chunks[i] !== lastChunks[i]) await db.doc(`demo_chunks/c${i}`).set({ text: chunks[i] });
      for (let i = chunks.length; i < chunkCount; i++) await db.doc(`demo_chunks/c${i}`).delete();
      const savedAt = kst();
      await db.doc('demo/meta').set({ chunks: chunks.length, savedAt, chars: json.length });
      lastChunks = chunks;
      chunkCount = chunks.length;
      setStorageStatus({ mode: 'saved', savedAt, message: `자동 저장됨 (${savedAt}). 새로고침하거나 다른 기기에서 열어도 이어서 쓸 수 있습니다.` });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'invalid_argument' || code === 'not_granted' || code === 'revoked') {
        readonly = true;
        setStorageStatus({ mode: 'readonly', savedAt: null, message: '보기 전용입니다. 이 페이지의 소유자만 데이터를 저장할 수 있어, 바꾼 내용은 새로고침하면 사라집니다.' });
      } else if (code === 'quota_exceeded') {
        setStorageStatus({ mode: 'error', savedAt: null, message: '저장 공간이 가득 찼습니다. 관리 → 시스템 정보에서 저장된 데이터를 지운 뒤 다시 올려 주세요.' });
      } else {
        setStorageStatus({ mode: 'error', savedAt: null, message: '저장하지 못했습니다. 잠시 후 다시 바꾸면 다시 저장을 시도합니다.' });
      }
    } finally {
      saving = false;
      if (again) {
        again = false;
        void save();
      }
    }
  };
  onStateChange(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void save(), 1500);
  });
  onResetStorage(async (keep) => {
    readonly = true; // 지우는 동안 자동 저장 멈춤
    window.clearTimeout(timer);
    // 계정만 남기고 나머지 데이터는 지운다
    const json = JSON.stringify(keep);
    await db.doc('demo_chunks/c0').set({ text: json });
    for (let i = 1; i < chunkCount; i++) await db.doc(`demo_chunks/c${i}`).delete();
    await db.doc('demo/meta').set({ chunks: 1, savedAt: kst(), chars: json.length });
    setTimeout(() => location.reload(), 300);
  });
}
