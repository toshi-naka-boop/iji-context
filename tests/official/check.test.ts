// design.md §11-3：公的文書の条件に当たるかを人が確かめる。規則 5 を 5a〜5d に替え、確認は OFFICIAL_CHECK で meta に残す
// 確認がない間の結果が今までと同じことは、tests/official/match.test.ts（無変更）が縛る
import { describe, expect, it } from "vitest";
import calendarJson from "../../config/calendar.json";
import type { Calendar } from "../../src/lifecycle/calendar";
import { transition } from "../../src/lifecycle/machine";
import { evaluateTriggers } from "../../src/lifecycle/triggers";
import type { KnowledgeMeta, KnowledgeStatus } from "../../src/lifecycle/types";
import { checkable, conflictKeys, docKey, judge, judgeAll, related } from "../../src/official/match";
import { at } from "../helpers/period";
import { makeMeta } from "../lifecycle/helpers";
import { makeDoc, officialOf } from "./helpers";

const GEN = "R8";
const NOW = at(14);
const CAL = calendarJson as Calendar;
/** 条件の注記つきで「認める」文書と「認めない」文書（支払基金・C001） */
const yes = makeDoc({ id: "X-YES", stance: "認める", scope: { conditionNote: "確定病名のとき" } });
const no = makeDoc({ id: "X-NO", stance: "認めない", scope: { conditionNote: "疑いのとき" } });
const cond = makeDoc({ id: "X-COND", stance: "条件つき", scope: { conditionNote: "医学的に必要なとき" } });
const avoid = (over: Partial<KnowledgeMeta> = {}) => makeMeta({ polarity: "avoid", ...over });
const check = (applies: boolean, by = "new1") => ({ applies, by, at: NOW });
const ev = (key: string, applies: boolean, by = "new1", actor: "clerk" | "veteran" | "manager" | "doctor" = "clerk") => ({ type: "OFFICIAL_CHECK" as const, key, applies, by, actor });

describe("judge：規則 5a〜5d", () => {
  it("5a：「条件つき」の文書は、確認があっても関連あり・未照合のまま（向きがないので進む先がない）", () => {
    expect(judge(avoid({ official_checks: { [docKey(cond)]: check(true) } }), cond, GEN)).toBe("関連あり・未照合");
    expect(checkable(cond)).toBe(false);
  });
  it("5b：条件の注記があり、確認がなければ関連あり・未照合。ほかの文書・古い鍵の確認は効かない", () => {
    expect(judge(avoid(), yes, GEN)).toBe("関連あり・未照合");
    expect(judge(avoid({ official_checks: {} }), yes, GEN)).toBe("関連あり・未照合");
    expect(judge(avoid({ official_checks: { [docKey(no)]: check(true), "X-YES#00000000": check(true) } }), yes, GEN)).toBe("関連あり・未照合");
  });
  it("5c：「当たらない」と確かめた文書は対象外", () => {
    expect(judge(avoid({ official_checks: { [docKey(yes)]: check(false) } }), yes, GEN)).toBe("対象外");
  });
  it("5d：「当たる」と確かめた文書は規則 6・7 へ進む（向きが逆なら矛盾の恐れ、同じなら整合）", () => {
    const both = avoid({ official_checks: { [docKey(yes)]: check(true), [docKey(no)]: check(true) } });
    expect(judge(both, yes, GEN)).toBe("矛盾の恐れ");
    expect(judge(both, no, GEN)).toBe("整合");
  });
  it("規則 1〜4 で対象外の文書は、確認があっても対象外のまま。条件の注記のない文書は確認に関係なく 6・7 へ進む", () => {
    const other = makeDoc({ id: "X-OTHER", scope: { kubun: ["C002"], conditionNote: "別の区分" } });
    const m = avoid({ official_checks: { [docKey(other)]: check(true) } });
    expect(related(m, other, GEN)).toBe(false);
    expect(judge(m, other, GEN)).toBe("対象外");
    const plain = makeDoc({ id: "X-PLAIN" });
    expect(checkable(plain)).toBe(false);
    expect(judge(avoid({ official_checks: { [docKey(plain)]: check(false) } }), plain, GEN)).toBe("矛盾の恐れ");
  });
  it("文書の判定に効く欄を直すと鍵が変わり、古い確認は効かなくなる（未照合に戻る）。要旨だけの直しでは変わらない", () => {
    const m = avoid({ official_checks: { [docKey(yes)]: check(true) } });
    expect(judge(m, { ...yes, summary: "要旨を直した" }, GEN)).toBe("矛盾の恐れ");
    expect(judge(m, makeDoc({ id: "X-YES", stance: "認める", scope: { conditionNote: "確定病名で、連月のとき" } }), GEN)).toBe("関連あり・未照合");
  });
});

describe("judgeAll：人が確かめた文書を添える", () => {
  it("確認がなければ今までと同じ形（checked の欄を持たない）", () => {
    expect(judgeAll(avoid(), [yes, no, cond], GEN)).toEqual({ verdict: "関連あり・未照合", approx: false, ids: { 矛盾の恐れ: [], "関連あり・未照合": ["X-COND", "X-NO", "X-YES"], 整合: [] } });
    expect("checked" in judgeAll(avoid(), [yes, no, cond], GEN)).toBe(false);
  });
  it("「当たる」は結果に進み、「当たらない」は結果から外れる。どちらも確かめた人・日が残る。文書の並び順に依らない", () => {
    const m = avoid({ official_checks: { [docKey(yes)]: check(true, "vet1"), [docKey(no)]: check(false, "new1") } });
    const all = judgeAll(m, [yes, no, cond], GEN);
    expect(all).toEqual({
      verdict: "矛盾の恐れ",
      approx: false,
      ids: { 矛盾の恐れ: ["X-YES"], "関連あり・未照合": ["X-COND"], 整合: [] },
      checked: [{ id: "X-NO", applies: false, by: "new1", at: NOW }, { id: "X-YES", applies: true, by: "vet1", at: NOW }],
    });
    expect(judgeAll(m, [cond, no, yes], GEN)).toEqual(all);
  });
  it("両方に「当たる」と確かめると、まとめは危ない側の矛盾の恐れ。認めない文書だけなら整合", () => {
    const both = avoid({ official_checks: { [docKey(yes)]: check(true), [docKey(no)]: check(true) } });
    expect(judgeAll(both, [yes, no], GEN)).toMatchObject({ verdict: "矛盾の恐れ", ids: { 矛盾の恐れ: ["X-YES"], 整合: ["X-NO"] } });
    expect(judgeAll(avoid({ official_checks: { [docKey(no)]: check(true) } }), [no], GEN).verdict).toBe("整合");
  });
});

describe("トリガー④：確認で矛盾の恐れになった文書が対象になる", () => {
  const official = officialOf([yes, no, cond]);
  it("確認がなければ ④ は出ない。「当たる」で矛盾の恐れになった文書の鍵が対象になり、承認済みの知識で発火する", () => {
    const base = avoid({ status_since: NOW, last_hit_at: NOW });
    expect(conflictKeys(base, official, NOW)).toEqual([]);
    expect(evaluateTriggers([base], NOW, CAL, official)).toEqual([]);
    const checked = { ...base, official_checks: { [docKey(yes)]: check(true), [docKey(no)]: check(true) } };
    expect(conflictKeys(checked, official, NOW)).toEqual([docKey(yes)]);
    expect(evaluateTriggers([checked], NOW, CAL, official)).toEqual([{ knowledgeId: checked.id, event: { type: "TRIGGER", trigger: "official" }, officialIds: [docKey(yes)] }]);
  });
  it("会議で確認済み（official_seen）の文書・「当たらない」に答え直した文書・承認済みでない知識では発火しない", () => {
    const checked = avoid({ status_since: NOW, last_hit_at: NOW, official_checks: { [docKey(yes)]: check(true) } });
    expect(evaluateTriggers([{ ...checked, official_seen: [docKey(yes)] }], NOW, CAL, official)).toEqual([]);
    expect(evaluateTriggers([{ ...checked, official_checks: { [docKey(yes)]: check(false) } }], NOW, CAL, official)).toEqual([]);
    for (const status of ["未検証", "contested", "要再検証"] as const) expect(evaluateTriggers([{ ...checked, status }], NOW, CAL, official), status).toEqual([]);
  });
});

describe("遷移：OFFICIAL_CHECK（§4-2 に足した行）", () => {
  const key = docKey(yes);
  it("未検証・承認済み・contested・要再検証で受け、状態と status_since を変えずに確認を残し、history に鍵・結果・役割を残す", () => {
    for (const status of ["未検証", "承認済み", "contested", "要再検証"] as KnowledgeStatus[]) {
      const before = makeMeta({ status });
      const r = transition(before, ev(key, true, "u0002", "manager"), NOW, { officialIds: [key] });
      expect([r.meta.status, r.meta.status_since], status).toEqual([status, before.status_since]);
      expect(r.meta.official_checks, status).toEqual({ [key]: { applies: true, by: "u0002", at: NOW } });
      expect(r.meta.history.at(-1), status).toEqual({ at: NOW, from: status, to: status, event: "OFFICIAL_CHECK{applies}", actor: "manager", basis: { officialIds: [key] } });
      expect(r.effects, status).toEqual([]);
      // 入力の meta は書き換えない
      expect(before.official_checks, status).toBeUndefined();
    }
  });
  it("停止・保管では受けない", () => {
    for (const status of ["停止", "保管"] as KnowledgeStatus[]) expect(() => transition(makeMeta({ status }), ev(key, true), NOW), status).toThrow(/許されない遷移/);
  });
  it("同じ鍵に答え直すと上書きし、history には両方残る。ほかの鍵の確認と official_seen は変えない", () => {
    const first = transition(makeMeta({ official_seen: ["A-1#aaaaaaaa"], official_checks: { [docKey(no)]: check(true) } }), ev(key, true, "new1", "clerk"), NOW).meta;
    const later = at(15);
    const second = transition(first, ev(key, false, "vet1", "veteran"), later).meta;
    expect(second.official_checks).toEqual({ [docKey(no)]: check(true), [key]: { applies: false, by: "vet1", at: later } });
    expect(second.history.map((h) => [h.event, h.actor])).toEqual([["OFFICIAL_CHECK{applies}", "clerk"], ["OFFICIAL_CHECK{not-applies}", "veteran"]]);
    expect(second.official_seen).toEqual(["A-1#aaaaaaaa"]);
  });
});
