// 査定・返戻の通知：読み取り結果の検査・対応づけ・知識の候補（API は呼ばない）
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKnowledge } from "../../src/lifecycle/store";
import { candidateOf, conditionNoteOf, parseNotice, REASON_NOTE_MAX, resolveNotice, type Notice } from "../../src/notice/notice";
import type { UkeSources } from "../../src/uke/cases";
import { loadCase } from "../engine/helpers";
import { at, claimId, month } from "../helpers/period";

const T = at(12);
const src = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/uke/patients.json"), "utf8")) as UkeSources;
const cases = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"].map((k) => loadCase(k));
const item = { yearMonth: month(-1), patientName: "架空 六郎", insurerNumber: "01139997", itemName: "BNP", outcome: "査定" as const, reason: "傷病名が「心不全の疑い」のまま、連月で算定されているため" };
const notice = (over: Partial<typeof item> = {}): Notice => ({ documentType: "増減点連絡書", prefecture: "東京都", items: [{ ...item, ...over }] });

describe("読み取り結果の検査", () => {
  it("形の違う項目は落とす（年月が西暦でない・結果が査定／返戻でない）", () => {
    const n = parseNotice({ documentType: "x", prefecture: "東京都", items: [item, { ...item, yearMonth: "令和7年2月" }, { ...item, outcome: "通過" }] });
    expect(n.items).toHaveLength(1);
    expect(() => parseNotice({ items: [] })).toThrow(/形/);
  });
});

describe("対応づけ（決まった規則）", () => {
  it("K6：氏名と保険者番号で請求、項目名で区分、保険者番号で審査支払機関が決まる", () => {
    const [r] = resolveNotice(notice(), src, cases);
    expect(r).toMatchObject({ claimId: claimId("K6"), kubun: "D008_19", payer: "支払基金", prefecture: "東京都", problems: [] });
  });
  it("患者・区分が見つからない、都道府県が違うときは、理由を付けて止める", () => {
    expect(resolveNotice(notice({ patientName: "架空 九郎" }), src, cases)[0].problems).toContain("患者（氏名と保険者番号）が見つからない");
    expect(resolveNotice(notice({ itemName: "BNP検査" }), src, cases)[0].problems).toContain("項目名に当たる区分が見つからない");
    expect(resolveNotice({ ...notice(), prefecture: "大阪府" }, src, cases)[0].problems.join()).toMatch(/都道府県/);
  });
});

describe("知識の候補（地域層。状態は F5 の規則で決まる）", () => {
  let root: string;
  const store = () => ({ knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, "skills") });
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "iji-notice-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("査定は未検証、再審査を申し出たら contested。条件は区分・審査支払機関・都道府県", () => {
    const [r] = resolveNotice(notice(), src, cases);
    const a = createKnowledge(store(), candidateOf(r, { reexamFiled: false, fileName: "n.pdf" }), T);
    expect(a).toMatchObject({ layer: "地域", status: "未検証", match: { kubunAll: ["D008_19"], payer: "支払基金", prefecture: "東京都" } });
    const [r2] = resolveNotice(notice({ yearMonth: month(-2) }), src, cases);
    expect(createKnowledge(store(), candidateOf(r2, { reexamFiled: true, fileName: "n.pdf" }), T).status).toBe("contested");
  });
  it("候補は必ず avoid・近似で、通知の理由を条件の注記に入れる。機械は連月・摘要コメントの条件を足さない（design.md §3。X-69）", () => {
    const [r] = resolveNotice(notice(), src, cases);
    const c = candidateOf(r, { reexamFiled: false, fileName: "n.pdf" });
    expect(c).toMatchObject({ polarity: "avoid", matchApprox: true, conditionNote: `通知の理由：${item.reason}` });
    expect(c.match).toEqual({ kubunAll: ["D008_19"], payer: "支払基金", prefecture: "東京都" });
    expect(c.summary).toBe(`東京都・支払基金：BNP（D008_19）が査定された（${month(-1)} 診療分）`);
  });
  it("理由が空の項目からも近似の候補ができる。理由の有無で変わるのは注記の文だけ。長い理由は切る", () => {
    const [r] = resolveNotice(notice({ reason: "　 " }), src, cases);
    const c = candidateOf(r, { reexamFiled: false, fileName: "n.pdf" });
    expect(c).toMatchObject({ polarity: "avoid", matchApprox: true, conditionNote: "通知に理由の記載がない（条件は未確認）" });
    expect(createKnowledge(store(), c, T)).toMatchObject({ matchApprox: true, polarity: "avoid" });
    expect(conditionNoteOf("あ".repeat(500))).toBe(`通知の理由：${"あ".repeat(REASON_NOTE_MAX)}`);
  });
  it("返戻の通知からの候補も同じ（avoid・近似）", () => {
    const [r] = resolveNotice(notice({ outcome: "返戻" as never }), src, cases);
    expect(candidateOf(r, { reexamFiled: false, fileName: "n.pdf" })).toMatchObject({ polarity: "avoid", matchApprox: true, source: { type: "返戻" } });
  });
  it("対応づけが済んでいない項目は候補にできない", () => {
    const [r] = resolveNotice(notice({ itemName: "BNP検査" }), src, cases);
    expect(() => candidateOf(r, { reexamFiled: false, fileName: "n.pdf" })).toThrow(/対応づけ/);
  });
  it("候補の本文に点数・金額を入れない", () => {
    const [r] = resolveNotice(notice(), src, cases);
    const c = candidateOf(r, { reexamFiled: false, fileName: "n.pdf" });
    expect(`${c.summary}\n${c.body}`).not.toMatch(/[0-9]+\s*点|円/);
  });
});
