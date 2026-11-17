// 年月の直書きの検査（design.md §7-1。spec FR-91）。`npm run check:dates`
// 対象：git が追跡する src/・app/・scripts/ の下の .ts・.tsx。版のファイル（src/engine/revisions/）は見ない（適用開始・終了の年月を持つのが仕様）。
// 見る場所：文字列リテラル・テンプレートリテラルの文字の部分・正規表現リテラル・JSX のテキスト。コメントは見ない。
// 一致が 1 件でもあれば「ファイル:行:桁: 文字列」を出して終了コード 1。例外を許す印は設けない。
//
// 設計書は TypeScript の構文木（ts.createSourceFile）で見る場所を決めるとしているが、同梱の typescript（7 系）は
// JavaScript から呼べる構文解析を持たない。依存を足さずに済むよう、ここに小さな字句の読み取りを置く。
// 読み取りはコメント・文字列・テンプレート・正規表現を見分け、残り（コードと JSX のテキスト）も YYYY-MM の形だけは見る
// （JSX のテキストを取りこぼさないため。見すぎる側に倒してある）
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TARGET_DIRS = ["src/", "app/", "scripts/"];
export const EXCLUDED_DIRS = ["src/engine/revisions/"];

/** YYYY-MM（YYYY-MM-DD の頭も当たる） */
const YEAR_MONTH = /(?<![0-9])20[0-9]{2}-(0[1-9]|1[0-2])(?![0-9])/;
/** 節の文字の全体が 6 桁の年月（UKE の年月の形） */
const COMPACT = /^20[0-9]{2}(0[1-9]|1[0-2])$/;
/** JSX のテキストの全体が 6 桁の年月 */
const COMPACT_JSX = />\s*20[0-9]{2}(0[1-9]|1[0-2])\s*</;

export type DateHit = { file: string; line: number; column: number; text: string };

/** 検査の対象のファイルか（パスは "/" 区切りの、リポジトリ直下からの相対） */
export function isTarget(file: string): boolean {
  if (!/\.tsx?$/.test(file)) return false;
  if (!TARGET_DIRS.some((d) => file.startsWith(d))) return false;
  return !EXCLUDED_DIRS.some((d) => file.startsWith(d));
}

type Piece = { kind: "literal" | "code"; start: number; text: string };

/** 正規表現リテラルが始まり得る位置か（直前の、空白でない文字で決める。割り算と見分けるための目安） */
function regexCanStart(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(src[j])) return true;
  return /(?:^|[^A-Za-z0-9_$])(?:return|typeof|case|in|of|void|delete|throw|new|else|do)$/.test(src.slice(Math.max(0, j - 10), j + 1));
}

/** ソースを、コメントを除いた断片（リテラルの中身と、それ以外のコード）に分ける */
export function pieces(src: string): Piece[] {
  const out: Piece[] = [];
  const n = src.length;
  let i = 0;
  let codeStart = 0;
  /** テンプレートの ${ } の中にいるときの、波かっこの深さ（入れ子のテンプレートごとに積む） */
  const braces: number[] = [];
  const flushCode = (end: number) => {
    if (end > codeStart) out.push({ kind: "code", start: codeStart, text: src.slice(codeStart, end) });
  };
  /** テンプレートの文字の部分を、次の ${ か ` まで読む。読み終えた位置を返す */
  const readTemplate = (from: number): number => {
    let j = from;
    while (j < n) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "`") break;
      else if (src[j] === "$" && src[j + 1] === "{") break;
      else j++;
    }
    out.push({ kind: "literal", start: from, text: src.slice(from, Math.min(j, n)) });
    if (src[j] === "`") return j + 1;
    if (j < n) {
      braces.push(0);
      return j + 2;
    }
    return n;
  };
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/" && src[i - 1] !== ":") {
      flushCode(i);
      while (i < n && src[i] !== "\n") i++;
      codeStart = i;
    } else if (ch === "/" && next === "*") {
      flushCode(i);
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      codeStart = i;
    } else if (ch === '"' || ch === "'") {
      flushCode(i);
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out.push({ kind: "literal", start: i + 1, text: src.slice(i + 1, Math.min(j, n)) });
      i = src[j] === ch ? j + 1 : j;
      codeStart = i;
    } else if (ch === "`") {
      flushCode(i);
      i = readTemplate(i + 1);
      codeStart = i;
    } else if (ch === "{" && braces.length > 0) {
      braces[braces.length - 1]++;
      i++;
    } else if (ch === "}" && braces.length > 0) {
      if (braces[braces.length - 1] === 0) {
        // ${ } が閉じた。テンプレートの続きを読む
        braces.pop();
        flushCode(i);
        i = readTemplate(i + 1);
        codeStart = i;
      } else {
        braces[braces.length - 1]--;
        i++;
      }
    } else if (ch === "/" && regexCanStart(src, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n" && (inClass || src[j] !== "/")) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j++;
      }
      if (src[j] === "/") {
        flushCode(i);
        out.push({ kind: "literal", start: i + 1, text: src.slice(i + 1, j) });
        i = j + 1;
        codeStart = i;
      } else i++;
    } else i++;
  }
  flushCode(n);
  return out;
}

/** 1 つのソースの中の、年月の直書き */
export function findDates(file: string, source: string): DateHit[] {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const at = (pos: number) => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= pos) line++;
    return { line: line + 1, column: pos - lineStarts[line] + 1 };
  };
  const hits: DateHit[] = [];
  for (const p of pieces(source)) {
    const m = YEAR_MONTH.exec(p.text) ?? (p.kind === "literal" ? COMPACT.exec(p.text) : COMPACT_JSX.exec(p.text));
    if (!m) continue;
    const pos = p.start + m.index;
    const lineEnd = source.indexOf("\n", pos);
    hits.push({ file, ...at(pos), text: source.slice(pos, lineEnd < 0 ? source.length : lineEnd).trim().slice(0, 80) });
  }
  return hits;
}

/** git が追跡するファイルのうち、検査の対象のもの */
export function targetFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--", ...TARGET_DIRS], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter(Boolean).filter(isTarget);
}

/** 検査を回す。出力の行と終了コードを返す */
export function run(files: { file: string; source: string }[]): { lines: string[]; exitCode: number } {
  const hits = files.flatMap((f) => findDates(f.file, f.source));
  return { lines: hits.map((h) => `${h.file}:${h.line}:${h.column}: ${h.text}`), exitCode: hits.length === 0 ? 0 : 1 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(targetFiles().map((file) => ({ file, source: readFileSync(path.join(root, file), "utf8") })));
  for (const l of r.lines) console.log(l);
  console.log(r.exitCode === 0 ? "年月の直書きはない（0 件）" : `年月の直書きが ${r.lines.length} 件ある`);
  process.exit(r.exitCode);
}
