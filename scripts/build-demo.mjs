// 데모 빌드 결과(dist-demo)의 JS·CSS를 HTML 안에 넣어 파일 하나(dist-demo/anchor-chatbot-demo.html)로 만든다.
// 이 파일은 claude.ai 아티팩트처럼 문서 뼈대(<html><head><body>)를 따로 감싸 주는 곳에 올리는 조각이다.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

execSync('npx vite build --config vite.demo.config.ts', { stdio: 'inherit' });
const dir = 'dist-demo';
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const read = (href) => fs.readFileSync(path.join(dir, href.replace(/^\//, '')), 'utf8');

const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => read(m[1])).join('\n');
const js = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)].map((m) => read(m[1])).join('\n');
const themeScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

const page = `<title>앵커 사업비 챗봇 데모</title>
<style>
/* 화면 배경: 보는 사람의 밝은/어두운 테마를 따른다 (앱 안의 달 아이콘으로도 바꿀 수 있음) */
:root { --demo-bg: #f1f5f9; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --demo-bg: #020617; color-scheme: dark; } }
:root[data-theme="dark"] { --demo-bg: #020617; color-scheme: dark; }
:root.dark { --demo-bg: #020617; color-scheme: dark; }
:root:not(.dark) { --demo-bg: #f1f5f9; color-scheme: light; }
html, body { height: 100%; }
body { background: var(--demo-bg); }
${css.replace(/<\/style/gi, '<\\/style')}
</style>
<script>
(function () {
  var root = document.documentElement;
  var t = root.getAttribute('data-theme');
  var dark = t ? t === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  try { var saved = localStorage.getItem('theme'); if (saved) dark = saved === 'dark'; } catch (e) {}
  root.classList.toggle('dark', dark);
})();
</script>
<div id="root"></div>
<script type="module">
${js.replace(/<\/script/gi, '<\\/script').replace(/\uFFFD/g, '\\uFFFD')}
</script>
`;
void themeScript;
const out = path.join(dir, 'anchor-chatbot-demo.html');
fs.writeFileSync(out, page);
console.log(`데모 파일: ${out} (${(Buffer.byteLength(page) / 1024).toFixed(0)}KB)`);
