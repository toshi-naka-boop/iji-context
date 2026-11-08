/**
 * Render a demo-video draft (stage.html → headless Chrome → ffmpeg).
 * デモ動画の素案を書き出す。cuts/<案>.json の台本を stage.html が 1 コマずつ描き、録画・BGM・キャラの声と合わせて mp4 にする。
 *
 *   npx tsx video/demo/render.ts v1                 # out/v1.mp4（1280×720・素案）
 *   npx tsx video/demo/render.ts v1 --stills 3,10   # 指定した秒の静止画（out/stills/）
 *   npx tsx video/demo/render.ts v1 --full          # 1920×1080 で書き出す
 *
 * 新しい npm 依存は使わない（opening/render.ts と同じく Node 標準の WebSocket で DevTools を操作する）。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FPS = 30;
// 配信してよい場所だけ（リポジトリの他のファイルは出さない）
const ALLOW = ['video/', 'assets/characters/', 'design/demo-video/'];

// at は秒。cut を書くと「その番号（0 始まり）のカットの頭 + at 秒」になる
type Track = { file: string; at?: number; cut?: number; from?: number; dur?: number; vol?: number; fadeIn?: number; fadeOut?: number };
type Doc = { title: string; cuts: { dur: number; voice?: Track }[]; bgm?: Track[]; voices?: Track[]; duck?: number };

const name = process.argv[2];
if (!name || name.startsWith('--')) throw new Error('案の名前（例：v1）を指定してください');
const doc = JSON.parse(fs.readFileSync(path.join(HERE, 'cuts', `${name}.json`), 'utf8')) as Doc;
const starts: number[] = [];
const total = doc.cuts.reduce((s, c) => (starts.push(s), s + c.dur), 0);
const absolute = (tr: Track): Track & { at: number } => ({ ...tr, at: (tr.cut !== undefined ? starts[tr.cut] : 0) + (tr.at ?? 0) });
doc.bgm = (doc.bgm ?? []).map(absolute);
// カットに書いた声（voice）も、そのカットの頭から鳴らす
doc.voices = [...(doc.voices ?? []), ...doc.cuts.flatMap((c, i) => (c.voice ? [{ ...c.voice, cut: i }] : []))].map(absolute);
const full = process.argv.includes('--full');
const [VW, VH] = full ? [1920, 1080] : [1280, 720];

function serve(): Promise<http.Server> {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
  };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(REPO, rel));
    const ok = file.startsWith(REPO + path.sep) && ALLOW.some((p) => rel.startsWith(p)) && fs.existsSync(file) && types[path.extname(file)];
    if (!ok) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => resolve(server)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      const p = m.id && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close(): void { this.ws.close(); }
}

async function openPage(pageUrl: string): Promise<{ cdp: Cdp; chrome: ChildProcess; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resemen-demo-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    if (!port) await sleep(100);
  }
  if (!port) throw new Error(`Chrome が起動しませんでした: ${CHROME}`);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: pageUrl });
  for (let i = 0; i < 300; i++) {
    if (await cdp.evaluate('typeof window.ready !== "undefined"')) break;
    await sleep(100);
  }
  await cdp.evaluate('window.ready');
  return { cdp, chrome, dir };
}

async function shot(cdp: Cdp, t: number, format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer> {
  await cdp.evaluate(`renderAt(${t})`);
  const r = await cdp.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 92 } : {}) });
  return Buffer.from(r.data, 'base64');
}

function run(cmd: string, args: string[]): { proc: ChildProcess; done: Promise<void> } {
  const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = new Promise<void>((res, rej) => proc.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} が終了コード ${c} で止まりました`)))));
  return { proc, done };
}

/** BGM とキャラの声を重ねる。声が鳴る間は BGM を下げる（duck） */
function audioArgs(): { inputs: string[]; filter: string } | null {
  const bgm = doc.bgm ?? [], voices = doc.voices ?? [];
  if (!bgm.length && !voices.length) return null;
  const inputs: string[] = [];
  const parts: string[] = [];
  const chain = (tr: Track & { at: number }, i: number, label: string) => {
    const from = tr.from ?? 0;
    const dur = tr.dur ?? 999;
    const ms = Math.round(tr.at * 1000);
    let f = `[${i}:a]atrim=start=${from}:duration=${dur},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo`;
    if (tr.fadeIn) f += `,afade=t=in:d=${tr.fadeIn}`;
    if (tr.fadeOut && tr.dur) f += `,afade=t=out:st=${Math.max(0, tr.dur - tr.fadeOut)}:d=${tr.fadeOut}`;
    f += `,volume=${tr.vol ?? 1},adelay=${ms}|${ms}[${label}]`;
    parts.push(f);
  };
  let n = 1; // 0 は映像
  (bgm as (Track & { at: number })[]).forEach((tr, j) => { inputs.push('-i', path.join(HERE, tr.file)); chain(tr, n++, `b${j}`); });
  (voices as (Track & { at: number })[]).forEach((tr, j) => { inputs.push('-i', path.join(HERE, tr.file)); chain(tr, n++, `v${j}`); });
  const duck = (voices as (Track & { at: number })[]).map((v) => `between(t,${v.at - 0.15},${v.at + (v.dur ?? 8) + 0.2})`).join('+') || '0';
  if (bgm.length) parts.push(`${bgm.map((_, j) => `[b${j}]`).join('')}amix=inputs=${bgm.length}:normalize=0,volume='if(${duck},${doc.duck ?? 0.3},1)':eval=frame[bg]`);
  const mixIn = [...(bgm.length ? ['[bg]'] : []), ...voices.map((_, j) => `[v${j}]`)];
  parts.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0,afade=t=out:st=${total - 1.5}:d=1.5,alimiter=limit=0.9[aout]`);
  return { inputs, filter: parts.join(';') };
}

async function main(): Promise<void> {
  console.log(`${doc.title}：${total.toFixed(1)} 秒（上限 140 秒）${total <= 140 ? ' OK' : ' 超過'}`);
  const server = await serve();
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/video/demo/stage.html?v=${name}&render=1`;
  fs.mkdirSync(OUT, { recursive: true });
  const { cdp, chrome, dir } = await openPage(base);
  try {
    const si = process.argv.indexOf('--stills');
    if (si >= 0) {
      const stillDir = path.join(OUT, 'stills');
      fs.mkdirSync(stillDir, { recursive: true });
      for (const s of process.argv[si + 1].split(',').map(Number)) {
        fs.writeFileSync(path.join(stillDir, `${name}-${s.toFixed(1)}.png`), await shot(cdp, s, 'png'));
      }
      console.log(`静止画: ${stillDir}`);
      return;
    }
    const frames = Math.round(total * FPS);
    const video = path.join(OUT, `${name}-video.mp4`);
    const ff = run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', full ? '18' : '24', '-preset', 'medium', video]);
    const t0 = Date.now();
    for (let f = 0; f < frames; f++) {
      const img = await shot(cdp, f / FPS);
      if (!ff.proc.stdin!.write(img)) await new Promise((r) => ff.proc.stdin!.once('drain', r));
      if (f % 300 === 0) console.log(`コマ ${f}/${frames}（${((Date.now() - t0) / 1000).toFixed(0)} 秒経過）`);
    }
    ff.proc.stdin!.end();
    await ff.done;

    const final = path.join(OUT, `${name}.mp4`);
    const a = audioArgs();
    if (a) {
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, ...a.inputs, '-filter_complex', a.filter, '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', String(total), final]).done;
      fs.rmSync(video);
    } else fs.renameSync(video, final);
    console.log(`書き出し: ${final}（${(fs.statSync(final).size / 1e6).toFixed(1)} MB）`);
  } finally {
    cdp.close();
    chrome.kill();
    server.close();
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
