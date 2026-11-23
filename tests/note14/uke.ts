// 注14 の道具のテストの作り物の UKE（合成データ）。版の区分の行は writeUke で書き、版の区分にない行（数える行の別表の「乙だけ」のコードなど）は SI のレコードを足して書く。
// 足した行の点数は、レセプトの HO と GO の合計に足す（読み取りの検査を通すため）
import { readFileSync } from "node:fs";
import path from "node:path";
import type { UkeFile, UkeReceipt } from "../../src/uke/types";
import { encodeUke, formatUke, readUke } from "../../src/uke/uke";

const repo = path.join(__dirname, "..", "..");
export const baseFile = (): UkeFile => readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));

/** 足す SI の行：コード・1 回の点数・算定した日（月の中の日の数字） */
export type ExtraSi = { code: string; points: number; days: number[] };

let seq = 0;
/** 作り物の患者（目印の値を入れられる） */
export function receipt(yearMonth: string, lines: UkeReceipt["lines"], p: { name?: string; birth?: string; sex?: 1 | 2; receiptType?: string; no?: string } = {}): UkeReceipt {
  const r = baseFile().receipts[0];
  seq++;
  return {
    ...r,
    claimId: `T${seq}`,
    yearMonth,
    patient: { ...r.patient, name: p.name ?? `架空 患者${seq}`, birth: p.birth ?? `1940${String((seq % 12) + 1).padStart(2, "0")}15`, sex: p.sex ?? 2, receiptType: p.receiptType ?? r.patient.receiptType, insurer: { ...r.patient.insurer, no: p.no ?? String(800 + seq) }, kohi: [] },
    lines,
    others: undefined,
    comments: [],
  };
}

/** UKE のバイト列。extra はレセプトの添字 → 足す SI の行。raw はレセプトの添字 → RE の直後に足す行（未対応のレコードなど。round-61 X-201・X-202）。edit は書き終えた行を直す（同じ単位に行を足すなど。round-62 X-210） */
export function ukeBytes(file: UkeFile, extra: Record<number, ExtraSi[]> = {}, raw: Record<number, string[]> = {}, edit: (lines: string[]) => string[] = (l) => l): Buffer {
  const rows = formatUke(file).split("\r\n").filter((l) => l !== "");
  const out: string[] = [];
  let idx = -1;
  let added = 0;
  let addedHere = 0;
  let hoAt = -1;
  const flush = () => {
    if (idx >= 0) {
      for (const x of extra[idx] ?? []) {
        const c = Array.from({ length: 44 }, () => "");
        c[0] = "SI";
        c[1] = "14";
        c[2] = "1";
        c[3] = x.code;
        c[5] = String(x.points);
        c[6] = String(x.days.length);
        for (const d of x.days) c[13 + d - 1] = String(Number(c[13 + d - 1] || 0) + 1);
        // 同じ日を 2 回数えるときは回数を合わせる
        c[6] = String(c.slice(13).reduce((s, v) => s + Number(v || 0), 0));
        out.push(c.join(","));
        addedHere += x.points * Number(c[6]);
      }
      if (hoAt >= 0 && addedHere > 0) {
        const h = out[hoAt].split(",");
        h[5] = String(Number(h[5]) + addedHere);
        out[hoAt] = h.join(",");
      }
      added += addedHere;
    }
    addedHere = 0;
    hoAt = -1;
  };
  for (const l of rows) {
    if (l.startsWith("RE,") || l.startsWith("GO,")) {
      flush();
      if (l.startsWith("RE,")) idx++;
    }
    if (l.startsWith("GO,")) {
      const g = l.split(",");
      g[2] = String(Number(g[2]) + added);
      out.push(g.join(","));
      continue;
    }
    if (l.startsWith("HO,")) hoAt = out.length;
    out.push(l);
    if (l.startsWith("RE,")) out.push(...(raw[idx] ?? []));
  }
  return encodeUke(`${edit(out).join("\r\n")}\r\n`);
}
