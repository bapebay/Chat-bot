// 데모 모드: 실제 서버 대신 브라우저 안의 가짜 서버(server.ts)로 요청을 보낸다.
import { handle } from './server';

export function installDemo(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(location.origin, '');
    if (!path.startsWith('/api/')) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = undefined;
    if (init?.body instanceof FormData) body = {};
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
        toast('데모 페이지에서는 엑셀 받기를 지원하지 않습니다. 실제 서비스에서는 이 버튼으로 엑셀 파일을 받습니다.');
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
