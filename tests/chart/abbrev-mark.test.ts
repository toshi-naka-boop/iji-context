// 分からない略語の印（spec FR-211。plan-fr211.md の受け入れ条件 1・2）：決まった規則だけで印を付ける。LLM は使わない。
// 手で作った小さな表（tests/chart/small-chart-masters.ts）で規則を縛り、データがあるとき（RESEMEN_MASTER_DIR）は本物の masters.db で、
// 略した書き方の合成カルテ（fixtures/charts/K*-abbrev.json）の全部の印の語と件数を出す（件数は記録するだけで、線は置かない）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { abbrevMarks, abbrevTokens, abbrevVocabOf, askedItems, diseaseExact, itemKeyOf, KNOWN_WORDS, markDay, NO_MASTER_NOTE, sentenceWith } from "../../src/chart/abbrev";
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
  /** その日の行ったこと・事実の印（原文は省くと、引用をつないだ文） */
  type V = typeof vocab;
  const markActs = (a: ChartAct[], v: V, text = a.flatMap((x) => [x.quote, ...(x.with ?? []).map((c) => c.quote)]).join("\n")) => markDay(a, [], v, text).acts;
  const markFacts = (f: Parameters<typeof markDay>[1], v: V, text = f.map((x) => x.quote).join("\n")) => markDay([], f, v, text).facts;
  it("画面から来た印は使わず付け直す。聞く行為・子の lookup は空にし、書かれた名前の語が分かる語なら印を付けない", () => {
    const m = markActs(acts, vocab);
    expect(m.map((a) => [a.abbrev, a.lookup])).toEqual([[["ECG12"], []], [undefined, ["特異的ＩｇＥ"]], [undefined, []]]);
    expect(m[2].with?.[0]).toMatchObject({ abbrev: ["ABC"], lookup: [] });
    expect(markActs([{ ...acts[0], quote: "ＥＣＧ１２施行" }], { ...vocab, words: new Set(["ECG12"]) })[0].abbrev).toBeUndefined();
  });
  describe("語を単位にした規則（plan-fr211.md「規則の作り直し」6 の例）", () => {
    const linkedOf = (d: ReturnType<typeof markDay>) => ({ acts: d.acts.map((a) => [a.written, a.abbrev, a.lookup]), facts: d.facts.map((f) => [f.kind, f.value, f.abbrev]), unlinked: d.unlinked });
    it("AF→心房細動・ECG12→心電図：書かれた名前が引用に含まれず、引用に略語があれば結び付き、lookup は空・医師に聞く（X-490）", () => {
      const d = markDay([{ category: "検査", written: "心電図", lookup: ["心電図"], quote: "ＥＣＧ１２" }], [{ kind: "病名の記載", value: "心房細動", quote: "AF" }], vocab, "O: ＥＣＧ１２。\nA: AF");
      expect(linkedOf(d)).toEqual({ acts: [["心電図", ["ECG12"], []]], facts: [["病名の記載", "心房細動", ["AF"]]], unlinked: [] });
      expect(askedItems("訪問診療", { acts: d.acts, rx: [], rxChoice: null, rxChoiceBy: null }, d.facts).map((x) => [x.place, x.written, x.tokens])).toEqual([
        ["act", "心電図", ["ECG12"]],
        ["fact", "心房細動", ["AF"]],
      ]);
    });
    it("引用を別の文にした組：言い換えの疑いだけでは結び付けず聞かない。原文の略語は結び付かない語として事務が選ぶ（C-642・round-97 の「施行」「継続」）", () => {
      const a = markDay([{ category: "検査", written: "心電図", lookup: ["心電図"], quote: "前回の心電図" }], [], vocab, "O: ECG12施行。前回の心電図と著変なし");
      expect(linkedOf(a)).toEqual({ acts: [["心電図", undefined, ["心電図"]]], facts: [], unlinked: ["ECG12"] });
      const b = markDay([{ category: "検査", written: "心電図", lookup: ["心電図"], quote: "施行" }], [{ kind: "病名の記載", value: "心房細動", quote: "継続" }], vocab, "O: AF 継続。ECG12 施行");
      expect(linkedOf(b)).toEqual({ acts: [["心電図", undefined, ["心電図"]]], facts: [["病名の記載", "心房細動", undefined]], unlinked: ["AF", "ECG12"] });
    });
    it("ADL・NRS3（C-640）：どの記載にも結び付かず、言い換えた行為・処方・急性増悪の事実に付かない。結び付かない語として事務が選ぶ", () => {
      const d = markDay(
        [{ category: "診療行為", written: "在宅酸素療法指導管理", lookup: ["在宅酸素療法指導管理料"], quote: "在宅酸素療法の指導" }],
        [
          { kind: "処方", value: "利尿薬", quote: "フロセミド" },
          { kind: "急性増悪", value: "あり", quote: "急変" },
        ],
        vocab,
        "S: ADL低下、NRS3\nO: 在宅患者訪問診療。急変。\nP: 在宅酸素療法の指導。\n処方: フロセミド",
      );
      expect(linkedOf(d)).toEqual({ acts: [["在宅酸素療法指導管理", undefined, ["在宅酸素療法指導管理料"]]], facts: [["処方", "利尿薬", undefined], ["急性増悪", "あり", undefined]], unlinked: ["ADL", "NRS3"] });
    });
    it("処方の分類名：処方の事実には結び付けない（K4 の見本の DOAC は結び付かない語。AF は病名の記載に結び付く）", () => {
      const d = markDay([], [{ kind: "病名の記載", value: "AF", quote: "AF" }, { kind: "処方", value: "DOAC", quote: "DOAC継続" }], vocab, "変わりなし。AF。DOAC継続。");
      expect(linkedOf(d)).toEqual({ acts: [], facts: [["病名の記載", "AF", ["AF"]], ["処方", "DOAC", undefined]], unlinked: ["DOAC"] });
    });
    it("「の」「料」の違い・酸素ボンベ加算（C-641）：言い換えの疑いでも略語がなければ聞かず、lookup も残る", () => {
      const d = markDay(
        [
          { category: "診療行為", written: "在宅酸素療法指導", lookup: ["在宅酸素療法指導管理料"], quote: "在宅酸素療法の指導" },
          { category: "診療行為", written: "在宅患者訪問診療料", lookup: ["在宅患者訪問診療料"], quote: "在宅患者訪問診療" },
          { category: "診療行為", written: "酸素ボンベ加算", lookup: ["酸素ボンベ加算"], quote: "酸素ボンベ使用" },
        ],
        [],
        vocab,
        "O: 在宅患者訪問診療。\nP: 在宅酸素療法の指導。酸素ボンベ使用。",
      );
      expect(linkedOf(d)).toEqual({
        acts: [
          ["在宅酸素療法指導", undefined, ["在宅酸素療法指導管理料"]],
          ["在宅患者訪問診療料", undefined, ["在宅患者訪問診療料"]],
          ["酸素ボンベ加算", undefined, ["酸素ボンベ加算"]],
        ],
        facts: [],
        unlinked: [],
      });
    });
    it("ECG12 の引用に AF が入った組（C-632）：書かれた名前が引用に含まれれば引用のほかの略語は結び付けない。AF は結び付かない語になる", () => {
      const d = markDay([{ category: "検査", written: "ECG12", lookup: ["ECG12"], quote: "AF継続、ECG12施行" }], [], { ...vocab, words: new Set(["ECG12"]) }, "O: AF継続、ECG12施行");
      expect(linkedOf(d)).toEqual({ acts: [["ECG12", undefined, ["ECG12"]]], facts: [], unlinked: ["AF"] });
    });
    it("書かれた名前にそのままある略語は結び付く（ECG12 を書いた行為）。言い換えた事実の AF は結び付かない語", () => {
      const d = markDay([{ category: "検査", written: "ECG12", lookup: [], quote: "ECG12 施行" }], [{ kind: "病名の記載", value: "心房細動", quote: "継続" }], vocab, "O: AF 継続。ECG12 施行");
      expect(linkedOf(d)).toEqual({ acts: [["ECG12", ["ECG12"], []]], facts: [["病名の記載", "心房細動", undefined]], unlinked: ["AF"] });
    });
    it("引用が 2 文にまたがる組（round-99 C-650）：言い換えた訪問診療の行為は、名前と重なる節の語だけを結ぶ。ECG12 は結び付かない語になり、訪問診療は確かめ待ちにならない", () => {
      const d = markDay(
        [
          { category: "診療行為", written: "在宅患者訪問診療料", lookup: ["在宅患者訪問診療料"], quote: "在宅患者訪問診療。ECG12、採血。" },
          { category: "検査", written: "心電図", lookup: ["心電図（１２誘導）"], quote: "前回の心電図" },
        ],
        [],
        vocab,
        "O: 在宅患者訪問診療。ECG12、採血。前回の心電図と著変なし",
      );
      expect(linkedOf(d)).toEqual({
        acts: [
          ["在宅患者訪問診療料", undefined, ["在宅患者訪問診療料"]],
          ["心電図", undefined, ["心電図（１２誘導）"]],
        ],
        facts: [],
        unlinked: ["ECG12"],
      });
      expect(askedItems("訪問診療", { acts: d.acts, rx: [], rxChoice: null, rxChoiceBy: null }, d.facts)).toEqual([]);
    });
    it("重なる節がない言い換え（AF→心房細動）は、今までどおり引用全体の語を結ぶ（引用「AF」・「AF継続」）", () => {
      for (const quote of ["AF", "AF継続"]) {
        const d = markDay([], [{ kind: "病名の記載", value: "心房細動", quote }], vocab, `A: ${quote}`);
        expect([quote, linkedOf(d)]).toEqual([quote, { acts: [], facts: [["病名の記載", "心房細動", ["AF"]]], unlinked: [] }]);
      }
    });
    it("問いの引用は、原文のその語を含む文", () => {
      const note = { s: "ADL低下、NRS3", o: "在宅患者訪問診療。ＥＣＧ１２施行。前回の心電図と著変なし", a: "AF", p: "", rx: "" };
      expect(sentenceWith(note, "ECG12")).toBe("ＥＣＧ１２施行。");
      expect(sentenceWith(note, "NRS3")).toBe("ADL低下、NRS3");
      expect(sentenceWith(note, "AF")).toBe("AF");
      expect(sentenceWith(note, "XYZ")).toBeNull();
    });
  });
  it("当てた・たたんだ行為は聞かない。病名の記載は名前に分からない略語がなければ印を付けない。貼ったカルテは病名を聞かない", () => {
    const m = markActs(acts, vocab);
    // 処方の事実には結び付けない（DOAC は結び付かない語。規則の作り直し 3・4）
    const facts = markFacts([{ kind: "病名の記載", value: "AF", quote: "AF" }, { kind: "病名の記載", value: "心房細動", quote: "心房細動" }, { kind: "処方", value: "DOAC", quote: "DOAC継続" }], vocab);
    expect(facts.map((f) => f.abbrev)).toEqual([["AF"], undefined, undefined]);
    const stored = { acts: m, rx: [], rxChoice: null, rxChoiceBy: null };
    expect(askedItems("訪問診療", stored, facts).map((x) => [x.place, x.written, x.tokens])).toEqual([["act", "ＥＣＧ１２", ["ECG12"]], ["child", "ABC液", ["ABC"]], ["fact", "AF", ["AF"]]]);
    expect(askedItems("記録", stored, facts).map((x) => x.place)).toEqual(["act", "child"]);
    const matched = { ...stored, acts: [{ ...m[0], match: { tbl: "shinryo" as const, code: "160068410", name: "ＥＣＧ１２", by: "search" as const } }, { ...m[2], fold: { kind: "order" as const, ref: "o1", by: "person" as const } }] };
    expect(askedItems("記録", matched, null)).toEqual([]);
    // 「違う」（same: false）はたたまない印なので、行為も子も聞く（X-491）
    const differ = { ...stored, acts: [{ ...m[0], fold: { kind: "order" as const, by: "person" as const, same: false as const } }, { ...m[2], fold: { kind: "order" as const, by: "person" as const, same: false as const } }] };
    expect(askedItems("記録", differ, null).map((x) => [x.place, x.written])).toEqual([["act", "ＥＣＧ１２"], ["child", "ABC液"]]);
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
