// 起動時の確かめ（spec FR-216）。サーバーが立ち上がるとき（instrumentation.ts）に 1 回だけ呼ぶ。
// - 本番（NODE_ENV=production）では、鍵がなければ止める
// - 鍵があれば、auth.db を開いて鍵が合うかを確かめる。合わなければ止める（新しく作らない・上書きしない）
// - 鍵があるのに、暗号化していないデータベース・ファイルが置き場にあれば止め、移す手順（scripts/encrypt-at-rest.ts）を案内する
// - 本番で鍵があるときは、メンターの会話の記録の手元の写し（CLAUDE_CONFIG_DIR）がデータの置き場の外にあることを確かめる（FR-214）
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DataKeyError, DATA_KEY_ENV, isProduction, masterKey, type Env } from "../db/key";
import { appPurposeOf, dbFileState, headOf, openDatabase, PlaintextFoundError, type DbPurpose } from "../db/open";
import { isSealed, SEALED_MAGIC } from "../db/sealed";
import { dataDir } from "./auth-db";

/**
 * 暗号化の対象：データベース（用途つき）と、患者情報が入るファイル。
 * transcripts は、前の版が置き場に残したメンターの会話の記録（<置き場>/home/.claude/projects の JSONL。平文）。移す手順で app.db に写して消す
 */
export type AtRestTargets = { dbs: { file: string; purpose: DbPurpose }[]; files: string[]; transcripts: string[] };

/** 前の版の Docker が HOME（/data/home）の下に残した、SDK の置き場 */
export const legacySdkDir = (data: string) => path.join(data, "home", ".claude");

/** 置き場の下の、SDK の会話の記録（*.jsonl。サブエージェントの記録を含む） */
function jsonlUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? jsonlUnder(f) : e.isFile() && e.name.endsWith(".jsonl") ? [f] : [];
  });
}

const listDir = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort().map((n) => path.join(dir, n)) : []);
/** フォルダの中のファイル（移す手順の途中のもの〔.rekey-tmp〕は除く） */
const filesIn = (dir: string): string[] => listDir(dir).filter((f) => statSync(f).isFile() && !f.endsWith(".rekey-tmp"));

/**
 * データの置き場にある暗号化の対象の一覧。data は置き場（RESEMEN_DATA）、root はアプリのフォルダ。
 * クリニックの置き場は tenants/<id>/（退避したものを含む）。ファイルは、取り込んだ UKE（uke/）と医師確認の記録（query-log/）。
 * ログインなしの既定の置き場（開発用の <root>/data/resemen.db。アップロードは data/uke、医師確認の記録は <root>/query-log）は、置き場が <root>/data のときだけ入れる。
 * outside は、そのうち置き場の外にあるフォルダ（<root>/query-log。移す前の控えに一緒に入れる）
 */
export function atRestTargets(data: string, root: string = process.cwd()): AtRestTargets & { outside: string[] } {
  const withDefault = path.resolve(root, "data") === path.resolve(data);
  const places: { dbFile: string; dir: string; queryLog?: string }[] = [
    ...listDir(path.join(data, "tenants")).filter((d) => /^t[0-9a-f]{12}(?:$|\.retired-)/.test(path.basename(d))).map((dir) => ({ dbFile: path.join(dir, "app.db"), dir })),
    ...(withDefault ? [{ dbFile: path.join(root, "data", "resemen.db"), dir: path.join(root, "data"), queryLog: path.join(root, "query-log") }] : []),
  ];
  const dbs = [{ file: path.join(data, "auth.db"), purpose: "auth" as DbPurpose }, ...places.map((p) => ({ file: p.dbFile, purpose: appPurposeOf(p.dbFile) }))].filter((d) => existsSync(d.file));
  const files = places.flatMap((p) => [...filesIn(path.join(p.dir, "uke")), ...filesIn(p.queryLog ?? path.join(p.dir, "query-log"))]);
  const outside = withDefault && existsSync(path.join(root, "query-log")) ? [path.resolve(root, "query-log")] : [];
  return { dbs: [...new Map(dbs.map((d) => [path.resolve(d.file), d])).values()], files: [...new Set(files.map((f) => path.resolve(f)))], transcripts: jsonlUnder(path.join(legacySdkDir(data), "projects")).sort(), outside };
}

/** 対象のうち、暗号化していないもの（ファイルは先頭の印で見分ける。空のファイルは除く） */
export function plaintextOf(t: AtRestTargets): string[] {
  const plainFile = (f: string) => {
    const head = headOf(f, SEALED_MAGIC.length);
    return head.length > 0 && !isSealed(head);
  };
  return [...t.dbs.filter((d) => dbFileState(d.file) === "plain").map((d) => d.file), ...t.files.filter(plainFile), ...t.transcripts];
}

/** 置き場のパスを、置き場からの相対で見せる（ほかの場所はそのまま） */
const shown = (file: string, data: string) => (file.startsWith(data + path.sep) ? path.relative(data, file) : file);

export type AtRestState = { encrypted: boolean };

/** 起動時の確かめ。止めるときは DataKeyError（文は利用者・運用者向け。鍵の値は出さない） */
export function assertAtRest(env: Env = process.env, dirs: { data?: string; root?: string } = {}): AtRestState {
  const data = path.resolve(dirs.data ?? dataDir());
  const root = dirs.root ?? process.cwd();
  const master = masterKey(env);
  if (!master) {
    if (isProduction(env)) throw new DataKeyError(`本番では鍵（${DATA_KEY_ENV}）がなければ起動しません。鍵の作り方と控え方は docs/deploy-gcp.md にあります`);
    return { encrypted: false };
  }
  if (isProduction(env)) {
    const sdk = env.CLAUDE_CONFIG_DIR;
    if (!sdk) throw new DataKeyError("メンターの会話の記録の手元の写しの置き場（CLAUDE_CONFIG_DIR）を、ディスクに残らない場所（tmpfs）に設定してください（docs/deploy-gcp.md）");
    const abs = path.resolve(sdk);
    if (abs === data || abs.startsWith(data + path.sep)) throw new DataKeyError("CLAUDE_CONFIG_DIR がデータの置き場の中にあります。ディスクに残らない場所（tmpfs）に設定してください");
  }
  const auth = path.join(data, "auth.db");
  if (existsSync(auth)) openDatabase(auth, "auth", { readonly: true, fileMustExist: true }, master).close();
  const plain = plaintextOf(atRestTargets(data, root));
  if (plain.length > 0) throw new PlaintextFoundError(plain.map((f) => shown(f, data)).join("、"));
  return { encrypted: true };
}
