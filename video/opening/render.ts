/**
 * Render the opening video (HTML → headless Chrome → ffmpeg).
 * ハッカソン動画の冒頭を書き出す。index.html の renderAt(t) を手元の Chrome（ヘッドレス）で 1 コマずつ撮り、ffmpeg で mp4 にする。
 *
 *   npx tsx video/opening/render.ts           # 確認 → 書き出し（out/opening.mp4）
 *   npx tsx video/opening/render.ts --check   # 長さ・読む速さ・文字サイズの確認だけ
 *   npx tsx video/opening/render.ts --stills  # 各画面の終わり際の静止画だけ（out/stills/）
 *   npx tsx video/opening/render.ts --serve   # ブラウザで再生して確かめる用のサーバ
 *
 * Chrome の場所は CHROME_PATH で変えられる。新しい npm 依存は使わない（Node 標準の WebSocket で DevTools を操作する）。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeBgm } from './bgm';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'out');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

type Scene = { id: number; dur: number; big?: string; small?: string; smallParts?: string[]; usText?: string; logo?: string; bg?: string };
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenes.json'), 'utf8')) as {
  style: { width: number; height: number; fps: number; bigPx: number; smallPx: number; sourcePx: number; bgmStartScene: number; bgmVolume: number };
  scenes: Scene[];
};

// 読む速さは句読点・括弧・空白を除いた文字数で数える
const PUNCT = /[\s、。・『』「」（）？！?!,.\/]/g;
const MAX_CPS = 8;
const TOTAL_RANGE: [number, number] = [33, 37];
const MIN_SMALL_RATIO = 0.035;

/** 長さ・読む速さ・文字サイズを表にして出す。基準を外れた項目は「要確認」と出すが、書き出しは止めない */
function check(): void {
  const total = doc.scenes.reduce((s, sc) => s + sc.dur, 0);
  console.log('画面 | 秒 | 小さい文字（句読点除く） | 1秒あたり | 判定');
  for (const sc of doc.scenes) {
    const small = (sc.small ?? sc.smallParts?.join('') ?? '') + (sc.usText ?? '');
    const chars = small.replace(PUNCT, '').length;
    const cps = chars / sc.dur;
    console.log(`${String(sc.id).padStart(2)} | ${sc.dur} | ${String(chars).padStart(2)}字 | ${cps.toFixed(1)} | ${cps <= MAX_CPS ? 'OK' : '要確認（8字/秒超）'}`);
  }
  const inRange = total >= TOTAL_RANGE[0] && total <= TOTAL_RANGE[1];
  console.log(`全体の長さ: ${total} 秒（目安 ${TOTAL_RANGE.join('〜')} 秒）${inRange ? ' OK' : ' 要確認'}`);
  const ratio = doc.style.smallPx / doc.style.height;
  console.log(`小さい文字: ${doc.style.smallPx}px ＝ 高さの ${(ratio * 100).toFixed(1)}%（基準 3.5% 以上）${ratio >= MIN_SMALL_RATIO ? ' OK' : ' NG'}`);
  console.log(`出典の文字: ${doc.style.sourcePx}px ＝ 高さの ${((doc.style.sourcePx / doc.style.height) * 100).toFixed(1)}%（出典表記のため基準の対象外）`);
}

function serve(): Promise<http.Server> {
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !types[path.extname(file)]) {
      res.writeHead(404).end();
      return;
    }
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
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resemen-opening-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: doc.style.width, height: doc.style.height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: pageUrl });
  for (let i = 0; i < 100; i++) {
    if (await cdp.evaluate('typeof window.ready !== "undefined"')) break;
    await sleep(100);
  }
  await cdp.evaluate('window.ready');
  return { cdp, chrome, dir };
}

async function shot(cdp: Cdp, t: number): Promise<Buffer> {
  await cdp.evaluate(`renderAt(${t})`);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(r.data, 'base64');
}

function run(cmd: string, args: string[]): { proc: ChildProcess; done: Promise<void> } {
  const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = new Promise<void>((res, rej) => proc.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} が終了コード ${c} で止まりました`)))));
  return { proc, done };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  check();
  if (args.includes('--check')) return;

  const server = await serve();
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/index.html`;
  if (args.includes('--serve')) {
    console.log(`再生: ${base}（?t=秒 でその時点に止まる）`);
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const { cdp, chrome, dir } = await openPage(`${base}?render=1`);
  try {
    if (args.includes('--stills')) {
      const stillDir = path.join(OUT, 'stills');
      fs.mkdirSync(stillDir, { recursive: true });
      let t = 0;
      for (const sc of doc.scenes) {
        const at = t + sc.dur - 0.35;
        fs.writeFileSync(path.join(stillDir, `scene-${String(sc.id).padStart(2, '0')}.png`), await shot(cdp, at));
        t += sc.dur;
      }
      console.log(`静止画: ${stillDir}`);
      return;
    }

    const total = doc.scenes.reduce((s, sc) => s + sc.dur, 0);
    const fps = doc.style.fps;
    const frames = Math.round(total * fps);
    const video = path.join(OUT, 'video.mp4');
    const ff = run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', video]);
    for (let f = 0; f < frames; f++) {
      const png = await shot(cdp, f / fps);
      if (!ff.proc.stdin!.write(png)) await new Promise((r) => ff.proc.stdin!.once('drain', r));
      if (f % 90 === 0) console.log(`コマ ${f}/${frames}`);
    }
    ff.proc.stdin!.end();
    await ff.done;

    // --bgm <wav> があれば生成済みの曲を bgmStartScene の頭から鳴らす。なければ bgm.ts で合成する
    const bgmIdx = process.argv.indexOf('--bgm');
    let wav: string, af: string;
    if (bgmIdx >= 0) {
      wav = path.resolve(process.argv[bgmIdx + 1]);
      const startSec = doc.scenes.filter((sc) => sc.id < doc.style.bgmStartScene).reduce((s, sc) => s + sc.dur, 0);
      const ms = Math.round(startSec * 1000);
      af = `adelay=${ms}|${ms},afade=t=in:st=${startSec}:d=0.8,afade=t=out:st=${total - 2}:d=2,volume=${doc.style.bgmVolume}`;
    } else {
      wav = path.join(OUT, 'bgm.wav');
      writeBgm(wav, total);
      af = `lowpass=f=6000,aecho=0.8:0.6:180|360:0.22|0.14,afade=t=in:d=1.5,afade=t=out:st=${total - 2.5}:d=2.5,volume=0.6`;
    }
    const final = path.join(OUT, 'opening.mp4');
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-i', wav, '-af', af,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(total), final]).done;
    console.log(`書き出し: ${final}`);
  } finally {
    cdp.close();
    chrome.kill();
    server.close();
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
