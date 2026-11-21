// 以前の作り物の診療行為コードが残っていないかの検査（design.md §11-8 完了条件 2）。`npm run check:codes`
// 作り物のコードは「99 で始まる 9 桁」だった。実在の診療行為コードに替えたあと、これが残っていないことを確かめる。
// 対象：git が追跡する src/・scripts/・fixtures/ の下のファイル（連携の模擬応答・模擬サーバー・同梱の UKE を含む）。
// 同梱の UKE（.UKE）は Shift_JIS なので、文字コードを変えてから探す（grep は環境によって Shift_JIS のファイルを飛ばすので使わない）。
// 一致が 1 件でもあれば「ファイル:行: 文字列」を出して終了コード 1。例外を許す印は設けない
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TARGET_DIRS = ["src/", "scripts/", "fixtures/"];
/** 文字として読むファイル（ほかは見ない。PDF などの中身は対象外） */
const TEXT = /\.(ts|tsx|mts|js|mjs|json|html|md|txt|csv|xml)$/i;
const UKE = /\.UKE$/i;

/** 9 桁ちょうどの数字の並びで、先頭 2 桁が 9（前後が数字のものは、もっと長い番号の一部なので当てない） */
const FICTIONAL = new RegExp(`(?<![0-9])${"9".repeat(2)}[0-9]{7}(?![0-9])`, "g");

export type CodeHit = { file: string; line: number; text: string };

/** 検査の対象のファイルか（パスは "/" 区切りの、リポジトリ直下からの相対） */
export const isTarget = (file: string): boolean => TARGET_DIRS.some((d) => file.startsWith(d)) && (TEXT.test(file) || UKE.test(file));

/** ファイルの中身を文字にする。UKE は Shift_JIS（末尾の EOF は読み飛ばす） */
export function decode(file: string, bytes: Uint8Array): string {
  return UKE.test(file) ? new TextDecoder("shift_jis").decode(bytes).replace(/\u001a$/, "") : new TextDecoder("utf-8").decode(bytes);
}

export function hitsOf(file: string, text: string): CodeHit[] {
  const out: CodeHit[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    for (const m of l.matchAll(FICTIONAL)) out.push({ file, line: i + 1, text: m[0] });
  });
  return out;
}

export function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", ...TARGET_DIRS], { cwd: root, encoding: "utf8" }).split("\0").filter((f) => f && isTarget(f));
}

export function scan(files: string[] = trackedFiles()): CodeHit[] {
  return files.flatMap((f) => hitsOf(f, decode(f, readFileSync(path.join(root, f)))));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const files = trackedFiles();
  const hits = scan(files);
  for (const h of hits) console.log(`${h.file}:${h.line}: ${h.text}`);
  console.log(hits.length === 0 ? `作り物の診療行為コードは残っていない（${files.length} ファイルを見て 0 件）` : `作り物の診療行為コードが ${hits.length} 件残っている`);
  process.exit(hits.length > 0 ? 1 : 0);
}
