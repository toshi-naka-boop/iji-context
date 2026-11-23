// 機器の種類（design.md §16-5。W-15）：DEVICE_KINDS が EM の行と 1 対 1（EM §2-8 の別表「規則の候補で使うコード」の機器の行と、§2-2 の項目名）
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { C150_BANDS, DEVICE_KINDS, deviceOfRece } from "../../src/structured/devices";

const em = readFileSync(path.join(__dirname, "..", "..", "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8").split("\n");
const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim());
const start = em.findIndex((l) => l.startsWith("**規則の候補で使うコード"));
/** 別表の機器の行：コード・区分キー（C150 は段と患者の区分つき）・EM の行・マスターの名称 */
const rows = em
  .slice(start, em.findIndex((l, i) => i > start && l.startsWith("### ")))
  .filter((l) => /^\| \d{9} \|/.test(l))
  .map(cells)
  .filter((c) => c[5].startsWith("機器"))
  .map((c) => {
    const m = /^(.+?)（(R8-\d+)）$/.exec(c[1])!;
    return { code: c[0], key: m[1], em: m[2], name: c[2] };
  });
const itemOf = (id: string) => cells(em.find((l) => l.startsWith(`| ${id} |`))!)[2];

describe("DEVICE_KINDS と EM", () => {
  it("区分キーの集合とコードが、EM の別表の機器の行と 1 対 1（C150 は段・患者の区分ごとのコードを 1 つの種類にまとめる）", () => {
    expect(rows.length).toBe(24);
    const fromEm = new Map<string, Set<string>>();
    for (const r of rows) {
      const k = r.key.startsWith("C150_") ? "C150" : r.key;
      fromEm.set(k, (fromEm.get(k) ?? new Set()).add(r.code));
    }
    expect(Object.keys(DEVICE_KINDS).sort()).toEqual([...fromEm.keys()].sort());
    for (const [k, d] of Object.entries(DEVICE_KINDS)) expect([k, [...d.codes].sort()]).toEqual([k, [...fromEm.get(k)!].sort()]);
    // C150 の段と患者の区分のコードも EM の行どおり
    for (const r of rows.filter((x) => x.key.startsWith("C150_"))) {
      const [band, cls] = r.key.split("・");
      const b = C150_BANDS[band];
      expect([r.key, cls ? b[cls as "イ" | "ロ"] : b.one]).toEqual([r.key, r.code]);
    }
  });
  it("名称：先頭は EM §2-2 の行の項目名（人工呼吸器は 3 区分を 1 行に書くのでマスターの名称）、ほかの名称は別表のマスターの名称", () => {
    for (const [k, d] of Object.entries(DEVICE_KINDS)) {
      const masterNames = rows.filter((r) => (k === "C150" ? r.key.startsWith("C150_") : r.key === k)).map((r) => r.name);
      expect([k, d.em]).toEqual([k, rows.find((r) => (k === "C150" ? r.key.startsWith("C150_") : r.key === k))!.em]);
      if (k.startsWith("C164_")) expect(d.names).toEqual(masterNames);
      else {
        expect([k, d.names[0]]).toEqual([k, itemOf(d.em)]);
        for (const n of d.names.slice(1)) expect(masterNames).toContain(n);
      }
    }
  });
  it("rece のコードから区分キーを引く（ちょうど 1 つ）。C150 は段と患者の区分も決まる", () => {
    expect(deviceOfRece("114006210")).toEqual({ kind: "C158" });
    expect(deviceOfRece("114046010")).toEqual({ kind: "C150", c150: { band: "C150_2", patientClass: "イ" } });
    expect(deviceOfRece("114041610")).toBeNull();
  });
});
