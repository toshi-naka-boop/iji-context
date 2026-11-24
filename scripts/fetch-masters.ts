// 公開データを公開元から落として、<データ置き場>/masters/raw/<データ名>/<更新日>/ に置く（design.md §12-1・L-64）。`npm run masters:fetch -- [--yes] [データ名…]`
// 何をどこから落とすかを先に一覧で出し、--yes が付いていなければ落とさない（一覧を出すために読むのは、config/masters.json の公開ページの HTML だけ）。
// 守り：接続先は config/masters.json の URL のホストだけ／https だけ／リダイレクトには従わない／時間と大きさの上限／名前解決は 1 回で、内部のアドレスには出ない（src/connect/fetch.ts の部品）。
// zip は unzip コマンドで、中の名前と大きさを確かめてから、config の files の名前の形に合うファイルの中身だけを取り出し（unzip -p）、こちらで決めた名前で置き場に置く。
// 落としたファイルは実行しない。すでに置き場にあるファイルは上書きしない
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dnsResolver, isInternalAddress, pinnedLookup } from "../src/connect/fetch";
import { MASTERS_CONFIG, snapshotOf, type DatasetConfig } from "../src/masters/config";
import { mastersDir } from "../src/masters/db";

const TIMEOUT_MS = 120_000;
/** ページ（HTML）の大きさの上限 */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** 落とすファイル 1 つの大きさの上限（いちばん大きい公開ファイルは 8MB ほど） */
const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** zip を展開した合計の大きさと、中のファイルの数の上限（いちばん大きいのはチェックマスタの約 190MB・7 本） */
const MAX_UNZIPPED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 50;

/** 接続してよいホスト：config/masters.json に書いてある URL のホストだけ（手で置くデータの公開ページには接続しない） */
export const allowedHosts = (): Set<string> =>
  new Set(Object.values(MASTERS_CONFIG.datasets).flatMap((d) => (d.download ? [d.page, ...(d.download.url ? [d.download.url] : [])] : [])).map((u) => new URL(u).hostname));

/** https で 1 つ読む。sink があればファイルに流し、なければ本文を返す。失敗は定型文の Error（相手の応答の中身は入れない） */
async function get(url: URL, maxBytes: number, sink?: string): Promise<Buffer> {
  if (url.protocol !== "https:" || !allowedHosts().has(url.hostname) || url.username || url.password) throw new Error("許可していない接続先");
  const addresses = await dnsResolver.resolve(url.hostname);
  if (addresses.length === 0 || addresses.some((a) => isIP(a) === 0 || isInternalAddress(a))) throw new Error("接続先の名前を解決できない、または内部のアドレス");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const r = https.request({ hostname: url.hostname, port: 443, path: url.pathname + url.search, method: "GET", headers: { "user-agent": "masters-fetch" }, lookup: pinnedLookup(addresses[0]), agent: false, signal: ac.signal });
      r.once("response", resolve).once("error", reject);
      r.end();
    });
    const status = res.statusCode ?? 0;
    if (status !== 200) {
      res.destroy();
      throw new Error(status >= 300 && status < 400 ? "相手がリダイレクトを返した（従わない）" : `相手がエラーを返した（HTTP ${status}）`);
    }
    const out = sink ? createWriteStream(sink, { flags: "wx" }) : null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        res.destroy();
        out?.destroy();
        throw new Error("応答が上限より大きい");
      }
      if (out) await new Promise<void>((ok, ng) => out.write(chunk, (e) => (e ? ng(e) : ok())));
      else chunks.push(chunk);
    }
    if (out) await new Promise<void>((ok) => out.end(ok));
    return Buffer.concat(chunks);
  } catch (e) {
    if (ac.signal.aborted) throw new Error("時間内に応答がなかった");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export type Target = { dataset: string; url: string; snapshot: string | null; skip?: string };

/** 公開ページの HTML から、href が形に合うリンクを全部拾い、更新日を取り出す（href とリンクの文字から） */
export function linksOf(html: string, page: string, ds: DatasetConfig, dataset: string): Target[] {
  const out: Target[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([^<]*)/g)) {
    if (!ds.download || !new RegExp(ds.download.href ?? "$^").test(m[1])) continue;
    const url = new URL(m[1], page);
    const snapshot = snapshotOf(ds.download.date, `${m[1]} ${m[2]}`);
    out.push({ dataset, url: url.href, snapshot, ...(snapshot === null ? { skip: "更新日を読み取れない" } : ds.since !== undefined && snapshot < ds.since ? { skip: `世代 ${MASTERS_CONFIG.generation} より前の更新分` } : {}) });
  }
  return out;
}

/**
 * zip の中の名前の検査：パスの細工（絶対パス・..）がないこと。戻り値は、置くときの名前（パスを捨て、英数字と少しの記号のほかは _ に寄せる）。フォルダは ""。
 * 日本語の名前は Shift_JIS のバイト列で入っていて、そのままではファイル名にできない OS があるので、名前には使わない
 */
export function safeName(entry: string): string | null {
  if (entry.startsWith("/") || entry.split("/").includes("..")) return null;
  return (entry.split("/").pop() ?? "").replace(/[^A-Za-z0-9._ -]/g, "_");
}

/**
 * 落とした zip から、config の名前の形に合うファイルだけを、作業用のフォルダに取り出す（作業用のフォルダの中のパスと、置くときの名前を返す）。
 * 中の名前でファイルを作らない：unzip -p で中身を標準出力に出させ、こちらで決めた名前のファイルに流す（パスの細工が効かない）
 */
async function unzipTo(zip: string, work: string, ds: DatasetConfig): Promise<{ from: string; name: string }[]> {
  const env = { ...process.env, LC_ALL: "C" };
  const run = (args: string[]) => execFileSync("unzip", args, { encoding: "latin1", maxBuffer: 4 * 1024 * 1024, env });
  const entries = run(["-Z1", zip]).split("\n").filter(Boolean);
  if (entries.length > MAX_ENTRIES) throw new Error("zip の中のファイルが多すぎる");
  if (entries.some((e) => safeName(e) === null)) throw new Error("zip の中の名前に、パスの細工がある");
  const total = Number(/^\s*(\d+)\s+\d+ files?$/m.exec(run(["-l", zip]))?.[1] ?? Number.NaN);
  if (!(total <= MAX_UNZIPPED_BYTES)) throw new Error("zip を展開した大きさが上限を超える、または読み取れない");
  mkdirSync(work);
  // 中の名前を unzip に渡すときは、英数字と少しの記号のほかを ?（1 バイト）にした形にする。同じ形になる名前が 2 つあれば断る
  const pattern = (e: string) => e.replace(/[^A-Za-z0-9._ \/-]/g, "?");
  const out: { from: string; name: string }[] = [];
  // 目次の申告は偽れるので、実際に書き出した量も数え、合計が上限を超えたら止める（round-32 S-10）
  let written = 0;
  for (const [i, e] of entries.entries()) {
    const name = safeName(e) ?? "";
    if (name === "" || !ds.files.some((x) => new RegExp(x.name, "i").test(name))) continue;
    if (entries.filter((o) => pattern(o) === pattern(e)).length > 1) throw new Error("zip の中に、見分けられない名前のファイルがある");
    const from = path.join(work, `${i}.out`);
    written += await extractCapped(zip, pattern(e), from, MAX_UNZIPPED_BYTES - written);
    out.push({ from, name });
  }
  return out;
}

/**
 * unzip -p で zip の中の 1 つを標準出力に出させ、dest（新しく作るファイル）に流す。書いたバイト数を数え、budget を超えたら unzip を止めて、書きかけの dest を消して投げる。
 * 戻り値は書いたバイト数
 */
export function extractCapped(zip: string, entry: string, dest: string, budget: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest, { flags: "wx" });
    const child = spawn("unzip", ["-p", zip, entry], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } });
    let n = 0;
    let why: string | null = null;
    child.stdout.on("data", (b: Buffer) => {
      if (why !== null) return;
      n += b.length;
      if (n > budget) {
        why = "zip を展開した大きさが上限を超える";
        child.kill();
        return;
      }
      if (!file.write(b)) {
        child.stdout.pause();
        file.once("drain", () => child.stdout.resume());
      }
    });
    child.on("error", () => (why ??= "zip を展開できない"));
    child.on("close", (code) => {
      if (why === null && code !== 0) why = "zip を展開できない";
      file.end(() => {
        if (why === null) return resolve(n);
        rmSync(dest, { force: true });
        reject(new Error(why));
      });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const only = args.filter((a) => !a.startsWith("--"));
  const unknown = only.filter((d) => !Object.hasOwn(MASTERS_CONFIG.datasets, d));
  if (unknown.length > 0) throw new Error(`config/masters.json にないデータ名: ${unknown.join("、")}`);
  const raw = path.join(mastersDir(), "raw");

  const targets: Target[] = [];
  for (const [dataset, ds] of Object.entries(MASTERS_CONFIG.datasets)) {
    if (only.length > 0 && !only.includes(dataset)) continue;
    // 手で置くデータ（万病辞書）は落とさない（docs/masters.md の「手で置く場合」）
    if (!ds.download) {
      targets.push({ dataset, url: ds.page, snapshot: null, skip: "手で raw/ に置くデータ（docs/masters.md の「手で置く場合」）" });
      continue;
    }
    if (ds.download.url) targets.push({ dataset, url: ds.download.url, snapshot: null });
    else {
      const found = linksOf((await get(new URL(ds.page), MAX_PAGE_BYTES)).toString("utf8"), ds.page, ds, dataset);
      if (found.length === 0) targets.push({ dataset, url: ds.page, snapshot: null, skip: "公開ページに、形に合うリンクが見つからない（ページが変わった。docs/masters.md の手で置く手順へ）" });
      targets.push(...found);
    }
  }
  console.log(`置き場：${raw}`);
  for (const t of targets) {
    const ds = MASTERS_CONFIG.datasets[t.dataset];
    console.log(`- ${t.dataset}（${ds.title}／${ds.publisher}）\n    ${t.url}\n    → ${t.skip ? `落とさない：${t.skip}` : `raw/${t.dataset}/${t.snapshot ?? "<更新日は中のファイル名から>"}/`}`);
  }
  if (!yes) {
    console.log("ここまでは一覧だけ。落とすには --yes を付ける（公開元の利用条件は docs/masters.md）");
    return;
  }
  const work = path.join(mastersDir(), `fetch-${randomBytes(6).toString("hex")}`);
  mkdirSync(work, { recursive: true });
  let failed = 0;
  try {
    let n = 0;
    for (const t of targets.filter((x) => !x.skip)) {
      const ds = MASTERS_CONFIG.datasets[t.dataset];
      try {
        const zip = path.join(work, `${++n}.zip`);
        await get(new URL(t.url), MAX_FILE_BYTES, zip);
        const files = await unzipTo(zip, path.join(work, `${n}`), ds);
        const snapshot = t.snapshot ?? files.map((f) => snapshotOf(ds.download?.date ?? "$^", f.name)).find((s) => s !== null) ?? null;
        if (files.length === 0 || snapshot === null) throw new Error("中に、形に合うファイルがない、または更新日を読み取れない");
        if (ds.since !== undefined && snapshot < ds.since) throw new Error(`世代 ${MASTERS_CONFIG.generation} より前の更新分`);
        const dest = path.join(raw, t.dataset, snapshot);
        mkdirSync(dest, { recursive: true });
        for (const f of files) {
          if (existsSync(path.join(dest, f.name))) console.log(`  すでにある（上書きしない）：raw/${t.dataset}/${snapshot}/${f.name}`);
          else {
            renameSync(f.from, path.join(dest, f.name));
            console.log(`  置いた：raw/${t.dataset}/${snapshot}/${f.name}`);
          }
        }
      } catch (e) {
        failed++;
        console.error(`  失敗：${t.dataset}：${e instanceof Error ? e.message : "不明な誤り"}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(failed === 0 ? "落とし終えた。次は npm run masters:build" : `失敗 ${failed} 件`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
