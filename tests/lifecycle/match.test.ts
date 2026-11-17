// §7 #10：コメントと連続月の条件（design.md §3、v6）と、K6 の地域知識（査定の通知から作る近似の候補。FR-79）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seed } from "../../scripts/seed-knowledge";
import { evaluate } from "../../src/engine";
import { consecutiveMonths, matchState } from "../../src/lifecycle/match";
import { applyEvent, listKnowledge, readKnowledge } from "../../src/lifecycle/store";
import type { Notice } from "../../src/notice/notice";
import { openApp, type App } from "../../src/server/app";
import { at, claimId, month, YM } from "../helpers/period";
import { makeCtx, makeMeta } from "./helpers";

// 仕組みの確かめは、BNP 以外の区分の合成の知識で行う（K6 の筋としては使わない）
const KUBUN = "D005_9";

/** 3 か月連続で算定している固定のフィクスチャ（基準月 ＋ その前の 2 か月） */
const ctx3 = (withComment: boolean) =>
  makeCtx({
    yearMonth: YM,
    kubun: [KUBUN],
    history: [
      { yearMonth: month(-2), kubun: [KUBUN] },
      { yearMonth: month(-1), kubun: [KUBUN] },
    ],
    comments: withComment ? [{ kubun: KUBUN, code: "800000001" }] : [],
  });

const region = { payer: "支払基金" as const, prefecture: "東京都" };
const avoid = makeMeta({ id: "regional/no-comment", polarity: "avoid", match: { kubunAll: [KUBUN], ...region, commentOn: [{ kubun: KUBUN, present: false }], consecutiveMonths: { kubun: KUBUN, min: 3 } } });
const allow = makeMeta({ id: "regional/comment", polarity: "allow", match: { kubunAll: [KUBUN], ...region, commentOn: [{ kubun: KUBUN, present: true }], consecutiveMonths: { kubun: KUBUN, min: 3 } } });

describe("commentOn", () => {
  it("コメントの有無で当てはまりが変わる", () => {
    expect(matchState(avoid, ctx3(false), [])).toBe("match");
    expect(matchState(avoid, ctx3(true), [])).toBe("nomatch");
    expect(matchState(allow, ctx3(true), [])).toBe("match");
    expect(matchState(allow, ctx3(false), [])).toBe("nomatch");
  });

  it("avoid／allow の組は、コメントの有無でちょうど片方だけ当てはまる", () => {
    for (const c of [true, false]) {
      const hits = [avoid, allow].filter((m) => matchState(m, ctx3(c), []) === "match");
      expect(hits).toHaveLength(1);
    }
  });
});

describe("consecutiveMonths", () => {
  it("history から当月を含めて数える", () => {
    expect(consecutiveMonths(ctx3(false), KUBUN)).toBe(3);
  });

  it("途切れたら数え直し", () => {
    const gap = makeCtx({
      yearMonth: YM,
      kubun: [KUBUN],
      history: [
        { yearMonth: month(-3), kubun: [KUBUN] },
        { yearMonth: month(-2), kubun: [] },
        { yearMonth: month(-1), kubun: [KUBUN] },
      ],
    });
    expect(consecutiveMonths(gap, KUBUN)).toBe(2);
    expect(matchState(avoid, gap, [])).toBe("nomatch");
  });

  it("当月に算定していなければ 0", () => {
    expect(consecutiveMonths(makeCtx({ yearMonth: YM, kubun: ["C001"], history: [{ yearMonth: month(-1), kubun: [KUBUN] }] }), KUBUN)).toBe(0);
  });

  it("年をまたいでも数える", () => {
    const jan = `${Number(YM.slice(0, 4)) + 1}-01`;
    const ctx = makeCtx({
      kubun: [KUBUN],
      yearMonth: jan,
      history: [
        { yearMonth: `${YM.slice(0, 4)}-11`, kubun: [KUBUN] },
        { yearMonth: `${YM.slice(0, 4)}-12`, kubun: [KUBUN] },
      ],
    });
    expect(consecutiveMonths(ctx, KUBUN)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// K6 の地域知識（design.md §3 の表）。通知から作る候補は必ず avoid・近似で、提出結果からは当たり・外れを数えない

describe("K6 の地域知識（査定の通知から作る近似の候補）", () => {
  const repo = path.join(__dirname, "..", "..");
  const BNP = "D008_19";
  const K6 = claimId("K6");
  let tmp: string;
  let app: App;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "iji-k6-"));
    app = openApp({ root: repo, dbFile: path.join(tmp, "app.db"), knowledgeDir: path.join(tmp, "knowledge"), skillsDir: path.join(tmp, "skills"), queryLogDir: path.join(tmp, "query-log") });
    seed(app.store);
    app.upsertClerk({ id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" });
    app.seedLocalRules();
  });
  afterEach(() => {
    app.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  const regional = () => listKnowledge(app.store).filter((m) => m.layer === "地域");
  const seeded = () => regional().find((m) => m.source_event.type === "査定")!;
  /** K6 を確定して提出にし、結果を取り込む。提出の id を返す */
  const submitK6 = (resultId: string, outcome: "通過" | "査定") => {
    const q = app.start("new1", K6);
    app.confirm(q.id, app.caseOf(K6).lines);
    app.importClaimResult({ resultId, submissionId: q.id, kind: "原審査", outcome, kubun: [BNP] });
    return q.id;
  };
  const missItems = (id: string) => app.agenda().items.filter((i) => i.kind === "miss" && i.knowledgeId === id);

  it("種は §3 の表のとおり：未検証・avoid・近似・条件の注記に通知の理由。条件は区分・審査支払機関・都道府県の 3 つだけ", () => {
    expect(regional()).toHaveLength(1);
    const m = seeded();
    expect(m).toMatchObject({ layer: "地域", status: "未検証", polarity: "avoid", matchApprox: true });
    expect(m.match).toEqual({ kubunAll: [BNP], payer: "支払基金", prefecture: "東京都" });
    expect(m.conditionNote).toMatch(/^通知の理由：.*心不全の疑い.*連月/);
    expect(m.summary).toBe(`東京都・支払基金：BNP（${BNP}）が査定された（${month(-1)} 診療分）`);
    expect(m.summary + (m.conditionNote ?? "")).not.toMatch(/[0-9]+\s*点|円/);
  });

  it("支払基金・東京都で BNP を算定した請求に当たる。摘要コメントを足しても、初めての算定でも、確定病名でも変わらない（近似）", () => {
    const m = seeded();
    const k6 = app.caseOf(K6);
    const applied = evaluate(k6).applied;
    expect(matchState(m, k6, applied)).toBe("match");
    expect(matchState(m, { ...k6, comments: [{ kubun: BNP, code: "820100001" }] }, applied)).toBe("match");
    expect(matchState(m, { ...k6, history: [] }, applied)).toBe("match");
    expect(matchState(m, { ...k6, facts: { ...k6.facts, mainDisease: { known: true, value: "慢性心不全" } } }, applied)).toBe("match");
    // 国保連の請求（K1 も BNP を算定している）には当たらない
    expect(matchState(m, app.caseOf(claimId("K1")), evaluate(app.caseOf(claimId("K1"))).applied)).toBe("nomatch");
  });

  it("承認した K6 の知識を適用した提出に、通過・査定の結果を取り込んでも、hits・misses は変わらず、外れの議題も出ない", () => {
    const id = seeded().id;
    app.verify(id, true);
    // 同じ請求を出し直すと前の提出は置き換わるので、通過と査定を 1 回ずつ、会議をはさんで確かめる
    submitK6("r-pass", "通過");
    app.advanceClock(at(17));
    expect(readKnowledge(app.store, id)).toMatchObject({ status: "承認済み", hits: 0, misses: 0 });
    expect(missItems(id)).toEqual([]);
    submitK6("r-cut", "査定");
    app.advanceClock(at(24));
    expect(readKnowledge(app.store, id)).toMatchObject({ status: "承認済み", hits: 0, misses: 0 });
    expect(missItems(id)).toEqual([]);
  });

  it("通知を登録する通常の道で、翌月の同じ内容の査定通知から作った候補も avoid・近似。種とは ref・slug・診療年月のほかが同じ（X-69）", () => {
    const seedMeta = seeded();
    const notice: Notice = {
      documentType: "増減点連絡書",
      prefecture: "東京都",
      items: [{ yearMonth: YM, patientName: "架空 六郎", insurerNumber: "01139997", itemName: "BNP", outcome: "査定", reason: "傷病名が「心不全の疑い」のまま、連月で算定されているため" }],
    };
    const made = app.registerNotice(notice, 0, { reexamFiled: false, fileName: "next.pdf" });
    expect(made).toMatchObject({ polarity: "avoid", matchApprox: true, status: "未検証", match: seedMeta.match, conditionNote: seedMeta.conditionNote, layer: seedMeta.layer });
    expect(made.id).not.toBe(seedMeta.id);
    expect(made.summary).toBe(seedMeta.summary.replace(month(-1), YM));

    // 承認し、通過した請求を取り込んでも、misses は増えず、外れの議題も出ない（条件なしで BNP の全部を避ける知識にならない）
    app.verify(made.id, true);
    submitK6("r-pass-1", "通過");
    app.advanceClock(at(17));
    expect(readKnowledge(app.store, made.id)).toMatchObject({ hits: 0, misses: 0 });
    expect(missItems(made.id)).toEqual([]);
  });

  it("理由が空の項目からも、近似の候補ができる", () => {
    const notice: Notice = { documentType: "増減点連絡書", prefecture: "東京都", items: [{ yearMonth: YM, patientName: "架空 六郎", insurerNumber: "01139997", itemName: "BNP", outcome: "査定", reason: "" }] };
    expect(app.registerNotice(notice, 0, { reexamFiled: false, fileName: "next.pdf" })).toMatchObject({ polarity: "avoid", matchApprox: true, conditionNote: "通知に理由の記載がない（条件は未確認）" });
  });

  it("再審査で復活した知識は allow で、近似にしない（条件の注記も引き継がない）。翌月の同じ項目の査定は外れに数え、会議の議題に出る（C-73）", () => {
    const src = seeded().id;
    applyEvent(app.store, src, { type: "REEXAM_FILED" }, app.now());
    applyEvent(app.store, src, { type: "REEXAM_RESULT", result: "復活" }, app.now());
    const revived = regional().find((m) => m.source_event.type === "再審査")!;
    expect(revived).toMatchObject({ status: "承認済み", polarity: "allow", matchApprox: false, conditionNote: null, relates_to: src, match: { kubunAll: [BNP], payer: "支払基金", prefecture: "東京都" } });
    expect(readKnowledge(app.store, src)?.status).toBe("保管");

    const cut = submitK6("r-next-cut", "査定");
    app.advanceClock(at(17));
    expect(readKnowledge(app.store, revived.id)).toMatchObject({ status: "承認済み", misses: 1, hits: 0 });
    const items = missItems(revived.id);
    expect(items).toHaveLength(1);
    // 外れの確認の議題：外れた提出と、同じように適用したほかの請求の欄（sameApplied）が並ぶ
    const reason = items[0].reason as { kind: "miss"; misses: { submissionId: string }[]; sameApplied: unknown[] };
    expect(reason.misses.map((x) => x.submissionId)).toEqual([cut]);
    expect(Array.isArray(reason.sameApplied)).toBe(true);
  });
});
