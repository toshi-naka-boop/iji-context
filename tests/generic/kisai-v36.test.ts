// 設計 v36（design.md §17）：G07 の摘要欄の残り。条件区分 00 の「記載が要ることがある項目」（§17-1）、項番 0237 の回数（§17-2）、記載の形（§17-3）。
// 手で作った数行の表（tests/generic/small-comments.ts）で確かめ、実データ（RESEMEN_MASTER_DIR の masters.db）があれば完了条件 17-6 の 2 も確かめる
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { warekiOf } from "../../src/engine/comments";
import { resolveRevision } from "../../src/engine/revisions";
import { evaluateGeneric } from "../../src/generic";
import { commentGroupsOf, conditionalOf, kisaiOf } from "../../src/generic/g07";
import { genericScopeOf } from "../../src/generic/scope";
import type { GenericAboutMore, GenericClaim } from "../../src/generic/types";
import { genericView } from "../../src/generic/view";
import { openMasters } from "../../src/masters/db";
import { day, YM } from "../helpers/period";
import { GEN, put } from "./small-masters";
import { commentMasters, K } from "./small-comments";

const rev = resolveRevision(YM);
const about: GenericAboutMore = { yearMonth: YM, generation: GEN, outpatient: true };
type Kind = "SI" | "IY" | "TO";
type Unit = { items: { kind: Kind; code: string; quantity?: string }[]; count?: number };
const unit = (kind: Kind, code: string, count = 1, quantity = ""): Unit => ({ items: [{ kind, code, quantity }], count });
const claimOf = (units: Unit[], comments: { code: string; raw?: string; unit?: number | null }[] = []): GenericClaim => ({ units, comments });
const g07 = (c: GenericClaim, a: GenericAboutMore = about, db = commentMasters()) => evaluateGeneric(c, db, a).findings.filter((f) => f.check === "G07");
const LIVE = { change: "0", changed_on: "20260601", abolished_on: "99999999", hisantei: "0", nyugai: "0", joken: "00", tsuchi: "1", kaisu: "0" };

/** 材料加算（項番 0237。条件区分 03・算定回数 2）の行を 2 つのコードに足し、別表Ⅰ の 00 の組を数行足した表 */
const ZAIRYO = { bombe: "114006110", noshuku: "114006210", other: "114006310", other2: "114011070" } as const;
const MONTHS = ["820100122", "820100123", "820100124", "820100125", "820100126"];
function v36Masters() {
  const db = commentMasters();
  const row = (more: Record<string, string>) => put(db, "comment_kanren", "20261001", { ...LIVE, ...more });
  for (const code of Object.values(ZAIRYO)) for (const c of MONTHS) row({ kouban: "0237", edaban: "11", code, comment_code: c, joken: "03", kaisu: "2" });
  // 往診料の項番 0162：R17 が見る理由（03）のほかに、00 の枝 01・04（04 は診療年月の後に変わった行）
  row({ kouban: "0162", edaban: "01", code: K.oushin, comment_code: "830100814" });
  row({ kouban: "0162", edaban: "04", code: K.oushin, comment_code: "850100499", changed_on: "20991001" });
  // 在医総管の項番 0176 の 00 の枝 05（みなし。選択）
  row({ kouban: "0176", edaban: "05", code: K.zaiisoukan, comment_code: "820100095" });
  row({ kouban: "0176", edaban: "05", code: K.zaiisoukan, comment_code: "820100096" });
  // 別表Ⅱ の同じ項番（0162）の行：医薬品の行にだけ当たり、別表Ⅰ の項目に混ざらない
  row({ kouban: "0162", edaban: "01", code: K.adtralza, comment_code: "850600294", tsuchi: "5" });
  // 版の要旨がある項番（0170 死亡診断加算）
  row({ kouban: "0170", edaban: "00", code: "114007270", comment_code: "820100624" });
  const has = db.prepare("SELECT 1 FROM shinryo WHERE snapshot = '20261001' AND code = ?");
  for (const code of [ZAIRYO.bombe, ZAIRYO.noshuku, ZAIRYO.other, ZAIRYO.other2, "114007270"]) if (!has.get(code)) put(db, "shinryo", "20261001", { code, name: `手作りの行為${code.slice(-4)}` });
  return db;
}

describe("条件区分 00：判定せず、記載が要ることがある項目として組の単位で並べる（design.md §17-1）", () => {
  it("R17 がこのレセプトで見ている組（往診料の理由）だけを外し、ほかの枝（往診料の 01、在医総管の 05）は残る。別表Ⅱ の同じ項番は別の項目", () => {
    const db = v36Masters();
    const c = claimOf([unit("SI", K.oushin), unit("SI", K.zaiisoukan), unit("IY", K.adtralza)], [{ code: K.ishi, raw: "" }]);
    const a = { ...about, kisai: kisaiOf(rev, ["C000", "C002_2I1"]) };
    const r = conditionalOf(c, db, a)!;
    expect(r.items.map((x) => [x.sheet, x.kouban, x.codes.map((y) => y.code), x.branches.map((b) => b.edaban)])).toEqual([
      ["別表Ⅰ", "162", [K.oushin], ["01"]],
      ["別表Ⅰ", "176", [K.zaiisoukan], ["05"]],
      ["別表Ⅱ", "162", [K.adtralza], ["01"]],
    ]);
    expect(r.hidden).toEqual({ r17: 1, present: 0 });
    // 版の R17 の規則の区分に当たらないレセプト（区分を渡さない）では、R17 は理由を見ないので外さない
    expect(conditionalOf(c, db, { ...about, kisai: kisaiOf(rev, []) })!.items[0].branches.map((b) => b.edaban)).toEqual(["01", "03"]);
    // 診療年月の後に変わった行（0162 の 04）は、使わなかった組に数える
    expect(commentGroupsOf(c, db, a)).toMatchObject({ notUsed: 1 });
  });

  it("組のコメントのどれかがレセプトにある組は外す。指摘の数は変わらない（一覧は指摘にしない）", () => {
    const db = v36Masters();
    const a = { ...about, kisai: kisaiOf(rev, []) };
    const c = claimOf([unit("SI", K.zaiisoukan)], [{ code: K.houmonDate, raw: warekiOf(day(3))! }, { code: "820100096" }]);
    expect(conditionalOf(c, db, a)).toEqual({ items: [], hidden: { r17: 0, present: 1 } });
    const bare = claimOf([unit("SI", K.zaiisoukan), unit("SI", K.oushin)], [{ code: K.houmonDate, raw: warekiOf(day(3))! }]);
    const r = evaluateGeneric(bare, db, a);
    expect(r.findings.filter((f) => f.check === "G07")).toEqual(evaluateGeneric(bare, db, about).findings.filter((f) => f.check === "G07"));
    expect(genericScopeOf(bare, db, a, r).conditional?.items.length).toBe(2);
  });

  it("要旨は版の kisaiYoshi（EM に採用した行）だけ。表にない項番は要旨なしで、記載要領へのリンクだけ。定型文は先頭の 3 つと残りの数", () => {
    const db = v36Masters();
    for (const code of ["820100127", "820100128", "820100129"]) put(db, "comment_kanren", "20261001", { ...LIVE, kouban: "0170", edaban: "00", code: "114007270", comment_code: code });
    const r = conditionalOf(claimOf([unit("SI", "114007270"), unit("SI", K.oushin)]), db, { ...about, kisai: kisaiOf(rev, ["C000"]) })!;
    const shibou = r.items.find((x) => x.kouban === "170")!;
    const yoshi = rev.kisaiYoshi.find((y) => y.kouban === "0170")!;
    expect([shibou.summary, shibou.source]).toEqual([yoshi.summary, { em: yoshi.em, url: yoshi.url, page: yoshi.page }]);
    expect(shibou.branches[0].comments).toHaveLength(4);
    expect(shibou.branches[0].comments[3]).toBe("ほか 1 個");
    const oushin = r.items.find((x) => x.kouban === "162")!;
    expect([oushin.summary, oushin.source]).toEqual([null, { url: yoshi.url }]);
  });
});

describe("項番 0237：同じコードの回数が算定回数に届き、選択式のコメントがないとき、条件つきで言う（design.md §17-2）", () => {
  it("回数 2 でコメントなし：G07.missing_any（条件つき。条件区分 03）。対象の月のコメントがあれば言わない", () => {
    const db = v36Masters();
    const f = g07(claimOf([unit("SI", ZAIRYO.bombe, 2)]), about, db);
    expect(f.map((x) => [x.messageKey, x.certainty, x.codes, x.params.joken, x.params.kouban])).toEqual([["G07.missing_any", "条件つき", [ZAIRYO.bombe], "03", "237"]]);
    expect(genericView({ findings: f, ran: [], notRun: [] }, null).findings[0].text).toContain("（このレセプトでは 2 回。2 回以上算定するとき。2 回分・3 回分を回数で表すという読み〔明文なし〕による）");
    expect(g07(claimOf([unit("SI", ZAIRYO.bombe, 2)], [{ code: "820100125" }]), about, db)).toEqual([]);
    // 言い切りの一覧に載せても、確定にしない
    expect(evaluateGeneric(claimOf([unit("SI", ZAIRYO.bombe, 2)]), db, about, undefined, new Set(["G07.missing_any"])).findings.filter((x) => x.check === "G07").map((x) => x.certainty)).toEqual(["条件つき"]);
    // 同じコードの単位が 2 つ（回数 1 ずつ）でも、合わせて 2 回
    expect(g07(claimOf([unit("SI", ZAIRYO.bombe), unit("SI", ZAIRYO.bombe)]), about, db)).toHaveLength(1);
  });

  it("回数 1 の別のコード 4 行では言わない（別のコードの行は足さない）。数量の書いてある行は判定せず、判定していない組に数える", () => {
    const db = v36Masters();
    const four = claimOf(Object.values(ZAIRYO).map((code) => unit("SI", code)));
    expect(g07(four, about, db)).toEqual([]);
    const q = claimOf([unit("SI", ZAIRYO.bombe, 2, "2")]);
    expect(g07(q, about, db)).toEqual([]);
    expect(commentGroupsOf(q, db, about)).toMatchObject({ groups: [], notUsed: 1 });
    // 数量が 1 の行は判定する
    expect(g07(claimOf([unit("SI", ZAIRYO.bombe, 2, "1")]), about, db)).toHaveLength(1);
  });

  it("点検の範囲：見た組に 0237 の組の数を出す", () => {
    const db = v36Masters();
    const c = claimOf([unit("SI", ZAIRYO.bombe, 2)]);
    expect(genericScopeOf(c, db, about, evaluateGeneric(c, db, about)).notDone.find((t) => t.startsWith("必須コメント"))).toContain("材料加算の 2 回分・3 回分の記載（項番 237）1 組");
  });
});

describe("実データの masters.db で（完了条件 17-6 の 2・3）", () => {
  const dir = process.env.RESEMEN_MASTER_DIR;
  const file = dir ? path.join(dir, "masters.db") : "";
  const has = file !== "" && existsSync(file);
  const real: GenericAboutMore = { yearMonth: YM, generation: rev.generation, outpatient: true };
  it.skipIf(!has)("往診料と在医総管：R17 が見ている組だけが外れ、ほかの枝（往診料の 01・02・04・05、在医総管の 05）が残る。別表Ⅱ の同じ項番は混ざらない。指摘の数は変わらない", () => {
    const db = openMasters(file)!;
    const c = claimOf([unit("SI", "114000110"), unit("SI", "114032510"), unit("IY", "622989701")], [{ code: "850100106", raw: warekiOf(day(3))! }]);
    const a = { ...real, kisai: kisaiOf(rev, ["C000", "C002_2I1"]) };
    const r = conditionalOf(c, db, a)!;
    const brief = r.items.map((x) => [x.sheet, x.kouban, x.codes.map((y) => y.code).join(), x.branches.map((b) => b.edaban).join()]);
    expect(brief).toContainEqual(["別表Ⅰ", "162", "114000110", "01,02,04,05"]);
    expect(brief).toContainEqual(["別表Ⅰ", "176", "114032510", "05"]);
    expect(brief.filter((x) => x[0] === "別表Ⅰ").every((x) => !x[2].includes("622989701"))).toBe(true);
    expect(brief.some((x) => x[0] === "別表Ⅱ" && x[1] === "162" && x[2] === "622989701")).toBe(true);
    expect(r.hidden.r17).toBe(1);
    const withKisai = evaluateGeneric(c, db, a).findings;
    expect(withKisai).toEqual(evaluateGeneric(c, db, real).findings);
    console.log(`v36 実データ：00 の項目 ${r.items.length} 件（R17 で外した組 ${r.hidden.r17}・記載がある組 ${r.hidden.present}）`);
    db.close();
  });

  it.skipIf(!has)("材料加算（酸素ボンベ加算）：回数 2 でコメントなしなら条件つきの G07.missing_any。回数 1 の別のコード 4 行では出ない。数量のある行では出ない", () => {
    const db = openMasters(file)!;
    const zero = (c: GenericClaim) => evaluateGeneric(c, db, real).findings.filter((f) => f.check === "G07" && f.params.joken === "03");
    expect(zero(claimOf([unit("SI", "114006110", 2)])).map((f) => [f.messageKey, f.certainty])).toEqual([["G07.missing_any", "条件つき"]]);
    expect(zero(claimOf(["114006110", "114006210", "114006310", "114011070"].map((code) => unit("SI", code))))).toEqual([]);
    expect(zero(claimOf([unit("SI", "114006110", 2, "2")]))).toEqual([]);
    db.close();
  });
});
