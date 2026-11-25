import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import calendarJson from "../../config/calendar.json";
import { period } from "../../src/demo/period";
import type { Calendar } from "../../src/lifecycle/calendar";
import { transition } from "../../src/lifecycle/machine";
import { baselineSeeds, seedLocalRules } from "../../src/lifecycle/seed-local";
import { applyEvent, createKnowledge, listKnowledge, readKnowledge, type StoreOptions } from "../../src/lifecycle/store";
import { evaluateTriggers } from "../../src/lifecycle/triggers";
import type { KnowledgeMeta } from "../../src/lifecycle/types";
import { docKey } from "../../src/official/match";
import type { OfficialDoc, OfficialInput } from "../../src/official/types";
import { at, dateIn, YM } from "../helpers/period";
import { makeDoc, officialOf } from "../official/helpers";
import { makeMeta } from "./helpers";

const cal = calendarJson as Calendar;
const day = (iso: string, plus: number) =>
  `${new Date(Date.parse(iso) + plus * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10)}T00:00:00+09:00`;

describe("config/calendar.json", () => {
  it("改定は偶数年 6/1、支払基金の改選は奇数年 6/1、東京都の国保連は null", () => {
    expect(cal.revision).toEqual({ parity: "even", monthDay: "06-01" });
    expect(cal.shiharaiKikin).toEqual({ parity: "odd", monthDay: "06-01" });
    expect(cal.kokuhoren["東京都"]).toBeNull();
  });
});

describe("① 改定", () => {
  const sys = (over = {}) => makeMeta({ id: "system/r01", layer: "制度", match: { ruleId: "R01" }, ...over });
  it("改定日が status_since より後なら TRIGGER{revision}", () => {
    const r = evaluateTriggers([sys({ status_since: "2024-01-01T00:00:00+09:00" })], "2024-06-01T00:00:00+09:00", cal);
    expect(r).toEqual([{ knowledgeId: "system/r01", event: { type: "TRIGGER", trigger: "revision" } }]);
  });
  it("改定日の前日は発火しない", () => {
    expect(evaluateTriggers([sys({ status_since: "2024-01-01T00:00:00+09:00" })], "2024-05-31T00:00:00+09:00", cal)).toEqual([]);
  });
  it("改定日以降に承認済みになった知識は発火しない", () => {
    expect(evaluateTriggers([sys({ status_since: "2024-06-01T00:00:00+09:00" })], "2025-03-01T00:00:00+09:00", cal)).toEqual([]);
  });
  it("制度層は 180 日経っても idle で発火しない", () => {
    expect(evaluateTriggers([sys({ status_since: "2024-06-02T00:00:00+09:00" })], "2025-05-30T00:00:00+09:00", cal)).toEqual([]);
  });
});

describe("制度層の要再検証", () => {
  it("180 日経っても IDLE_EXPIRED にならない", () => {
    const m = makeMeta({ id: "system/r01", layer: "制度", status: "要再検証", match: { ruleId: "R01" }, status_since: "2024-06-01T00:00:00+09:00" });
    expect(evaluateTriggers([m], "2025-05-31T00:00:00+09:00", cal)).toEqual([]);
    expect(evaluateTriggers([m], "2030-01-01T00:00:00+09:00", cal)).toEqual([]);
  });
});

describe("② 改選", () => {
  it("2025-06-01 で K6（支払基金）の地域知識が要再検証になる", () => {
    const k6 = makeMeta({ id: "regional/k6", status_since: "2025-03-31T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "支払基金", prefecture: "東京都" } });
    const fired = evaluateTriggers([k6], "2025-06-01T00:00:00+09:00", cal);
    expect(fired).toEqual([{ knowledgeId: "regional/k6", event: { type: "TRIGGER", trigger: "reappointment" } }]);
    expect(transition(k6, fired[0].event, "2025-06-01T00:00:00+09:00").meta.status).toBe("要再検証");
    expect(evaluateTriggers([k6], "2025-05-31T00:00:00+09:00", cal)).toEqual([]);
  });
  it("国保連の改選日が null（東京都）なら発火しない", () => {
    const m = makeMeta({ status_since: "2020-01-01T00:00:00+09:00", last_hit_at: "2025-05-30T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "国保連", prefecture: "東京都" } });
    expect(evaluateTriggers([m], "2025-06-01T00:00:00+09:00", cal)).toEqual([]);
  });
  it("カレンダーに都道府県の日付が入っていれば発火する。未登録の都道府県は発火しない", () => {
    const c: Calendar = { ...cal, kokuhoren: { 東京都: ["2025-09-01"] } };
    const m = makeMeta({ status_since: "2025-03-01T00:00:00+09:00", last_hit_at: "2025-09-01T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "国保連", prefecture: "東京都" } });
    expect(evaluateTriggers([m], "2025-08-31T00:00:00+09:00", c)).toEqual([]);
    expect(evaluateTriggers([m], "2025-09-01T00:00:00+09:00", c)).toHaveLength(1);
    const other = makeMeta({ status_since: "2025-03-01T00:00:00+09:00", last_hit_at: "2025-09-01T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "国保連", prefecture: "大阪府" } });
    expect(evaluateTriggers([other], "2025-09-01T00:00:00+09:00", c)).toEqual([]);
  });
  it("改選は地域層だけ。ベテラン層・院内層は改選日を過ぎても落ちない", () => {
    const v = makeMeta({ id: "veteran/a", layer: "ベテラン", status_since: "2025-03-01T00:00:00+09:00", last_hit_at: "2025-05-30T00:00:00+09:00", match: {} });
    const l = makeMeta({ id: "local/a", layer: "院内", status_since: "2025-03-01T00:00:00+09:00", last_hit_at: "2025-05-30T00:00:00+09:00", match: {} });
    expect(evaluateTriggers([v, l], "2025-06-01T00:00:00+09:00", cal)).toEqual([]);
  });
});

describe("③ idle", () => {
  const base = "2025-01-01T00:00:00+09:00";
  it("180 日ちょうどで発火し、179 日では発火しない（ベテラン層）", () => {
    const v = makeMeta({ id: "veteran/a", layer: "ベテラン", status_since: base, match: {} });
    expect(evaluateTriggers([v], day(base, 179), cal)).toEqual([]);
    expect(evaluateTriggers([v], day(base, 180), cal)).toEqual([
      { knowledgeId: "veteran/a", event: { type: "TRIGGER", trigger: "idle" } },
    ]);
  });
  it("起点は max(last_hit_at, status_since)", () => {
    const v = makeMeta({ id: "veteran/a", layer: "ベテラン", status_since: base, last_hit_at: "2025-03-01T00:00:00+09:00", match: {} });
    expect(evaluateTriggers([v], day(base, 200), cal)).toEqual([]);
    expect(evaluateTriggers([v], day("2025-03-01T00:00:00+09:00", 180), cal)).toHaveLength(1);
  });
  it("院内層の idle も発火する", () => {
    const l = makeMeta({ id: "local/a", layer: "院内", status_since: base, match: {} });
    expect(evaluateTriggers([l], day(base, 180), cal)).toHaveLength(1);
  });
  it("要再検証は 180 日で IDLE_EXPIRED", () => {
    const m = makeMeta({ id: "veteran/a", layer: "ベテラン", status: "要再検証", status_since: base, match: {} });
    expect(evaluateTriggers([m], day(base, 180), cal)).toEqual([{ knowledgeId: "veteran/a", event: { type: "IDLE_EXPIRED" } }]);
    expect(evaluateTriggers([m], day(base, 179), cal)).toEqual([]);
  });
  it("未検証・contested・停止・保管はトリガーの対象外", () => {
    const ms = (["未検証", "contested", "停止", "保管"] as const).map((status) => makeMeta({ status, status_since: base }));
    expect(evaluateTriggers(ms, "2030-01-01T00:00:00+09:00", cal)).toEqual([]);
  });
});

describe("1 件の知識につきイベントは最大 1 件", () => {
  it("改選と idle が同時に該当しても 1 件（改選が優先）", () => {
    const m = makeMeta({ status_since: "2024-01-01T00:00:00+09:00", last_hit_at: "2024-01-02T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "支払基金", prefecture: "東京都" } });
    const r = evaluateTriggers([m], "2025-06-01T00:00:00+09:00", cal);
    expect(r).toEqual([{ knowledgeId: "regional/sample", event: { type: "TRIGGER", trigger: "reappointment" } }]);
  });
});

describe("DISPOSAL_REJECT 直後", () => {
  it("即座に再発火しない（status_since が戻った日になる）", () => {
    const stopped = makeMeta({ status: "停止", status_since: "2025-02-01T00:00:00+09:00", last_hit_at: "2024-01-01T00:00:00+09:00", match: { kubunAll: ["C001"], payer: "支払基金", prefecture: "東京都" } });
    const now = "2025-06-01T00:00:00+09:00";
    const back = transition(stopped, { type: "DISPOSAL_REJECT" }, now).meta;
    expect(evaluateTriggers([back], now, cal)).toEqual([]);
    expect(evaluateTriggers([back], day(now, 179), cal)).toEqual([]);
    expect(evaluateTriggers([back], day(now, 180), cal)).toHaveLength(1);
  });
});

describe("v21：修正版は元の知識の層の改定・改選を引き継ぐ（round-15 X-57）", () => {
  it("制度層の知識の修正版（ベテラン層）は改定日を過ぎると要再検証、地域層の知識の修正版は改選日を過ぎると要再検証", () => {
    const sys = makeMeta({ id: "system/r01", layer: "制度", match: { ruleId: "R01" }, status: "保管" });
    const fixSys = makeMeta({ id: "veteran/fix-sys", layer: "ベテラン", relates_to: "system/r01", match: { ruleId: "R01" }, status_since: "2025-07-01T00:00:00+09:00" });
    const reg = makeMeta({ id: "regional/a", layer: "地域", status: "保管" });
    const fixReg = makeMeta({ id: "veteran/fix-reg", layer: "ベテラン", relates_to: "regional/a", status_since: "2025-07-01T00:00:00+09:00", last_hit_at: "2026-06-01T00:00:00+09:00" });
    const plain = makeMeta({ id: "veteran/plain", layer: "ベテラン", status_since: "2025-07-01T00:00:00+09:00", last_hit_at: "2026-06-01T00:00:00+09:00" });
    const metas = [sys, fixSys, reg, fixReg, plain];
    const fired = evaluateTriggers(metas, "2026-06-02T00:00:00+09:00", cal);
    expect(fired.find((f) => f.knowledgeId === "veteran/fix-sys")?.event).toEqual({ type: "TRIGGER", trigger: "revision" });
    expect(evaluateTriggers([reg, fixReg], "2027-06-02T00:00:00+09:00", cal).find((f) => f.knowledgeId === "veteran/fix-reg")?.event).toEqual({ type: "TRIGGER", trigger: "reappointment" });
    expect(fired.find((f) => f.knowledgeId === "veteran/plain")).toBeUndefined();
  });
});

// design.md §4-7・§7 #4：K6 の地域知識（支払基金）の降格の筋書き。日付は基準月（config/demo.json）から作る
describe("K6 の地域知識：改選と、使われない期間", () => {
  /** 基準月の 14 日に承認した、支払基金・東京都の地域知識（近似なので、提出結果では last_hit_at が動かない） */
  const k6 = () =>
    makeMeta({
      id: "regional/k6-bnp",
      layer: "地域",
      polarity: "avoid",
      matchApprox: true,
      conditionNote: "通知の理由：（合成）",
      match: { kubunAll: ["D008_19"], payer: "支払基金", prefecture: "東京都" },
      status_since: at(14),
      valid_from: at(14),
    });
  const june5 = `${dateIn(8, 5)}T09:00:00+09:00`;
  const april17 = `${dateIn(6, 17)}T09:00:00+09:00`;

  it("前提：基準月の翌年の 6 月 1 日が、支払基金の次の改選日（奇数年）。そこまで 180 日を超える", () => {
    expect(dateIn(8, 1).slice(0, 4)).toBe(String(Number(YM.slice(0, 4)) + 1));
    expect(Number(dateIn(8, 1).slice(0, 4)) % 2).toBe(1);
    expect(dateIn(8, 1).slice(5)).toBe(cal.shiharaiKikin.monthDay);
    expect((Date.parse(`${dateIn(8, 1)}T00:00:00+09:00`) - Date.parse(at(14))) / 86_400_000).toBeGreaterThan(180);
  });
  it("時計を改選日の後（翌年 6 月 5 日）へ 1 回で進めると、改選と使われない期間の両方が当たるが、出るのは改選の 1 件だけ", () => {
    expect(evaluateTriggers([k6()], june5, cal)).toEqual([{ knowledgeId: "regional/k6-bnp", event: { type: "TRIGGER", trigger: "reappointment" } }]);
  });
  it("改選日より前（翌年 4 月 17 日）の整理では、使われない期間（180 日）が先に当たる", () => {
    expect(evaluateTriggers([k6()], april17, cal)).toEqual([{ knowledgeId: "regional/k6-bnp", event: { type: "TRIGGER", trigger: "idle" } }]);
  });
  it("承認から 180 日たつ前は、何も出ない。未承認のまま時計を進めても、何も出ない", () => {
    expect(evaluateTriggers([k6()], `${dateIn(5, 31)}T09:00:00+09:00`, cal)).toEqual([]);
    expect(evaluateTriggers([{ ...k6(), status: "未検証" }], june5, cal)).toEqual([]);
  });
  it("同じ整理で、種の日付（基準月の初日）で入った制度層の知識は動かない（次の改定は偶数年の 6 月 1 日）", () => {
    const sys = makeMeta({ id: "system/r01", layer: "制度", match: { ruleId: "R01" }, status_since: `${YM}-01T00:00:00+09:00` });
    expect(evaluateTriggers([sys, k6()], june5, cal).map((e) => e.knowledgeId)).toEqual(["regional/k6-bnp"]);
  });
});

// design.md §7 #20：トリガー④（公的文書）。文書は合成（tests/official/helpers.ts）
describe("④ 公的文書（official）", () => {
  /** C001 を条件なしに「認めない」合成の文書（allow の知識と矛盾の恐れ） */
  const ng = (id = "X-1", over: Parameters<typeof makeDoc>[0] = {}) => makeDoc({ id, stance: "認めない", ...over });
  const now = at(20);
  const plus = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString();
  const approved = (over: Partial<KnowledgeMeta> = {}) => makeMeta({ status_since: at(14), valid_from: at(14), ...over });
  const fire = (meta: KnowledgeMeta, docs: OfficialDoc[], when = now) => evaluateTriggers([meta], when, cal, officialOf(docs));

  it("未確認の矛盾する文書で、地域・ベテラン・院内の承認済みが TRIGGER{official} になり、未確認の鍵が付く。制度層は発火しない", () => {
    const doc = ng();
    for (const layer of ["地域", "ベテラン", "院内"] as const) {
      const meta = approved({ id: `x/${layer}`, layer });
      expect(fire(meta, [doc])).toEqual([{ knowledgeId: meta.id, event: { type: "TRIGGER", trigger: "official" }, officialIds: [docKey(doc)] }]);
    }
    expect(fire(approved({ layer: "制度", match: { ruleId: "R01", kubunAll: ["C001"] } }), [doc])).toEqual([]);
  });
  it("official を省くと判定しない。now の年月の版がなければ判定しない。承認済みでなければ対象外", () => {
    expect(evaluateTriggers([approved()], now, cal)).toEqual([]);
    expect(evaluateTriggers([approved()], now, cal, { docs: [ng()], generationOf: () => null })).toEqual([]);
    for (const status of ["未検証", "contested", "要再検証", "停止", "保管"] as const) expect(fire(approved({ status }), [ng()])).toEqual([]);
  });
  it("整合・関連あり・未照合・対象外の文書では発火しない", () => {
    expect(fire(approved(), [makeDoc({ stance: "認める" })])).toEqual([]);
    expect(fire(approved(), [ng("X-1", { scope: { conditionNote: "傷病名が疑いのとき" } }), makeDoc({ id: "X-2", stance: "条件つき" })])).toEqual([]);
    expect(fire(approved(), [ng("X-1", { scope: { kubun: ["C999"] } }), ng("X-2", { generations: ["R6"] })])).toEqual([]);
  });
  it("鍵が official_seen にある文書では発火しない（recheck 1 の後、同じ文書で再び発火しない）", () => {
    const doc = ng();
    const fired = fire(approved(), [doc])[0];
    const down = transition(approved(), fired.event, now, { trigger: "official", officialIds: fired.officialIds }).meta;
    expect(down.status).toBe("要再検証");
    const back = transition(down, { type: "RECHECK_PASS", via: "veteran", officialKeys: [docKey(doc)] }, at(27)).meta;
    expect(back.official_seen).toEqual([docKey(doc)]);
    expect(fire(back, [doc], at(28))).toEqual([]);
  });
  it("確認済みの文書があっても、別の矛盾する文書を足すと発火し、付く鍵は未確認の分だけ（X-66）", () => {
    const [a, b] = [ng("X-1"), ng("X-2")];
    const meta = approved({ official_seen: [docKey(a)] });
    expect(fire(meta, [a])).toEqual([]);
    expect(fire(meta, [b, a])[0].officialIds).toEqual([docKey(b)]);
  });
  it("承認より前からある文書でも、未確認なら発火する（文書に登録時刻はない。L-25）", () => {
    const old = ng("X-1", { issuedOn: dateIn(-24, 1), checkedOn: dateIn(-24, 1) });
    expect(fire(approved(), [old])).toHaveLength(1);
  });
  it("確認済みの文書の立場・対象を直すと鍵が変わり、矛盾のままなら発火する。整合だった文書を直して初めて矛盾するようになったときも発火する（X-70）", () => {
    const doc = ng();
    const meta = approved({ official_seen: [docKey(doc)] });
    const widened = ng("X-1", { scope: { kubun: ["C001", "C002"] } });
    expect(fire(meta, [widened])[0].officialIds).toEqual([docKey(widened)]);
    // 要旨だけの直しでは鍵が変わらず、発火しない
    expect(fire(meta, [ng("X-1", { summary: "直した要旨" })])).toEqual([]);
    const agreed = makeDoc({ id: "X-2", stance: "認める" });
    const seenAgreed = approved({ official_seen: [docKey(agreed)] });
    expect(fire(seenAgreed, [agreed])).toEqual([]);
    const flipped = makeDoc({ id: "X-2", stance: "認めない" });
    expect(fire(seenAgreed, [flipped])[0].officialIds).toEqual([docKey(flipped)]);
  });
  it("通知から作って承認した近似の地域知識（avoid・条件の注記あり）も、条件の注記のない逆向きの文書で発火する（C-73）", () => {
    const approx = approved({ polarity: "avoid", matchApprox: true, conditionNote: "通知の理由：（合成）" });
    const allowDoc = makeDoc({ stance: "認める" });
    expect(fire(approx, [allowDoc])[0]).toMatchObject({ event: { type: "TRIGGER", trigger: "official" }, officialIds: [docKey(allowDoc)] });
    expect(fire(approx, [makeDoc({ stance: "認める", scope: { conditionNote: "傷病名が確定のとき" } })])).toEqual([]);
  });
  it("改定・改選と同時なら改定・改選が選ばれ、使われない期間（idle）と同時なら公的文書が選ばれる", () => {
    const doc = ng();
    const june5 = `${dateIn(8, 5)}T09:00:00+09:00`;
    // 支払基金の地域知識：改選日を過ぎている
    expect(fire(approved(), [doc], june5)).toEqual([{ knowledgeId: "regional/sample", event: { type: "TRIGGER", trigger: "reappointment" } }]);
    // 制度層の知識の修正版（ベテラン層）：次の改定日（偶数年の 6 月 1 日）を過ぎている
    const origin = makeMeta({ id: "system/r01", layer: "制度", match: { ruleId: "R01" }, status_since: at(1) });
    const fix = approved({ id: "veteran/fix", layer: "ベテラン", relates_to: origin.id });
    const afterRevision = `${dateIn(20, 5)}T09:00:00+09:00`;
    expect(evaluateTriggers([origin, fix], afterRevision, cal, officialOf([doc])).find((e) => e.knowledgeId === fix.id)?.event).toEqual({ type: "TRIGGER", trigger: "revision" });
    // 国保連（東京都は改選日なし）の地域知識：180 日を過ぎていても、理由のはっきりした公的文書が先
    const kokuho = approved({ match: { kubunAll: ["C001"], payer: "国保連", prefecture: "東京都" } });
    expect(fire(kokuho, [ng("X-1", { scope: { payer: null } })], june5)[0].event).toEqual({ type: "TRIGGER", trigger: "official" });
  });
  it("④ の後も停止にはならない（要再検証のまま。IDLE_EXPIRED は 180 日後の別の判定）", () => {
    const doc = ng("X-1", { scope: { payer: null } });
    const kokuho = approved({ match: { kubunAll: ["C001"], payer: "国保連", prefecture: "東京都" } });
    const down = transition(kokuho, { type: "TRIGGER", trigger: "official" }, now, { trigger: "official" });
    expect(down.meta.status).toBe("要再検証");
    expect(down.effects).toEqual([]);
    expect(fire(down.meta, [doc], plus(now, 179))).toEqual([]);
    expect(fire(down.meta, [doc], plus(now, 180))).toEqual([{ knowledgeId: kokuho.id, event: { type: "IDLE_EXPIRED" } }]);
  });

  describe("種（OFFICIAL_BASELINE）", () => {
    let root: string;
    let store: StoreOptions;
    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), "iji-official-seed-"));
      store = { knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, "skills") };
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));
    const clock = period.clockStart;
    /** 院内の種 seed-06（BNP・返戻から＝avoid・承認済み）と矛盾する、BNP を条件なしに「認める」合成の文書 */
    const bnpAllowed = makeDoc({ id: "X-BNP", stance: "認める", scope: { kubun: ["D008_19"], payer: null } });
    const official = (e: { event: { type: string; trigger?: string } }) => e.event.type === "TRIGGER" && e.event.trigger === "official";
    const fired = (docs: OfficialDoc[], when = clock) => evaluateTriggers(listKnowledge(store), when, cal, officialOf(docs)).filter(official);

    it("承認済みで入る種を入れた直後の整理では、種は ④ で 1 件も発火せず、official_seen に種の時点の矛盾の鍵が入っている。鍵は投入時の時計で作る（C-77 (h)）", () => {
      // 種の遷移の古い日付の年月には版がなく、投入時の時計の年月にだけ版がある入力
      const input: OfficialInput = { docs: [bnpAllowed], generationOf: (ym) => (ym === YM ? "R8" : null) };
      seedLocalRules(store, { official: input, now: clock });
      const seed06 = readKnowledge(store, "local/seed-06")!;
      expect(seed06.official_seen).toEqual([docKey(bnpAllowed)]);
      expect(seed06.history.at(-1)).toMatchObject({ at: clock, event: "OFFICIAL_BASELINE", from: "承認済み", to: "承認済み", basis: { officialIds: [docKey(bnpAllowed)] } });
      // 状態と、状態に入った日は変わらない
      expect([seed06.status, seed06.status_since]).toEqual(["承認済み", `${dateIn(-76, 27)}T10:00:00+09:00`]);
      // 矛盾しない種には何も残さない。未検証・保管の種には出さない
      for (const m of listKnowledge(store).filter((m) => m.id !== seed06.id)) {
        expect(m.official_seen, m.id).toEqual([]);
        expect(m.history.some((h) => h.event === "OFFICIAL_BASELINE"), m.id).toBe(false);
      }
      expect(evaluateTriggers(listKnowledge(store), clock, cal, input).filter(official)).toEqual([]);
    });
    it("その後に矛盾する文書を 1 件足すと、当たる種だけが発火する（X-70）", () => {
      seedLocalRules(store, { official: officialOf([bnpAllowed]), now: clock });
      // 往診料（seed-02。手動から＝allow）を条件なしに「認めない」合成の文書
      const added = makeDoc({ id: "X-C000", stance: "認めない", scope: { kubun: ["C000"], payer: null } });
      expect(fired([bnpAllowed, added])).toEqual([{ knowledgeId: "local/seed-02", event: { type: "TRIGGER", trigger: "official" }, officialIds: [docKey(added)] }]);
    });
    it("baseline を渡さずに入れた種（段 4 より前のデータ）は、矛盾する文書がすでにあれば発火する", () => {
      seedLocalRules(store);
      expect(fired([bnpAllowed]).map((e) => e.knowledgeId)).toEqual(["local/seed-06"]);
    });
    it("段 4 を後から入れる操作（baselineSeeds）の後、種の承認済みは発火せず official_seen に鍵が入り、種でない承認済みの知識は最初の会議で発火する（C-76）", () => {
      seedLocalRules(store);
      // 種でない承認済みの知識（ベテランが承認した提案）
      const own = createKnowledge(store, { layer: "院内", slug: "proposal-0001", summary: "BNP の提案", body: "本文", source: { type: "提案", ref: "proposal-1" }, polarity: "avoid", match: { kubunAll: ["D008_19"] } }, at(1));
      applyEvent(store, own.id, { type: "VERIFY_APPROVE" }, at(2));
      expect(baselineSeeds(store, officialOf([bnpAllowed]), clock)).toEqual(["local/seed-06"]);
      expect(readKnowledge(store, "local/seed-06")!.official_seen).toEqual([docKey(bnpAllowed)]);
      expect(readKnowledge(store, own.id)!.official_seen).toEqual([]);
      expect(fired([bnpAllowed]).map((e) => e.knowledgeId)).toEqual([own.id]);
      // もう一度行っても、足すものがなければ何も書かない
      expect(baselineSeeds(store, officialOf([bnpAllowed]), clock)).toEqual([]);
    });
    it("official_seen のない meta.json（段 4 より前に書かれたもの）は、空として読む", () => {
      seedLocalRules(store);
      const file = path.join(store.knowledgeDir, "local", "seed-06", "meta.json");
      const { official_seen: _dropped, ...old } = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify(old));
      expect(readKnowledge(store, "local/seed-06")!.official_seen).toEqual([]);
      expect(fired([bnpAllowed]).map((e) => e.knowledgeId)).toEqual(["local/seed-06"]);
    });
  });
});
