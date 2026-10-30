// 화면이 그려지기 전에 다크 모드를 적용한다 (보안 정책상 HTML 안에 스크립트를 직접 넣지 않고 파일로 분리)
try {
  var t = localStorage.getItem('theme');
  if (t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
} catch (e) {}
