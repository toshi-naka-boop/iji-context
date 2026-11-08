/**
 * Generate BGM candidates with Lyria 2 on Vertex AI.
 * Vertex AI の Lyria 2 で BGM の候補を作る（horimovie の gen_bgm.py を TypeScript に移したもの）。
 * 1 曲は 32.8 秒・48kHz ステレオの WAV。プロンプトは同名の .json に残す（素材一覧の出典になる）。
 *
 *   npx tsx video/opening/gen-bgm.ts --name hope --count 2 --prompt "..." [--negative "..."]
 *
 * 認証は gcloud の Application Default Credentials。切れていれば gcloud にログイン中のユーザーのトークンを使う。
 * プロジェクトは GCP_PROJECT（既定 cuc-opening-movie）、リージョンは GCP_LOCATION（既定 us-central1）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = process.env.GCP_PROJECT ?? 'cuc-opening-movie';
const LOCATION = process.env.GCP_LOCATION ?? 'us-central1';
const MODEL = 'lyria-002';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback === undefined) throw new Error(`--${name} を指定してください`);
  return fallback;
}

// ADC が切れていたら gcloud にログイン中のユーザーのトークンを使う
function accessToken(): string {
  const run = (args: string[]) => execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return run(['auth', 'application-default', 'print-access-token']);
  } catch {
    return run(['auth', 'print-access-token']);
  }
}

async function main(): Promise<void> {
  const name = arg('name');
  const prompt = arg('prompt');
  const negative = arg('negative', 'vocals, singing, lyrics');
  const count = Number(arg('count', '1'));

  const token = accessToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT, 'content-type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt, negative_prompt: negative }], parameters: { sample_count: count } }),
  });
  if (!res.ok) throw new Error(`Lyria error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const preds = (await res.json()).predictions as { bytesBase64Encoded?: string; audioContent?: string }[];

  const dir = path.join(ROOT, 'bgm');
  fs.mkdirSync(dir, { recursive: true });
  preds.forEach((p, i) => {
    const base = path.join(dir, preds.length > 1 ? `${name}-${i + 1}` : name);
    fs.writeFileSync(`${base}.wav`, Buffer.from(p.bytesBase64Encoded ?? p.audioContent ?? '', 'base64'));
    fs.writeFileSync(`${base}.json`, JSON.stringify({ model: MODEL, project: PROJECT, prompt, negative, createdAt: new Date().toISOString() }, null, 2) + '\n');
    console.log('->', `${base}.wav`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
