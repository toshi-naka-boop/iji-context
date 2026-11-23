// 段 19a（design.md §16-1・16-10）：構造化データの型、能力の申告と欠けの数え方、合成の接続先の structured。AI は呼ばない
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureConnector } from "../../src/connect/fixture";
import { readStructured, BAD_ROW } from "../../src/structured/read";
import { day, YM } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});
/** 同梱の fixtures を見せ、structured/ だけを作った根（テスト用の作った症例。値は形の確かめだけに使う） */
function rootWith(structured: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), "resemen-structured-"));
  tmps.push(root);
  mkdirSync(path.join(root, "fixtures"));
  for (const d of ["uke", "cases", "charts"]) symlinkSync(path.join(repo, "fixtures", d), path.join(root, "fixtures", d));
  mkdirSync(path.join(root, "fixtures", "structured"));
  for (const [id, body] of Object.entries(structured)) writeFileSync(path.join(root, "fixtures", "structured", `${id}.json`), JSON.stringify(body));
  return root;
}

describe("能力の申告（design.md §16-1）", () => {
  it("structured のない接続先は、4 種類とも unsupported として読まれる（今のコネクタはそのまま通る）", async () => {
    expect(readStructured({})).toEqual({ visits: { status: "unsupported" }, orders: { status: "unsupported" }, procedures: { status: "unsupported" }, homeCare: { status: "unsupported" } });
    // 同梱の合成データの接続先も、structured/ のファイルがない患者は持たない
    const chart = await createFixtureConnector(repo).chart!.getChart({ patientId: "K1", yearMonth: YM });
    expect(chart.structured).toBeUndefined();
    expect(Object.values(readStructured(chart)).map((p) => p.status)).toEqual(["unsupported", "unsupported", "unsupported", "unsupported"]);
  });

  it("0 件（supported で行がない）と unsupported は別に返る。申告の値がほかの文字なら unsupported", () => {
    const s = readStructured({ structured: { visits: { status: "supported", items: [], gaps: {} }, orders: { status: "unsupported" }, procedures: { status: "yes" }, homeCare: { status: "supported", items: [], gaps: {} } } as never });
    expect(s.visits).toEqual({ status: "supported", items: [], gaps: {} });
    expect(s.orders).toEqual({ status: "unsupported" });
    expect(s.procedures).toEqual({ status: "unsupported" });
    expect(s.homeCare).toEqual({ status: "supported", items: [], gaps: {} });
  });

  it("null の欄が欄ごとに数えられ、接続先の申告した欠けの数と違っても手元の数が使われる", () => {
    const s = readStructured({
      structured: {
        visits: {
          status: "supported",
          // 接続先は「欠けなし」と申告しているが、終了の時刻が 2 件ない
          gaps: {},
          items: [
            { ref: "v1", date: day(3), start: "09:00", end: null, kind: "訪問診療" },
            { ref: "v2", date: day(10), start: "09:00", end: null, kind: null },
            { ref: "v3", date: day(17), start: "9時", end: "10:10", kind: "往診" },
            { date: day(24), start: "09:00", end: "10:00", kind: "往診" },
          ],
        },
        orders: {
          status: "supported",
          gaps: { place: 0, "drugs.days": 0 },
          items: [{ ref: "o1", date: day(3), place: null, refills: null, drugs: [{ code: { system: "yj", value: "" }, name: null, days: 14, quantity: null }, { code: { system: "rece", value: "620008991" }, name: null, days: null, quantity: "20g" }] }],
        },
        procedures: { status: "supported", gaps: { count: 9 }, items: [{ ref: "p1", date: day(3), act: { code: null, name: "注射" }, count: 1, items: [{ kind: "器材", code: null, name: null, quantity: null, unit: null }] }] },
        homeCare: { status: "supported", gaps: {}, items: [{ ref: "h1", kind: { code: null, name: null }, devices: [{ code: { system: "local", value: "001" }, name: "酸素", startedOn: null, endedOn: null }], startedOn: null }] },
      } as never,
    });
    expect(s.visits.status === "supported" && s.visits.gaps).toEqual({ start: 1, end: 2, kind: 1, [BAD_ROW]: 1 });
    expect(s.visits.status === "supported" && s.visits.items.map((v) => v.ref)).toEqual(["v1", "v2", "v3"]);
    // コードの値が空なら、コードは null。コードも表示名もない行は「当てられない」欠けに数える
    expect(s.orders.status === "supported" && s.orders.gaps).toEqual({ place: 1, refills: 1, "drugs.coded": 1, "drugs.days": 1, "drugs.quantity": 1 });
    expect(s.orders.status === "supported" && s.orders.items[0].drugs[0].code).toBeNull();
    expect(s.procedures.status === "supported" && s.procedures.gaps).toEqual({ "items.coded": 1, "items.quantity": 1, "items.unit": 1 });
    expect(s.homeCare.status === "supported" && s.homeCare.gaps).toEqual({ "kind.coded": 1, "devices.startedOn": 1, "devices.endedOn": 1, startedOn: 1 });
  });
});

describe("合成の接続先の structured（FR-105。fixtures/structured/<症例>.json）", () => {
  it("ファイルのある患者は、日のある 3 種類をその月の行だけにして返す。在宅療養の指示は日で切らない", async () => {
    const other = `${Number(YM.slice(0, 4)) - 1}${YM.slice(4)}-05`;
    const root = rootWith({
      K1: {
        visits: { status: "supported", items: [{ ref: "v1", date: day(3), start: "09:00", end: "09:40", kind: "訪問診療" }, { ref: "v0", date: other, start: "09:00", end: "09:40", kind: "訪問診療" }] },
        orders: { status: "supported", items: [] },
        procedures: { status: "unsupported" },
        homeCare: { status: "supported", items: [{ ref: "h1", kind: { code: null, name: "在宅酸素" }, devices: [], startedOn: other }] },
      },
    });
    const s = readStructured(await createFixtureConnector(root).chart!.getChart({ patientId: "K1", yearMonth: YM }));
    expect(s.visits.status === "supported" && s.visits.items.map((v) => v.ref)).toEqual(["v1"]);
    expect(s.orders).toEqual({ status: "supported", items: [], gaps: {} });
    expect(s.procedures).toEqual({ status: "unsupported" });
    expect(s.homeCare.status === "supported" && s.homeCare.items.map((h) => h.ref)).toEqual(["h1"]);
  });
});
