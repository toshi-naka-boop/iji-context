// 公開データの CSV を流して読む（design.md §12-1）。Shift_JIS・カンマ区切り・全項目が二重引用符つき・CRLF（万病辞書は UTF-8・引用符なし・LF。config の encoding）。
// ファイルをまるごとメモリに載せない（128 万行のファイルがある）。大きさ・行数・1 行の長さに上限を置き、超えたら断る
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** 読むときの上限（設計の値）。いちばん大きい公開ファイル（医薬品適応関連マスタ：約 160MB・128 万行）の数倍 */
export const MASTER_LIMITS = {
  maxBytes: 600 * 1024 * 1024,
  maxRows: 5_000_000,
  /** 1 行の文字数（いちばん長いのは医科診療行為マスターの 1 行で、1,000 文字ほど） */
  maxLineChars: 20_000,
} as const;

/** 形式が合わない入力。理由は定型文と行番号だけ（行の中身は入れない） */
export class MasterFormatError extends Error {
  constructor(reason: string, line?: number) {
    super(line === undefined ? reason : `${line} 行目：${reason}`);
    this.name = "MasterFormatError";
  }
}

/** 引用符つきの CSV の 1 行を欄に分ける（欄の中の "" は " 1 つ）。引用符が閉じていない行は断る */
export function cellsOf(line: string, lineNo?: number): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (quoted) throw new MasterFormatError("引用符が閉じていない（欄の中の改行には対応していない）", lineNo);
  out.push(cur);
  return out;
}

/**
 * ファイルを 1 行ずつ読み、欄に分けて onRow に渡す（行番号は 1 起算）。Shift_JIS として読めない・上限を超える・引用符が閉じない入力は MasterFormatError。
 * 戻り値はファイルの sha256（16 進）と大きさ
 */
export function readCsv(file: string, onRow: (cells: string[], line: number) => void, limits: { maxBytes: number; maxRows: number; maxLineChars: number } = MASTER_LIMITS, encoding: "shift_jis" | "utf-8" = "shift_jis"): { sha256: string; bytes: number } {
  const label = encoding === "utf-8" ? "UTF-8" : "Shift_JIS";
  const fd = openSync(file, "r");
  try {
    const bytes = fstatSync(fd).size;
    if (bytes > limits.maxBytes) throw new MasterFormatError("ファイルが大きすぎる");
    const hash = createHash("sha256");
    const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: false });
    const buf = Buffer.alloc(1024 * 1024);
    let rest = "";
    let line = 0;
    const emit = (l: string) => {
      line++;
      if (line > limits.maxRows) throw new MasterFormatError("行数が上限を超えている");
      if (l.length > limits.maxLineChars) throw new MasterFormatError("1 行が長すぎる", line);
      // 末尾の EOF(0x1A) だけの行は読み飛ばす
      if (l === "" || l === "\u001a") return;
      onRow(cellsOf(l, line), line);
    };
    const feed = (textChunk: string) => {
      const parts = (rest + textChunk).split("\n");
      rest = parts.pop() ?? "";
      for (const p of parts) emit(p.replace(/\r$/, ""));
      if (rest.length > limits.maxLineChars) throw new MasterFormatError("1 行が長すぎる", line + 1);
    };
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const chunk = buf.subarray(0, n);
      hash.update(chunk);
      try {
        feed(decoder.decode(chunk, { stream: true }));
      } catch (e) {
        if (e instanceof MasterFormatError) throw e;
        throw new MasterFormatError(`${label} として読めない`);
      }
    }
    try {
      feed(decoder.decode());
    } catch (e) {
      if (e instanceof MasterFormatError) throw e;
      throw new MasterFormatError(`${label} として読めない`);
    }
    if (rest !== "") emit(rest.replace(/\r$/, ""));
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    closeSync(fd);
  }
}
