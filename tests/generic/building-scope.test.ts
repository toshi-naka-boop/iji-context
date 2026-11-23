// 段 17f（design.md §15-4・§15-10）：単一建物の人数の次元で、点検の範囲に出す数。作り物の小さな表（公開元の表の行ではない）。
// みなしのコメントで 1 人と読んだ行（V-3）と、情報通信機器の区分の行（対象外の単位のまま。L-110）
import { describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import type { ClaimContext } from "../../src/engine/types";
import { buildingScopeNotes } from "../../src/generic/scope";
import { loadCase } from "../engine/helpers";
import { YM } from "../helpers/period";
import { GEN, put, smallMasters } from "./small-masters";

const SNAP = "20261001";
const rev = resolveRevision(YM);
const about = { yearMonth: YM, generation: GEN };
const K1 = loadCase("K1");
/** 作り物の情報通信機器の在医総管の行（区分番号 C002、施設基準の組 ③ に 3825） */
const ICT = "114055310";

describe("点検の範囲の数（単一建物の人数）", () => {
  it("戸数によるみなしのコメントが付いた在医総管の 1 人の区分の行は「みなしのコメントで 1 人と読んだ行：n 行」", () => {
    const c: ClaimContext = { ...K1, comments: [{ code: "820100095", text: "", raw: "", on: ["C002_2I1"] }], commentsKnown: true };
    expect(buildingScopeNotes(c, rev, null, null, null)).toEqual(["みなしのコメントで 1 人と読んだ行：1 行"]);
    expect(buildingScopeNotes({ ...c, commentsKnown: false }, rev, null, null, null)).toEqual([]);
  });

  it("情報通信機器の区分の管理料の行は、対象外の単位のまま「情報通信機器の区分は見ていません：n 行」（マスターがなければ数えない）", () => {
    const db = smallMasters(":memory:", SNAP);
    put(db, "shinryo", SNAP, { code: ICT, name: "在医総管（機能強化在支診等・床有・月２回～通信機１人）", alpha: "C", sho: 2, bu: 2, kubun_no: 2, eda: 0, shisetsu_g1: "3055/4247/3057/3058", shisetsu_g2: "721", shisetsu_g3: "3825" });
    const claim = { units: [{ items: [{ kind: "SI" as const, code: ICT }] }, { items: [{ kind: "SI" as const, code: rev.codes.C001_1I.primary }] }] };
    expect(buildingScopeNotes(K1, rev, claim, db, about)).toEqual(["情報通信機器の区分は見ていません：1 行"]);
    expect(buildingScopeNotes(K1, rev, claim, null, null)).toEqual([]);
  });
});
