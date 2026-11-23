// 段 19h（design.md §16-10）の受け入れのうち AI を使わない部分を、実データの masters.db と受け入れの症例 K12・K13（EM §5-1。E-13）で確かめる。
// 入力は同梱の合成データだけ：請求は fixtures/uke/kozoka.UKE、構造化データは合成の接続先（src/connect/fixture.ts）が返す fixtures/structured/K12・K13.json、
// カルテの文章と確かめたあとの行ったことは fixtures/charts/K12・K13.json、患者の機器は同じ structured の patientDevices（合成の設定）。
// G11 の入力の組み立ては、画面の経路（src/server/app/torikawasure.ts の run・src/server/app/structured.ts の structuredRulesOf）と同じ部品で行う。LLM は使わない。
// K13 に院外の日はないので、院外の日の処方箋料と「院外の日に調剤料が出ない」は、K13 のオーダーの院内・院外だけを変えた作り物の入力で確かめる（EM §5-1-2・設計 16-10 の判断）。
// データは同梱しないので、環境変数 RESEMEN_MASTER_DIR（masters.db のあるフォルダ）があるときだけ動く。ないときは飛ばし、飛ばした数を表示する
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChartAct, RxChoice, RxNote } from "../../src/chart/acts";
import { rxDefault } from "../../src/chart/rx-default";
import { createFixtureConnector, FIXTURE_ID } from "../../src/connect/fixture";
import type { RxOrder, StructuredChart } from "../../src/connect/types";
import { evaluateG11, type ConfirmedAct, type G11Claim, type G11Devices, type G11Finding, type G11Result, type G11Structured, type RxDay } from "../../src/generic/g11";
import { openMasters, type MastersDb } from "../../src/masters/db";
import { effectiveDevices, type DeviceRow } from "../../src/structured/devices";
import { withStructured } from "../../src/structured/g11-input";
import { itemsOf, ORDER_MISSING } from "../../src/structured/overlap";
import { readStructured } from "../../src/structured/read";
import { RULE_CODES as R } from "../../src/structured/rule-codes";
import { parseUke } from "../../src/uke/uke";
import { demoDeclaration, repo, rev, YM } from "./g11-helpers";
import { month } from "../helpers/period";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
let skipped = 0;
const withData = (name: string, fn: () => void) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn);
};
let db: MastersDb | null = null;
afterAll(() => {
  db?.close();
  if (!has) process.stderr.write(`段 19h の実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
});

type Case = "K12" | "K13";
type Entry = { date: string; s: string; o: string; a: string; p: string; rx: string; acts: ChartAct[]; rxNotes: RxNote[]; rxChoice: RxChoice | null };
/** 合成の接続先が返す当月と、さかのぼる月（rxLookbackMonths。config/structured.json）の構造化データ */
type Fetched = { chart: StructuredChart; history: { yearMonth: string; chart: StructuredChart }[] };
const fetched = new Map<Case, Fetched>();
const LOOKBACK = (JSON.parse(readFileSync(path.join(repo, "config", "structured.json"), "utf8")) as { rxLookbackMonths: number }).rxLookbackMonths;
beforeAll(async () => {
  if (has) db = openMasters(file);
  const connector = createFixtureConnector(repo).chart!;
  for (const k of ["K12", "K13"] as const) {
    const chart = readStructured(await connector.getChart({ patientId: k, yearMonth: YM }));
    const history = [];
    for (let i = 1; i <= LOOKBACK; i++) history.push({ yearMonth: month(-i), chart: readStructured(await connector.getChart({ patientId: k, yearMonth: month(-i) })) });
    fetched.set(k, { chart, history });
  }
});

/** kozoka.UKE の K12・K13 の請求（カルテ番号等の欄が症例の番号） */
function claimOf(k: Case): G11Claim {
  const c = parseUke(readFileSync(path.join(repo, "fixtures", "uke", "kozoka.UKE"))).claims.find((x) => x.patientNo === k);
  if (!c) throw new Error(`kozoka.UKE に ${k} がない`);
  return c;
}
const entriesOf = (k: Case): Entry[] => (JSON.parse(readFileSync(path.join(repo, "fixtures", "charts", `${k}.json`), "utf8")) as { entries: Entry[] }).entries;
/** 患者の機器（合成の設定。structured の patientDevices を、確かめた機器の行として読む） */
function devicesOf(k: Case, c103: boolean): G11Devices {
  const raw = (JSON.parse(readFileSync(path.join(repo, "fixtures", "structured", `${k}.json`), "utf8")) as { patientDevices: Omit<DeviceRow, "seq" | "checkedBy" | "checkedAt">[] }).patientDevices;
  const eff = effectiveDevices(raw.map((r, i) => ({ ...r, seq: i + 1, checkedBy: "医療事務", checkedAt: "" })), YM);
  return { checked: eff.checked, rows: eff.rows.map((r) => ({ kind: r.kind, fromMonth: r.fromMonth, source: r.source })), pending: [], prev: [], c103 };
}
const mapCtx = (ym: string) => ({ db, yearMonth: ym, connectorId: FIXTURE_ID, localMap: () => null });
const rxCodes = new Set([rev.consts.rx.many, rev.consts.rx.other].flatMap((k) => (Object.hasOwn(rev.codes, k) ? [rev.codes[k].primary, ...rev.codes[k].accept] : [])));

type Opt = {
  /** 当月の構造化データを差し替える（作り物の入力） */
  chart?: (c: StructuredChart) => StructuredChart;
  /** カルテの日を差し替える */
  entries?: (e: Entry[]) => Entry[];
};
/** 画面の経路と同じ組み立て（src/server/app/torikawasure.ts の run）で G11 を掛ける */
function run(k: Case, claim: G11Claim, o: Opt = {}): Extract<G11Result, { findings: unknown }> {
  const f = fetched.get(k)!;
  const chart = o.chart ? o.chart(f.chart) : f.chart;
  const items = itemsOf(chart, mapCtx(YM));
  const entries = o.entries ? o.entries(entriesOf(k)) : entriesOf(k);
  const acts: ConfirmedAct[] = entries.flatMap((e, i) => e.acts.map((act) => ({ date: e.date, noteId: i + 1, act })));
  const rxDays: RxDay[] = entries.map((e) => ({ date: e.date, rx: e.rxNotes.length > 0, choice: e.rxChoice ?? (e.rxNotes.length > 0 ? rxDefault(e.rxNotes) : null) }));
  const history = f.history.map((h) => ({
    yearMonth: h.yearMonth,
    orders: h.chart.orders,
    items: h.chart.orders.status === "supported" ? itemsOf({ ...h.chart, visits: { status: "unsupported" }, procedures: { status: "unsupported" }, homeCare: { status: "unsupported" } }, mapCtx(h.yearMonth)) : [],
  }));
  const c103 = chart.homeCare.status === "supported" && chart.homeCare.items.some((h) => h.kind.code?.value === rev.codes.C103_2.primary);
  const structured: G11Structured = {
    chart,
    items,
    history,
    lookbackMonths: LOOKBACK,
    times: [],
    devices: devicesOf(k, c103),
    texts: entries.map((e) => ({
      date: e.date,
      text: [e.s, e.o, e.a, e.p, e.rx].filter(Boolean).join("\n"),
      soap: [e.s, e.o, e.a, e.p].filter(Boolean).join("\n"),
      confirmed: true,
      choice: e.rxChoice ?? (e.rxNotes.length > 0 ? rxDefault(e.rxNotes) : null),
      rxAct: e.acts.some((a) => a.match && rxCodes.has(a.match.code)),
    })),
  };
  const joined = withStructured(acts, { chart, items }, rev);
  const r = evaluateG11(claim, db!, { yearMonth: YM, generation: rev.generation, acts: joined.acts, rxDays, path: "uke", dispensing: "inside", declaration: demoDeclaration(), outpatient: true, structured }, rev);
  if ("skip" in r) throw new Error(r.skip);
  return joined.scope.length === 0 ? r : { ...r, scope: [...r.scope, ...joined.scope] };
}
/** 請求から、そのコードの行を外す（単位の行がなくなれば単位ごと） */
const without = (claim: G11Claim, ...codes: string[]): G11Claim => ({
  units: claim.units.flatMap((u) => {
    const items = u.items.filter((it) => !codes.includes(it.code));
    return items.length === 0 ? [] : [{ ...u, items }];
  }),
});
const keys = (fs: G11Finding[]) => fs.map((f) => `${f.messageKey} ${f.codes.join("+")} ${f.days.map((d) => d.date.slice(8)).join(",")}${f.caution ? " 注意つき" : ""}`);
const ruleOf = (r: ReturnType<typeof run>, code: string) => r.findings.filter((f) => f.messageKey === "G11.missing_rule" && f.codes.includes(code));
const notesOf = (f: G11Finding) => f.days.flatMap((d) => d.notes.map((n) => n.text));

/** 同じコードの指摘（G11 のどの種類でも） */
const anyOf = (r: ReturnType<typeof run>, code: string) => r.findings.filter((f) => f.codes.includes(code));

/** 当月の構造化データの差し替え（作り物の入力） */
const ordersAt = (place: RxOrder["place"]) => (ch: StructuredChart): StructuredChart =>
  ch.orders.status === "supported" ? { ...ch, orders: { ...ch.orders, items: ch.orders.items.map((o) => ({ ...o, place })) } } : ch;
const visitEnd = (ref: string, end: string) => (ch: StructuredChart): StructuredChart =>
  ch.visits.status === "supported" ? { ...ch, visits: { ...ch.visits, items: ch.visits.items.map((v) => (v.ref === ref ? { ...v, end } : v)) } } : ch;
/**
 * K13 の往診の日を、院外処方の日にした作り物（テストの中だけ。EM §5-1-2 の「K13 には院外の日を置かない」）：オーダーを院外にし、
 * カルテの処方の欄を同じ薬の院外処方の記載にする（「院内で投薬」を「院外処方」に、院内の投与の文と、その文から当てた調剤料の行為を外す。院外の語は src/chart/rx-default.ts の一覧の語）
 */
const k13Outside: Opt = {
  chart: ordersAt("院外"),
  entries: (es) =>
    es.map((e) => ({
      ...e,
      rx: e.rx.replace("院内で投薬", "院外処方").replace("内服薬・外用薬を投与。", ""),
      rxNotes: [{ quote: "院外処方" }],
      rxChoice: "outside",
      acts: e.acts.filter((a) => a.match?.code !== R.chozaiOral && a.match?.code !== R.chozaiExternal),
    })),
};
const N2 = rev.codes.C002_N2.primary;
const SHOHOSEN = rev.codes.F400_3.primary;
/** 投薬の規則の候補のコード（調剤料・処方料・麻薬等加算・処方箋料） */
const RX_RULE_CODES = [R.chozaiOral, R.chozaiExternal, R.shohoryo3, R.shohoryo2, R.mayakuChozai, R.mayakuShohoryo];

describe("段 19h：受け入れの症例 K12・K13（実データ・構造化データつき）", () => {
  withData("正しい請求（kozoka.UKE のまま）では、K12・K13 とも指摘が 0 件（規則の候補も出ない）", () => {
    for (const k of ["K12", "K13"] as const) expect([k, keys(run(k, claimOf(k)).findings)]).toEqual([k, []]);
  });

  describe("請求から外すと、それぞれ G11.missing_rule が出る", () => {
    for (const [k, code, label, day] of [
      ["K13", R.chozaiOral, "調剤料（内服）", "02"],
      ["K13", R.chozaiExternal, "調剤料（外用）", "02"],
      ["K13", R.shohoryo3, "処方料", "02"],
      ["K13", R.mayakuChozai, "麻薬等加算（調剤料）", "02"],
      ["K13", R.mayakuShohoryo, "麻薬等加算（処方料）", "02"],
      ["K13", R.kakaOushin, "患家診療時間加算（往診。75 分）", "02"],
      ["K12", R.kakaVisit, "患家診療時間加算（訪問診療。70 分）", "14"],
      ["K12", N2, "在医総管 注2（在医総管の月・院外のオーダーのない月）", "14"],
      ["K12", "114006210", "材料加算（酸素濃縮装置加算）", ""],
      ["K12", "114006310", "材料加算（酸素ボンベ加算（携帯用酸素ボンベ））", ""],
      ["K12", "114041610", "材料加算（在宅酸素療法材料加算（その他））", ""],
    ] as const) {
      withData(`${k}：${label}`, () => {
        const r = run(k, without(claimOf(k), code));
        const fs = ruleOf(r, code);
        expect(fs.length).toBe(1);
        expect(fs[0].days.map((d) => d.date.slice(8)).join(",")).toBe(day);
        expect(fs[0].certainty).toBe("条件つき");
        expect(fs[0].text).not.toMatch(/点|円/);
        // 同じコードは規則の候補の 1 件だけ（文章の行為の側はたたまれ、G11.missing に二重に出ない）
        expect(anyOf(r, code)).toEqual(fs);
      });
    }
    withData("K13：処方箋料（院外の日。作り物の入力）は、請求になければ規則の候補に出る", () => {
      const r = run("K13", without(claimOf("K13"), ...RX_RULE_CODES), k13Outside);
      expect(ruleOf(r, SHOHOSEN).map((f) => f.days.map((d) => d.date.slice(8)).join(","))).toEqual(["02"]);
    });
    withData("材料加算の候補には、前の 2 か月の請求がないので「前の月に当月分を算定していないか確かめてください」が添う（EM K12 の前の 2 か月の請求）", () => {
      const f = ruleOf(run("K12", without(claimOf("K12"), "114006210")), "114006210")[0];
      expect(notesOf(f)).toContain("前の月に当月分を算定していないか確かめてください");
    });
  });

  describe("出ないのが正しいもの", () => {
    withData("院外の日に調剤料・処方料・麻薬等加算が出ない（K13 を院外の日にした作り物の入力）", () => {
      const r = run("K13", without(claimOf("K13"), ...RX_RULE_CODES), k13Outside);
      for (const code of [R.chozaiOral, R.chozaiExternal, R.shohoryo3, R.shohoryo2, R.mayakuChozai, R.mayakuShohoryo]) expect([code, anyOf(r, code)]).toEqual([code, []]);
      expect(r.scope).toContain("院外処方箋の日なので薬は見ていません：6 件");
    });
    withData("要件の時間に届かない訪問に時間の加算が出ない：K12 の 45 分の訪問（10-28）には出ず、70 分の日（10-14）だけ。70 分の訪問を 60 分にした作り物では、どの日にも出ない", () => {
      const r = run("K12", without(claimOf("K12"), R.kakaVisit));
      expect(anyOf(r, R.kakaVisit).map((f) => f.days.map((d) => d.date.slice(8)).join(","))).toEqual(["14"]);
      const sixty = run("K12", without(claimOf("K12"), R.kakaVisit), { chart: visitEnd("v1", "14:00") });
      expect(anyOf(sixty, R.kakaVisit)).toEqual([]);
    });
    withData("在医総管の月（K12）は、院内の日の調剤料・処方料が出ず、在医総管の包括（G04）の理由で言わなかったものに並ぶ。処方箋料も出ない", () => {
      const r = run("K12", claimOf("K12"));
      for (const code of [...RX_RULE_CODES, SHOHOSEN]) expect([code, anyOf(r, code)]).toEqual([code, []]);
      const hidden = r.hidden.filter((h) => h.reason === "包括" && h.check === "G04").map((h) => h.written);
      expect(hidden).toEqual(expect.arrayContaining(["調剤料（内服薬・浸煎薬・屯服薬）", "処方料"]));
    });
    withData("在医総管の月でも、院外のオーダーのある月には注2 が出ない（K12 のオーダーを院外にした作り物の入力）", () => {
      const r = run("K12", without(claimOf("K12"), N2), { chart: ordersAt("院外") });
      expect(anyOf(r, N2)).toEqual([]);
      expect(anyOf(r, SHOHOSEN)).toEqual([]);
    });
    withData("在医総管のない月（K13）には注2 が出ない（加算の元がない）", () => {
      for (const claim of [claimOf("K13"), without(claimOf("K13"), ...RX_RULE_CODES)]) expect(anyOf(run("K13", claim), N2)).toEqual([]);
    });
  });

  describe("構造化データと文章の重なり", () => {
    withData("同じ行為が構造化データと AI の取り出しの両方から出ない：K12 の注射（10-14。注射の実施と文章の両方）・K13 の薬（10-02。オーダーと文章の両方）を外すと、同じ日・同じコードの G11 の指摘が 1 件", () => {
      for (const [k, code, day] of [
        ["K12", "130000510", "14"],
        ["K13", "622095502", "02"],
      ] as const) {
        const r = run(k, without(claimOf(k), code));
        const fs = anyOf(r, code);
        expect([k, code, fs.length]).toEqual([k, code, 1]);
        expect(fs[0].days.map((d) => d.date.slice(8))).toEqual([day]);
        // オーダー・実施にもあるので「文章にあるがオーダーにない」は付かない
        expect(notesOf(fs[0])).not.toContain(ORDER_MISSING);
      }
      expect(run("K12", claimOf("K12")).scope).toContain("オーダーにもある行為をたたみました：4 件");
      expect(run("K13", claimOf("K13")).scope).toContain("オーダーにもある行為をたたみました：7 件");
    });
    withData("文章にだけある行為に「文章にあるがオーダーにない」が付く：K12 の関節腔内注射（10-28。注射・処置を受け取っている月で、実施の記録にない）", () => {
      const r = run("K12", without(claimOf("K12"), "130005310"));
      const fs = anyOf(r, "130005310");
      expect(fs.length).toBe(1);
      expect(fs[0].days.map((d) => d.date.slice(8))).toEqual(["28"]);
      expect(notesOf(fs[0])).toContain(ORDER_MISSING);
    });
  });
});
