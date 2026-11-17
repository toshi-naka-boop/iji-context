// §7 #13：架空コードの明示の表（design.md §2-6）。行は追記だけ
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_TABLE, fictionalCode, kubunOfCode } from "../../src/engine/codes-fictional";
import { REVISIONS } from "../../src/engine/revisions";
import { UKE_FILES } from "../../scripts/gen-uke";

type Row = { kubun: string; code: string };
const root = path.join(__dirname, "..", "..");
const lock = JSON.parse(readFileSync(path.join(__dirname, "codes.lock.json"), "utf8")) as Row[];

/** 写しが表の先頭と完全に一致するか（行を変える・消す・並べ替えると偽。末尾に足しても真） */
const matchesHead = (copy: Row[], table: readonly Row[]) => copy.length <= table.length && copy.every((r, i) => r.kubun === table[i].kubun && r.code === table[i].code);

describe("架空コードの表", () => {
  it("codes.lock.json が CODE_TABLE の先頭と完全に一致する", () => {
    expect(lock.length).toBeGreaterThan(0);
    expect(matchesHead(lock, CODE_TABLE)).toBe(true);
  });

  it("行を 1 つ書き換える・消す・並べ替えると落ち、末尾に足しても落ちない", () => {
    const table = CODE_TABLE.map((r) => ({ ...r }));
    expect(matchesHead(lock, [...table, { kubun: "NEW_KUBUN", code: "999999999" }])).toBe(true);
    expect(matchesHead(lock, table.map((r, i) => (i === 3 ? { ...r, code: "990009999" } : r)))).toBe(false);
    expect(matchesHead(lock, table.map((r, i) => (i === 3 ? { ...r, kubun: "RENAMED" } : r)))).toBe(false);
    expect(matchesHead(lock, table.filter((_, i) => i !== 3))).toBe(false);
    expect(matchesHead(lock, [table[1], table[0], ...table.slice(2)])).toBe(false);
    // 写しのほうを書き換えても、今の表とは合わない
    expect(matchesHead(lock.map((r, i) => (i === 0 ? { ...r, code: "990009999" } : r)), CODE_TABLE)).toBe(false);
  });

  it("コード・キーの重複なし。形式は 99＋7 桁。行の順に厳密に増える", () => {
    expect(new Set(CODE_TABLE.map((r) => r.kubun)).size).toBe(CODE_TABLE.length);
    expect(new Set(CODE_TABLE.map((r) => r.code)).size).toBe(CODE_TABLE.length);
    for (const r of CODE_TABLE) expect(r.code).toMatch(/^99\d{7}$/);
    for (let i = 1; i < CODE_TABLE.length; i++) expect(Number(CODE_TABLE[i].code)).toBeGreaterThan(Number(CODE_TABLE[i - 1].code));
  });

  it("全版の点数表の区分に行がある", () => {
    for (const rev of REVISIONS) for (const kubun of Object.keys(rev.points)) expect(() => fictionalCode(kubun), `${rev.id} ${kubun}`).not.toThrow();
  });

  it("fictionalCode → kubunOfCode で元に戻る。表にない区分・コードは例外", () => {
    for (const r of CODE_TABLE) {
      expect(fictionalCode(r.kubun)).toBe(r.code);
      expect(kubunOfCode(fictionalCode(r.kubun))).toBe(r.kubun);
    }
    expect(() => fictionalCode("XXXX")).toThrow(/未知の区分/);
    for (const bad of ["990009999", "980000001", "99000001", ""]) expect(() => kubunOfCode(bad)).toThrow(/未知のコード/);
  });

  it("同梱の UKE の診療行為コードは、すべて表にある（明示の表に替えても読める）", () => {
    for (const file of Object.values(UKE_FILES)) {
      const text = new TextDecoder("shift_jis").decode(readFileSync(path.join(root, file)));
      const codes = text.split("\r\n").filter((l) => l.startsWith("SI,")).map((l) => l.split(",")[3]);
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) expect(() => kubunOfCode(code), `${file} ${code}`).not.toThrow();
    }
  });
});
