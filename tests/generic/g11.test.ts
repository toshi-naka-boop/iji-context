// 段 18b の完了条件のうち、作り物の小さな表で確かめるもの（design.md §15-8・§15-10）。データは同梱しない（§12-7）。
// 抑えの表（包括・背反・回数・施設基準）は、確かめたい組み合わせだけを作る「作り物の表」で、公開元の表の行ではない。コードは EM §2-8 の症例のコードの表のもの
import { describe, expect, it } from "vitest";
import type { ChartAct, ChildKind, Tbl } from "../../src/chart/acts";
import { g11Owned } from "../../src/engine/derive";
import { resolveRevision } from "../../src/engine/revisions";
import type { ClaimContext } from "../../src/engine/types";
import type { DeclarationView, Tri } from "../../src/facility/declaration";
import { evaluateGeneric } from "../../src/generic";
import { evaluateG11, type ConfirmedAct, type G11About, type G11Claim, type G11Finding, type G11Result } from "../../src/generic/g11";
import { r18Step3 } from "../../src/generic/g11-rules";
import { g03 } from "../../src/generic/g03";
import { g04 } from "../../src/generic/g04";
import { makeG05 } from "../../src/generic/g05";
import { g10 } from "../../src/generic/g10";
import type { HaihanConfig, HaihanException } from "../../src/generic/haihan";
import { loadCase } from "../engine/helpers";
import { YM } from "../helpers/period";
import { GEN, put } from "./small-masters";
import { putHaihan, tensuhyoMasters } from "./small-tensuhyo";
import type Database from "better-sqlite3";

const SNAP = "20261001";
const rev = resolveRevision(YM);
const LIVE = { change: "0", created_on: "20100401", abolished_on: "99999999" };
const C = {
  burn: "140032110",
  wound: "140000610",
  shippu: "140002210",
  nail: "150054110",
  inj: "130000510",
  bio: "130000110",
  tsh: "160031710",
  pt: "160012010",
  aptt: "160012310",
  handanBlood: "160061810",
  sanso: "114003710",
  sansoKyunyu: "140005610",
  kanka: "114001470",
  kansetsu: "130005310",
  zaiisoukan: "114032510",
  shohosen: "120002910",
} as const;
const D = { carve: "622095502", geben: "620008991", xylo: "620007260" } as const;

/** G11 の点検に要る表を持つ小さな masters.db（G03〜G06・G10・G11 の準備ができている） */
function g11Db(): Database.Database {
  const db = tensuhyoMasters(SNAP);
  db.prepare("INSERT INTO checks_ready (check_id, ready, reason) VALUES ('G03', 1, ''), ('G10', 1, ''), ('G11', 1, '')").run();
  const si = (code: string, name: string, more: Record<string, string | number> = {}) => {
    db.prepare("DELETE FROM shinryo WHERE snapshot = ? AND code = ?").run(SNAP, code);
    put(db, "shinryo", SNAP, { code, name, alpha: "J", ...more });
  };
  si(C.burn, "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）");
  si(C.wound, "創傷処置（１００ｃｍ２未満）");
  si(C.shippu, "消炎鎮痛等処置（湿布処置）");
  si(C.nail, "爪甲除去術", { unit_code: 116, unit_name: "指" });
  si(C.inj, "皮内、皮下及び筋肉内注射");
  si(C.bio, "生物学的製剤注射加算");
  si(C.tsh, "ＴＳＨ", { kensa_kind: "1", kensa_group: 4 });
  si(C.pt, "ＰＴ", { kensa_kind: "1", kensa_group: 2 });
  si(C.aptt, "ＡＰＴＴ", { kensa_kind: "1", kensa_group: 2 });
  si(C.handanBlood, "血液学的検査判断料", { kensa_kind: "2", kensa_group: 2 });
  si("160062010", "生化学的検査（２）判断料", { kensa_kind: "2", kensa_group: 4 });
  si(C.sansoKyunyu, "酸素吸入");
  si(C.kanka, "患家診療時間加算（在宅患者訪問診療料（１）・（２））", { unit_code: 1, unit_name: "分" });
  si(C.kansetsu, "関節腔内注射");
  for (const [code, name, zaikei, unit_name] of [[D.carve, "カルベジロール錠１０ｍｇ「ニプロ」", "1", "錠"], [D.geben, "ゲーベンクリーム１％", "6", "ｇ"], [D.xylo, "キシロカイン注ポリアンプ０．５％　５ｍＬ", "4", "管"]])
    put(db, "iyakuhin", SNAP, { code, name, zaikei, unit_name });
  return db;
}

const dayArr = (...days: number[]) => Array.from({ length: 31 }, (_, i) => days.filter((d) => d === i + 1).length);
const unit = (codes: string[], ...days: number[]) => ({ items: codes.map((code) => ({ kind: (code.startsWith("6") ? "IY" : "SI") as "SI" | "IY", code })), count: days.length, days: dayArr(...days) });
const date = (d: number) => `${YM}-${String(d).padStart(2, "0")}`;
let noteId = 0;
function act(d: number, code: string, written: string, more: Partial<ChartAct> & { tbl?: Tbl; kids?: [ChildKind, string, string, string?][] } = {}): ConfirmedAct {
  const tbl: Tbl = more.tbl ?? (code.startsWith("6") ? "iyakuhin" : "shinryo");
  const a: ChartAct = { category: more.category ?? (tbl === "iyakuhin" ? "投薬" : "処置"), written, lookup: [], quote: written, match: { tbl, code, name: written, by: "name" }, ...(more.quantity ? { quantity: more.quantity } : {}) };
  if (more.kids) a.with = more.kids.map(([kind, kcode, kname, q]) => ({ kind, written: kname, lookup: [], quote: kname, match: { tbl: kind === "薬" ? "iyakuhin" : "tokutei", code: kcode, name: kname, by: "name" }, ...(q ? { quantity: q } : {}) }));
  return { date: date(d), noteId: ++noteId, act: a };
}
const held: DeclarationView = { held: () => ({ v: "held" }), nameOf: () => null };
const viewWith = (tri: (kijun: string) => Tri): DeclarationView => ({ held: (c) => tri(c), nameOf: () => null });
const about = (acts: ConfirmedAct[], more: Partial<G11About> = {}): G11About => ({ yearMonth: YM, generation: GEN, acts, rxDays: [], path: "uke", dispensing: "inside", declaration: held, outpatient: true, ...more });
const ok = (r: G11Result) => {
  if ("skip" in r) throw new Error(r.skip);
  return r;
};
const keys = (fs: G11Finding[]) => fs.map((f) => `${f.messageKey} ${f.codes.join("+")} ${f.days.map((d) => Number(d.date.slice(8))).join(",")}${f.caution ? " 注意つき" : ""}`);
const notesOf = (f: G11Finding) => f.days.flatMap((d) => d.notes.map((n) => n.text));
/** 並べ方を逆にしても同じ結果（候補の並べ方・足す順に依らない） */
function both(db: Database.Database, claim: G11Claim, a: G11About) {
  const x = ok(evaluateG11(claim, db, a, rev));
  const y = ok(evaluateG11(claim, db, { ...a, acts: [...(a.acts ?? [])].reverse() }, rev));
  expect(y.findings).toEqual(x.findings);
  expect(y.hidden).toEqual(x.hidden);
  return x;
}

describe("G11 が動かないとき（X-131）", () => {
  it("確かめた行為がない請求・G04 が notReady・G10 に申告を渡さない呼び出しでは、何も言わず理由を返す", () => {
    const db = g11Db();
    expect(evaluateG11({ units: [] }, db, about([]), rev)).toEqual({ skip: "確かめたカルテの「行ったこと」がないので、取り忘れは見ていません" });
    const a = about([act(10, C.nail, "爪甲除去術")]);
    expect(evaluateG11({ units: [] }, db, { ...a, declaration: undefined }, rev)).toEqual({ skip: "G10（施設基準）が動いていないので、算定できるかを確かめられず、取り忘れは見ていません" });
    db.prepare("UPDATE checks_ready SET ready = 0, reason = '錨がない' WHERE check_id = 'G04'").run();
    expect(evaluateG11({ units: [] }, db, a, rev)).toEqual({ skip: "G04（包括）が動いていないので、算定できるかを確かめられず、取り忘れは見ていません" });
  });
});

describe("1 つずつ見る（手順 1）", () => {
  it("X-137：10 日の熱傷処置と創傷処置の背反が元の請求にあり、20 日の熱傷処置だけがないとき、20 日の熱傷処置は出る。20 日にも相手があれば言わない", () => {
    const db = g11Db();
    // 作り物の表：1 日につき、創傷処置を算定する（熱傷処置が算定しない側）
    putHaihan(db, SNAP, 1, C.wound, C.burn, "1", "0");
    const acts = [act(10, C.burn, "熱傷処置"), act(20, C.burn, "熱傷処置")];
    const r = both(db, { units: [unit([C.burn], 10), unit([C.wound], 10)] }, about(acts));
    expect(keys(r.findings)).toEqual(["G11.missing 140032110 20"]);
    const r2 = both(db, { units: [unit([C.burn], 10), unit([C.wound], 10, 20)] }, about(acts));
    expect(keys(r2.findings)).toEqual([]);
    expect(r2.hidden).toEqual([{ written: "熱傷処置", date: date(20), reason: "背反", check: "G05", partner: "創傷処置（１００ｃｍ２未満）" }]);
  });

  it("X-138：元の請求に包括の指摘が 200 件を超え、足した処置が 201 件目で包括されるときも言わない。点検の上限によらず同じ結果", () => {
    const db = g11Db();
    const parents = Array.from({ length: 201 }, (_, i) => `19${String(i).padStart(7, "0")}`);
    db.transaction(() => {
      for (const code of parents) put(db, "hojo", SNAP, { ...LIVE, code, unit1: "1", group1: "X000001" });
      put(db, "houkatsu", SNAP, { ...LIVE, group_no: "X000001", code: C.shippu, tokurei: "0" });
      put(db, "houkatsu", SNAP, { ...LIVE, group_no: "X000001", code: C.wound, tokurei: "0" });
    })();
    const claim = { units: [...parents.map((p) => unit([p], 5)), unit([C.shippu], 5)] };
    expect(evaluateGeneric(claim, db, { yearMonth: YM, generation: GEN }).omitted?.find((o) => o.check === "G04")?.count).toBeGreaterThan(0);
    const a = about([act(5, C.wound, "創傷処置")]);
    const r = ok(evaluateG11(claim, db, a, rev));
    expect(keys(r.findings)).toEqual([]);
    expect(r.hidden.map((h) => h.reason)).toEqual(["包括"]);
    for (const findingLimit of [1, 1000]) expect(ok(evaluateG11(claim, db, { ...a, findingLimit }, rev))).toEqual(r);
  });

  it("背反区分 3 の相手が請求にあるときは、もう片方を言わない。点検の範囲に数が出て、言わなかった一覧には入らない（C-283）", () => {
    const db = g11Db();
    putHaihan(db, SNAP, 2, C.nail, C.bio, "3", "0");
    const r = both(db, { units: [unit([C.bio], 3)] }, about([act(10, C.nail, "爪甲除去術")]));
    expect(keys(r.findings)).toEqual([]);
    expect(r.hidden).toEqual([]);
    expect(r.scope).toContain("どちらか一方の組で、請求に相手がある：1 件");
  });

  it("月 1 回が上限の行為がカルテの 2 日にあって請求にないときは 1 件で言い、元の請求に 1 回あるときは言わない（X-140・L-114）。特例条件ありの行・週の上限は隠さず添え書き（C-280）", () => {
    const db = g11Db();
    put(db, "kaisu", SNAP, { ...LIVE, code: C.nail, unit_code: 131, limit_count: 1, tokurei: "0" });
    const acts = [act(10, C.nail, "爪甲除去術"), act(20, C.nail, "爪甲除去術")];
    expect(keys(both(db, { units: [] }, about(acts)).findings)).toEqual(["G11.missing 150054110 10,20"]);
    const once = both(db, { units: [unit([C.nail], 3)] }, about(acts));
    expect(keys(once.findings)).toEqual([]);
    expect(once.hidden.map((h) => `${h.date.slice(8)} ${h.reason}`)).toEqual(["10 回数", "20 回数"]);
    db.prepare("UPDATE kaisu SET tokurei = '1' WHERE code = ?").run(C.nail);
    const cond = both(db, { units: [unit([C.nail], 3)] }, about(acts));
    expect(keys(cond.findings)).toEqual(["G11.missing 150054110 10,20 注意つき"]);
    expect(notesOf(cond.findings[0])).toContain("回数の表では、条件によっては算定できません（相手：爪甲除去術。特例条件あり）。告示・通知を確かめてください");
    db.prepare("UPDATE kaisu SET tokurei = '0', unit_code = 138 WHERE code = ?").run(C.nail);
    const week = both(db, { units: [unit([C.nail], 9)] }, about([act(10, C.nail, "爪甲除去術")]));
    expect(keys(week.findings)).toEqual(["G11.missing 150054110 10 注意つき"]);
    expect(notesOf(week.findings[0])[0]).toContain("1 週間の数え方");
    expect(week.scope.find((s) => s.startsWith("注意つきで出したもの"))).toBe("注意つきで出したもの：1 件（データの点検の条件つきの違反 1）");
  });

  it("特例条件のない同一月の包括は隠れ、特例条件ありの包括・同時の表で別の単位の背反は隠さず添え書き（C-280）。言い切りの一覧に依らない", () => {
    const db = g11Db();
    // tensuhyoMasters の包括：在医総管（同一月）→ 処方箋料（特例 0）。作り物：在医総管 → 関節腔内注射（特例 1）、同時の背反（別の単位）
    put(db, "houkatsu", SNAP, { ...LIVE, group_no: "C002001", code: C.kansetsu, tokurei: "1" });
    putHaihan(db, SNAP, 3, C.inj, C.bio, "1", "0");
    const claim = { units: [unit([C.zaiisoukan], 28), unit([C.inj], 14)] };
    const r = both(db, claim, about([act(14, C.shohosen, "処方箋料", { category: "投薬" }), act(14, C.kansetsu, "関節腔内注射"), act(14, C.bio, "生物学的製剤注射加算")], { dispensing: "outside" }));
    expect(keys(r.findings)).toEqual(["G11.missing 130000110 14 注意つき", "G11.missing 130005310 14 注意つき"]);
    expect(r.hidden.map((h) => `${h.written} ${h.reason}`)).toEqual(["処方箋料 包括"]);
    expect(notesOf(r.findings[0])).toEqual(["背反の表では、条件によっては算定できません（相手：皮内、皮下及び筋肉内注射。別の単位の同時）。告示・通知を確かめてください"]);
    expect(notesOf(r.findings[1])[0]).toContain("特例条件あり");
    expect(r.findings.every((f) => f.certainty === "条件つき")).toBe(true);
  });

  it("背反の特例条件の例外（C-280 の直し）：例外が全部 分類ア で元の請求から当たらないと決まる組は隠れる。分類イの例外がある組は注意つきで、添え書きに例外の一言が入る", () => {
    // 作り物の決まり：酸素の管理料 × 酸素吸入（tensuhyoMasters の同一月の背反。区分 1・特例条件あり）。例外の一言は作り物
    const RECEIPT: HaihanException = { id: "HX-T1", text: "入院中の患者に行ったもの", kind: "receipt", allow: { receiptKind: "入院" } };
    const ASK: HaihanException = {
      id: "HX-T3",
      text: "短期入所中の患者に行ったもの",
      kind: "fact",
      ask: { factKey: "haihan:HX-T3", scope: "day", askOn: "b", question: "短期入所中でしたか", choices: [{ label: "はい", means: "当たる" }, { label: "いいえ", means: "当たらない" }, { label: "その他", means: "決まらない" }, { label: "判定不能", means: "決まらない" }] },
    };
    const config = (ids: string[]): HaihanConfig => ({ patterns: [{ id: "HP-T1", a: { codes: [C.sanso] }, b: { codes: [C.sansoKyunyu] }, tani: [2], exceptions: ids }], exceptions: [RECEIPT, ASK] });
    const claim = { units: [unit([C.sanso], 6)] };
    const run = (ids: string[], acts: ConfirmedAct[]) => ok(evaluateG11(claim, g11Db(), about(acts), rev, { checks: [g03, g04, makeG05(config(ids)), g10] }));
    const acts = [act(20, C.sansoKyunyu, "酸素吸入")];
    // アだけ：隠れて、言わなかった一覧に背反で並ぶ
    const a = run(["HX-T1"], acts);
    expect(keys(a.findings)).toEqual([]);
    expect(a.hidden).toEqual([{ written: "酸素吸入", date: date(20), reason: "背反", check: "G05", partner: "在宅酸素療法指導管理料 2 その他" }]);
    // イがある：注意つきで、添え書きに例外の一言（決まらない側だけ）が入る
    const b = run(["HX-T1", "HX-T3"], acts);
    expect(keys(b.findings)).toEqual(["G11.missing 140005610 20 注意つき"]);
    expect(b.findings[0].days[0].notes).toEqual([{ reason: "データの点検の条件つきの違反", text: "在宅酸素療法指導管理料 2 その他を算定する月は、原則として算定できません。例外：短期入所中の患者に行ったもの。当たらなければ、請求にないままで合っています" }]);
    expect(b.hidden).toEqual([]);
    // 並べ方を逆にしても同じ
    expect(run(["HX-T1", "HX-T3"], [...acts].reverse()).findings).toEqual(b.findings);
  });

  it("届出なしと包括（M-2）：施設基準の届出なしの候補 A は隠れ、A に包括される候補 B は添え書きなしで出る。並べ方を逆にしても同じ", () => {
    const db = g11Db();
    db.prepare("UPDATE shinryo SET shisetsu_g1 = '721' WHERE snapshot = ? AND code = ?").run(SNAP, C.nail);
    put(db, "hojo", SNAP, { ...LIVE, code: C.nail, unit1: "1", group1: "K089001" });
    put(db, "houkatsu", SNAP, { ...LIVE, group_no: "K089001", code: C.wound, tokurei: "0" });
    const decl = viewWith((k) => (k === "721" ? { v: "not", reason: "notified_no" } : { v: "held" }));
    const r = both(db, { units: [] }, about([act(10, C.nail, "爪甲除去術"), act(10, C.wound, "創傷処置")], { declaration: decl }));
    expect(keys(r.findings)).toEqual(["G11.missing 140000610 10"]);
    expect(r.hidden).toEqual([{ written: "爪甲除去術", date: date(10), reason: "施設基準", check: "G10", partner: "コード 721（名称は表 4 にありません）" }]);
  });

  it("申告が分からない（G10.unknown だけ）候補は隠さず、施設基準の申告が分からない旨を添える。届出なしなら言わない（C-232）", () => {
    const db = g11Db();
    db.prepare("UPDATE shinryo SET shisetsu_g1 = '721' WHERE snapshot = ? AND code = ?").run(SNAP, C.nail);
    const unknown = viewWith(() => ({ v: "unknown", reason: "no_row" }));
    const r = both(db, { units: [] }, about([act(10, C.nail, "爪甲除去術")], { declaration: unknown }));
    expect(keys(r.findings)).toEqual(["G11.missing 150054110 10 注意つき"]);
    expect(notesOf(r.findings[0])[0]).toMatch(/^施設基準コード 721（名称は表 4 にありません）の申告が分からないので、算定できるかは施設の申告しだいです（施設の申告による）$/);
    expect(r.scope).toContain("施設基準の申告が分からないまま出したもの：1 件。施設の申告を確かめてください");
    expect(r.hidden).toEqual([]);
  });
});

describe("候補どうし（手順 2）", () => {
  it("X-151：a・b が背反区分 3、a が c を包括し、3 つとも請求にないとき、a・b は 1 件の missing_either、c は「（これも取り忘れの候補）」の添え書きつき。どれも隠れない", () => {
    const db = g11Db();
    putHaihan(db, SNAP, 2, C.nail, C.bio, "3", "0");
    put(db, "hojo", SNAP, { ...LIVE, code: C.nail, unit1: "2", group1: "K089001" });
    put(db, "houkatsu", SNAP, { ...LIVE, group_no: "K089001", code: C.wound, tokurei: "0" });
    const r = both(db, { units: [] }, about([act(10, C.nail, "爪甲除去術"), act(10, C.bio, "生物学的製剤注射加算"), act(10, C.wound, "創傷処置")]));
    expect(keys(r.findings)).toEqual(["G11.missing_either 130000110+150054110 10", "G11.missing 140000610 10 注意つき"]);
    expect(notesOf(r.findings[1])).toEqual(["『爪甲除去術』（これも取り忘れの候補）を算定すると、包括で算定できません。どちらを算定するか確かめてください"]);
    expect(r.findings[0].text).toBe("カルテ（10日）に『生物学的製剤注射加算』（生物学的製剤注射加算）と『爪甲除去術』（爪甲除去術）があり、どちらも請求にありません。どちらか一方を算定できる見込みです。どちらで算定するか、算定できるかを確かめてください");
    expect(r.hidden).toEqual([]);
  });

  it("背反区分 3 の組の片方に施設基準の届出なしが結び付くときは、その側が隠れ、もう片方は添え書きなしの missing（L-113 を v30 で改める）", () => {
    const db = g11Db();
    putHaihan(db, SNAP, 2, C.nail, C.bio, "3", "0");
    db.prepare("UPDATE shinryo SET shisetsu_g1 = '721' WHERE snapshot = ? AND code = ?").run(SNAP, C.nail);
    const decl = viewWith((k) => (k === "721" ? { v: "not", reason: "notified_no" } : { v: "held" }));
    const r = both(db, { units: [] }, about([act(10, C.nail, "爪甲除去術"), act(10, C.bio, "生物学的製剤注射加算")], { declaration: decl }));
    expect(keys(r.findings)).toEqual(["G11.missing 130000110 10"]);
  });

  it("互いに算定しない側になる候補（単独では通り、同時には背反区分 1 で互いに算定しない側）は、2 つとも添え書きつきで出て隠れない", () => {
    const db = g11Db();
    putHaihan(db, SNAP, 1, C.nail, C.bio, "1", "0");
    putHaihan(db, SNAP, 1, C.bio, C.nail, "1", "0");
    const r = both(db, { units: [] }, about([act(10, C.nail, "爪甲除去術"), act(10, C.bio, "生物学的製剤注射加算")]));
    expect(keys(r.findings)).toEqual(["G11.missing 130000110 10 注意つき", "G11.missing 150054110 10 注意つき"]);
    expect(r.scope.find((s) => s.startsWith("注意つき"))).toBe("注意つきで出したもの：2 件（候補どうしの包括・背反 2）");
  });

  it("約束の 3 つ目：出した候補を全部足した請求で、別の候補が相手の抑えが関わる候補には必ず添え書きがある（上の作り物の請求のどれでも）", () => {
    const db = g11Db();
    putHaihan(db, SNAP, 2, C.nail, C.bio, "1", "0");
    put(db, "hojo", SNAP, { ...LIVE, code: C.bio, unit1: "1", group1: "G005001" });
    put(db, "houkatsu", SNAP, { ...LIVE, group_no: "G005001", code: C.wound, tokurei: "0" });
    const r = both(db, { units: [] }, about([act(10, C.nail, "爪甲除去術"), act(10, C.bio, "生物学的製剤注射加算"), act(10, C.wound, "創傷処置")]));
    const all = { units: r.findings.flatMap((f) => f.codes.map((c) => unit([c], 10))) };
    const g = evaluateGeneric(all, db, { yearMonth: YM, generation: GEN });
    const losers = g.findings.flatMap((f) => (f.check === "G04" ? [f.codes[1]] : f.check === "G05" && f.params.keep !== "いずれか一方" ? [f.codes.find((c) => c !== f.params.keep)!] : []));
    expect(losers.length).toBeGreaterThan(0);
    for (const code of losers) expect([code, r.findings.find((f) => f.codes.includes(code))!.caution]).toEqual([code, true]);
  });
});

describe("決まった規則で足す候補（M-1・X-147）", () => {
  it("検査の項目がカルテにあり、判断料の行がマスターの検査のグループで 1 つに決まると missing_derived。2 行あれば言わず点検の範囲に数。カルテに判断料があれば missing だけ", () => {
    const db = g11Db();
    const claim = { units: [unit([C.pt], 14), unit([C.aptt], 14)] };
    const r = both(db, claim, about([act(14, C.pt, "ＰＴ", { category: "検査" })]));
    expect(keys(r.findings)).toEqual(["G11.missing_derived 160061810 14"]);
    expect(r.findings[0].text).toBe("カルテ（14日）に『ＰＴ』があり、血液学的検査判断料が請求にありません。マスターの検査のグループから決まる項目です。算定できるか確かめてください");
    const two = both(db, claim, about([act(14, C.pt, "ＰＴ", { category: "検査" }), act(14, C.handanBlood, "血液学的検査判断料", { category: "検査" })]));
    expect(keys(two.findings)).toEqual(["G11.missing 160061810 14"]);
    put(db, "shinryo", SNAP, { code: "160999910", name: "作り物の判断料", kensa_kind: "2", kensa_group: 2 });
    const undecided = both(db, claim, about([act(14, C.pt, "ＰＴ", { category: "検査" })]));
    expect(keys(undecided.findings)).toEqual([]);
    expect(undecided.scope).toContain("判断料の行を 1 つに決められない検査のグループ：1 件");
  });

  it("在医総管の月で包括される組み合わせ（処方箋料）は出ない。院内処方もある施設の院外処方箋の日に処方箋料がなければ、書かれていれば missing、書かれていなければ missing_derived。薬は見ない（C-231）", () => {
    const db = g11Db();
    const rx = [{ date: date(14), rx: true, choice: "outside" as const }];
    const drug = act(14, D.carve, "カルベジロール錠１０ｍｇ「ニプロ」");
    const derived = both(db, { units: [] }, about([drug], { rxDays: rx }));
    expect(keys(derived.findings)).toEqual(["G11.missing_derived 120002910 14"]);
    expect(derived.findings[0].text).toBe("カルテ（14日）に処方の記載があり、処方箋料が請求にありません。処方の記載から決まる項目です。算定できるか確かめてください");
    expect(derived.scope).toContain("院外処方箋の日なので薬は見ていません：1 件");
    const written = both(db, { units: [] }, about([drug, act(14, C.shohosen, "処方箋料", { category: "投薬" })], { rxDays: rx }));
    expect(keys(written.findings)).toEqual(["G11.missing 120002910 14"]);
    const kanri = both(db, { units: [unit([C.zaiisoukan], 28)] }, about([drug], { rxDays: rx }));
    expect(keys(kanri.findings)).toEqual([]);
    expect(kanri.hidden.map((h) => h.reason)).toEqual(["包括"]);
  });
});

describe("院内・院外と剤形（C-221・C-231・C-243・M-3）", () => {
  it("院内処方もある施設で、選ばれていない日は B の欄の上に 1 行の案内を出し、見ていないものに入れない。処方の記載がない日は案内を出さず、理由を点検の範囲に出す", () => {
    const db = g11Db();
    const acts = [act(14, D.carve, "カルベジロール錠１０ｍｇ「ニプロ」"), act(28, D.carve, "カルベジロール錠１０ｍｇ「ニプロ」"), act(7, D.carve, "カルベジロール錠１０ｍｇ「ニプロ」")];
    const r = both(db, { units: [] }, about(acts, { rxDays: [{ date: date(14), rx: true, choice: "unknown" }, { date: date(28), rx: true, choice: null }] }));
    expect(r.guide).toBe("14日・28日の処方の院内・院外を選ぶと、薬の取り忘れを見ます");
    expect(keys(r.findings)).toEqual([]);
    expect(r.scope).toEqual(["10月7日は処方の記載がないので薬は見ていません：1 件"]);
  });

  it("院内の日の投薬の組：薬と、剤形から決まる調剤料・処方料を組にし、組が抑えられなければ書かれた薬だけを言う（調剤料・処方料は足すだけ）。剤形 4 の薬は組に入れない", () => {
    const db = g11Db();
    const rx = [{ date: date(14), rx: true, choice: "inside" as const }];
    const r = both(db, { units: [] }, about([act(14, D.carve, "カルベジロール錠１０ｍｇ「ニプロ」")], { rxDays: rx }));
    expect(keys(r.findings)).toEqual(["G11.missing 622095502 14"]);
    const four = both(db, { units: [] }, about([act(14, D.xylo, "キシロカイン注ポリアンプ０．５％　５ｍＬ")], { rxDays: rx }));
    expect(keys(four.findings)).toEqual([]);
    expect(four.scope).toEqual(["剤形が内服・外用でない薬は見ていません：1 件"]);
    // 在医総管の月：調剤料・処方料が包括されるので、組ごと言わない（X-130）
    db.prepare("UPDATE hojo SET unit1 = '2' WHERE code = ?").run(C.zaiisoukan);
    put(db, "houkatsu", SNAP, { ...LIVE, group_no: "C002001", code: "120000710", tokurei: "0" });
    const kanri = both(db, { units: [unit([C.zaiisoukan], 28)] }, about([act(14, D.carve, "カルベジロール錠１０ｍｇ「ニプロ」")], { rxDays: rx }));
    expect(keys(kanri.findings)).toEqual([]);
    expect(kanri.hidden).toEqual([{ written: "カルベジロール錠１０ｍｇ「ニプロ」", date: date(14), reason: "包括", check: "G04", partner: expect.stringContaining("在医総管") }]);
  });

  it("院外処方だけ・分からない施設では、薬を見ない（理由を出す）", () => {
    const db = g11Db();
    const acts = [act(14, D.carve, "カルベジロール錠１０ｍｇ「ニプロ」")];
    const rx = [{ date: date(14), rx: true, choice: null }];
    expect(both(db, { units: [unit([C.shohosen], 14)] }, about(acts, { dispensing: "outside", rxDays: rx })).scope).toEqual(["院外処方の施設なので薬は見ていません：1 件"]);
    expect(both(db, { units: [] }, about(acts, { dispensing: "unknown", rxDays: rx })).scope).toEqual(["院内か院外かが分からないので薬は見ていません：1 件。施設の申告で院内・院外処方を入れてください"]);
  });
});

describe("量（L-98・C-253・C-261・C-262・X-144・X-146）", () => {
  /** 作り物の 1 日の上限の行（上限 2）を持つ、マスターの単位のない行為（処置の湿布） */
  const db121 = () => {
    const db = g11Db();
    put(db, "kaisu", SNAP, { ...LIVE, code: C.shippu, unit_code: 121, limit_count: 2, tokurei: "0" });
    return db;
  };
  const shippu = (q: string | undefined, d = 14) => act(d, C.shippu, "湿布処置", q === undefined ? {} : { quantity: q });
  const claimN = (n: number) => ({ units: [{ ...unit([C.shippu], 14), count: n, days: dayArr(...Array.from({ length: n }, () => 14)) }] });

  it("「回」：カルテ 2 回・請求 1 回は quantity_less。3 回・請求 1 は上限 2 で頭打ちにして比べ、文に上限を添え、上の数に数える。3 回・請求 2 は言わない。請求 2・カルテ 1 回は quantity_more", () => {
    const db = db121();
    expect(keys(both(db, claimN(1), about([shippu("2回")])).findings)).toEqual(["G11.quantity_less 140002210 14"]);
    const three = both(db, claimN(1), about([shippu("3回")]));
    expect(three.findings.map((f) => f.text)).toEqual(["カルテ（14日）では『湿布処置』が3回（1 日に算定できるのは 2 回まで）、請求では1回です。算定できるか確かめてください"]);
    expect(three.scope).toContain("カルテの回数が 1 日の上限を超えています：1 件");
    const three2 = both(db, claimN(2), about([shippu("3回")]));
    expect(keys(three2.findings)).toEqual([]);
    expect(three2.scope).toContain("カルテの回数が 1 日の上限を超えています：1 件");
    const more = both(db, claimN(2), about([shippu("1回")]));
    expect(keys(more.findings)).toEqual(["G11.quantity_more 140002210 14"]);
    expect(more.findings[0].text).toBe("カルテ（14日）では『湿布処置』が1回、請求では2回です。カルテの記載と請求を確かめてください");
  });

  it("1 日の上限の行がないコードは比べない（多い側も言わない）。決まった形でない量・マスターに量の単位がない行為の「分」も数に出す", () => {
    const db = g11Db();
    for (const [q, n] of [["3回", 1], ["1回", 3]] as const) {
      const r = both(db, claimN(n), about([shippu(q)]));
      expect([q, keys(r.findings), r.scope]).toEqual([q, [], ["量は見ていません（1 日の回数の決まりがデータにない）：1 件"]]);
    }
    expect(both(db, claimN(1), about([shippu("朝夕")])).scope).toEqual(["量は見ていません（決まった形で書かれていない）：1 件"]);
    expect(both(db, claimN(1), about([shippu("10分")])).scope).toEqual(["量は見ていません（この行為はマスターに量の単位がない）：1 件"]);
  });

  it("合計（X-146）：同じ日のカルテに「1回」の行が 2 つあり請求が 1 回なら、合計 2 回と比べて 1 件。片方の量が空なら比べず「そろっていない」に数える", () => {
    const db = db121();
    expect(keys(both(db, claimN(1), about([shippu("1回"), shippu("1回")])).findings)).toEqual(["G11.quantity_less 140002210 14"]);
    const r = both(db, claimN(1), about([shippu("1回"), shippu(undefined)]));
    expect(keys(r.findings)).toEqual([]);
    expect(r.scope).toEqual(["量は見ていません（同じ日の記載の量がそろっていない）：1 件"]);
  });

  it("「回」と量を分ける（X-144）：単位が「分」の行為で「70分」は数量データと比べ、「1回」は回数の規則に回る（数量データと比べない）", () => {
    const db = g11Db();
    const claim = { units: [{ items: [{ kind: "SI" as const, code: C.kanka, quantity: "70" }], count: 1, days: dayArr(14) }] };
    expect(keys(both(db, claim, about([act(14, C.kanka, "患家診療時間加算", { quantity: "70分" })])).findings)).toEqual([]);
    expect(keys(both(db, claim, about([act(14, C.kanka, "患家診療時間加算", { quantity: "80分" })])).findings)).toEqual(["G11.quantity_less 114001470 14"]);
    const once = both(db, claim, about([act(14, C.kanka, "患家診療時間加算", { quantity: "1回" })]));
    expect([keys(once.findings), once.scope]).toEqual([[], ["量は見ていません（1 日の回数の決まりがデータにない）：1 件"]]);
  });

  it("大文字・小文字（L-98）：単位の名前が「mL」の薬に、カルテの「10ml」を数として比べる。マスターに「ml」の別の単位も置いて衝突させると、字のまま比べて合わない", () => {
    const db = g11Db();
    db.prepare("UPDATE iyakuhin SET unit_name = 'mL' WHERE code = ?").run(D.geben);
    const claim = { units: [{ items: [{ kind: "SI" as const, code: C.burn }, { kind: "IY" as const, code: D.geben, quantity: "5" }], count: 1, days: dayArr(14) }] };
    const a = about([act(14, C.burn, "熱傷処置", { kids: [["薬", D.geben, "ゲーベンクリーム１％", "10ml"]] })]);
    const r = both(db, claim, a);
    expect(keys(r.findings)).toEqual(["G11.quantity_less 620008991 14"]);
    expect(r.findings[0].text).toBe("カルテ（14日）では「熱傷処置」で使った「ゲーベンクリーム１％」が10ml、請求では5です。算定できるか確かめてください");
    put(db, "tokutei", SNAP, { code: "700990000", name: "作り物の器材", unit_name: "ml" });
    const c = both(db, claim, a);
    expect([keys(c.findings), c.scope]).toEqual([[], ["量は見ていません（単位がマスターと合わない（マスターは mL））：1 件"]]);
  });

  it("単位の列のない古い masters.db では比べず「単位の列が古い形です」に数え、取り忘れは同じに出る。子の「回」は比べない", () => {
    const db = g11Db();
    db.prepare("ALTER TABLE tokutei DROP COLUMN unit_name").run();
    const claim = { units: [{ items: [{ kind: "SI" as const, code: C.burn }, { kind: "IY" as const, code: D.geben, quantity: "10" }], count: 1, days: dayArr(14) }] };
    const r = both(db, claim, about([act(14, C.burn, "熱傷処置", { kids: [["薬", D.geben, "ゲーベンクリーム１％", "20g"]] }), act(14, C.nail, "爪甲除去術")]));
    expect([keys(r.findings), r.scope]).toEqual([["G11.missing 150054110 14"], ["量は見ていません（単位の列が古い形です）：1 件"]]);
    const db2 = g11Db();
    const kid = both(db2, claim, about([act(14, C.burn, "熱傷処置", { kids: [["薬", D.geben, "ゲーベンクリーム１％", "1回"]] })]));
    expect([keys(kid.findings), kid.scope]).toEqual([[], []]);
  });
});

describe("出し方", () => {
  it("注意つきの候補は添え書きのない候補の後ろに並び、どれも条件つきで、文に点数・金額がない", () => {
    const db = g11Db();
    putHaihan(db, SNAP, 1, C.nail, C.bio, "1", "1");
    const r = both(db, { units: [unit([C.nail], 10)] }, about([act(10, C.bio, "生物学的製剤注射加算"), act(10, C.wound, "創傷処置"), act(20, C.inj, "注射")]));
    expect(r.findings.map((f) => f.caution)).toEqual([false, false, true]);
    expect(r.findings.every((f) => f.certainty === "条件つき" && !/\d+\s*点|円/.test(f.text))).toBe(true);
  });

  it("当てられない行為は指摘にならず数で出る。算定プレビューでは g11Owned の区分（訪問診療料など）は見ない", () => {
    const db = g11Db();
    const unmatched: ConfirmedAct = { date: date(10), act: { category: "処置", written: "よく分からない処置", lookup: [], quote: "よく分からない処置", match: null } };
    const r = both(db, { units: [] }, about([unmatched, act(10, "114001110", "在宅患者訪問診療料", { category: "診療行為" })], { path: "preview" }));
    expect(keys(r.findings)).toEqual([]);
    expect(r.counts.unmatched).toBe(1);
    expect(r.counts.notSeen).toBe(1);
    expect(r.scope).toEqual(["訪問診療料・管理料など、R ルールと導出が見る区分は見ていません（算定プレビューでは導出と手書きのルールが見ます）：1 件", "当てられない行為：1 件"]);
  });
});

describe("手順 3（R18 だけ。段 18b）", () => {
  it("R18 の区分は、g11Owned・C〜I に回した区分・初診時のベースアップ評価料のどれか（候補が R18 の区分になるのは初診時のベースアップ評価料だけ）", () => {
    const owned = new Set([...g11Owned(rev.consts), ...(rev.consts.deferred ?? [])]);
    expect(rev.rules.find((r) => r.id === "R18")!.kubun.filter((k) => !owned.has(k))).toEqual(["O001_1", "O001_1_N5"]);
  });

  it("候補が R18 の区分に当たり、施設の申告（ベースアップ評価料）が分からないとき、情報不足の添え書きが付いて注意つきで出る（隠さない。C-252）", () => {
    const db = g11Db();
    const code = rev.codes.O001_1.primary;
    const k8 = loadCase("K8");
    const base: ClaimContext = { ...k8, events: [], recordsKnown: false, commentsKnown: true, facility: { ...k8.facility, baseUp: { known: false } } };
    const r = both(db, { units: [] }, about([act(10, code, "ベースアップ評価料", { category: "診療行為" })]));
    expect(keys(r.findings)).toEqual([`G11.missing ${code} 10`]);
    const s3 = ok(evaluateG11({ units: [] }, db, about([act(10, code, "ベースアップ評価料", { category: "診療行為" })]), rev, { step3: r18Step3(base, rev, db) }));
    expect(keys(s3.findings)).toEqual([`G11.missing ${code} 10 注意つき`]);
    expect(notesOf(s3.findings[0])[0]).toMatch(/を確かめないと算定できるかは言えません$/);
    expect(s3.scope.find((s) => s.startsWith("注意つき"))).toBe("注意つきで出したもの：1 件（情報不足 1）");
  });
});

// 反証 round-55（v30 の実装）で受理した G11 の指摘。作り物の表で、直す前に落ちることを確かめてから直した
describe("反証 round-55", () => {
  const RECEIPT: HaihanException = { id: "HX-T1", text: "入院中の患者に行ったもの", kind: "receipt", allow: { receiptKind: "入院" } };
  const ASK: HaihanException = {
    id: "HX-T3",
    text: "短期入所中の患者に行ったもの",
    kind: "fact",
    ask: { factKey: "haihan:HX-T3", scope: "day", askOn: "b", question: "短期入所中でしたか", choices: [{ label: "はい", means: "当たる" }, { label: "いいえ", means: "当たらない" }, { label: "その他", means: "決まらない" }, { label: "判定不能", means: "決まらない" }] },
  };

  it("C-291：背反区分 3・特例条件ありの組は、相手が元の請求にあれば条件つきの違反の添え書きで、両方が候補なら候補どうしの添え書きで、注意つきで出る（添え書きのない取り忘れにしない）", () => {
    const db = g11Db();
    putHaihan(db, SNAP, 1, C.nail, C.bio, "3", "1");
    const inClaim = both(db, { units: [unit([C.bio], 10)] }, about([act(10, C.nail, "爪甲除去術")]));
    expect(keys(inClaim.findings)).toEqual(["G11.missing 150054110 10 注意つき"]);
    expect(notesOf(inClaim.findings[0])).toEqual(["背反の表では、条件によっては算定できません（相手：生物学的製剤注射加算。特例条件あり）。告示・通知を確かめてください"]);
    const cands = both(db, { units: [] }, about([act(10, C.nail, "爪甲除去術"), act(10, C.bio, "生物学的製剤注射加算")]));
    expect(keys(cands.findings)).toEqual(["G11.missing 130000110 10 注意つき", "G11.missing 150054110 10 注意つき"]);
    expect(notesOf(cands.findings[0])).toEqual(["『爪甲除去術』（これも取り忘れの候補）を算定すると、背反で算定できません。どちらを算定するか確かめてください"]);
  });

  it("C-291：背反区分 3・特例条件ありで例外の決まりがある組は C-280 の直しと同じ。例外が全部 分類ア で当たらないと決まれば隠し、分類イがあれば例外を名指しした注意つき", () => {
    const config = (ids: string[]): HaihanConfig => ({ patterns: [{ id: "HP-T2", a: { codes: [C.bio] }, b: { codes: [C.nail] }, tani: [1], exceptions: ids }], exceptions: [RECEIPT, ASK] });
    const run = (ids: string[]) => {
      const db = g11Db();
      putHaihan(db, SNAP, 1, C.bio, C.nail, "3", "1");
      return ok(evaluateG11({ units: [unit([C.bio], 10)] }, db, about([act(10, C.nail, "爪甲除去術")]), rev, { checks: [g03, g04, makeG05(config(ids)), g10] }));
    };
    const a = run(["HX-T1"]);
    expect(keys(a.findings)).toEqual([]);
    expect(a.hidden).toEqual([{ written: "爪甲除去術", date: date(10), reason: "背反", check: "G05", partner: "生物学的製剤注射加算" }]);
    const b = run(["HX-T1", "HX-T3"]);
    expect(keys(b.findings)).toEqual(["G11.missing 150054110 10 注意つき"]);
    expect(notesOf(b.findings[0])).toEqual(["生物学的製剤注射加算を算定する日は、原則として算定できません。例外：短期入所中の患者に行ったもの。当たらなければ、請求にないままで合っています"]);
  });

  it("C-291：往診料と訪問診療料の組（背反区分 3・特例条件あり）は、今までどおり G05 の添え書きを付けない（R10 が日つきの添え書きで扱う）", () => {
    const db = g11Db();
    const oushin = rev.codes[rev.consts.oushin.kubun].primary;
    const visit = rev.codes[rev.consts.visitKubun[0]].primary;
    putHaihan(db, SNAP, 1, oushin, visit, "3", "1");
    const r = both(db, { units: [unit([visit], 10)] }, about([act(10, oushin, "往診料", { category: "診療行為" })]));
    expect(keys(r.findings)).toEqual([`G11.missing ${oushin} 10`]);
  });

  it("C-294・X-155：背反区分 3 の関係が候補どうしで 3 つ以上つながると、組に入らなかった関係の両側に添え書きが付く（A・B の組と、A・C の関係）", () => {
    const db = g11Db();
    putHaihan(db, SNAP, 1, C.nail, C.bio, "3", "0");
    putHaihan(db, SNAP, 1, C.nail, C.wound, "3", "0");
    const r = both(db, { units: [] }, about([act(10, C.nail, "爪甲除去術"), act(10, C.bio, "生物学的製剤注射加算"), act(10, C.wound, "創傷処置")]));
    expect(keys(r.findings)).toEqual(["G11.missing_either 130000110+150054110 10 注意つき", "G11.missing 140000610 10 注意つき"]);
    expect(notesOf(r.findings[0])).toEqual(["『創傷処置』（これも取り忘れの候補）を算定すると、背反で算定できません。どちらを算定するか確かめてください"]);
    expect(notesOf(r.findings[1])).toEqual(["『爪甲除去術』（これも取り忘れの候補）を算定すると、背反で算定できません。どちらを算定するか確かめてください"]);
  });

  it("C-295：例外を名指しする添え書きは表の単位で言い分ける（同一月は「月」、1 日は「日」、同時の表は「同時に行うときは」）", () => {
    const config: HaihanConfig = { patterns: [{ id: "HP-T3", a: { codes: [C.bio] }, b: { codes: [C.nail] }, tani: [3], exceptions: ["HX-T3"] }], exceptions: [ASK] };
    const db = g11Db();
    putHaihan(db, SNAP, 3, C.bio, C.nail, "1", "1");
    const r = ok(evaluateG11({ units: [unit([C.bio], 10)] }, db, about([act(10, C.nail, "爪甲除去術")]), rev, { checks: [g03, g04, makeG05(config), g10] }));
    expect(keys(r.findings)).toEqual(["G11.missing 150054110 10 注意つき"]);
    expect(notesOf(r.findings[0])).toEqual(["生物学的製剤注射加算と同時に行うときは、原則として算定できません。例外：短期入所中の患者に行ったもの。当たらなければ、請求にないままで合っています"]);
  });

  it("C-292・X-154：施設基準の抑えは足した単位の日だけで決める。算定開始が 15 日で、元の請求の 5 日が開始の前でも、20 日の候補は隠れない", () => {
    const db = g11Db();
    db.prepare("UPDATE shinryo SET shisetsu_g1 = '721' WHERE snapshot = ? AND code = ?").run(SNAP, C.nail);
    const decl: DeclarationView = { held: (k, on) => (k === "721" && on.day !== undefined && on.day < date(15) ? { v: "not", reason: "before_start", startOn: date(15) } : { v: "held" }), nameOf: () => null };
    const r = both(db, { units: [unit([C.nail], 5)] }, about([act(20, C.nail, "爪甲除去術")], { declaration: decl }));
    expect(keys(r.findings)).toEqual(["G11.missing 150054110 20"]);
    expect(r.hidden).toEqual([]);
    // 足した単位の日が開始の前なら隠れる
    const early = both(db, { units: [] }, about([act(10, C.nail, "爪甲除去術")], { declaration: decl }));
    expect(early.hidden.map((h) => `${h.date.slice(8)} ${h.reason}`)).toEqual(["10 施設基準"]);
  });

  it("X-156：同じ日・同じ親の区分の同じ子の量は合計して請求と比べる（10g ずつ 2 行と請求の 20 は合っている）", () => {
    const db = g11Db();
    const claim = { units: [{ items: [{ kind: "SI" as const, code: C.burn }, { kind: "IY" as const, code: D.geben, quantity: "20" }], count: 1, days: dayArr(14) }] };
    const kid: [ChildKind, string, string, string?][] = [["薬", D.geben, "ゲーベンクリーム１％", "10g"]];
    const r = both(db, claim, about([act(14, C.burn, "熱傷処置", { kids: kid }), act(14, C.burn, "熱傷処置", { kids: kid })]));
    expect(keys(r.findings)).toEqual([]);
    const less = both(db, { units: [{ ...claim.units[0], items: [claim.units[0].items[0], { ...claim.units[0].items[1], quantity: "10" }] }] }, about([act(14, C.burn, "熱傷処置", { kids: kid }), act(14, C.burn, "熱傷処置", { kids: kid })]));
    expect(keys(less.findings)).toEqual(["G11.quantity_less 620008991 14"]);
  });

  it("X-157：当てられない行為は、日・書かれた名前・種類と、保存したカルテの id と位置（あとから選ぶ入口）を結果に並べる。位置のない行為（合成カルテ）は位置なし", () => {
    const db = g11Db();
    const stored: ConfirmedAct = { date: date(10), noteId: 7, index: 2, act: { category: "処置", written: "よく分からない処置", lookup: [], quote: "よく分からない処置", match: null } };
    const synthetic: ConfirmedAct = { date: date(12), noteId: 1, act: { category: "注射", written: "よく分からない注射", lookup: [], quote: "よく分からない注射", match: null } };
    const r = both(db, { units: [] }, about([stored, synthetic]));
    expect(r.unmatchedActs).toEqual([
      { date: date(10), written: "よく分からない処置", category: "処置", noteId: 7, index: 2 },
      { date: date(12), written: "よく分からない注射", category: "注射" },
    ]);
    expect(r.scope).toContain("当てられない行為：2 件");
  });

  it("X-158：判断料の候補は、請求にある検査の項目からも立てる（請求に ＰＴ があって判断料がなく、カルテには別の処置だけ）", () => {
    const db = g11Db();
    const r = both(db, { units: [unit([C.pt], 14)] }, about([act(14, C.wound, "創傷処置")]));
    expect(keys(r.findings)).toEqual(["G11.missing_derived 160061810 14", "G11.missing 140000610 14"]);
    expect(r.findings[0].text).toBe("請求（14日）に『ＰＴ』があり、血液学的検査判断料が請求にありません。マスターの検査のグループから決まる項目です。算定できるか確かめてください");
  });
});

describe("再反証 round-56", () => {
  it("C-310＝X-160：子の量は、請求の側も同じ日・同じ親の区分の単位の中で合計して比べる（創傷処置と熱傷処置でゲーベン 10g ずつ・請求も単位ごとに 10g は合っている）", () => {
    const db = g11Db();
    const geben = (q: string) => ({ kind: "IY" as const, code: D.geben, quantity: q });
    const claim = (burn: string) => ({ units: [{ items: [{ kind: "SI" as const, code: C.wound }, geben("10")], count: 1, days: dayArr(5) }, { items: [{ kind: "SI" as const, code: C.burn }, geben(burn)], count: 1, days: dayArr(5) }] });
    const kid: [ChildKind, string, string, string?][] = [["薬", D.geben, "ゲーベン", "10g"]];
    const acts = [act(5, C.wound, "創傷処置", { kids: kid }), act(5, C.burn, "熱傷処置", { kids: kid })];
    expect(keys(both(db, claim("10"), about(acts)).findings)).toEqual([]);
    // 熱傷処置の単位だけ 5g なら、熱傷処置の子だけを言い、請求の数はその親の単位の量
    const less = both(db, claim("5"), about(acts));
    expect(keys(less.findings)).toEqual(["G11.quantity_less 620008991 5"]);
    expect(less.findings[0].text).toBe("カルテ（5日）では「熱傷処置」で使った「ゲーベン」が10g、請求では5です。算定できるか確かめてください");
  });

  it("X-161：親が当たって請求にあり、使った薬だけ当てられないときも、その子を当てられない行為に並べる（親の位置と子の位置・種類・親の名前つき）", () => {
    const db = g11Db();
    const a: ConfirmedAct = { date: date(14), noteId: 9, index: 1, act: { category: "処置", written: "熱傷処置", lookup: [], quote: "熱傷処置", match: { tbl: "shinryo", code: C.burn, name: "熱傷処置", by: "name" }, with: [{ kind: "薬", written: "よく分からない軟膏", lookup: [], quote: "よく分からない軟膏", quantity: "10g", match: null }] } };
    const r = both(db, { units: [unit([C.burn], 14)] }, about([a]));
    expect(keys(r.findings)).toEqual([]);
    expect(r.unmatchedActs).toEqual([{ date: date(14), written: "よく分からない軟膏", category: "処置", noteId: 9, index: 1, child: { index: 0, kind: "薬", parent: "熱傷処置" } }]);
    expect(r.scope).toContain("当てられない行為：1 件");
    expect(r.counts.unmatched).toBe(1);
  });

  it("X-162：算定日の分からない請求の検査からは、日を付けた判断料の候補を作らない（月で扱い、文に日を出さない）", () => {
    const db = g11Db();
    const untimed = { units: [{ items: [{ kind: "SI" as const, code: C.pt }], count: 1 }] };
    const r = both(db, untimed, about([act(20, C.wound, "創傷処置")]));
    const f = r.findings.find((x) => x.messageKey === "G11.missing_derived")!;
    expect(f.text).toBe("請求に『ＰＴ』があり、血液学的検査判断料が請求にありません。マスターの検査のグループから決まる項目です。算定できるか確かめてください");
    expect(f.days.map((d) => d.date)).toEqual([YM]);
    expect(JSON.stringify(r)).not.toContain(`${YM}-01`);
  });
});

describe("減算中の施設の請求：減の行と通常の行の組（段 17h。design.md §15-8。17f の暫定をやめた）", () => {
  const putKanri = (db: Database.Database) => {
    for (const [code, name] of [["114711810", "在医総管（在支診等・月２回～１０～１９人）"], ["114721110", "在医総管（在支診等・月２回～１０～１９人減）"]]) {
      db.prepare("DELETE FROM shinryo WHERE snapshot = ? AND code = ?").run(SNAP, code);
      put(db, "shinryo", SNAP, { code, name, alpha: "C" });
    }
  };
  it("減の行だけの請求に、管理料の行為を通常の区分のコードに当てたカルテを貼っても G11.missing が出ず（組のどちらかがあるので「ある」）、17f の「まだ見ていません」の行も出ない", () => {
    const db = g11Db();
    putKanri(db);
    const r = ok(evaluateG11({ units: [unit(["114721110"], 20)] }, db, about([act(20, "114711810", "在医総管", { category: "診療行為" })]), rev));
    expect(r.findings).toEqual([]);
    expect(r.scope.some((s) => s.startsWith("注14 の減算の行がある請求"))).toBe(false);
  });
  it("カルテの管理料の行為を減の行に当てて、請求に管理料（通常・減とも）が抜けたときは G11.missing が出る", () => {
    const db = g11Db();
    putKanri(db);
    const r = ok(evaluateG11({ units: [] }, db, about([act(20, "114721110", "在医総管（減）", { category: "診療行為" })]), rev));
    expect(r.findings.map((f) => f.messageKey)).toEqual(["G11.missing"]);
  });
});
