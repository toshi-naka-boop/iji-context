// 保存時の暗号化の鍵（spec FR-215）。親鍵は環境変数 1 本（32 バイト。16 進 64 文字）に置き、用途ごとの鍵は親鍵から HKDF で作る。
// 鍵をデータの置き場に自動で作ることはしない。鍵の値はログ・エラーの文に出さない
import { hkdfSync } from "node:crypto";

/** 親鍵を置く環境変数の名前 */
export const DATA_KEY_ENV = "RESEMEN_DATA_KEY";

/** 鍵の誤り（鍵がない・形が違う・データと合わない）。起動を止める側で使う */
export class DataKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataKeyError";
  }
}

/** 環境変数の形（テストが一部だけを渡せるように） */
export type Env = Record<string, string | undefined>;

/** HKDF の salt（用途の鍵を作る規則の版。変えると全部の鍵が変わる） */
const SALT = Buffer.from("resemen-at-rest-v1");

/**
 * 親鍵（32 バイト）。環境変数がなければ null（鍵のない開発・テストは平文で動く。本番で止めるのは起動時の確かめ。src/server/at-rest.ts）。
 * 形が違えば誤り（黙って平文にしない）
 */
export function masterKey(env: Env = process.env): Buffer | null {
  const v = env[DATA_KEY_ENV];
  if (v === undefined || v === "") return null;
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new DataKeyError(`${DATA_KEY_ENV} は 16 進 64 文字（32 バイト）にしてください`);
  return Buffer.from(v, "hex");
}

/** 用途の名前（auth・app:<クリニックの id>・files）。用途が違えば鍵も違う */
export type KeyPurpose = string;

const cache = new Map<string, Buffer>();
/** 親鍵から、用途ごとの鍵（32 バイト）を作る。同じ親鍵と用途には同じ鍵を返す（作った鍵はプロセスの中で覚える） */
export function deriveKey(purpose: KeyPurpose, master: Buffer): Buffer {
  const id = `${master.toString("hex")}\0${purpose}`;
  let k = cache.get(id);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", master, SALT, `resemen:${purpose}`, 32));
    cache.set(id, k);
  }
  return k;
}

/** 本番か（NODE_ENV=production）。本番では鍵がなければデータを開かない */
export const isProduction = (env: Env = process.env) => env.NODE_ENV === "production";
