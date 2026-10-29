// 의미 검색 모델(multilingual-e5-small, 약 120MB) 파일을 models/ 폴더에 내려받는다.
// 인터넷이 되는 컴퓨터에서 한 번 실행한 뒤, 서버가 인터넷이 안 되면 models/ 폴더를 통째로 복사하면 된다.
// 사용법: npm run download-model   (미러를 쓸 때: HF_ENDPOINT=https://미러주소 npm run download-model)
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODELS_DIR, LOCAL_MODEL_ID } from '../knowledge/embedder.js';

const endpoint = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/$/, '');
const dir = path.join(process.env.MODELS_DIR || DEFAULT_MODELS_DIR, LOCAL_MODEL_ID);
const FILES = [
  { name: 'config.json', required: true },
  { name: 'tokenizer.json', required: true },
  { name: 'tokenizer_config.json', required: true },
  { name: 'special_tokens_map.json', required: false },
  { name: 'onnx/model_quantized.onnx', required: true },
];

for (const f of FILES) {
  const target = path.join(dir, f.name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    console.log(`이미 있음: ${f.name}`);
    continue;
  }
  const url = `${endpoint}/${LOCAL_MODEL_ID}/resolve/main/${f.name}`;
  process.stdout.write(`내려받는 중: ${f.name} … `);
  const res = await fetch(url).catch((e: Error) => {
    console.error(`\n연결 실패: ${e.message}`);
    process.exit(1);
  });
  if (!res.ok) {
    if (!f.required) {
      console.log('없음(선택 파일, 건너뜀)');
      continue;
    }
    console.error(`\n실패 (상태 코드 ${res.status}): ${url}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${target}.part`, target);
  console.log(`완료 (${(fs.statSync(target).size / 1024 / 1024).toFixed(1)}MB)`);
}
console.log(`\n모델 준비 완료: ${dir}\n서버를 다시 시작하면 의미 검색이 켜집니다.`);
