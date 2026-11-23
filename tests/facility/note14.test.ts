// 段 17h（design.md §15-2）：施設の申告 note14 の三値・効く行・確かめ直す日の既定（版の定数と EM R8-201）、道具の結果との比べ（L-160。round-57 C-320〜round-60 C-350）。
// 道具の結果の表（note14_worksheets）は段 17i で足す。ここでは、結果を渡す純関数だけを確かめ、表を通した通しのテストは段 17i で通す（下の it.todo）
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REVISIONS, resolveRevision } from "../../src/engine/revisions";
import { effectiveRow, facilityFromDeclaration, note14Tri, NOTE14_KEY, type DeclarationRow } from "../../src/facility/declaration";
import { nextCheckMonthEnd, note14Compare, type Note14Result } from "../../src/facility/note14";
import { recheckDefaultOf } from "../../src/server/app/facility";
import { declarationBody } from "../../src/server/schemas/facility";

const TODAY = "2026-11-13";
const YM = "2026-10";
let id = 0;
const row = (o: Partial<DeclarationRow>): DeclarationRow => ({
  id: ++id,
  itemKey: NOTE14_KEY,
  fromMonth: YM,
  notified: "na",
  notifiedOn: null,
  startOn: null,
  requirement: "met",
  choice: "normal",
  checkedBy: "やまだ",
  checkedRole: "manager",
  checkedOn: "2026-11-01",
  recheckOn: "2027-02-28",
  source: "input",
  createdAt: "",
  ...o,
});

describe("note14 の三値と効く行", () => {
  it("通常の点数・減算の点数・分からない。確かめ直す日を過ぎた行・その月に効く行がない申告は分からない。算定開始年月日は見ない", () => {
    const n = (rows: DeclarationRow[], ym = YM) => facilityFromDeclaration(rows, TODAY, ym).note14;
    expect(n([row({ choice: "normal" })])).toBe("通常");
    expect(n([row({ choice: "reduced", startOn: "2026-12-01" })])).toBe("減算");
    expect(n([row({ choice: "unknown" })])).toBeNull();
    expect(n([row({ recheckOn: "2026-11-01" })])).toBeNull();
    expect(n([row({ fromMonth: "2026-11" })])).toBeNull();
    expect(n([])).toBeNull();
    // 効く行は 15-2 の規則（有効月の順。入れた順は効かない）
    const rows = [row({ fromMonth: "2026-12", choice: "reduced" }), row({ fromMonth: "2026-09", choice: "normal" })];
    expect([n(rows, "2026-10"), n(rows, "2026-12")]).toEqual(["通常", "減算"]);
    expect(note14Tri(rows, TODAY, "2026-08")).toEqual({ v: "unknown", reason: "no_month_row" });
    expect(effectiveRow(rows, NOTE14_KEY, "2026-11")?.row.choice).toBe("normal");
  });

  it("API の形：三値と from_month が要る（ないものは 400 の形）。override は理由の種類と確認月だけ（自由記述の欄はない）", () => {
    const ok = { item: "note14", fromMonth: YM, choice: "normal", notifiedOn: null, startOn: null, checkedOn: TODAY, recheckOn: "2027-02-28" };
    expect(declarationBody.safeParse(ok).success).toBe(true);
    expect(declarationBody.safeParse({ ...ok, fromMonth: undefined }).success).toBe(false);
    expect(declarationBody.safeParse({ ...ok, choice: "yes" }).success).toBe(false);
    expect(declarationBody.safeParse({ ...ok, override: { reason: "kouseikyoku", month: "2026-11" } }).success).toBe(true);
    expect(declarationBody.safeParse({ ...ok, override: { reason: "kouseikyoku", month: "2026-11", text: "電話で" } }).success).toBe(false);
    expect(declarationBody.safeParse({ ...ok, override: { reason: "free", month: "2026-11" } }).success).toBe(false);
  });
});

describe("確かめ直す日の既定：確かめた日の次の確認月の末日（確認月は版の定数。EM R8-201）", () => {
  it("版の定数の確認月が EM R8-201 の「毎年 2・5・8・11 月」と合う", () => {
    const em = readFileSync(path.join(__dirname, "../../design/iji-context/sources/evidence-master-iji-context.md"), "utf8");
    const r201 = em.split("\n").find((l) => l.startsWith("| R8-201 |"))!;
    const m = /毎年 \*\*([\d・]+) 月\*\*/.exec(r201)!;
    const months = m[1].split("・").map(Number);
    expect(months).toEqual([2, 5, 8, 11]);
    for (const rev of REVISIONS) expect(rev.consts.note14?.checkMonths, rev.id).toEqual(months);
  });
  it("次の確認月の末日（確認月の中で確かめたら、その次の確認月）", () => {
    const months = resolveRevision(YM).consts.note14!.checkMonths;
    expect(nextCheckMonthEnd("2026-10-05", months)).toBe("2026-11-30");
    expect(nextCheckMonthEnd("2026-11-13", months)).toBe("2027-02-28");
    expect(nextCheckMonthEnd("2026-12-01", months)).toBe("2027-02-28");
    expect(nextCheckMonthEnd("2027-02-28", months)).toBe("2027-05-31");
    expect(recheckDefaultOf({ note16: 3, default: 12 }, NOTE14_KEY, "2026-10-13")).toBe("2026-11-30");
    // ほかの項目は今までどおり月数
    expect(recheckDefaultOf({ note16: 3, default: 12 }, "note16", "2026-10-13")).toBe("2027-01-13");
  });
});

describe("道具の結果との比べ（純関数。round-58 C-331・round-59 C-342・round-60 C-350。L-160）", () => {
  const r = (checkMonth: string, outcome: Note14Result["outcome"], seq: number): Note14Result => ({ checkMonth, outcome, seq });
  it("結果がまだない：none（どの入口も止めない）", () => {
    expect(note14Compare([], "normal", TODAY).state).toBe("none");
  });
  it("not_meets があり meets で上書きされず、申告が通常 → block。減算なら止めない。undecided を追記しても戻らない。meets を追記すると外れる", () => {
    expect(note14Compare([r("2026-11", "not_meets", 1)], "normal", TODAY).state).toBe("block");
    expect(note14Compare([r("2026-11", "not_meets", 1)], "reduced", TODAY).state).toBe("same");
    expect(note14Compare([r("2026-11", "not_meets", 1), r("2026-11", "undecided", 2)], "normal", TODAY).state).toBe("block");
    expect(note14Compare([r("2026-11", "not_meets", 1), r("2026-11", "meets", 2)], "normal", TODAY).state).toBe("same");
    // meets で申告が減算（点数の低い側）は止めず、違いを添える
    expect(note14Compare([r("2026-11", "meets", 1)], "reduced", TODAY).state).toBe("differs");
  });
  it("比べる結果は、今日以前で結果のある最も新しい確認月（次の確認月に入って道具をまだ回していないあいだは前の確認月の結果が効く）", () => {
    const results = [r("2026-08", "meets", 1), r("2026-11", "not_meets", 1)];
    const s = note14Compare(results, "normal", "2027-02-10");
    expect([s.month, s.state]).toEqual(["2026-11", "block"]);
    // 先の確認月の結果は比べない
    expect(note14Compare([...results, r("2027-02", "meets", 1)], "normal", "2027-01-31").month).toBe("2026-11");
  });

  // 段 17i（note14_worksheets。マイグレーション 16）で表を足したあとに、同じ条件を API・画面で通す
  it.todo("17i で通す：C-320 道具の結果が undecided の確認月でも、「決めきれないまま」の行から note14 を「変わりなし」で残すと、同じ点検で情報不足が消え D03 の保留も外れる（道具の記録は変わらない）");
  it.todo("17i で通す：C-331・C-342 not_meets で申告が通常のとき、結果の画面・知らせに「変わりなし」が出ず「道具の結果と今の申告が違います」が出て、reconfirm がその行を断る。まとめて送ると note14 の行だけ断られ、ほかの行は追記される");
  it.todo("17i で通す：C-350（L-160）次の確認月に入って道具を回していない日に reconfirm を送ると、前の確認月の not_meets で断られる。申告の画面で通常を残すと警告と理由が要り、理由のない送信は 400、残すと監査ログに印と理由の種類、事務長の画面に 1 行（meets の追記か減算の選び直しで消える）");
});
