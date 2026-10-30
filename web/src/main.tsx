import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

async function start() {
  // 데모 페이지 빌드(npm run build:demo)에서만 브라우저 안 가짜 서버를 켠다
  if (import.meta.env.VITE_DEMO === '1') await (await import('./demo/install')).installDemo();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
start();
