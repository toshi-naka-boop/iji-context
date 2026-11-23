// design.md §7 #18：知識の種。制度層は基準月の版のルールと 1 対 1、文に点数を書かない。院内ルールと K6 の地域知識の区分は基準月の版の点数表にある
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RULE_TEXT, seed, SEED_AT } from "../../scripts/seed-knowledge";
import { NOTICE_REASON, noticeHtml } from "../../scripts/gen-notice";
import { period } from "../../src/demo/period";
import { rulesOf } from "../../src/engine";
import { resolveRevision } from "../../src/engine/revisions";
import { LOCAL_SEEDS } from "../../src/lifecycle/seed-local";
import { listKnowledge, readBody } from "../../src/lifecycle/store";
import { candidateOf, type Notice } from "../../src/notice/notice";
import { SAMPLE_NOTICE_BASE, SAMPLE_NOTICE_MONTH, SAMPLE_NOTICE_PDF } from "../../src/notice/sample";
import { openApp, type App } from "../../src/server/app";

const repo = path.join(__dirname, "..", "..");
const points = resolveRevision(period.yearMonth).points;

describe("制度層の種", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "iji-seed-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("基準月の版のルール（R01〜R19）と 1 対 1。2 回目は何も作らない", () => {
    const store = { knowledgeDir: path.join(tmp, "knowledge"), skillsDir: path.join(tmp, "skills") };
    const ids = rulesOf(period.yearMonth).map((r) => r.id);
    // R19（単一建物の人数。段 17f）を足して 19 本
    expect(ids).toHaveLength(19);
    expect(Object.keys(RULE_TEXT).sort()).toEqual([...ids].sort());
    expect(seed(store)).toEqual(ids.map((id) => `system/${id.toLowerCase()}`));
    expect(seed(store)).toEqual([]);
    const metas = listKnowledge(store);
    expect(metas.map((m) => m.match.ruleId).sort()).toEqual([...ids].sort());
    expect(metas.every((m) => m.status === "承認済み" && m.status_since === SEED_AT && m.source_event.type === "初期投入")).toBe(true);
  });
  it("文に点数（数字＋点）・金額・年度の直書きがなく、禁止語もない", () => {
    for (const [id, text] of Object.entries(RULE_TEXT)) {
      expect(text, id).not.toMatch(/[0-9０-９][0-9０-９,，]*\s*点/);
      expect(text, id).not.toMatch(/円|20[0-9]{2}\s*年|令和/);
      expect(text, id).not.toMatch(/教育|学習|学ぶ|教える/);
    }
  });
  it("リポジトリに置いた生成物（knowledge/system・.claude/skills）は、今の文で作り直したものと一致する", () => {
    const store = { knowledgeDir: path.join(tmp, "knowledge"), skillsDir: path.join(tmp, "skills") };
    seed(store);
    for (const m of listKnowledge(store)) {
      const slug = m.id.split("/")[1];
      expect(readFileSync(path.join(repo, "knowledge", "system", slug, "SKILL.md"), "utf8").trim(), m.id).toBe(readBody(store, m.id).trim());
      expect(JSON.parse(readFileSync(path.join(repo, "knowledge", "system", slug, "meta.json"), "utf8")), m.id).toEqual(m);
      expect(readFileSync(path.join(repo, ".claude", "skills", `iji-system-${slug}`, "SKILL.md"), "utf8"), m.id).toBe(readFileSync(path.join(tmp, "skills", `iji-system-${slug}`, "SKILL.md"), "utf8"));
    }
  });
});

describe("院内ルールの種と K6 の地域知識の種", () => {
  let tmp: string;
  let app: App;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "iji-seed-app-"));
    app = openApp({ root: repo, dbFile: path.join(tmp, "app.db"), knowledgeDir: path.join(tmp, "knowledge"), skillsDir: path.join(tmp, "skills"), queryLogDir: path.join(tmp, "query-log") });
  });
  afterEach(() => {
    app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("院内ルールの種の区分は、すべて基準月の版の点数表にある（表にコードが残るだけの古いキーを止める）", () => {
    expect(LOCAL_SEEDS).toHaveLength(12);
    for (const s of LOCAL_SEEDS) expect(Object.hasOwn(points, s.kubun), `${s.slug}: ${s.kubun}`).toBe(true);
  });
  it("院内ルールの種の日付は、どれも時計の初期値より前（基準月からの相対）で、遷移の順に並ぶ", () => {
    for (const s of LOCAL_SEEDS) {
      const times = [`${s.created}T10:00:00+09:00`, ...s.steps.map((x) => x.at)].map((t) => Date.parse(t));
      expect(times.every((t) => !Number.isNaN(t) && t < Date.parse(period.clockStart)), s.slug).toBe(true);
      expect([...times].sort((a, b) => a - b), s.slug).toEqual(times);
    }
  });
  it("K6 の種は、同梱の読み取り結果を candidateOf に通した出力そのまま（種を入れる処理が欄を重ねていない）", () => {
    const notice = JSON.parse(readFileSync(path.join(repo, `${SAMPLE_NOTICE_BASE}.json`), "utf8")) as Notice;
    expect(notice.items).toHaveLength(1);
    expect(notice.items[0]).toMatchObject({ yearMonth: SAMPLE_NOTICE_MONTH, itemName: "BNP", outcome: "査定", reason: NOTICE_REASON });
    const cand = candidateOf(app.resolveNoticeItems(notice)[0], { reexamFiled: false, fileName: SAMPLE_NOTICE_PDF });
    app.seedLocalRules();
    const m = listKnowledge(app.store).find((x) => x.layer === "地域")!;
    expect(m).toMatchObject({ id: `regional/${cand.slug}`, summary: cand.summary, polarity: cand.polarity, matchApprox: cand.matchApprox, conditionNote: cand.conditionNote, match: cand.match, status: "未検証" });
    expect(readBody(app.store, m.id).trim()).toBe(cand.body.trim());
    expect(cand).toMatchObject({ polarity: "avoid", matchApprox: true, match: { kubunAll: ["D008_19"], payer: "支払基金", prefecture: "東京都" } });
    for (const k of m.match.kubunAll ?? []) expect(Object.hasOwn(points, k), k).toBe(true);
    // v21 の「コメントを付ければ通る」の知識は種に入れない
    expect(listKnowledge(app.store).filter((x) => x.layer === "地域")).toHaveLength(1);
    expect(m.match.commentOn).toBeUndefined();
    expect(m.match.consecutiveMonths).toBeUndefined();
  });
  it("同梱の通知（HTML）は、スクリプトで作り直したものと一致し、点数・金額の欄がない", () => {
    const html = readFileSync(path.join(repo, `${SAMPLE_NOTICE_BASE}.html`), "utf8");
    expect(html).toBe(noticeHtml());
    expect(html).toContain(NOTICE_REASON);
    expect(html).not.toMatch(/[0-9]+\s*点|円/);
  });
});
