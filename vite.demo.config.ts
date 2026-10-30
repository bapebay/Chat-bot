// 데모 페이지 빌드: 실제 서버 없이 브라우저 안 가짜 서버로 도는 한 장짜리 HTML
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

export default mergeConfig(
  base,
  defineConfig({
    define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
    build: {
      outDir: '../dist-demo',
      emptyOutDir: true,
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      // 한 장짜리 HTML로 묶기 위해 데모 코드를 별도 파일로 나누지 않는다
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  }),
);
