/**
 * Generate background images with Codex CLI (image_generation).
 * 背景画像を Codex CLI の image_generation で作る（horimovie の gen_image.sh を TypeScript に移したもの）。
 * プロンプトは image-prompts.json。できた画像は images/<名前>.png、使ったプロンプトとスレッド ID は images/<名前>.json に残す。
 *
 *   npx tsx video/opening/gen-image.ts                 # まだ無い画像をすべて作る
 *   npx tsx video/opening/gen-image.ts s07-chart       # 指定した画像を作り直す
 *
 * 他のセッションの画像を拾わないよう、Codex のスレッド ID のフォルダから自分の画像だけをコピーする。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(ROOT, 'images');
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'image-prompts.json'), 'utf8')) as { style: string; images: Record<string, string> };

function generate(name: string): void {
  const prompt = conf.images[name];
  if (!prompt) throw new Error(`image-prompts.json に ${name} がありません`);
  const full = `image_generation ツールで次の画像を 1 枚生成してください（ファイルのコピーや追加作業は不要）。画面比率は横長 16:9。画像内に文字・数字・ロゴを入れない（指定した記号を除く）。\n\n${conf.style}\n\n${prompt}`;
  const r = spawnSync('codex', ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-C', DIR, '-'], {
    input: full, encoding: 'utf8', maxBuffer: 1 << 28,
  });
  const started = r.stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.type === 'thread.started');
  const tid = started?.thread_id;
  const genDir = path.join(os.homedir(), '.codex', 'generated_images', String(tid));
  const pngs = tid && fs.existsSync(genDir)
    ? fs.readdirSync(genDir).filter((f) => f.endsWith('.png')).map((f) => path.join(genDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];
  if (!pngs.length) {
    console.error(`NG: ${name} の画像ができませんでした（thread ${tid}）\n${r.stdout.split('\n').slice(-4).join('\n')}${r.stderr?.slice(-500) ?? ''}`);
    process.exitCode = 1;
    return;
  }
  fs.copyFileSync(pngs[0], path.join(DIR, `${name}.png`));
  fs.writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify({ tool: 'codex image_generation', threadId: tid, prompt: full, createdAt: new Date().toISOString() }, null, 2) + '\n');
  console.log('->', path.join(DIR, `${name}.png`));
}

fs.mkdirSync(DIR, { recursive: true });
const names = process.argv.slice(2);
const targets = names.length ? names : Object.keys(conf.images).filter((n) => !fs.existsSync(path.join(DIR, `${n}.png`)));
for (const n of targets) generate(n);
