// 段 16：改定の棚卸（design.md §14-4・§14-5。v27）。改定前後の世代の 1 枚で、その組の背反の行・コードの行・EM の組のどれかに差がある知識だけ要再検証になる。
// 改定後の 1 枚がないときは保留（C-181）、改定前の 1 枚・EM の行がないときは要再検証（C-202）
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { r2024 } from "../../src/engine/revisions/r2024";
import { r2026 } from "../../src/engine/revisions/r2026";
import { r2027_06 } from "../../src/engine/revisions/r2027-06";
import { HAIHAN, HAIHAN_BY_GENERATION, type HaihanConfig } from "../../src/generic/haihan";
import { MASTERS_CONFIG } from "../../src/masters/config";
import { generationsAt, NO_BEFORE, pairRevisionDiff } from "../../src/generic/local-revision";
import { buildDigest } from "../../src/lifecycle/review";
import { applyEvent, createKnowledge, readKnowledge } from "../../src/lifecycle/store";
import type { CodePair } from "../../src/lifecycle/types";
import { harness } from "../lifecycle/review-helpers";
import { source } from "./small-masters";
import { C, tensuhyoMasters } from "./small-tensuhyo";

const OLD = "20261001";
const NEW = "20280601";
const GENS = { before: "R8", after: "R10" };
/** 改定後の世代（仮に R10）の 1 枚を、改定前の 1 枚の写しとして足す */
function twoGenerations(): Database.Database {
  const db = tensuhyoMasters(OLD);
  for (const t of ["shinryo", "haihan"]) {
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name).filter((c) => c !== "snapshot");
    db.exec(`INSERT INTO ${t} (snapshot, ${cols.join(", ")}) SELECT '${NEW}', ${cols.join(", ")} FROM ${t} WHERE snapshot = '${OLD}'`);
  }
  source(db, "shinryo", NEW, "R10");
  source(db, "tensuhyo", NEW, "R10");
  return db;
}
const PAIR: CodePair = { a: C.oushin, b: C.houmon, tani: 1 };
const EM: Record<string, HaihanConfig> = { R8: HAIHAN, R10: HAIHAN };

describe("改定前の EM の行は、版ごとに写して持つ（round-43 codex #2）", () => {
  it("R8 の行は、出荷の json そのものではない写し。今の世代（R8）の写しは、出荷の json と同じ（改定で出荷の json を書き換える前に、今の世代の写しを残す）", () => {
    expect(HAIHAN_BY_GENERATION.R8).not.toBe(HAIHAN);
    expect(HAIHAN_BY_GENERATION[MASTERS_CONFIG.generation]).toEqual(HAIHAN);
  });
});

describe("改定の前後でその組に差が出たか（pairRevisionDiff）", () => {
  it("差がなければ空。背反の行（特例条件）・コードの行（名称）・EM の組のどれかが変わると、その項目を返す", () => {
    expect(pairRevisionDiff(twoGenerations(), PAIR, GENS, EM)).toEqual([]);
    const t = twoGenerations();
    t.prepare("UPDATE haihan SET tokurei = '0' WHERE snapshot = ? AND code1 = ? AND code2 = ?").run(NEW, C.oushin, C.houmon);
    expect(pairRevisionDiff(t, PAIR, GENS, EM)).toEqual(["背反の表のこの組の行（あるか・表・算定する側・特例条件）"]);
    const s = twoGenerations();
    s.prepare("UPDATE shinryo SET name = '別の名称' WHERE snapshot = ? AND code = ?").run(NEW, C.houmon);
    expect(pairRevisionDiff(s, PAIR, GENS, EM)).toEqual([`基本マスターの ${C.houmon} の行（名称）`]);
    const gone = twoGenerations();
    gone.prepare("DELETE FROM shinryo WHERE snapshot = ? AND code = ?").run(NEW, C.oushin);
    // 廃止されると、区分番号で選ぶ EM の組にも当たらなくなる
    expect(pairRevisionDiff(gone, PAIR, GENS, EM)).toEqual([`基本マスターの ${C.oushin} の行（廃止）`, "EM §2-12 のこの組に当たる組・例外の決まり"]);
    const em: Record<string, HaihanConfig> = { R8: HAIHAN, R10: { ...HAIHAN, exceptions: HAIHAN.exceptions.map((x) => (x.id === "HX-01" ? { ...x, text: "変えた一言" } : x)) } };
    expect(pairRevisionDiff(twoGenerations(), PAIR, GENS, em)).toEqual(["EM §2-12 のこの組に当たる組・例外の決まり"]);
  });
  it("ほかの組の差は、この組の差にしない", () => {
    const t = twoGenerations();
    t.prepare("UPDATE haihan SET kubun = '1' WHERE snapshot = ? AND code1 = ?").run(NEW, C.shoshin);
    t.prepare("UPDATE shinryo SET name = '別の名称' WHERE snapshot = ? AND code = ?").run(NEW, C.shoshin);
    expect(pairRevisionDiff(t, PAIR, GENS, EM)).toEqual([]);
  });
  it("改定後の 1 枚（電子点数表・医科診療行為マスター）か改定後の EM の行がないときだけ保留（pending）。マスターがないときも保留（改定後の 1 枚もない）", () => {
    expect(pairRevisionDiff(tensuhyoMasters(OLD), PAIR, GENS, EM)).toBe("pending");
    expect(pairRevisionDiff(twoGenerations(), PAIR, GENS, { R8: HAIHAN })).toBe("pending");
    expect(pairRevisionDiff(null, PAIR, GENS, EM)).toBe("pending");
  });
  it("改定前の 1 枚・改定前の EM の行・改定前の版がなくて比べられないときは、要再検証にする文を返す（C-202・設計 v27）", () => {
    // マスターを消して作り直した：改定後（R10）の 1 枚だけがある
    const onlyAfter = twoGenerations();
    onlyAfter.prepare("DELETE FROM sources WHERE generation = 'R8'").run();
    expect(pairRevisionDiff(onlyAfter, PAIR, GENS, EM)).toEqual([NO_BEFORE]);
    expect(pairRevisionDiff(twoGenerations(), PAIR, GENS, { R10: HAIHAN })).toEqual([NO_BEFORE]);
    expect(pairRevisionDiff(twoGenerations(), PAIR, { before: null, after: "R10" }, EM)).toEqual([NO_BEFORE]);
  });
  it("改定日から前後の世代：令和 8 年度の改定日は R6 → R8。版のない改定日（令和 10 年度）は決まらない（null）", () => {
    const revs = [r2024, r2026, r2027_06];
    expect(generationsAt("2026-06-01T00:00:00+09:00", revs)).toEqual({ before: "R6", after: "R8" });
    expect(generationsAt("2028-06-01T00:00:00+09:00", revs)).toBeNull();
    expect(generationsAt("2024-06-01T00:00:00+09:00", revs)).toEqual({ before: null, after: "R6" });
  });
});

describe("会議の整理で、差が出た知識だけを要再検証にする（TRIGGER{localRevision}）", () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h.cleanup());
  it("差が出た知識だけ要再検証（根拠に差の中身）、差のない知識・保留の知識は承認済みのまま。議題に差の中身を出す", () => {
    h = harness();
    const T = "2026-05-01T09:00:00+09:00";
    const mk = (slug: string, b: string) => {
      const m = createKnowledge(h.deps.store, { layer: "院内", slug, summary: slug, body: slug, source: { type: "手動", ref: "t" }, polarity: "allow", matchApprox: true, conditionNote: "根拠：その他。条件", match: { codePair: { a: "112007410", b, tani: 1 } } }, T);
      applyEvent(h.deps.store, m.id, { type: "VERIFY_APPROVE" }, T);
      return m.id;
    };
    const [changed, same, pending] = [mk("p-changed", "114001110"), mk("p-same", "114001210"), mk("p-pending", "114001310")];
    const seen: string[] = [];
    h.deps.localRevision = (pair, d) => {
      seen.push(`${pair.b}@${d.slice(0, 10)}`);
      return pair.b === "114001110" ? ["背反の表のこの組の行（あるか・表・算定する側・特例条件）"] : pair.b === "114001210" ? [] : "pending";
    };
    h.review("2026-06-06T09:00:00+09:00");
    expect(seen.sort()).toEqual(["114001110@2026-06-01", "114001210@2026-06-01", "114001310@2026-06-01"]);
    expect([readKnowledge(h.deps.store, changed)?.status, readKnowledge(h.deps.store, same)?.status, readKnowledge(h.deps.store, pending)?.status]).toEqual(["要再検証", "承認済み", "承認済み"]);
    expect(readKnowledge(h.deps.store, changed)?.history.at(-1)).toEqual(expect.objectContaining({ event: "TRIGGER{localRevision}", basis: { trigger: "localRevision", codePair: { a: "112007410", b: "114001110", tani: 1 }, changes: ["背反の表のこの組の行（あるか・表・算定する側・特例条件）"], revisionDate: "2026-06-01T00:00:00+09:00" } }));
    expect(buildDigest(h.deps).items.find((x) => x.knowledgeId === changed)?.reason).toEqual(expect.objectContaining({ trigger: "localRevision", changes: ["背反の表のこの組の行（あるか・表・算定する側・特例条件）"] }));
    // 棚卸の記録は知識ごとに残る：差のなかった知識は見直さず、保留の知識だけ次の会議で比べ直す
    expect([readKnowledge(h.deps.store, changed)?.revision_checks, readKnowledge(h.deps.store, same)?.revision_checks, readKnowledge(h.deps.store, pending)?.revision_checks]).toEqual([{ "2026-06-01T00:00:00+09:00": "changed" }, { "2026-06-01T00:00:00+09:00": "same" }, { "2026-06-01T00:00:00+09:00": "pending" }]);
    seen.length = 0;
    h.review("2026-06-13T09:00:00+09:00");
    expect(seen).toEqual(["114001310@2026-06-01"]);
  });

  it("保留は、別の理由で承認し直しても残り、比べる 1 枚がそろったら比べる（round-43 codex #2）。改定の後に承認済みに入った知識は見ない", () => {
    h = harness();
    const T = "2026-05-01T09:00:00+09:00";
    const m = createKnowledge(h.deps.store, { layer: "院内", slug: "p-hold", summary: "p", body: "p", source: { type: "手動", ref: "t" }, polarity: "allow", matchApprox: true, conditionNote: "根拠：その他。条件", match: { codePair: { a: "112007410", b: "114001110", tani: 1 } } }, T);
    applyEvent(h.deps.store, m.id, { type: "VERIFY_APPROVE" }, T);
    const late = createKnowledge(h.deps.store, { layer: "院内", slug: "p-late", summary: "p", body: "p", source: { type: "手動", ref: "t" }, polarity: "allow", matchApprox: true, conditionNote: "根拠：その他。条件", match: { codePair: { a: "112007410", b: "114001210", tani: 1 } } }, "2026-06-03T09:00:00+09:00");
    applyEvent(h.deps.store, late.id, { type: "VERIFY_APPROVE" }, "2026-06-03T09:00:00+09:00");
    let ready = false;
    const seen: string[] = [];
    h.deps.localRevision = (pair) => {
      seen.push(pair.b);
      return ready ? ["基本マスターの 114001110 の行（名称）"] : "pending";
    };
    h.review("2026-06-06T09:00:00+09:00");
    expect([seen, readKnowledge(h.deps.store, m.id)?.status]).toEqual([["114001110"], "承認済み"]);
    // 返戻で要再検証 → 会議で承認し直す（status_since は改定日より後になる）。保留は残る
    applyEvent(h.deps.store, m.id, { type: "TRIGGER", trigger: "localReturn" }, "2026-06-08T09:00:00+09:00", { trigger: "localReturn" });
    applyEvent(h.deps.store, m.id, { type: "RECHECK_PASS", via: "veteran" }, "2026-06-09T09:00:00+09:00");
    expect(readKnowledge(h.deps.store, m.id)?.revision_checks).toEqual({ "2026-06-01T00:00:00+09:00": "pending" });
    ready = true;
    h.review("2026-06-13T09:00:00+09:00");
    expect([readKnowledge(h.deps.store, m.id)?.status, readKnowledge(h.deps.store, m.id)?.history.at(-1)?.event, readKnowledge(h.deps.store, m.id)?.revision_checks]).toEqual(["要再検証", "TRIGGER{localRevision}", { "2026-06-01T00:00:00+09:00": "changed" }]);
    expect(seen).not.toContain("114001210");
  });
});

describe("改定の棚卸を途中で止めても、やり直すと同じ結果になる（round-45 codex #2）", () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h.cleanup());
  it("要再検証にしたあと、結果を残す前に止まった → やり直すと結果が戻り、承認し直したあとに二度要再検証にしない", () => {
    h = harness();
    const T = "2026-05-01T09:00:00+09:00";
    const m = createKnowledge(h.deps.store, { layer: "院内", slug: "p-stop", summary: "p", body: "p", source: { type: "手動", ref: "t" }, polarity: "allow", matchApprox: true, conditionNote: "根拠：その他。条件", match: { codePair: { a: "112007410", b: "114001110", tani: 1 } } }, T);
    applyEvent(h.deps.store, m.id, { type: "VERIFY_APPROVE" }, T);
    h.deps.localRevision = () => ["基本マスターの 114001110 の行（名称）"];
    expect(() =>
      h.review("2026-06-06T09:00:00+09:00", {
        onStep: (step) => {
          if (step === "localRevision") throw new Error("ここで止める");
        },
      }),
    ).toThrow("ここで止める");
    expect([readKnowledge(h.deps.store, m.id)?.status, readKnowledge(h.deps.store, m.id)?.revision_checks]).toEqual(["要再検証", undefined]);
    h.review("2026-06-06T09:00:00+09:00");
    expect(readKnowledge(h.deps.store, m.id)?.revision_checks).toEqual({ "2026-06-01T00:00:00+09:00": "changed" });
    // 会議で承認し直す → 次の整理で、同じ改定の差で二度要再検証にしない
    applyEvent(h.deps.store, m.id, { type: "RECHECK_PASS", via: "veteran" }, "2026-06-07T09:00:00+09:00");
    h.review("2026-06-13T09:00:00+09:00");
    expect([readKnowledge(h.deps.store, m.id)?.status, readKnowledge(h.deps.store, m.id)?.history.filter((x) => x.event === "TRIGGER{localRevision}").length]).toEqual(["承認済み", 1]);
  });
});
