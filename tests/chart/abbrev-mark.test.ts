// 分からない略語の印（spec FR-211。plan-fr211.md の受け入れ条件 1・2）：決まった規則だけで印を付ける。LLM は使わない。
// 手で作った小さな表（tests/chart/small-chart-masters.ts）で規則を縛り、データがあるとき（RESEMEN_MASTER_DIR）は本物の masters.db で、
// 略した書き方の合成カルテ（fixtures/charts/K*-abbrev.json）の全部の印の語と件数を出す（件数は記録するだけで、線は置かない）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { abbrevMarks, abbrevTokens, abbrevVocabOf, askedItems, diseaseExact, itemKeyOf, KNOWN_WORDS, markActs, markFacts, NO_MASTER_NOTE } from "../../src/chart/abbrev";
import type { ChartAct } from "../../src/chart/acts";
import { lostAbbrevs } from "../../src/chart/soap";
import { noteText } from "../../src/chart/extract";
import { openMasters } from "../../src/masters/db";
import { abbrevOf, chartMasters, type AbbrevEntry } from "./small-chart-masters";
import { claimId, month, YM } from "../helpers/period";

const samples = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "fixtures", "charts", "samples.json"), "utf8")) as Record<string, { lacking: string; complete: string }>;

describe("語の切り方", () => {
  it("NFKC にして、英字の並びとそれに続く数字を 1 語にする。2 文字以上だけ。大文字・小文字は区別する", () => {
    expect(abbrevTokens("ＥＣＧ１２。ＦＴ４、SpO2 98%、T3、ID70mg、BNP")).toEqual(["ECG12", "FT4", "SpO2", "T3", "ID70", "mg", "BNP"]);
    expect(abbrevTokens("Af と AF")).toEqual(["Af", "AF"]);
    expect(abbrevTokens("20g、K 3.5")).toEqual([]);
  });
  it("固定の一覧は単位とバイタルの 14 語で、BT を含まない", () => {
    expect([...KNOWN_WORDS].sort()).toEqual(["BP", "HR", "PR", "RR", "SpO2", "cm", "dL", "kg", "mEq", "mg", "mL", "ml", "mm", "mmHg"].sort());
    expect(KNOWN_WORDS.has("BT")).toBe(false);
  });
});

describe("手で作った小さな表で", () => {
  const db = chartMasters();
  const vocab = abbrevVocabOf(db, YM)!;
  const k10 = abbrevOf("K10").entries;
  // 計画の受け入れ条件 1 は「ECG12 に印が付く」だが、ECG12 は基本マスターの名称（160068410「ＥＣＧ１２」。小さな表も本物も同じ）にあるので、規則 (a) では分かる語になる。
  // 規則どおり、名称にある表では印が付かず、名称にない表（その行を除いた表）では印が付くことを縛る（食い違いは呼び出し側に報告した）
  it("K10-abbrev の o の文で、IgE（マスターの名称にある）・mL（固定の一覧）には印が付かない。ECG12 は名称にある表では付かず、名称にない表では付く", () => {
    expect(vocab).not.toBeNull();
    expect(abbrevTokens(k10[0].o)).toEqual(expect.arrayContaining(["IgE", "ECG12"]));
    expect(abbrevMarks(k10[0].o, vocab)).toEqual([]);
    expect(abbrevTokens(k10[1].o)).toContain("mL");
    expect(abbrevMarks(k10[1].o, vocab)).toEqual([]);
    const without = chartMasters();
    without.prepare("DELETE FROM shinryo WHERE code = '160068410'").run();
    expect(abbrevMarks(k10[0].o, abbrevVocabOf(without, YM)!)).toEqual(["ECG12"]);
  });
  it("samples.json の K4 の「AF」に印が付く。Af と AF は別の語になる", () => {
    expect(abbrevMarks(samples[claimId("K4")].lacking, vocab)).toContain("AF");
    expect(abbrevMarks("Af。AF。", { words: new Set(["AF"]), diseases: new Set() })).toEqual(["Af"]);
    expect(abbrevMarks("Af。AF。", { words: new Set(["Af"]), diseases: new Set() })).toEqual(["AF"]);
  });
  it("病名の記載は、傷病名マスターの名称と完全に一致するかを見る（心房細動は一致、AF は一致しない）", () => {
    expect(diseaseExact("心房細動", vocab)).toBe(true);
    expect(diseaseExact("AF", vocab)).toBe(false);
  });
  it("マスターがない・版のない診療年月は印を付けない（null）。そのときの文は「見ていません」", () => {
    expect(abbrevVocabOf(null, YM)).toBeNull();
    expect(abbrevVocabOf(db, month(-12))).toBeNull();
    expect(NO_MASTER_NOTE).toContain("見ていません");
  });
});

describe("印の付け直しと聞く記載（保存のとき）", () => {
  const vocab = { words: new Set<string>(["IgE"]), diseases: new Set<string>(["心房細動"]) };
  const acts: ChartAct[] = [
    { category: "検査", written: "ＥＣＧ１２", lookup: ["心電図"], quote: "ＥＣＧ１２。", abbrev: ["XX"] },
    { category: "検査", written: "特異的ＩｇＥ", lookup: ["特異的ＩｇＥ"], quote: "特異的ＩｇＥ" },
    { category: "注射", written: "注射", lookup: [], quote: "注射", with: [{ kind: "薬", written: "ABC液", lookup: ["推し量り"], quote: "ABC液" }] },
  ];
  it("画面から来た印は使わず付け直す。聞く行為・子の lookup は空にし、名称の完全一致がある書き方には印を付けない", () => {
    const m = markActs(acts, vocab, () => false);
    expect(m.map((a) => [a.abbrev, a.lookup])).toEqual([[["ECG12"], []], [undefined, ["特異的ＩｇＥ"]], [undefined, []]]);
    expect(m[2].with?.[0]).toMatchObject({ abbrev: ["ABC"], lookup: [] });
    expect(markActs(acts, vocab, (_k, w) => w === "ＥＣＧ１２")[0].abbrev).toBeUndefined();
  });
  it("当てた・たたんだ行為は聞かない。病名の記載は傷病名と完全一致なら印を付けない。貼ったカルテは病名を聞かない", () => {
    const m = markActs(acts, vocab, () => false);
    const facts = markFacts([{ kind: "病名の記載", value: "AF", quote: "AF" }, { kind: "病名の記載", value: "心房細動", quote: "心房細動" }, { kind: "処方", value: "DOAC", quote: "DOAC継続" }], vocab);
    expect(facts.map((f) => f.abbrev)).toEqual([["AF"], undefined, ["DOAC"]]);
    const stored = { acts: m, rx: [], rxChoice: null, rxChoiceBy: null };
    expect(askedItems("訪問診療", stored, facts).map((x) => [x.place, x.written, x.tokens])).toEqual([["act", "ＥＣＧ１２", ["ECG12"]], ["child", "ABC液", ["ABC"]], ["fact", "AF", ["AF"]]]);
    expect(askedItems("記録", stored, facts).map((x) => x.place)).toEqual(["act", "child"]);
    const matched = { ...stored, acts: [{ ...m[0], match: { tbl: "shinryo" as const, code: "160068410", name: "ＥＣＧ１２", by: "search" as const } }, { ...m[2], fold: { kind: "order" as const, by: "person" as const, same: false as const } }] };
    expect(askedItems("記録", matched, null)).toEqual([]);
    // 指紋は書かれた名前と引用で決まる（位置によらない）
    expect(askedItems("記録", stored, null)[0].key).toBe(itemKeyOf("ＥＣＧ１２", "ＥＣＧ１２。"));
  });
  it("整形で消えた略語：原文の印の語が、整えた欄のどこにもなければ返す", () => {
    expect(lostAbbrevs({ s: "", o: "ＥＣＧ１２", a: "心房細動", p: "", rx: "" }, ["ECG12", "AF"])).toEqual(["AF"]);
  });
});

const real = process.env.RESEMEN_MASTER_DIR ? path.join(process.env.RESEMEN_MASTER_DIR, "masters.db") : "";
describe.skipIf(!real || !existsSync(real))("本物の masters.db で", () => {
  it("略した書き方の合成カルテの全部（K8〜K24）の印の語と件数を出す（記録だけ。線は置かない）", () => {
    const db = openMasters(real)!;
    try {
      const dir = path.join(__dirname, "..", "..", "fixtures", "charts");
      const files = readdirSync(dir).filter((f) => /^K\d+-abbrev\.json$/.test(f)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
      expect(files.length).toBeGreaterThan(0);
      const count = new Map<string, number>();
      let notes = 0;
      let marked = 0;
      for (const f of files) {
        for (const e of (JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { entries: AbbrevEntry[] }).entries) {
          const vocab = abbrevVocabOf(db, e.date.slice(0, 7));
          expect(vocab).not.toBeNull();
          const marks = abbrevMarks(noteText(e), vocab!);
          notes++;
          if (marks.length > 0) marked++;
          for (const w of marks) count.set(w, (count.get(w) ?? 0) + 1);
        }
      }
      const list = [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      console.info(`略語の印（本物のマスター）：カルテ ${files.length} 症例・${notes} 日、印のある日 ${marked}、印の語 ${list.length} 種：${list.map(([w, n]) => `${w} ${n}`).join("、") || "なし"}`);
    } finally {
      db.close();
    }
  });
});
