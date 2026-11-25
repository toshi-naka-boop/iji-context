// 今ある平文のデータを移す（spec FR-217）と、鍵の入れ替え（FR-218）。どちらもアプリを止めてから、手で流すスクリプト（scripts/encrypt-at-rest.ts・scripts/rotate-key.ts）で行う。
// 流れ：①データの置き場を丸ごと控える → ②全部の対象について、新しい鍵で包んだ写しを横に作り、確かめる → ③全部が確かめられてから差し替える。
// データベースの確かめ：整合性の検査（integrity_check）・スキーマの版（user_version）・表ごとの行数が元と合うこと。ファイルの確かめ：開いた中身が元と同じこと。
// 先頭の印で平文か暗号化済みかを見分けるので、二度流しても壊れない（済んだものは、鍵で開けることだけ確かめて飛ばす）
import { copyFileSync, cpSync, existsSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deriveKey } from "../db/key";
import { dbFileState, openDatabase, type Db, type DbPurpose } from "../db/open";
import { isSealed, seal, unseal } from "../db/sealed";
import { atRestTargets, legacySdkDir, type AtRestTargets } from "./at-rest";

export type MoveLog = (line: string) => void;

/** 表ごとの行数（sqlite_ で始まる内部の表を除く） */
function tableCounts(db: Db): Record<string, number> {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(names.map((n) => [n, (db.prepare(`SELECT COUNT(*) AS n FROM "${n.replace(/"/g, '""')}"`).get() as { n: number }).n]));
}
const versionOf = (db: Db) => db.pragma("user_version", { simple: true }) as number;

/** データベース 1 つの中身の要約（行数とスキーマの版） */
export type DbSummary = { version: number; counts: Record<string, number> };

/** 写しの名前（移す途中のもの。起動時の確かめと、次に流したときの対象から外れる） */
const tmpOf = (file: string) => `${file}.rekey-tmp`;

/**
 * データベース 1 つを、新しい鍵で包んだ写し（<file>.rekey-tmp）にして確かめる。from は今の親鍵（平文なら null）、to は新しい親鍵。
 * 元のファイルは読むだけ（WAL は元のファイルに書き戻してから写す）。確かめた要約を返す
 */
function rewrapDb(file: string, purpose: DbPurpose, from: Buffer | null, to: Buffer): DbSummary {
  const src = openDatabase(file, purpose, {}, from);
  let before: DbSummary;
  try {
    src.pragma("wal_checkpoint(TRUNCATE)");
    before = { version: versionOf(src), counts: tableCounts(src) };
  } finally {
    src.close();
  }
  const wal = `${file}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) throw new Error(`WAL が書き戻されていません（アプリが動いていませんか）: ${path.basename(file)}`);
  const tmp = tmpOf(file);
  for (const s of ["", "-wal", "-shm", "-journal"]) rmSync(tmp + s, { force: true });
  copyFileSync(file, tmp);
  const w = openDatabase(tmp, purpose, {}, from);
  try {
    // 鍵を変えるのは、WAL でない形で行う（auth.db は次に開いたときに WAL に戻る。src/server/auth.ts）
    w.pragma("journal_mode = DELETE");
    if (!from) {
      w.pragma("cipher = 'sqlcipher'");
      w.pragma("legacy = 4");
    }
    w.pragma(`rekey = "x'${deriveKey(purpose, to).toString("hex")}'"`);
  } finally {
    w.close();
  }
  if (dbFileState(tmp) !== "encrypted") throw new Error(`暗号化できませんでした: ${path.basename(file)}`);
  const v = openDatabase(tmp, purpose, { readonly: true, fileMustExist: true }, to);
  try {
    const ok = v.pragma("integrity_check", { simple: true });
    const after = { version: versionOf(v), counts: tableCounts(v) };
    if (ok !== "ok") throw new Error(`整合性の検査が通りません: ${path.basename(file)}`);
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`スキーマの版か表ごとの行数が元と合いません: ${path.basename(file)}`);
    return after;
  } finally {
    v.close();
  }
}

/** 写しを元の場所に置き換える（元の WAL・共有メモリのファイルは消す。平文の WAL を、暗号化したファイルに当てないため） */
function swapDb(file: string): void {
  for (const s of ["-wal", "-shm", "-journal"]) rmSync(file + s, { force: true });
  renameSync(tmpOf(file), file);
}

/** ファイル 1 つを、新しい鍵で包んだ写しにして確かめる（名前は元のまま。追加の認証データが名前なので） */
function rewrapFile(file: string, from: Buffer | null, to: Buffer): void {
  const name = path.basename(file);
  const raw = readFileSync(file);
  const plain = from ? unseal(raw, name, from) : raw;
  const out = seal(plain, name, to);
  if (!unseal(out, name, to).equals(plain)) throw new Error(`包んだファイルを確かめられません: ${name}`);
  writeFileSync(tmpOf(file), out);
}

/**
 * データの置き場を丸ごと控える（置き場の外の、横の場所に）。控えの場所を返す。
 * outside は、置き場の外にある対象のフォルダ（開発用の <root>/query-log）。控えの _outside/ の下に一緒に写す
 */
export function backupData(data: string, dest: string, outside: string[] = []): string {
  if (existsSync(dest)) throw new Error(`控えの場所がすでにあります: ${dest}`);
  const abs = path.resolve(dest);
  if (abs.startsWith(path.resolve(data) + path.sep)) throw new Error("控えは、データの置き場の外に置いてください");
  cpSync(data, abs, { recursive: true, preserveTimestamps: true });
  for (const o of outside) cpSync(o, path.join(abs, "_outside", path.basename(o)), { recursive: true, preserveTimestamps: true });
  return abs;
}

/** 控えの場所の既定（<置き場>.backup-<日時。ミリ秒まで>） */
export const defaultBackupOf = (data: string, at: Date = new Date()) => `${path.resolve(data)}.backup-${at.toISOString().replace(/[-:.]/g, "").slice(0, 18)}`;

/** 移すものがあるか（平文のデータベース・ファイル・会話の記録） */
export const hasWork = (plan: MovePlan) => plan.dbs.some((d) => d.state === "plain") || plan.files.some((f) => f.state === "plain") || plan.transcripts.length > 0;

export type MovePlan = {
  /** 暗号化するデータベース（平文のもの）と、もう暗号化してあるもの */
  dbs: { file: string; purpose: DbPurpose; state: "plain" | "encrypted" }[];
  files: { file: string; state: "plain" | "sealed" }[];
  /** 前の版が置き場に残した会話の記録（クリニックに当てられたもの・当てられないもの） */
  transcripts: { file: string; tenant: string | null }[];
};

/** 会話の記録の JSONL から、どのクリニックのものか（作業場所 <RESEMEN_WORKSPACES>/<クリニック>/<医療事務> の名前から）。当てられなければ null */
function tenantOfTranscript(sdkDir: string, file: string): string | null {
  const project = path.relative(path.join(sdkDir, "projects"), file).split(path.sep)[0];
  return /-(t[0-9a-f]{12}|default)-[A-Za-z0-9_]+$/.exec(project)?.[1] ?? null;
}

/** 移す対象の一覧（--dry-run はこれを出すだけ。何も変えない） */
export function planMove(t: AtRestTargets, data: string): MovePlan {
  const sdk = legacySdkDir(data);
  return {
    dbs: t.dbs.map((d) => ({ ...d, state: dbFileState(d.file) === "plain" ? ("plain" as const) : ("encrypted" as const) })),
    files: t.files.filter((f) => statSync(f).size > 0).map((f) => ({ file: f, state: isSealed(readFileSync(f)) ? ("sealed" as const) : ("plain" as const) })),
    transcripts: t.transcripts.map((f) => ({ file: f, tenant: tenantOfTranscript(sdk, f) })),
  };
}

/** 会話の記録を写す先（クリニックの会話の記録の置き場）。scripts/encrypt-at-rest.ts が、アプリと同じ開き方（マイグレーションを当てる）で渡す */
export type TranscriptSink = (tenant: string) => { append: (key: { projectKey: string; sessionId: string; subpath?: string }, entries: { type: string; [k: string]: unknown }[]) => Promise<void>; load: (key: { projectKey: string; sessionId: string; subpath?: string }) => Promise<unknown[] | null>; close: () => void };

export type MoveResult = { dbs: { file: string; summary: DbSummary; done: "encrypted" | "already" }[]; files: { file: string; done: "sealed" | "already" }[]; transcripts: { file: string; entries: number }[]; skipped: string[] };

/**
 * 平文のデータを暗号化して移す（FR-217）。master は新しい親鍵。控えは呼ぶ前に取る（scripts/encrypt-at-rest.ts）。
 * データベースとファイルは、全部の写しを確かめてから差し替える。会話の記録は、差し替えたあとのクリニックの置き場に写し、読み戻して数が合ったものだけを消す
 */
export async function encryptAll(data: string, root: string, master: Buffer, sink: TranscriptSink | null, log: MoveLog = () => {}): Promise<MoveResult> {
  const plan = planMove(atRestTargets(data, root), data);
  const result: MoveResult = { dbs: [], files: [], transcripts: [], skipped: [] };
  const todo: string[] = [];
  for (const d of plan.dbs) {
    if (d.state === "encrypted") {
      // 済んだもの：今の鍵で開けることだけ確かめる（開けなければ止まる）
      const db = openDatabase(d.file, d.purpose, { readonly: true, fileMustExist: true }, master);
      result.dbs.push({ file: d.file, summary: { version: versionOf(db), counts: tableCounts(db) }, done: "already" });
      db.close();
      continue;
    }
    result.dbs.push({ file: d.file, summary: rewrapDb(d.file, d.purpose, null, master), done: "encrypted" });
    todo.push(d.file);
    log(`データベースを確かめた: ${path.relative(data, d.file) || d.file}`);
  }
  const files: string[] = [];
  for (const f of plan.files) {
    if (f.state === "sealed") {
      unseal(readFileSync(f.file), path.basename(f.file), master);
      result.files.push({ file: f.file, done: "already" });
      continue;
    }
    rewrapFile(f.file, null, master);
    files.push(f.file);
    result.files.push({ file: f.file, done: "sealed" });
  }
  // 全部を確かめてから差し替える
  for (const f of todo) swapDb(f);
  for (const f of files) renameSync(tmpOf(f), f);
  log(`差し替えた: データベース ${todo.length} 件・ファイル ${files.length} 件`);

  const sdk = legacySdkDir(data);
  const byTenant = new Map<string, string[]>();
  for (const t of plan.transcripts) {
    if (!t.tenant || !sink) result.skipped.push(t.file);
    else byTenant.set(t.tenant, [...(byTenant.get(t.tenant) ?? []), t.file]);
  }
  for (const [tenant, list] of byTenant) {
    const store = sink!(tenant);
    try {
      for (const file of list) {
        const rel = path.relative(path.join(sdk, "projects"), file).split(path.sep);
        const projectKey = rel[0];
        // <projectKey>/<会話の id>.jsonl が本体、<projectKey>/<会話の id>/subagents/<名前>.jsonl がサブエージェントの記録
        const sessionId = rel.length === 2 ? rel[1].replace(/\.jsonl$/, "") : rel[1];
        const subpath = rel.length === 2 ? undefined : rel.slice(2).join("/").replace(/\.jsonl$/, "");
        const entries = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { type: string });
        const key = { projectKey, sessionId, ...(subpath ? { subpath } : {}) };
        await store.append(key, entries);
        const back = (await store.load(key)) ?? [];
        const uuidOf = (e: unknown) => (e as { uuid?: unknown }).uuid;
        const expected = new Set(entries.map(uuidOf).filter((u) => typeof u === "string")).size + entries.filter((e) => typeof uuidOf(e) !== "string").length;
        if (back.length < expected) throw new Error(`会話の記録を写せませんでした: ${path.basename(file)}`);
        rmSync(file);
        result.transcripts.push({ file, entries: entries.length });
      }
    } finally {
      store.close();
    }
  }
  removeEmptyDirs(path.join(sdk, "projects"));
  return result;
}

/** 空になったフォルダを消す（中身のあるものは残す） */
function removeEmptyDirs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * 鍵の入れ替え（FR-218）。全部のデータベースの鍵を変え、ファイルを包み直す。from は今の親鍵、to は新しい親鍵。
 * 平文のものが残っていれば、先に移す手順を流すよう止める。全部の写しを確かめてから差し替える
 */
export function rotateAll(data: string, root: string, from: Buffer, to: Buffer, log: MoveLog = () => {}): { dbs: number; files: number } {
  if (from.equals(to)) throw new Error("新しい鍵が今の鍵と同じです");
  const plan = planMove(atRestTargets(data, root), data);
  const plain = [...plan.dbs.filter((d) => d.state === "plain").map((d) => d.file), ...plan.files.filter((f) => f.state === "plain").map((f) => f.file), ...plan.transcripts.map((t) => t.file)];
  if (plain.length > 0) throw new Error(`暗号化していないデータがあります。先に scripts/encrypt-at-rest.ts で移してください（${plain.length} 件）`);
  for (const d of plan.dbs) rewrapDb(d.file, d.purpose, from, to);
  for (const f of plan.files) rewrapFile(f.file, from, to);
  for (const d of plan.dbs) swapDb(d.file);
  for (const f of plan.files) renameSync(tmpOf(f.file), f.file);
  log(`鍵を入れ替えた: データベース ${plan.dbs.length} 件・ファイル ${plan.files.length} 件`);
  return { dbs: plan.dbs.length, files: plan.files.length };
}
