// レセメン自身を説明する文書・UI 文言に、使わないと決めた 4 語が入っていないかを検査する（CLAUDE.md 固定条件）
// 使い方: npx tsx scripts/check-banned-words.ts
// 逃げ道: 他社の製品・サービスのカテゴリ名として引用する箇所は、その行か直前行に banned-words-allow と書く
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BANNED_WORDS = ["教育", "学習", "学ぶ", "教える"];
export const ALLOW_MARKER = "banned-words-allow";

export type Hit = { file: string; line: number; word: string; text: string };

/** 検査対象。dir は再帰、exts はその中で見る拡張子 */
const TARGETS: { path: string; exts?: string[]; recursive?: boolean }[] = [
  { path: "README.md" },
  { path: "docs", exts: [".md"], recursive: true },
  { path: "app", exts: [".ts", ".tsx"], recursive: true },
  { path: "config", exts: [".json"], recursive: false },
  { path: "src/messages.ts" },
];

/** 直前行がマーカーだけのコメント行か（// ・ /* ・ {/* ・ <!-- のいずれかで始まる） */
const MARKER_ONLY_LINE = new RegExp(`^\\s*(//|/\\*|\\{/\\*|<!--)\\s*${ALLOW_MARKER}`);

/**
 * Strip // and block comments from TS/TSX source, keeping line breaks.
 * 簡易な実装。文字列の中の // は残す。URL の :// はコメント扱いしない。
 * ' と " の文字列は行末で閉じたものとみなす（JSX テキスト中のアポストロフィで状態が崩れ続けないように）。
 */
export function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      if (c === "\\" && next !== undefined && next !== "\n") {
        out += c + next;
        i += 2;
        continue;
      }
      if (c === quote || (c === "\n" && quote !== "`")) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/" && source[i - 1] !== ":") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      // 行番号がずれないよう改行だけ残す
      out += source.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 1 ファイル分の検査。file は表示用のパス */
export function scanText(file: string, source: string): Hit[] {
  const rawLines = source.split("\n");
  const isCode = /\.tsx?$/.test(file);
  const lines = isCode ? stripComments(source).split("\n") : rawLines;
  const hits: Hit[] = [];
  lines.forEach((text, idx) => {
    // マーカーはコメントの中に書くので、コメントを落とす前の行で見る
    if (rawLines[idx].includes(ALLOW_MARKER)) return;
    if (idx > 0 && MARKER_ONLY_LINE.test(rawLines[idx - 1])) return;
    for (const word of BANNED_WORDS) {
      if (text.includes(word)) hits.push({ file, line: idx + 1, word, text: rawLines[idx].trim() });
    }
  });
  return hits;
}

function listFiles(dir: string, exts: string[], recursive: boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (recursive) out.push(...listFiles(full, exts, recursive));
    } else if (exts.includes(path.extname(name))) {
      out.push(full);
    }
  }
  return out;
}

/** root 以下の検査対象をすべて見て、見つかった箇所を返す */
export function scanRepo(root: string): { files: number; hits: Hit[] } {
  const files: string[] = [];
  for (const t of TARGETS) {
    const full = path.join(root, t.path);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) files.push(...listFiles(full, t.exts ?? [], t.recursive ?? false));
    else files.push(full);
  }
  // docs/sources は外部の調査資料（他社製品・市場の記述）で、レセメン自身の説明ではない
  const hits = files.filter((f) => !path.relative(root, f).startsWith(path.join("docs", "sources") + path.sep)).flatMap((f) => scanText(path.relative(root, f), readFileSync(f, "utf8")));
  return { files: files.length, hits };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { files, hits } = scanRepo(process.cwd());
  if (hits.length === 0) {
    console.log(`禁止語の検査: ${files} ファイルを見て 0 件`);
  } else {
    for (const h of hits) console.error(`${h.file}:${h.line}: 「${h.word}」 ${h.text.slice(0, 80)}`);
    console.error(
      `\n禁止語の検査: ${hits.length} 件。他社の製品・サービスのカテゴリ名として引用する箇所は、その行か直前行に ${ALLOW_MARKER} と書く`,
    );
    process.exit(1);
  }
}
