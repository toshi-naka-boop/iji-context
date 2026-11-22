// いつの診療月から（from_month）で効く行を選ぶ・直後の組の確かめた日・確かめの文・確かめ直す日の知らせ・まとめて「変わりなし」の選べる行
// （src/facility/declaration.ts。design.md §15-2・§15-10 の段 17c。P-2・round-50 C-240・X-142・round-52 X-150・round-53 C-271・C-274）。純関数だけを見る
import { describe, expect, it } from "vitest";
import { changeNotices, effectiveRow, facilityFromDeclaration, heldOf, initialSelection, recheckNotices, selectableRows, type DeclarationRow } from "../../src/facility/declaration";
import { month, YM } from "../helpers/period";

// 基準月（YM）を 10 月とみて、9 月・11 月・12 月など
const M = (n: number) => month(n);
const SEP = M(-1);
const NOV = M(1);
const DEC = M(2);
const d = (ym: string, n: number) => `${ym}-${String(n).padStart(2, "0")}`;
const FAR = "2099-12-31";

let nextId = 1;
function row(itemKey: string, over: Partial<DeclarationRow> = {}): DeclarationRow {
  return { id: nextId++, itemKey, fromMonth: YM, notified: "yes", notifiedOn: null, startOn: d(YM, 1), requirement: "met", choice: null, checkedBy: "事務長", checkedRole: "manager", checkedOn: d(YM, 1), recheckOn: FAR, source: "input", createdAt: "", ...over };
}
const grade = (over: Partial<DeclarationRow>) => row("grade", over);
const note16 = (over: Partial<DeclarationRow>) => row("note16", { notified: "na", startOn: null, ...over });
const reorder = (rows: DeclarationRow[]) => rows.map((r, i) => ({ ...r, id: rows.length - i }));

describe("さかのぼらない（docs H-1・P-2）", () => {
  it("10 月から「注16 を満たす」のあと、11-04 に 11 月から「満たさない」を残すと、10 月は真・11 月は偽。10 月からにすると 10 月から変わる", () => {
    const base = note16({ fromMonth: YM });
    const today = d(NOV, 4);
    const later = note16({ fromMonth: NOV, requirement: "not_met", checkedOn: today });
    expect([facilityFromDeclaration([base, later], today, YM).note16Met, facilityFromDeclaration([base, later], today, NOV).note16Met]).toEqual([true, false]);
    const fix = note16({ fromMonth: YM, requirement: "not_met", checkedOn: today });
    expect([facilityFromDeclaration([base, fix], today, YM).note16Met, facilityFromDeclaration([base, fix], today, NOV).note16Met]).toEqual([false, false]);
    // 画面の確かめの文に、変わる月の範囲が出る（今日の前の月 10 月より前ではないので、さかのぼりの文はない）
    expect(changeNotices([base], "note16", NOV, today)).toEqual([`${NOV} より前の診療月の請求は、前の申告（満たす）で判定します`]);
    // 9 月から（さかのぼる直し）なら、10 月からの行が残ることも見せる
    expect(changeNotices([base], "note16", SEP, today)).toEqual([`${SEP} から ${SEP} までの請求の判定が変わります`, `${YM} からの請求は、「満たす」のままです`]);
  });
  it("「届出なし」（4100）・dispensing・種別でも同じ", () => {
    const today = d(NOV, 4);
    const dx = [row("code:4100", { choice: "1" }), row("code:4100", { fromMonth: NOV, notified: "no", startOn: null, checkedOn: today })];
    expect([facilityFromDeclaration(dx, today, YM).dxTier, facilityFromDeclaration(dx, today, NOV).dxTier]).toEqual(["1", "なし"]);
    const g = [grade({ choice: "zaishishin3" }), grade({ fromMonth: NOV, choice: "solo_nobeds", startOn: d(NOV, 1), checkedOn: today })];
    expect([facilityFromDeclaration(g, today, YM).grade, facilityFromDeclaration(g, today, NOV).grade]).toEqual(["2", "1N"]);
  });
});

describe("入れる順に依らない（round-50 C-240・X-142）", () => {
  // 11-04 に「12 月から・単独型・算定開始 12-01」（先の月からの変更）、11-10 に「9 月から・(3)」（さかのぼる直し）
  const a = () => grade({ fromMonth: DEC, choice: "solo_nobeds", startOn: d(DEC, 1), checkedOn: d(NOV, 4) });
  const b = () => grade({ fromMonth: SEP, choice: "zaishishin3", startOn: d(SEP, 1), checkedOn: d(NOV, 10) });
  const today = d(NOV, 10);
  const grades = (rows: DeclarationRow[]) => [SEP, YM, NOV, DEC].map((ym) => facilityFromDeclaration(rows, today, ym).grade);
  it("9〜11 月の請求は (3)、12 月の請求は単独型。逆の順で入れても、どの診療月の効く行も同じ", () => {
    const rows = [a(), b()];
    expect(grades(rows)).toEqual(["2", "2", "2", "1N"]);
    expect(grades(reorder(rows))).toEqual(["2", "2", "2", "1N"]);
    for (const ym of [SEP, YM, NOV, DEC]) expect(effectiveRow(reorder(rows), "grade", ym)?.row.choice).toBe(effectiveRow(rows, "grade", ym)?.row.choice);
    // 施設基準コードも同じ（12 月は 3055、9〜11 月は 3168）
    expect([heldOf(rows, "3168", { yearMonth: NOV }, today).v, heldOf(rows, "3055", { yearMonth: DEC }, today).v, heldOf(rows, "3168", { yearMonth: DEC }, today).v]).toEqual(["held", "held", "not"]);
  });
  it("注16（9 月から満たす → 12 月から満たさない → 10 月の直しとして 10 月から満たす）でも同じで、12 月は「満たさない」", () => {
    const rows = [note16({ fromMonth: SEP }), note16({ fromMonth: DEC, requirement: "not_met" }), note16({ fromMonth: YM })];
    const vals = (rs: DeclarationRow[]) => [SEP, YM, NOV, DEC].map((ym) => facilityFromDeclaration(rs, today, ym).note16Met);
    expect(vals(rows)).toEqual([true, true, true, false]);
    expect(vals(reorder(rows))).toEqual([true, true, true, false]);
  });
  it("同じ from_month の行を 2 つ入れると後の id が効く", () => {
    const rows = [note16({ fromMonth: YM }), note16({ fromMonth: YM, requirement: "not_met" })];
    expect(facilityFromDeclaration(rows, today, YM).note16Met).toBe(false);
  });
  it("さかのぼりの確かめの文：判定が変わる月の範囲と、先の月からの変更が残ること", () => {
    expect(changeNotices([a()], "grade", SEP, today)).toEqual([`${SEP} から ${NOV} までの請求の判定が変わります`, `${DEC} からの請求は、「機能強化型 単独型・病床なし」のままです`]);
  });
  it("さかのぼって入れた行は直後の行にならず、9 月の行の確かめ直す日は 12 月の行の確かめた日で比べる", () => {
    const rows = [a(), b()];
    expect(effectiveRow(rows, "grade", NOV)?.nextFirst?.fromMonth).toBe(DEC);
    // 9 月の行の確かめ直す日（11-08）が、12 月の行を確かめた日（11-04）より後なら、今日（11-20）を過ぎても 9〜11 月は「持つ」
    const b2 = { ...b(), recheckOn: d(NOV, 8) };
    expect(facilityFromDeclaration([a(), b2], d(NOV, 20), NOV).grade).toBe("2");
  });
});

describe("直後の組で最初に残した行の日で比べる（docs L-1・round-53 C-271）", () => {
  it("先の月の組が 2 つあるとき、from_month の小さい組の、最初に残した行の確かめた日で比べる", () => {
    const base = note16({ fromMonth: YM, recheckOn: d(NOV, 10) });
    const first = note16({ fromMonth: NOV, checkedOn: d(NOV, 5) });
    const second = note16({ fromMonth: NOV, checkedOn: d(NOV, 20) });
    const far = note16({ fromMonth: DEC, checkedOn: d(NOV, 1) });
    const e = effectiveRow([base, first, second, far], "note16", YM);
    expect(e?.nextFirst?.id).toBe(first.id);
    expect(facilityFromDeclaration([base, first, second, far], d(DEC, 20), YM).note16Met).toBe(true);
  });
  it("写しても過去の月が落ちない：r2 を「変わりなし」で写しても（r2'）、10・11 月の dxTier は写す前と同じ", () => {
    const r1 = row("code:4100", { fromMonth: YM, choice: "1", checkedOn: "2026-03-01", recheckOn: "2027-03-01" });
    const r2 = row("code:4100", { fromMonth: DEC, choice: "2", startOn: d(DEC, 1), checkedOn: d(NOV, 4) });
    const today = "2027-10-20";
    const before = [YM, NOV].map((ym) => facilityFromDeclaration([r1, r2], today, ym).dxTier);
    const r2copy = { ...r2, id: nextId++, checkedOn: today, recheckOn: "2028-10-20" };
    expect(before).toEqual(["1", "1"]);
    expect([YM, NOV].map((ym) => facilityFromDeclaration([r1, r2, r2copy], today, ym).dxTier)).toEqual(before);
    expect(effectiveRow([r1, r2, r2copy], "code:4100", NOV)?.nextFirst?.checkedOn).toBe(d(NOV, 4));
    // 施設基準コードの三値も同じ（「分からない（確かめ直す日を過ぎた）」に落ちない）
    expect(heldOf([r1, r2, r2copy], "4100", { yearMonth: NOV }, today)).toEqual({ v: "held" });
  });
});

describe("確かめ直す日の知らせ（round-52 X-150・round-53 C-274）", () => {
  it("今月から効く行の期限切れは、その行で出る。知らせから開くと、その行が選ばれている", () => {
    const today = d(NOV, 22);
    const oct = note16({ fromMonth: YM, checkedOn: d(YM, 31), recheckOn: "2027-01-31" });
    const nov = note16({ fromMonth: NOV, checkedOn: d("2026-08", 20), recheckOn: d(NOV, 20) });
    const n = recheckNotices([oct, nov], today, "2026-12-22");
    expect(n.rows.map((r) => [r.id, r.state, r.fromMonth, r.untilMonth])).toEqual([[nov.id, "overdue", NOV, null]]);
    expect(initialSelection([oct, nov], { notice: nov.id })).toEqual([nov.id]);
    // 11 月の請求は分からない（確かめ直す日を過ぎた）。11 月の行を写すと戻り、10 月の請求の比べる日は 11 月の組の最初の行のまま
    expect(facilityFromDeclaration([oct, nov], today, NOV).note16Met).toBeNull();
    const copy = { ...nov, id: nextId++, checkedOn: today, recheckOn: "2027-02-22" };
    expect(facilityFromDeclaration([oct, nov, copy], today, NOV).note16Met).toBe(true);
    expect(effectiveRow([oct, nov, copy], "note16", YM)?.nextFirst?.id).toBe(nov.id);
  });
  it("古い診療月で効く行：直後の組の最初の行の確かめた日より前に確かめ直す日がある行は「〜の診療月で分からない」として出て、選べる", () => {
    const today = d(NOV, 22);
    const r0 = row("code:4102", { fromMonth: "2026-04", startOn: "2026-04-01", checkedOn: "2026-03-01", recheckOn: "2026-08-01" });
    const r1 = row("code:4102", { fromMonth: YM, checkedOn: d(YM, 1) });
    const n = recheckNotices([r0, r1], today, "2026-12-22");
    expect(n.rows.map((r) => [r.id, r.state, r.fromMonth, r.untilMonth])).toEqual([[r0.id, "overdue", "2026-04", SEP]]);
    expect(selectableRows([r0, r1]).map((r) => r.id)).toEqual([r0.id, r1.id]);
    // 9 月の請求の理由から開くと r0 が選ばれ、写すと 9 月が申告の値に戻る
    expect(initialSelection([r0, r1], { month: SEP, itemKey: "code:4102" })).toEqual([r0.id]);
    expect(heldOf([r0, r1], "4102", { yearMonth: SEP }, today)).toEqual({ v: "unknown", reason: "expired" });
    const copy = { ...r0, id: nextId++, checkedOn: today, recheckOn: "2027-11-22" };
    expect(heldOf([r0, r1, copy], "4102", { yearMonth: SEP }, today)).toEqual({ v: "held" });
    // 確かめ直す日が直後の組の日より後の古い行は出ない
    const ok = { ...r0, recheckOn: d(YM, 5) };
    expect(recheckNotices([ok, r1], today, "2026-12-22").rows).toEqual([]);
  });
  it("from_month が空の行は「いつの診療月からを入れてください」に出て、選べず、初期の選択にならない", () => {
    const empty = row("note16", { fromMonth: null, notified: "na", startOn: null, checkedOn: null, recheckOn: null, source: "migrated" });
    const n = recheckNotices([empty], d(NOV, 22), "2026-12-22");
    expect(n).toEqual({ rows: [], noFromMonth: ["note16"] });
    expect(selectableRows([empty])).toEqual([]);
    expect(initialSelection([empty], { screen: d(NOV, 22) })).toEqual([]);
    expect(initialSelection([empty], { notice: empty.id })).toEqual([]);
  });
  it("申告の画面の初期の選択は、今日の前の月で効く行。12 月の行は選ばれない（選べる）", () => {
    const a = grade({ fromMonth: DEC, choice: "solo_nobeds", startOn: d(DEC, 1), checkedOn: d(NOV, 4) });
    const b = grade({ fromMonth: SEP, choice: "zaishishin3", startOn: d(SEP, 1), checkedOn: d(NOV, 10) });
    expect(initialSelection([a, b], { screen: d(NOV, 10) })).toEqual([b.id]);
    expect(selectableRows([a, b]).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });
});
