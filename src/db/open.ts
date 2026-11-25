// データベースを開く、ただ 1 つの入口（spec FR-219）。クリニックの app.db（開発用の data/resemen.db を含む）と、ログインの auth.db はここで開く。
// ここと公開のマスターの読み込み（src/masters/）の外で、データベースを直接開かない（tests/db/open-scan.test.ts がソースを走査して縛る）。
// 鍵（spec FR-215）があれば、SQLCipher 互換の形式（AES-256）で開く。鍵は用途ごとの生の鍵（32 バイト）で渡し、開くたびの鍵導出（PBKDF2）をしない。
// 鍵を渡すのは、開いてから最初に必ず行う（ほかの文を先に流さない）
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import type BetterSqlite3 from "better-sqlite3";
import { DataKeyError, DATA_KEY_ENV, deriveKey, masterKey } from "./key";

/** 開いたデータベース。呼び出し側（drizzle・マイグレーション・テスト）が使ってきた better-sqlite3 の型のまま渡す */
export type Db = BetterSqlite3.Database;

/** 何のデータベースか。鍵を用途ごとに分けるのに使う（auth＝ログインの auth.db、app:<クリニックの id>＝クリニックの app.db） */
export type DbPurpose = "auth" | `app:${string}`;

/**
 * クリニックの app.db の用途の名前。置き場のフォルダの名前（t + 16 進 12 文字）から決める。
 * 退避した置き場（t….retired-…）も元のクリニックの名前になる。tenants/ の下でない app.db（data/resemen.db・テスト）は app:default
 */
export function appPurposeOf(dbFile: string): DbPurpose {
  const m = /^(t[0-9a-f]{12})(?:$|\.retired-)/.exec(path.basename(path.dirname(path.resolve(dbFile))));
  return `app:${m ? m[1] : "default"}`;
}

/** 平文の SQLite のファイルの先頭 16 バイト */
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

/** ファイルの先頭から n バイト（足りなければあるだけ） */
export function headOf(file: string, n: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

/** データベースのファイルの状態：ない（または空）・平文の SQLite・それ以外（暗号化したもの） */
export function dbFileState(file: string): "missing" | "plain" | "encrypted" {
  if (file === ":memory:" || file === "" || !existsSync(file) || statSync(file).size === 0) return "missing";
  return headOf(file, SQLITE_HEADER.length).equals(SQLITE_HEADER) ? "plain" : "encrypted";
}

/** 鍵があるのに平文のデータが見つかった（spec FR-216）。黙って暗号化し直さず、移す手順を案内して止める */
export class PlaintextFoundError extends DataKeyError {
  constructor(what: string) {
    super(`鍵（${DATA_KEY_ENV}）があるのに、暗号化していないデータがあります（${what}）。アプリを止めて、scripts/encrypt-at-rest.ts で移してから起動してください（手順は docs/deploy-gcp.md）`);
    this.name = "PlaintextFoundError";
  }
}

/** 鍵（32 バイト）を、開いたばかりの接続に渡す。SQLCipher 4 互換の形式（AES-256・HMAC-SHA512）で、生の鍵として渡す */
export function applyKey(db: Db, key: Buffer): void {
  db.pragma("cipher = 'sqlcipher'");
  db.pragma("legacy = 4");
  db.pragma(`key = "x'${key.toString("hex")}'"`);
}

export type OpenOptions = { readonly?: boolean; fileMustExist?: boolean };

/**
 * データベースを開く。用途（purpose）は必ず渡す。master は親鍵（省けば環境変数。鍵の入れ替えのスクリプトだけが渡す）。
 * - 鍵があれば、その用途の鍵で開き、読めることを確かめる。合わなければ止める（新しく作らない・上書きしない）
 * - 鍵があるのに平文のファイルなら止める（FR-216）。鍵がないのに暗号化したファイルなら止める
 * 本番（NODE_ENV=production）で鍵がないときに止めるのは、起動時の確かめ（src/server/at-rest.ts）
 */
export function openDatabase(file: string, purpose: DbPurpose, opts: OpenOptions = {}, master: Buffer | null = masterKey()): Db {
  const name = file === ":memory:" ? file : path.basename(file);
  const state = dbFileState(file);
  if (master && state === "plain") throw new PlaintextFoundError(name);
  if (!master && state === "encrypted") throw new DataKeyError(`暗号化したデータベースです。鍵（${DATA_KEY_ENV}）を設定して起動してください（${name}）`);
  const db = new Database(file, opts) as unknown as Db;
  if (!master) return db;
  try {
    applyKey(db, deriveKey(purpose, master));
    // 鍵が合うかは、読んでみるまで分からない（合わなければ SQLITE_NOTADB）
    db.prepare("SELECT COUNT(*) FROM sqlite_master").get();
  } catch (e) {
    db.close();
    if ((e as { code?: string }).code === "SQLITE_NOTADB") throw new DataKeyError(`鍵（${DATA_KEY_ENV}）がデータベースと合いません（${name}）。鍵を確かめてください。データベースは変えていません`);
    throw e;
  }
  return db;
}
