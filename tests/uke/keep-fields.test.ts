// UKE の読み取りが、全部の行の点検（design.md §12-2）に要る項目を捨てないこと：単位の診療識別・負担区分、行の数量データ・使用量、
// 特定器材の単位コードと単価、行のコメント欄、算定日ごとの回数。区分キーにした行ごとに、もとのコードと単位の番号が残ること
import iconv from "iconv-lite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JITSUREI } from "../../scripts/gen-uke";
import { resolveRevision } from "../../src/engine/revisions";
import { r2026 } from "../../src/engine/revisions/r2026";
import { mapClaim, parseUke } from "../../src/uke/uke";
import { YM } from "../helpers/period";

const root = path.join(__dirname, "..", "..");
const enc = (s: string) => Buffer.concat([iconv.encode(s, "Shift_JIS"), Buffer.from([0x1a])]);
const rowsOf = (b: Buffer) => new TextDecoder("shift_jis").decode(b.subarray(0, -1)).slice(0, -2).split("\r\n");
const ukeOf = (rows: string[]) => enc(`${rows.join("\r\n")}\r\n`);
const rev = resolveRevision(YM);
const sample = readFileSync(path.join(root, "fixtures/uke/kokuhoren.UKE"));

describe("点検に要る項目を保持する", () => {
  it("診療識別だけを変えた UKE が、読み取りの結果で区別できる（単位と行の両方）", () => {
    const rows = rowsOf(sample);
    const at = rows.findIndex((l) => /^SI,\d{2},/.test(l));
    const cols = rows[at].split(",");
    const original = cols[1];
    const changed = original === "13" ? "14" : "13";
    const other = [...rows];
    other[at] = [cols[0], changed, ...cols.slice(2)].join(",");
    const a = parseUke(sample).claims[0];
    const b = parseUke(ukeOf(other)).claims[0];
    expect(a.units[0].shikibetsu).toBe(original);
    expect(b.units[0].shikibetsu).toBe(changed);
    expect(a.units[0].items[0].shikibetsu).toBe(original);
    expect(b.units[0].items[0].shikibetsu).toBe(changed);
    // ほかは同じ
    const strip = (c: typeof a) => JSON.stringify({ ...c, units: c.units.map((u) => ({ ...u, shikibetsu: "", items: u.items.map((it) => ({ ...it, shikibetsu: "" })) })) });
    expect(strip(b)).toBe(strip(a));
    // 診療識別は区切りに使わないので、区分に引いた結果（エンジンに渡る行）は変わらない
    expect(mapClaim(b, rev).lines).toEqual(mapClaim(a, rev).lines);
  });

  it("負担区分・算定日ごとの回数・数量データ・行のコメント欄を持つ。省略された診療識別は空のまま", () => {
    const claims = parseUke(sample).claims;
    for (const c of claims) {
      for (const u of c.units) {
        expect(u.futan).toMatch(/^[0-9A-Z]$/);
        expect(u.days).toHaveLength(31);
        expect(u.days.reduce((s, n) => s + n, 0)).toBe(u.count);
        expect(u.shikibetsu).toBe(u.items[0].shikibetsu);
      }
    }
    // 行のコメント欄のコメントは、行番号でその行に結び付く
    const withComment = claims.flatMap((c) => c.comments.filter((m) => m.unit !== null).map((m) => ({ c, m })))[0];
    expect(withComment).toBeDefined();
    expect(withComment.c.units[withComment.m.unit!].items.some((it) => it.line === withComment.m.line)).toBe(true);
    // 数量データ（きざみの項目数）は欄のまま
    const quantity = r2026.codes.D_GAIRAI_JINSOKU.primary;
    const items = claims.flatMap((c) => c.units.flatMap((u) => u.items));
    expect(items.filter((it) => it.code === quantity).every((it) => /^\d+$/.test(it.quantity))).toBe(true);
    // 2 行め以降の行は、診療識別を書いていない（書き出しは単位の先頭の行にだけ書く）
    const multi = claims.flatMap((c) => c.units).find((u) => u.items.length > 1)!;
    expect(multi.items.slice(1).every((it) => it.shikibetsu === "")).toBe(true);
  });

  it("医薬品の使用量、特定器材の使用量・単位コード・単価を持つ（検証用の合成の UKE）", () => {
    const claims = parseUke(readFileSync(path.join(root, JITSUREI.file))).claims;
    const items = claims.flatMap((c) => c.units.flatMap((u) => u.items));
    const iy = items.filter((it) => it.kind === "IY");
    const to = items.filter((it) => it.kind === "TO");
    expect(iy.length).toBeGreaterThan(0);
    expect(to.length).toBeGreaterThan(0);
    // 使用量は欄のまま（小数つき）。単位コード・単価は特定器材の行だけが持つ
    expect(iy.some((it) => it.quantity === "0.5")).toBe(true);
    expect(iy.every((it) => /^(\d+(\.\d+)?)?$/.test(it.quantity) && it.unitCode === undefined && it.unitPrice === undefined)).toBe(true);
    expect(to.every((it) => typeof it.unitCode === "string" && typeof it.unitPrice === "string")).toBe(true);
    // 単価を書いた器材の行（購入価格で算定するもの）が、単価を落とさずに読める
    expect(to.some((it) => /^\d+(\.\d+)?$/.test(it.unitPrice!))).toBe(true);
    // 行にだけ書いた単価・単位コードを変えると、読み取りの結果が変わる
    const rows = rowsOf(readFileSync(path.join(root, JITSUREI.file)));
    const at = rows.findIndex((l) => l.startsWith("TO,") && l.split(",")[8] !== "");
    const cols = rows[at].split(",");
    cols[8] = `${cols[8]}1`;
    cols[7] = "37";
    const changed = [...rows];
    changed[at] = cols.join(",");
    const row = (b: Buffer) => parseUke(b).claims.flatMap((c) => c.units.flatMap((u) => u.items)).find((it) => it.line === at + 1)!;
    expect([row(ukeOf(changed)).unitPrice, row(ukeOf(changed)).unitCode]).toEqual([cols[8], "37"]);
    expect([row(ukeOf(rows)).unitPrice, row(ukeOf(rows)).unitCode]).toEqual([cols[8].slice(0, -1), ""]);
  });
});

describe("行とコードの対応（mapClaim の origins）", () => {
  it("区分キーにした行ごとに、単位の番号と、もとの UKE のコード（primary・accept・包括の検査の項目）が残る。行の形は変えない", () => {
    for (const file of ["fixtures/uke/shiharaikikin.UKE", "fixtures/uke/kokuhoren.UKE", JITSUREI.file]) {
      for (const claim of parseUke(readFileSync(path.join(root, file))).claims) {
        if (claim.unsupported !== undefined) continue;
        const mapped = mapClaim(claim, rev);
        expect(mapped.origins).toHaveLength(mapped.lines.length);
        mapped.lines.forEach((line, i) => {
          const o = mapped.origins[i];
          const unit = claim.units[o.unit];
          expect(Object.keys(line).sort().filter((k) => k !== "items")).toEqual(["count", "dates", "kubun"]);
          expect(o.codes.every((code) => unit.items.some((it) => it.code === code))).toBe(true);
          if (o.via === "bundle") expect(o.codes).toEqual(line.items);
          else {
            const def = rev.codes[line.kubun];
            expect(o.codes).toHaveLength(1);
            expect(o.via === "primary" ? def.primary : def.accept.includes(o.codes[0]) ? o.codes[0] : null).toBe(o.codes[0]);
          }
        });
        // 対象外の単位の行は、対応にも入らない
        const mappedUnits = new Set(mapped.origins.map((o) => o.unit));
        for (const other of mapped.others) expect(mappedUnits.has(other.unit)).toBe(false);
      }
    }
  });

  it("accept のコードで書かれた行は、accept として残る", () => {
    const def = r2026.codes.F400_3;
    const rows = rowsOf(readFileSync(path.join(root, JITSUREI.file)));
    const at = rows.findIndex((l) => l.startsWith("SI,") && l.split(",")[3] === def.primary);
    expect(at).toBeGreaterThan(0);
    const cols = rows[at].split(",");
    cols[3] = def.accept[0];
    const changed = [...rows];
    changed[at] = cols.join(",");
    const claim = parseUke(ukeOf(changed)).claims.find((c) => c.units.some((u) => u.items.some((it) => it.code === def.accept[0])))!;
    const mapped = mapClaim(claim, rev);
    const i = mapped.lines.findIndex((l) => l.kubun === "F400_3");
    expect(mapped.origins[i]).toMatchObject({ codes: [def.accept[0]], via: "accept" });
  });
});
