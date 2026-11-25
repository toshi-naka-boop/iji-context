// データベースを開く、ただ 1 つの入口（spec FR-219）。クリニックの app.db（開発用の data/resemen.db を含む）と、ログインの auth.db はここで開く。
// ここと公開のマスターの読み込み（src/masters/）の外で、データベースを直接開かない（tests/db/open-scan.test.ts がソースを走査して縛る）
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import type BetterSqlite3 from "better-sqlite3";

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

export type OpenOptions = { readonly?: boolean; fileMustExist?: boolean };

/** データベースを開く。用途（purpose）は必ず渡す */
export function openDatabase(file: string, purpose: DbPurpose, opts: OpenOptions = {}): Db {
  void purpose;
  return new Database(file, opts) as unknown as Db;
}
