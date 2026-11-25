// 医師に確かめてほしい項目に、カルテの記載の引用を添える（採点 r2 医療事務課長 P1。医師確認の 7 要件の ①臨床指標）。
// カルテの記録がない請求は引用が空で noRecord が真。引用は点数・金額の語を伏せ、医師確認の検査（validateQuery）を通る。AI は呼ばない
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateQuery } from "../../src/query/doctor-query";
import { evidenceOf } from "../../src/server/app/doctor-facts";
import { autoConsent } from "../helpers/consent";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let instance: typeof import("../../src/server/instance");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-doctor-facts-evidence-"));
  process.env.RESEMEN_DATA = tmp;
  process.env.RESEMEN_WORKSPACES = path.join(tmp, "ws");
  instance = await import("../../src/server/instance");
  autoConsent(instance.getAuth());
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.RESEMEN_DATA;
  delete process.env.RESEMEN_WORKSPACES;
});

describe("カルテの記載の引用（evidenceOf）", () => {
  const chart = {
    claimId: "K0-2026-10",
    entries: [
      { date: "2026-10-05", s: "変わりなし", a: "パーキンソン病", p: "継続" },
      { date: "2026-10-06", s: "変わりなし", a: "パーキンソン病", p: "継続" },
      { date: "2026-10-12", s: "発熱", a: "肺炎疑い", p: "加算の確認、500点" },
    ],
    prescriptions: [{ date: "2026-10-12", category: "抗菌薬" }],
  };
  it("月の問いは月の記載を、同じ文どうしは日をまとめて並べ、点数・金額の語を伏せる", () => {
    const e = evidenceOf(chart, null)!;
    expect(e.map((x) => x.source)).toEqual(["カルテ 10/5・10/6", "カルテ 10/12", "処方"]);
    expect(e[1].text).not.toMatch(/加算|500点/);
    expect(validateQuery({ question: "別表第八の二に当たるか", indicators: e, options: ["はい", "いいえ", "その他", "判定不能"] })).toEqual([]);
  });
  it("その日の問いはその日の記載だけ（その日の記載がなければ月の全部）", () => {
    expect(evidenceOf(chart, "2026-10-12")!.map((x) => x.source)).toEqual(["カルテ 10/12", "処方"]);
    expect(evidenceOf(chart, "2026-10-20")!.length).toBe(3);
  });
  it("カルテがない・記載がない請求は null", () => {
    expect(evidenceOf(null, null)).toBeNull();
    expect(evidenceOf({ ...chart, entries: [] }, null)).toBeNull();
  });
});

describe("医師に確かめてほしい項目の一覧", () => {
  it("カルテのない取り込んだ請求は「記録がない」。貼って確かめたカルテがあれば、その記載を引用に付ける", () => {
    const owner = instance.getAuth().register("facts_evidence", "やまだ", "password123");
    const clerkId = instance.clerkIdOf(owner);
    const as = <T,>(fn: () => T) => instance.runAs(owner, fn);
    as(() => instance.getApp().uploadUke(clerkId, readFileSync(path.join(repo, "fixtures", "uke", "kisaimore.UKE"))));
    const before = as(() => instance.getApp().doctorFacts());
    expect(before.length).toBeGreaterThan(0);
    for (const i of before) expect([i.claimId, i.noRecord, i.evidence]).toEqual([i.claimId, true, []]);
    // 貼ったカルテは、確かめるまでは引用に使わない
    const target = before[0];
    const saved = as(() => instance.getApp().saveRecord(target.claimId, clerkId, `${target.yearMonth}-14`, { s: "息切れあり", o: "SpO2 92%", a: "慢性心不全", p: "在宅酸素を継続", rx: "" }));
    expect(as(() => instance.getApp().doctorFacts()).find((i) => i.claimId === target.claimId)?.noRecord).toBe(true);
    as(() => instance.getApp().confirmActs(saved.id, clerkId, { facts: [], acts: [], rx: [], rxChoice: null }));
    const after = as(() => instance.getApp().doctorFacts()).filter((i) => i.claimId === target.claimId);
    expect(after.length).toBeGreaterThan(0);
    for (const i of after) {
      expect([i.field, i.noRecord, i.evidence]).toEqual([i.field, false, [{ source: `カルテ ${Number(target.yearMonth.slice(5, 7))}/14`, text: "S: 息切れあり / O: SpO2 92% / A: 慢性心不全 / P: 在宅酸素を継続" }]]);
      expect([i.field, validateQuery({ question: i.question, indicators: i.evidence, options: i.options }).filter((e) => !(i.input === "text" && e.startsWith("②臨床的な選択肢")))]).toEqual([i.field, []]);
    }
  });
});
