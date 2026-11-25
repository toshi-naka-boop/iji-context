// design.md §7 #15：施設の設定（§2-7）。config/facility.json の null は「不明」、症例の上書きは既定値に重なり、ほかの症例に漏れない
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { facilityOf, type FacilityJson } from "../../src/engine/facility";
import { CASES } from "../../scripts/gen-uke";
import { loadCase } from "./helpers";

const root = path.join(__dirname, "..", "..");
const config = JSON.parse(readFileSync(path.join(root, "config", "facility.json"), "utf8")) as FacilityJson;

describe("施設の設定", () => {
  it("既定値は EM §5 の施設設定：DX 加算1・ベースアップ評価料は通常・物価対応料を算定・注16 の基準を満たす", () => {
    const f = facilityOf(config);
    expect(f.dxTier).toEqual({ known: true, value: "1" });
    expect(f.baseUp).toEqual({ known: true, value: "通常" });
    expect(f.priceResponse).toEqual({ known: true, value: true });
    expect(f.note16Met).toEqual({ known: true, value: true });
    expect(f).toMatchObject({ zaishishin: true, kyokagata: false, hasBeds: false, prefecture: "東京都" });
  });
  it("JSON の null は known: false になる（両方を算定した日の重ねの設定は、加算ごとに不明のまま）", () => {
    expect(config.revisitBaseUpSameDay).toBeNull();
    expect(config.revisitPriceSameDay).toBeNull();
    const f = facilityOf(config);
    expect(f.revisitBaseUpSameDay).toEqual({ known: false });
    expect(f.revisitPriceSameDay).toEqual({ known: false });
    expect(facilityOf({ ...config, note16Met: null }).note16Met).toEqual({ known: false });
  });
  it("項目がない設定も「不明」として読む（古い設定ファイル）", () => {
    const { dxTier: _dx, ...old } = config;
    expect(facilityOf(old as FacilityJson).dxTier).toEqual({ known: false });
  });
  it("症例の上書きが既定値に重なり、既定値そのものは変わらない", () => {
    const over = facilityOf(config, { note16Met: false, dxTier: "2" });
    expect(over.note16Met).toEqual({ known: true, value: false });
    expect(over.dxTier).toEqual({ known: true, value: "2" });
    expect(over.baseUp).toEqual({ known: true, value: "通常" });
    expect(facilityOf(config).note16Met).toEqual({ known: true, value: true });
    expect(config.note16Met).toBe(true);
  });
  it("選べない値は読み込みで断る", () => {
    expect(() => facilityOf({ ...config, dxTier: "3" as never })).toThrow();
    expect(() => facilityOf({ ...config, note16Met: "はい" as never })).toThrow();
  });
  it("同梱の症例のうち、K7 だけが注16 の基準を満たさない。上書きはほかの症例に漏れない", () => {
    const met = Object.fromEntries(CASES.map((k) => [k, loadCase(k).facility.note16Met]));
    for (const k of CASES) expect(met[k], k).toEqual({ known: true, value: k !== "K7" });
    // K7 を読んだあとに読んだ症例にも影響しない
    loadCase("K7");
    expect(loadCase("K2").facility.note16Met).toEqual({ known: true, value: true });
  });
});
