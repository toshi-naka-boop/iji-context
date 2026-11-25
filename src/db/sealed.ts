// 患者情報が入るファイル（取り込んだ UKE・医師確認の記録）を、node:crypto の AES-256-GCM で包む（spec FR-212）。
// 形：先頭の印（8 バイト）＋ IV（12 バイト）＋ 認証タグ（16 バイト）＋ 暗号文。ファイルの名前を追加の認証データにする（別のファイルと入れ替えても読めない）。
// 改ざん・鍵の違いは読み込みの誤りとして止め、黙って空として扱わない。鍵がなければ今までどおり平文のまま書いて読む
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DataKeyError, DATA_KEY_ENV, deriveKey, masterKey } from "./key";
import { PlaintextFoundError } from "./open";

/** 包んだファイルの先頭の印（平文か包んだものかを見分ける） */
export const SEALED_MAGIC = Buffer.from("RSMNENC1", "latin1");
const IV = 12;
const TAG = 16;
/** ファイルの鍵の用途の名前 */
export const FILES_PURPOSE = "files";

/** 包んだファイルを読めない（改ざん・鍵の違い・形の崩れ） */
export class SealedFileError extends DataKeyError {
  constructor(name: string) {
    super(`暗号化したファイルを読めません（改ざんされたか、鍵が違います）: ${name}`);
    this.name = "SealedFileError";
  }
}

export const isSealed = (buf: Buffer): boolean => buf.length >= SEALED_MAGIC.length && buf.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC);

const aadOf = (name: string) => Buffer.concat([SEALED_MAGIC, Buffer.from(name, "utf8")]);

/** バイト列を包む。name はファイルの名前（追加の認証データ） */
export function seal(plain: Buffer, name: string, master: Buffer): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", deriveKey(FILES_PURPOSE, master), iv);
  c.setAAD(aadOf(name));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([SEALED_MAGIC, iv, c.getAuthTag(), body]);
}

/** 包んだバイト列を開く。合わなければ SealedFileError */
export function unseal(data: Buffer, name: string, master: Buffer): Buffer {
  if (!isSealed(data) || data.length < SEALED_MAGIC.length + IV + TAG) throw new SealedFileError(name);
  const iv = data.subarray(SEALED_MAGIC.length, SEALED_MAGIC.length + IV);
  const tag = data.subarray(SEALED_MAGIC.length + IV, SEALED_MAGIC.length + IV + TAG);
  try {
    const d = createDecipheriv("aes-256-gcm", deriveKey(FILES_PURPOSE, master), iv);
    d.setAAD(aadOf(name));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data.subarray(SEALED_MAGIC.length + IV + TAG)), d.final()]);
  } catch {
    throw new SealedFileError(name);
  }
}

/** ファイルに書く（鍵があれば包む）。いったん別の名前に書いてから置き換える（途中で止まっても、半端なファイルを残さない） */
export function writeSealed(file: string, content: Buffer | string, master: Buffer | null = masterKey()): void {
  const plain = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, master ? seal(plain, path.basename(file), master) : plain);
  renameSync(tmp, file);
}

/**
 * ファイルを読む（包んだものは開く）。鍵があるのに平文のファイル、鍵がないのに包んだファイルは、読まずに止める（spec FR-216）
 */
export function readSealed(file: string, master: Buffer | null = masterKey()): Buffer {
  const data = readFileSync(file);
  const name = path.basename(file);
  if (master) {
    if (!isSealed(data)) throw new PlaintextFoundError(name);
    return unseal(data, name, master);
  }
  if (isSealed(data)) throw new DataKeyError(`暗号化したファイルです。鍵（${DATA_KEY_ENV}）を設定して起動してください（${name}）`);
  return data;
}
