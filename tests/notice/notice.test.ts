// 査定・返戻の通知：読み取り結果の検査・対応づけ・知識の候補（API は呼ばない）
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKnowledge } from "../../src/lifecycle/store";
import { candidateOf, parseNotice, resolveNotice, type Notice } from "../../src/notice/notice";
import type { UkeSources } from "../../src/uke/cases";
import { loadCase } from "../engine/helpers";

const T = "2025-03-10T09:00:00+09:00";
const src = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/uke/patients.json"), "utf8")) as UkeSources;
const cases = ["K1", "K2", "K3", "K4", "K5", "K6"].map((k) => loadCase(k));
const item = { yearMonth: "2025-02", patientName: "架空 六郎", insurerNumber: "01139999", itemName: "BNP", outcome: "査定" as const, reason: "長期にわたり漫然と実施されているものと認められるため" };
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
    expect(r).toMatchObject({ claimId: "K6-2025-03", kubun: "D008_18", payer: "支払基金", prefecture: "東京都", problems: [] });
  });
  it("患者・区分が見つからない、都道府県が違うときは、理由を付けて止める", () => {
    expect(resolveNotice(notice({ patientName: "架空 七郎" }), src, cases)[0].problems).toContain("患者（氏名と保険者番号）が見つからない");
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
    expect(a).toMatchObject({ layer: "地域", status: "未検証", match: { kubunAll: ["D008_18"], payer: "支払基金", prefecture: "東京都" } });
    const [r2] = resolveNotice(notice({ yearMonth: "2025-01" }), src, cases);
    expect(createKnowledge(store(), candidateOf(r2, { reexamFiled: true, fileName: "n.pdf" }), T).status).toBe("contested");
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
