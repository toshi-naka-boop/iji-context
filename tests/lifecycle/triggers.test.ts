import { describe, expect, it } from "vitest";
import calendarJson from "../../config/calendar.json";
import type { Calendar } from "../../src/lifecycle/calendar";
import { transition } from "../../src/lifecycle/machine";
import { evaluateTriggers } from "../../src/lifecycle/triggers";
import { at, dateIn, YM } from "../helpers/period";
import { makeMeta } from "./helpers";

const cal = calendarJson as Calendar;
const day = (iso: string, plus: number) =>
  `${new Date(Date.parse(iso) + plus * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10)}T00:00:00+09:00`;

describe("config/calendar.json", () => {
  it("改定は偶数年 6/1、支払基金の改選は奇数年 6/1、東京都の国保連は null", () => {
    expect(cal.revision).toEqual({ parity: "even", monthDay: "06-01" });
    expect(cal.shiharaiKikin).toEqual({ parity: "odd", monthDay: "06-01" });
    expect(cal.kokuhoren["東京都"]).toBeNull();
  });
});

describe("① 改定", () => {
  const sys = (over = {}) => makeMeta({ id: "system/r01", layer: "制度", match: { ruleId: "R01" }, ...over });
  it("改定日が status_since より後なら TRIGGER{revision}", () => {
    const r = evaluateTriggers([sys({ status_since: "2024-01-01T00:00:00+09:00" })], "2024-06-01T00:00:00+09:00", cal);
    expect(r).toEqual([{ knowledgeId: "system/r01", event: { type: "TRIGGER", trigger: "revision" } }]);
  });
  it("改定日の前日は発火しない", () => {
    expect(evaluateTriggers([sys({ status_since: "2024-01-01T00:00:00+09:00" })], "2024-05-31T00:00:00+09:00", cal)).toEqual([]);
  });
  it("改定日以降に承認済みになった知識は発火しない", () => {
    expect(evaluateTriggers([sys({ status_since: "2024-06-01T00:00:00+09:00" })], "2025-03-01T00:00:00+09:00", cal)).toEqual([]);
  });
  it("制度層は 180 日経っても idle で発火しない", () => {
    expect(evaluateTriggers([sys({ status_since: "2024-06-02T00:00:00+09:00" })], "2025-05-30T00:00:00+09:00", cal)).toEqual([]);
  });
});

describe("制度層の要再検証", () => {
  it("180 日経っても IDLE_EXPIRED にならない", () => {
    const m = makeMeta({ id: "system/r01", layer: "制度", status: "要再検証", match: { ruleId: "R01" }, status_since: "2024-06-01T00:00:00+09:00" });
    expect(evaluateTriggers([m], "2025-05-31T00:00:00+09:00", cal)).toEqual([]);
    expect(evaluateTriggers([m], "2030-01-01T00:00:00+09:00", cal)).toEqual([]);
  });
});

describe("② 改選", () => {
  it("2025-06-01 で K6（支払基金）の地域知識が要再検証になる", () => {
    const k6 = makeMeta({ id: "regional/k6", status_since: "2025-03-31T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "支払基金", prefecture: "東京都" } });
    const fired = evaluateTriggers([k6], "2025-06-01T00:00:00+09:00", cal);
    expect(fired).toEqual([{ knowledgeId: "regional/k6", event: { type: "TRIGGER", trigger: "reappointment" } }]);
    expect(transition(k6, fired[0].event, "2025-06-01T00:00:00+09:00").meta.status).toBe("要再検証");
    expect(evaluateTriggers([k6], "2025-05-31T00:00:00+09:00", cal)).toEqual([]);
  });
  it("国保連の改選日が null（東京都）なら発火しない", () => {
    const m = makeMeta({ status_since: "2020-01-01T00:00:00+09:00", last_hit_at: "2025-05-30T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "国保連", prefecture: "東京都" } });
    expect(evaluateTriggers([m], "2025-06-01T00:00:00+09:00", cal)).toEqual([]);
  });
  it("カレンダーに都道府県の日付が入っていれば発火する。未登録の都道府県は発火しない", () => {
    const c: Calendar = { ...cal, kokuhoren: { 東京都: ["2025-09-01"] } };
    const m = makeMeta({ status_since: "2025-03-01T00:00:00+09:00", last_hit_at: "2025-09-01T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "国保連", prefecture: "東京都" } });
    expect(evaluateTriggers([m], "2025-08-31T00:00:00+09:00", c)).toEqual([]);
    expect(evaluateTriggers([m], "2025-09-01T00:00:00+09:00", c)).toHaveLength(1);
    const other = makeMeta({ status_since: "2025-03-01T00:00:00+09:00", last_hit_at: "2025-09-01T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "国保連", prefecture: "大阪府" } });
    expect(evaluateTriggers([other], "2025-09-01T00:00:00+09:00", c)).toEqual([]);
  });
  it("改選は地域層だけ。ベテラン層・院内層は改選日を過ぎても落ちない", () => {
    const v = makeMeta({ id: "veteran/a", layer: "ベテラン", status_since: "2025-03-01T00:00:00+09:00", last_hit_at: "2025-05-30T00:00:00+09:00", match: {} });
    const l = makeMeta({ id: "local/a", layer: "院内", status_since: "2025-03-01T00:00:00+09:00", last_hit_at: "2025-05-30T00:00:00+09:00", match: {} });
    expect(evaluateTriggers([v, l], "2025-06-01T00:00:00+09:00", cal)).toEqual([]);
  });
});

describe("③ idle", () => {
  const base = "2025-01-01T00:00:00+09:00";
  it("180 日ちょうどで発火し、179 日では発火しない（ベテラン層）", () => {
    const v = makeMeta({ id: "veteran/a", layer: "ベテラン", status_since: base, match: {} });
    expect(evaluateTriggers([v], day(base, 179), cal)).toEqual([]);
    expect(evaluateTriggers([v], day(base, 180), cal)).toEqual([
      { knowledgeId: "veteran/a", event: { type: "TRIGGER", trigger: "idle" } },
    ]);
  });
  it("起点は max(last_hit_at, status_since)", () => {
    const v = makeMeta({ id: "veteran/a", layer: "ベテラン", status_since: base, last_hit_at: "2025-03-01T00:00:00+09:00", match: {} });
    expect(evaluateTriggers([v], day(base, 200), cal)).toEqual([]);
    expect(evaluateTriggers([v], day("2025-03-01T00:00:00+09:00", 180), cal)).toHaveLength(1);
  });
  it("院内層の idle も発火する", () => {
    const l = makeMeta({ id: "local/a", layer: "院内", status_since: base, match: {} });
    expect(evaluateTriggers([l], day(base, 180), cal)).toHaveLength(1);
  });
  it("要再検証は 180 日で IDLE_EXPIRED", () => {
    const m = makeMeta({ id: "veteran/a", layer: "ベテラン", status: "要再検証", status_since: base, match: {} });
    expect(evaluateTriggers([m], day(base, 180), cal)).toEqual([{ knowledgeId: "veteran/a", event: { type: "IDLE_EXPIRED" } }]);
    expect(evaluateTriggers([m], day(base, 179), cal)).toEqual([]);
  });
  it("未検証・contested・停止・保管はトリガーの対象外", () => {
    const ms = (["未検証", "contested", "停止", "保管"] as const).map((status) => makeMeta({ status, status_since: base }));
    expect(evaluateTriggers(ms, "2030-01-01T00:00:00+09:00", cal)).toEqual([]);
  });
});

describe("1 件の知識につきイベントは最大 1 件", () => {
  it("改選と idle が同時に該当しても 1 件（改選が優先）", () => {
    const m = makeMeta({ status_since: "2024-01-01T00:00:00+09:00", last_hit_at: "2024-01-02T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "支払基金", prefecture: "東京都" } });
    const r = evaluateTriggers([m], "2025-06-01T00:00:00+09:00", cal);
    expect(r).toEqual([{ knowledgeId: "regional/sample", event: { type: "TRIGGER", trigger: "reappointment" } }]);
  });
});

describe("DISPOSAL_REJECT 直後", () => {
  it("即座に再発火しない（status_since が戻った日になる）", () => {
    const stopped = makeMeta({ status: "停止", status_since: "2025-02-01T00:00:00+09:00", last_hit_at: "2024-01-01T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "支払基金", prefecture: "東京都" } });
    const now = "2025-06-01T00:00:00+09:00";
    const back = transition(stopped, { type: "DISPOSAL_REJECT" }, now).meta;
    expect(evaluateTriggers([back], now, cal)).toEqual([]);
    expect(evaluateTriggers([back], day(now, 179), cal)).toEqual([]);
    expect(evaluateTriggers([back], day(now, 180), cal)).toHaveLength(1);
  });
});

describe("v21：修正版は元の知識の層の改定・改選を引き継ぐ（round-15 X-57）", () => {
  it("制度層の知識の修正版（ベテラン層）は改定日を過ぎると要再検証、地域層の知識の修正版は改選日を過ぎると要再検証", () => {
    const sys = makeMeta({ id: "system/r01", layer: "制度", match: { ruleId: "R01" }, status: "保管" });
    const fixSys = makeMeta({ id: "veteran/fix-sys", layer: "ベテラン", relates_to: "system/r01", match: { ruleId: "R01" }, status_since: "2025-07-01T00:00:00+09:00" });
    const reg = makeMeta({ id: "regional/a", layer: "地域", status: "保管" });
    const fixReg = makeMeta({ id: "veteran/fix-reg", layer: "ベテラン", relates_to: "regional/a", status_since: "2025-07-01T00:00:00+09:00", last_hit_at: "2026-06-01T00:00:00+09:00" });
    const plain = makeMeta({ id: "veteran/plain", layer: "ベテラン", status_since: "2025-07-01T00:00:00+09:00", last_hit_at: "2026-06-01T00:00:00+09:00" });
    const metas = [sys, fixSys, reg, fixReg, plain];
    const fired = evaluateTriggers(metas, "2026-06-02T00:00:00+09:00", cal);
    expect(fired.find((f) => f.knowledgeId === "veteran/fix-sys")?.event).toEqual({ type: "TRIGGER", trigger: "revision" });
    expect(evaluateTriggers([reg, fixReg], "2027-06-02T00:00:00+09:00", cal).find((f) => f.knowledgeId === "veteran/fix-reg")?.event).toEqual({ type: "TRIGGER", trigger: "reappointment" });
    expect(fired.find((f) => f.knowledgeId === "veteran/plain")).toBeUndefined();
  });
});

// design.md §4-7・§7 #4：K6 の地域知識（支払基金）の降格の筋書き。日付は基準月（config/demo.json）から作る
describe("K6 の地域知識：改選と、使われない期間", () => {
  /** 基準月の 14 日に承認した、支払基金・東京都の地域知識（近似なので、提出結果では last_hit_at が動かない） */
  const k6 = () =>
    makeMeta({
      id: "regional/k6-bnp",
      layer: "地域",
      polarity: "avoid",
      matchApprox: true,
      conditionNote: "通知の理由：（合成）",
      match: { kubunAll: ["D008_19"], payer: "支払基金", prefecture: "東京都" },
      status_since: at(14),
      valid_from: at(14),
    });
  const june5 = `${dateIn(8, 5)}T09:00:00+09:00`;
  const april17 = `${dateIn(6, 17)}T09:00:00+09:00`;

  it("前提：基準月の翌年の 6 月 1 日が、支払基金の次の改選日（奇数年）。そこまで 180 日を超える", () => {
    expect(dateIn(8, 1).slice(0, 4)).toBe(String(Number(YM.slice(0, 4)) + 1));
    expect(Number(dateIn(8, 1).slice(0, 4)) % 2).toBe(1);
    expect(dateIn(8, 1).slice(5)).toBe(cal.shiharaiKikin.monthDay);
    expect((Date.parse(`${dateIn(8, 1)}T00:00:00+09:00`) - Date.parse(at(14))) / 86_400_000).toBeGreaterThan(180);
  });
  it("時計を改選日の後（翌年 6 月 5 日）へ 1 回で進めると、改選と使われない期間の両方が当たるが、出るのは改選の 1 件だけ", () => {
    expect(evaluateTriggers([k6()], june5, cal)).toEqual([{ knowledgeId: "regional/k6-bnp", event: { type: "TRIGGER", trigger: "reappointment" } }]);
  });
  it("改選日より前（翌年 4 月 17 日）の整理では、使われない期間（180 日）が先に当たる", () => {
    expect(evaluateTriggers([k6()], april17, cal)).toEqual([{ knowledgeId: "regional/k6-bnp", event: { type: "TRIGGER", trigger: "idle" } }]);
  });
  it("承認から 180 日たつ前は、何も出ない。未承認のまま時計を進めても、何も出ない", () => {
    expect(evaluateTriggers([k6()], `${dateIn(5, 31)}T09:00:00+09:00`, cal)).toEqual([]);
    expect(evaluateTriggers([{ ...k6(), status: "未検証" }], june5, cal)).toEqual([]);
  });
  it("同じ整理で、種の日付（基準月の初日）で入った制度層の知識は動かない（次の改定は偶数年の 6 月 1 日）", () => {
    const sys = makeMeta({ id: "system/r01", layer: "制度", match: { ruleId: "R01" }, status_since: `${YM}-01T00:00:00+09:00` });
    expect(evaluateTriggers([sys, k6()], june5, cal).map((e) => e.knowledgeId)).toEqual(["regional/k6-bnp"]);
  });
});
