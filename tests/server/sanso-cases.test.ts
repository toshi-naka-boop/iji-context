// 酸素の症例 K32〜K34（EM 5-1。fixtures/uke/sanso.json・sanso.UKE）で、design.md §19-10 の完了条件 7・8・12 を、EM の行の件数で縛る（§19-13 の 4）。
// 基本マスターは同梱しないので、RESEMEN_MASTER_DIR があるときだけ動く。AI は呼ばない
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateGeneric } from "../../src/generic";
import type { GenericAboutMore, GenericFinding } from "../../src/generic/types";
import { openMasters } from "../../src/masters/db";
import type { App } from "../../src/server/app";
import { parseUke } from "../../src/uke/uke";
import { repo, tempApp } from "../helpers/care";
import { YM } from "../helpers/period";

const dir = process.env.RESEMEN_MASTER_DIR;
const has = !!dir && existsSync(path.join(dir, "masters.db"));
const FILE = path.join(repo, "fixtures", "uke", "sanso.UKE");

/** EM 5-1 の行の「正解の指摘」の最初の文から、G12 と G05 の件数と G12 の強さ */
function emAnswer(id: string): { g12: { certainty: string; count: number } | null; g05: number } {
  const rows = readFileSync(path.join(repo, "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8").split("\n");
  const row = rows.find((l) => l.startsWith(`| ${id} |`));
  if (!row) throw new Error(`EM 5-1 に行がない: ${id}`);
  const seg = /正解の指摘：([^。]*)/.exec(row)![1];
  const g12 = /G12 の \d が(確定|条件つき) (\d+) 件/.exec(seg);
  const g05 = /G05 が (\d+) 件/.exec(seg);
  return { g12: g12 ? { certainty: g12[1], count: Number(g12[2]) } : null, g05: g05 ? Number(g05[1]) : 0 };
}
/** 言い切りの候補（一覧に載せたつもり）で数える。G12 と G05 だけ */
const LIST = new Set(["G05.exception_none", "G05.month", "G12.home_oxygen", "G12.over_limit"]);

let app: App;
let close: () => void;
let ids: Record<string, string>;
beforeEach(() => {
  ({ app, close } = tempApp());
  const files = app.uploadUke("new1", readFileSync(FILE));
  ids = Object.fromEntries(files.filter((f) => f.uploaded).flatMap((f) => f.receipts).filter((r) => app.caseOf(r.claimId).yearMonth === YM).map((r) => [r.patientNo!, r.claimId]));
});
afterEach(() => close());

type Check = { generic: { findings: (GenericFinding & { text: string })[]; scope: { notDone: string[] } } };
const check = (id: string) => app.ukeCheck(ids[id]) as unknown as Check;

describe("K32〜K34（EM 5-1。完了条件 7・8）", () => {
  it.skipIf(!has)("合成の UKE を読み、EM の行の件数どおりに G12・G05 が出る（前の月を取り込んだ点検と、言い切りの候補で数えて）", () => {
    const claims = parseUke(readFileSync(FILE)).claims;
    for (const id of ["K32", "K33", "K34"]) {
      const want = emAnswer(id);
      const c = claims.find((x) => x.patientNo === id && x.yearMonth === YM)!;
      // 前の月の管理料は、取り込んだ点検（oxygenOf）と同じ三値：K32 は前の月の請求があるので「ある」
      const prev = id === "K32" ? "ある" : "取り込んでいない";
      const fs = evaluateGeneric(c, openMasters()!, { yearMonth: YM, generation: "R8", outpatient: true, clinic: true, prevHomeOxygen: prev } as GenericAboutMore, undefined, LIST).findings;
      const g12 = fs.filter((f) => f.check === "G12");
      expect([id, g12.length, g12.every((f) => f.certainty === want.g12!.certainty)]).toEqual([id, want.g12!.count, true]);
      expect([id, fs.filter((f) => f.check === "G05").length]).toEqual([id, want.g05]);
    }
  });

  it.skipIf(!has)("取り込んだレセプトの点検：K32 は前の月の請求から管理料「ある」を読み、G12 の 1 が確定。前の月の請求がなければ条件つき（U-79）", () => {
    const k32 = check("K32").generic.findings.filter((f) => f.check === "G12");
    expect(k32.map((f) => [f.messageKey, f.certainty])).toEqual([["G12.home_oxygen", "確定"]]);
    const k34 = check("K34").generic.findings.filter((f) => f.check === "G12");
    expect(k34.map((f) => [f.messageKey, f.certainty])).toEqual([["G12.over_limit", "確定"]]);
    expect(k34[0].text).toMatch(/^当院が離島等に当たらない前提/);
  });

  it.skipIf(!has)("完了条件 12：小型ボンベの単価を入れると、K34 と jitsurei.UKE の点検の範囲から「上限だけを見ています」が消え、届け出た単価との違いが出る。取り消すと元に戻る", () => {
    const ONLY_LIMIT = "酸素の届け出た単価が入っていません。上限だけを見ています";
    expect(check("K34").generic.scope.notDone).toContain(ONLY_LIMIT);
    const saved = app.saveOxygenPrice("new1", { kind: "small", price: "1.80", validFrom: "2026-04-01", validUntil: "2027-03-31", basis: "前年の購入実績" });
    expect(check("K34").generic.scope.notDone).not.toContain(ONLY_LIMIT);
    // K34 の単価 2.50 は上限を超えるので、上限の確定（3）が出て、届出との違い（5）は掛けない
    expect(check("K34").generic.findings.filter((f) => f.check === "G12").map((f) => f.messageKey)).toEqual(["G12.over_limit"]);
    // K32 の 1.80 は届け出た単価と同じなので出ない。単価を変えると違いが条件つきで出る
    app.saveOxygenPrice("new1", { revokes: saved.rows[0].id });
    app.saveOxygenPrice("new1", { kind: "small", price: "1.70", validFrom: "2026-04-01", validUntil: "2027-03-31", basis: "前年の購入実績" });
    const diff = check("K32").generic.findings.filter((f) => f.messageKey === "G12.declared_diff");
    expect(diff.map((f) => f.certainty)).toEqual(["条件つき", "条件つき"]);
    expect(diff[0].text).toContain("届け出た単価 1.70 円/L と違います");
    app.saveOxygenPrice("new1", { revokes: app.oxygenPrices().rows[0].id });
    expect(check("K34").generic.scope.notDone).toContain(ONLY_LIMIT);
  });
});
