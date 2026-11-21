// 段 16：改定の棚卸（design.md §14-4・§14-5）。改定前後の世代の 1 枚で、その組の背反の行・コードの行・EM の組のどれかに差がある知識だけ要再検証になる。1 枚がないときは保留（C-181）
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { r2024 } from "../../src/engine/revisions/r2024";
import { r2026 } from "../../src/engine/revisions/r2026";
import { r2027_06 } from "../../src/engine/revisions/r2027-06";
import { HAIHAN, type HaihanConfig } from "../../src/generic/haihan";
import { generationsAt, pairRevisionDiff } from "../../src/generic/local-revision";
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
  it("比べる 1 枚（どちらかの世代の電子点数表・医科診療行為マスター）か、EM の版の行がないときは保留（pending）", () => {
    expect(pairRevisionDiff(tensuhyoMasters(OLD), PAIR, GENS, EM)).toBe("pending");
    expect(pairRevisionDiff(twoGenerations(), PAIR, GENS, { R8: HAIHAN })).toBe("pending");
  });
  it("改定日から前後の世代：令和 8 年度の改定日は R6 → R8。版のない改定日（令和 10 年度）は決まらない（null）", () => {
    const revs = [r2024, r2026, r2027_06];
    expect(generationsAt("2026-06-01T00:00:00+09:00", revs)).toEqual({ before: "R6", after: "R8" });
    expect(generationsAt("2028-06-01T00:00:00+09:00", revs)).toBeNull();
    expect(generationsAt("2024-06-01T00:00:00+09:00", revs)).toBeNull();
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
    expect(readKnowledge(h.deps.store, changed)?.history.at(-1)).toEqual(expect.objectContaining({ event: "TRIGGER{localRevision}", basis: { trigger: "localRevision", codePair: { a: "112007410", b: "114001110", tani: 1 }, changes: ["背反の表のこの組の行（あるか・表・算定する側・特例条件）"] } }));
    expect(buildDigest(h.deps).items.find((x) => x.knowledgeId === changed)?.reason).toEqual(expect.objectContaining({ trigger: "localRevision", changes: ["背反の表のこの組の行（あるか・表・算定する側・特例条件）"] }));
    // 改定日より後に承認済みに入った知識は見ない
    seen.length = 0;
    h.review("2026-06-13T09:00:00+09:00");
    expect(seen.sort()).toEqual(["114001210@2026-06-01", "114001310@2026-06-01"]);
  });
});
