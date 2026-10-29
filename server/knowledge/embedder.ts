import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db.js';

/** 문장을 벡터로 바꾸는 모델. 벡터는 길이 1로 정규화되어 있어 내적 = 코사인 유사도 */
export interface Embedder {
  name: string;
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>;
}

export const LOCAL_MODEL_ID = 'Xenova/multilingual-e5-small';
export const DEFAULT_MODELS_DIR = './models';

/** models/ 폴더에 모델 파일이 있으면 서버 안에서 직접 돌리는 임베딩 모델을 만든다. 없으면 null */
export async function loadLocalEmbedder(modelsDir: string, log: (msg: string) => void): Promise<Embedder | null> {
  const modelDir = path.join(modelsDir, LOCAL_MODEL_ID);
  if (!fs.existsSync(path.join(modelDir, 'onnx', 'model_quantized.onnx'))) {
    log(`의미 검색 모델이 없어 키워드 검색만 사용합니다. (npm run download-model 로 ${modelDir} 에 내려받을 수 있습니다)`);
    return null;
  }
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.localModelPath = path.resolve(modelsDir) + path.sep;
    const extractor = await pipeline('feature-extraction', LOCAL_MODEL_ID, { dtype: 'q8' });
    log(`의미 검색 모델을 불러왔습니다: ${LOCAL_MODEL_ID}`);
    return {
      name: LOCAL_MODEL_ID,
      async embed(texts, kind) {
        // e5 계열 모델은 질문/문서 앞에 접두어를 붙여야 성능이 나온다
        const prefixed = texts.map((t) => `${kind}: ${t}`);
        const out: Float32Array[] = [];
        for (let i = 0; i < prefixed.length; i += 16) {
          const batch = prefixed.slice(i, i + 16);
          const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
          const dim = tensor.dims[tensor.dims.length - 1];
          const data = tensor.data as Float32Array;
          for (let j = 0; j < batch.length; j++) out.push(data.slice(j * dim, (j + 1) * dim));
        }
        return out;
      },
    };
  } catch (e) {
    log(`의미 검색 모델을 불러오지 못해 키워드 검색만 사용합니다: ${(e as Error).message}`);
    return null;
  }
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 문서 벡터를 DB에 캐시해 재시작할 때 다시 계산하지 않는다 */
export async function embedPassagesCached(db: DB, embedder: Embedder, texts: string[]): Promise<Float32Array[]> {
  const get = db.prepare('SELECT vector FROM embeddings WHERE hash = ? AND model = ?');
  const put = db.prepare('INSERT OR REPLACE INTO embeddings (hash, model, vector) VALUES (?, ?, ?)');
  const hashes = texts.map(hashText);
  const result: (Float32Array | null)[] = hashes.map((h) => {
    const row = get.get(h, embedder.name) as { vector: Buffer } | undefined;
    if (!row) return null;
    const buf = row.vector;
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  });

  const missing = result.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const vectors = await embedder.embed(missing.map((i) => texts[i]), 'passage');
    db.transaction(() => {
      missing.forEach((idx, k) => {
        result[idx] = vectors[k];
        put.run(hashes[idx], embedder.name, Buffer.from(vectors[k].buffer, vectors[k].byteOffset, vectors[k].byteLength));
      });
    })();
  }
  return result as Float32Array[];
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
