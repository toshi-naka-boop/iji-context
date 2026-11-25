// 段 19b（design.md §16-2）：電子カルテのコードの当て方（rece・yj・local・名称）と、入力欄の種類ごとの当ててよい表（FIELD_TABLES。X-243）、機器の欄（C-422＝X-252）。
// マスターは手で作った小さな masters.db（tests/generic/small-masters.ts。コードは EM の採用値）。LLM は使わない
import { describe, expect, it } from "vitest";
import type { Coded } from "../../src/connect/types";
import { checkMapTarget, FIELD_TABLES, mapCoded, OUT_REASONS, type MapContext, type MapTable } from "../../src/structured/code-map";
import { DEVICE_KINDS } from "../../src/structured/devices";
import { r2026 } from "../../src/engine/revisions/r2026";
import { DEVICE, DRUG, put, smallMasters } from "../generic/small-masters";
import { YM } from "../helpers/period";

const SNAP = "20261001";
/** 医薬品 3 つ（EM §2-8 の症例のコード・§2-11 の錨のコード）。YJ は A123 の値と、同じ YJ の 2 行（統一名収載品の形） */
function db() {
  const d = smallMasters();
  put(d, "iyakuhin", SNAP, { code: "620008991", name: "ゲーベンクリーム１％", yj: "2633705N1031" });
  put(d, "iyakuhin", SNAP, { code: "611120055", name: "ハルシオン０．２５ｍｇ錠", yj: "1124007F2026" });
  put(d, "iyakuhin", SNAP, { code: "671120055", name: "ハルシオン０．２５ｍｇ錠（選）", yj: "1124007F2026" });
  return d;
}
const ctxOf = (maps: Record<string, { tbl: MapTable; code: string }> = {}, d = db()): MapContext => ({ db: d, yearMonth: YM, connectorId: "fixture", localMap: (field, system, value) => maps[`${field}|${system}|${value}`] ?? null });
const rece = (value: string, name: string | null = null): Coded => ({ code: { system: "rece", value }, name });
const yj = (value: string): Coded => ({ code: { system: "yj", value }, name: null });
const local = (value: string, name: string | null = null): Coded => ({ code: { system: "local", value }, name });
const VISIT = r2026.codes.C001_1I.primary;
const KANRI = r2026.codes.C103_2.primary;

describe("入力欄の種類と当ててよい表（FIELD_TABLES）", () => {
  it("薬＝医薬品、材料＝特定器材、行為＝医科診療行為、指導管理＝医科診療行為の C100〜C121、機器＝機器の種類", () => {
    expect(FIELD_TABLES).toEqual({ 薬: "iyakuhin", 材料: "tokutei", 行為: "shinryo", 指導管理: "shinryo_c100", 機器: "device" });
  });
});

describe("rece（規則 1）", () => {
  it("診療年月の 1 枚にあるコードだけ当たる。ないコードは判定の外", () => {
    expect(mapCoded("行為", rece(VISIT), ctxOf())).toMatchObject({ ok: true, code: VISIT, by: "rece" });
    expect(mapCoded("薬", rece(DRUG), ctxOf())).toMatchObject({ ok: true, code: DRUG, table: "iyakuhin" });
    expect(mapCoded("材料", rece(DEVICE), ctxOf())).toMatchObject({ ok: true, code: DEVICE, table: "tokutei" });
    expect(mapCoded("行為", rece("130000510"), ctxOf())).toEqual({ ok: false, reason: OUT_REASONS.notInMaster });
  });
  it("rece の行為の欄に医薬品コードが来ると判定の外（対応先の表が違う）。指導管理の欄は C100〜C121 の行だけ", () => {
    expect(mapCoded("行為", rece(DRUG), ctxOf())).toEqual({ ok: false, reason: OUT_REASONS.wrongTable });
    expect(mapCoded("指導管理", rece(KANRI), ctxOf())).toMatchObject({ ok: true, code: KANRI });
    expect(mapCoded("指導管理", rece(VISIT), ctxOf())).toEqual({ ok: false, reason: OUT_REASONS.wrongTable });
  });
  it("マスターがなければ判定の外", () => {
    expect(mapCoded("行為", rece(VISIT), { ...ctxOf(), db: null })).toEqual({ ok: false, reason: OUT_REASONS.noMaster });
  });
});

describe("yj（規則 2。E-12 の錨 A123 の列）", () => {
  it("ちょうど 1 行なら当たり、0 行・2 行は判定の外（YJ で 1 つに決まらない）", () => {
    expect(mapCoded("薬", yj("2633705N1031"), ctxOf())).toMatchObject({ ok: true, code: "620008991", by: "yj" });
    expect(mapCoded("薬", yj("1124007F2026"), ctxOf())).toEqual({ ok: false, reason: OUT_REASONS.yjAmbiguous });
    expect(mapCoded("薬", yj("9999999Z9999"), ctxOf())).toEqual({ ok: false, reason: OUT_REASONS.yjAmbiguous });
  });
  it("YJ は薬の欄だけ。列のない古い masters.db では、YJ の行は全部判定の外", () => {
    expect(mapCoded("行為", yj("2633705N1031"), ctxOf())).toEqual({ ok: false, reason: OUT_REASONS.wrongTable });
    const old = db();
    old.exec("DROP INDEX iyakuhin_1");
    old.exec("ALTER TABLE iyakuhin DROP COLUMN yj");
    expect(mapCoded("薬", yj("2633705N1031"), ctxOf({}, old))).toEqual({ ok: false, reason: OUT_REASONS.yjUnreadable });
  });
});

describe("local（規則 3）と名称（規則 4）", () => {
  it("独自コードは対応表の行で当たり、表にない行は判定の外（対応表にないコード）", () => {
    const ctx = ctxOf({ "薬|local|001": { tbl: "iyakuhin", code: DRUG } });
    expect(mapCoded("薬", local("001"), ctx)).toMatchObject({ ok: true, code: DRUG, by: "local" });
    expect(mapCoded("薬", local("002"), ctx)).toEqual({ ok: false, reason: OUT_REASONS.noMap });
  });
  it("同じ独自コード 001 でも、欄の種類ごとに別の対応で引く（薬の対応は行為の欄に効かない）", () => {
    const ctx = ctxOf({ "薬|local|001": { tbl: "iyakuhin", code: DRUG }, "行為|local|001": { tbl: "shinryo", code: VISIT } });
    expect(mapCoded("薬", local("001"), ctx)).toMatchObject({ ok: true, code: DRUG });
    expect(mapCoded("行為", local("001"), ctx)).toMatchObject({ ok: true, code: VISIT });
    expect(mapCoded("材料", local("001"), ctx)).toEqual({ ok: false, reason: OUT_REASONS.noMap });
  });
  it("コードなしは、名称の完全一致がちょうど 1 つのときだけ当たる。両方ないと判定の外", () => {
    expect(mapCoded("薬", { code: null, name: "ゲーベンクリーム１％" }, ctxOf())).toMatchObject({ ok: true, code: "620008991", by: "name" });
    expect(mapCoded("薬", { code: null, name: "ゲーベン" }, ctxOf())).toEqual({ ok: false, reason: OUT_REASONS.nameAmbiguous });
    expect(mapCoded("薬", { code: null, name: null }, ctxOf())).toEqual({ ok: false, reason: OUT_REASONS.blank });
  });
});

describe("機器の欄（C-422＝X-252。DEVICE_KINDS への所属で見る）", () => {
  it("rece の 114006210 が C158 に当たる。独自コードを C158 に対応付けると次から当たる。名称は DEVICE_KINDS の名称に完全一致", () => {
    expect(mapCoded("機器", rece("114006210"), ctxOf())).toMatchObject({ ok: true, table: "device", code: "C158", by: "rece" });
    expect(mapCoded("機器", local("D01"), ctxOf())).toEqual({ ok: false, reason: OUT_REASONS.noMap });
    expect(mapCoded("機器", local("D01"), ctxOf({ "機器|local|D01": { tbl: "device", code: "C158" } }))).toMatchObject({ ok: true, code: "C158", by: "local" });
    expect(mapCoded("機器", { code: null, name: "酸素濃縮装置加算" }, ctxOf())).toMatchObject({ ok: true, code: "C158", by: "name" });
    expect(mapCoded("機器", yj("2633705N1031"), ctxOf())).toEqual({ ok: false, reason: OUT_REASONS.wrongTable });
  });
  it("対応を残す先の検査：機器は DEVICE_KINDS のキーだけ（none・マスターのコードは不可）、ほかは欄の当ててよい表に実在するコードだけ", () => {
    const d = db();
    expect(checkMapTarget("機器", "C158", d, YM)).toEqual({ ok: true, tbl: "device" });
    expect(checkMapTarget("機器", "none", d, YM).ok).toBe(false);
    expect(checkMapTarget("機器", "114006210", d, YM).ok).toBe(false);
    expect(checkMapTarget("薬", DRUG, d, YM)).toEqual({ ok: true, tbl: "iyakuhin" });
    expect(checkMapTarget("行為", DRUG, d, YM).ok).toBe(false);
    expect(checkMapTarget("指導管理", KANRI, d, YM)).toEqual({ ok: true, tbl: "shinryo_c100" });
    expect(Object.keys(DEVICE_KINDS)).not.toContain("none");
  });
});
