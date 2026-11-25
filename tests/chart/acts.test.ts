// カルテの「行ったこと」（design.md §15-6・15-7。段 18a）：取り出した行為の検査・院内・院外の初期値・マスターに当てる規則・候補の並べ方・確かめる画面の並べ方。
// LLM は呼ばない（取り出しの出力は手で作った値）。マスターは手で作った小さな表（tests/chart/small-chart-masters.ts）
import { describe, expect, it } from "vitest";
import { cleanLookup, foldOfAct, validateActs, type ChartAct } from "../../src/chart/acts";
import { EXTRACT_PROMPT, EXTRACT_SCHEMA, noteText, type ChartNote } from "../../src/chart/extract";
import { matchItem, rowsFor, searchRows, MAX_CANDIDATES } from "../../src/chart/match";
import { RX_INSIDE_WORDS, RX_OUTSIDE_WORDS, rxDefault } from "../../src/chart/rx-default";
import { put } from "../generic/small-masters";
import { chartMasters } from "./small-chart-masters";
import { YM } from "../helpers/period";

const note: ChartNote = { s: "", o: "在宅患者訪問診療。", a: "", p: "熱傷処置（ゲーベンクリーム１％ 20g）。創傷処置。", rx: "院外処方箋を発行" };
const text = noteText(note);

describe("取り出した行ったことの検査（validateActs）", () => {
  it("引用がカルテにない行為・範囲外の種類・形の違う行為を捨て、理由を返す", () => {
    const r = validateActs(
      {
        acts: [
          { category: "処置", written: "熱傷処置", lookup: ["熱傷処置"], quote: "熱傷処置" },
          { category: "処置", written: "消炎鎮痛等処置", lookup: [], quote: "湿布処置" },
          { category: "手術", written: "創傷処置", lookup: [], quote: "創傷処置" },
          { category: "処置", written: "", lookup: [], quote: "創傷処置" },
        ],
        rx: [],
      },
      text,
    );
    expect(r.acts.map((a) => a.written)).toEqual(["熱傷処置"]);
    expect(r.dropped.map((d) => d.why)).toEqual(["カルテにない言葉から取っている", "取り出す種類の外", "形が違う"]);
  });
  it("lookup は 5 個を超えた分・空の語・コードの形の語（数字だけ・9 桁の数字を含む）を捨て、行為は残す", () => {
    expect(cleanLookup(["熱傷処置", "", "140032110", "１２３", "熱傷処置 140032110", "処置", "熱傷", "やけど", "熱傷処置（小）", "外す 6 個目"])).toEqual(["熱傷処置", "処置", "熱傷", "やけど", "熱傷処置（小）"]);
    expect(cleanLookup("熱傷処置")).toEqual([]);
    const r = validateActs({ acts: [{ category: "処置", written: "熱傷処置", lookup: ["140032110"], quote: "熱傷処置" }], rx: [] }, text);
    expect(r.acts).toEqual([{ category: "処置", written: "熱傷処置", lookup: [], quote: "熱傷処置" }]);
  });
  it("with の量（X-145）：引用の中にある量は残り、引用にない量は量だけを捨てて子は残す。子の引用がカルテにないと子だけを捨てる", () => {
    const r = validateActs(
      {
        acts: [
          {
            category: "処置",
            written: "熱傷処置",
            lookup: [],
            quantity: "3日",
            quote: "熱傷処置（ゲーベンクリーム１％ 20g）",
            with: [
              { kind: "薬", written: "ゲーベンクリーム１％", lookup: [], quantity: "20g", quote: "ゲーベンクリーム１％ 20g" },
              { kind: "薬", written: "ゲーベンクリーム１％", lookup: [], quantity: "30g", quote: "ゲーベンクリーム１％" },
              { kind: "薬", written: "ラクール冷シップ", lookup: [], quote: "ラクール冷シップ" },
            ],
          },
        ],
        rx: [],
      },
      text,
    );
    expect(r.acts).toEqual([
      {
        category: "処置",
        written: "熱傷処置",
        lookup: [],
        quote: "熱傷処置（ゲーベンクリーム１％ 20g）",
        with: [
          { kind: "薬", written: "ゲーベンクリーム１％", lookup: [], quantity: "20g", quote: "ゲーベンクリーム１％ 20g" },
          { kind: "薬", written: "ゲーベンクリーム１％", lookup: [], quote: "ゲーベンクリーム１％" },
        ],
      },
    ]);
    expect(r.dropped.map((d) => d.why)).toEqual(["量が引用の中にない（量だけを捨てた）", "量が引用の中にない（量だけを捨てた）", "カルテにない言葉から取っている"]);
    // 本人が確かめて直した量（保存のとき）は、引用の中になくても残す
    const byPerson = validateActs({ acts: [{ category: "処置", written: "熱傷処置", lookup: [], quote: "熱傷処置", with: [{ kind: "薬", written: "ゲーベンクリーム１％", lookup: [], quantity: "30g", quote: "ゲーベンクリーム１％" }] }], rx: [] }, text, true);
    expect(byPerson.acts[0].with?.[0].quantity).toBe("30g");
    expect(byPerson.dropped).toEqual([]);
  });
  it("rx（C-231）：引用がカルテにある処方の記載だけが残り、form などほかの項目は持たない。書かれていなければ出ない", () => {
    const r = validateActs({ acts: [], rx: [{ quote: "院外処方箋を発行", form: "院内" }, { quote: "院内で投薬" }] }, text);
    expect(r.rx).toEqual([{ quote: "院外処方箋を発行" }]);
    expect(r.dropped.map((d) => d.why)).toEqual(["カルテにない言葉から取っている"]);
    expect(validateActs({ acts: [] }, text).rx).toEqual([]);
    expect(validateActs(null, text)).toEqual({ acts: [], rx: [], dropped: [] });
  });
  it("取り出しの形：acts・rx を同じ 1 回の呼び出しの出力に足し、rx に form がない。指示文に「院内か院外かは分けない」がある", () => {
    const props = EXTRACT_SCHEMA.properties;
    expect(Object.keys(props)).toEqual(["facts", "acts", "rx"]);
    expect(Object.keys(props.rx.items.properties)).toEqual(["quote"]);
    expect(props.acts.items.properties.lookup.maxItems).toBe(5);
    expect(EXTRACT_PROMPT).toContain("院内か院外かは分けない");
    expect(EXTRACT_PROMPT).toContain("コードは書かない");
    expect(EXTRACT_PROMPT).toContain("時間や回数から加算を推し量らない");
  });
});

describe("院内・院外の初期値（C-243。決まった文字の規則）", () => {
  it("語の一覧は設計の値", () => {
    expect([...RX_OUTSIDE_WORDS]).toEqual(["院外処方", "処方箋", "処方せん"]);
    expect([...RX_INSIDE_WORDS]).toEqual(["院内"]);
  });
  it("院外処方箋交付 → 院外処方箋、院内で投薬 → 院内、両方・どちらもない → 分からない。2 つ以上の記載は合わせて探す。全角・空白も同じに読む", () => {
    expect(rxDefault([{ quote: "院外処方箋交付" }])).toBe("outside");
    expect(rxDefault([{ quote: "院内で投薬" }])).toBe("inside");
    expect(rxDefault([{ quote: "院内で投薬" }, { quote: "院外処方箋交付" }])).toBe("unknown");
    expect(rxDefault([{ quote: "Rp ロキソニン" }])).toBe("unknown");
    expect(rxDefault([])).toBe("unknown");
    expect(rxDefault([{ quote: "処方 せん を交付" }])).toBe("outside");
  });
});

describe("マスターに当てる（15-7）", () => {
  const db = chartMasters();
  const rows = (k: Parameters<typeof rowsFor>[1]) => rowsFor(db, k, YM);
  it("名称の完全一致が 1 つで当てる。2 つ以上なら当てずに候補に並べ、0 なら当てられない", () => {
    expect(matchItem(rows("shinryo"), "shinryo", "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）", [], null).initial).toEqual({ tbl: "shinryo", code: "140032110", name: "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）", by: "name" });
    // 全角・空白の違いは normName でそろえる
    expect(matchItem(rows("iyakuhin"), "iyakuhin", "ゲーベンクリーム1%", [], null).initial?.code).toBe("620008991");
    const twin = chartMasters();
    twin.prepare("UPDATE iyakuhin SET name = 'キシロカイン注ポリアンプ０．５％　５ｍＬ' WHERE code = '620002613'").run();
    const two = matchItem(rowsFor(twin, "iyakuhin", YM), "iyakuhin", "キシロカイン注ポリアンプ０．５％　５ｍＬ", [], null);
    expect(two.initial).toBeNull();
    expect(two.candidates.map((c) => c.code)).toEqual(["620002613", "620007260"]);
    expect(matchItem(rows("shinryo"), "shinryo", "やけど", [], null)).toEqual({ initial: null, candidates: [] });
  });
  it("投薬の「処方料」「調剤料（内服薬・浸煎薬・屯服薬）」は医薬品で当たらず、医科診療行為の第5部 投薬で当たる（C-224）", () => {
    expect(matchItem(rows("toyaku"), "toyaku", "調剤料（内服薬・浸煎薬・屯服薬）", [], null).initial).toMatchObject({ tbl: "shinryo", code: "120000710", by: "name" });
    expect(matchItem(rows("toyaku"), "toyaku", "処方料（その他）", [], null).initial).toMatchObject({ tbl: "shinryo", code: "120001210" });
    const r = matchItem(rows("toyaku"), "toyaku", "処方料", [], null);
    expect(r.initial).toBeNull();
    expect(r.candidates.map((c) => [c.tbl, c.code])).toEqual([["shinryo", "120001210"], ["shinryo", "120001310"]]);
    // 医薬品は医薬品で当たる。投薬の表に第5部でない診療行為は入らない
    expect(matchItem(rows("toyaku"), "toyaku", "ハルシオン０．２５ｍｇ錠", [], null).initial).toMatchObject({ tbl: "iyakuhin", code: "611120055" });
    expect(rows("toyaku")!.filter((r) => r.tbl === "shinryo").every((r) => r.code.startsWith("12"))).toBe(true);
    expect(matchItem(rows("toyaku"), "toyaku", "熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）", [], null)).toEqual({ initial: null, candidates: [] });
  });
  it("候補の並べ方：前に選んだもの → 名前の完全一致 → lookup の完全一致 → lookup の語と名前の前方一致・部分一致（語の輪。v32）。同じコードは 1 回。lookup の候補で自動に当てない", () => {
    const r = matchItem(rows("shinryo"), "shinryo", "創傷処置（１００ｃｍ２未満）", ["熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）", "超音波", "創傷"], { tbl: "shinryo", code: "150054110" });
    expect(r.candidates.map((c) => [c.code, c.prior])).toEqual([
      ["150054110", true], // 前に選んだもの
      ["140000610", false], // 名前の完全一致
      ["140032110", false], // lookup の完全一致
      ["160072210", false], // lookup「超音波」の前方一致
    ]);
    // 前に選んだ対応が初期値（名前の完全一致が別のコードに 1 つあっても。L-95 を v30 で改める）
    expect(r.initial).toMatchObject({ code: "150054110", by: "alias" });
    // lookup の完全一致が 1 つでも当てない
    const l = matchItem(rows("shinryo"), "shinryo", "やけど", ["熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）"], null);
    expect(l.initial).toBeNull();
    expect(l.candidates.map((c) => c.code)).toEqual(["140032110"]);
    // 同じ強さ（前方一致）の中はコードの順（v32。L-161。v31 までは名称の短い順）
    const p = matchItem(rows("shinryo"), "shinryo", "x", ["他医撮影"], null);
    expect(p.candidates.map((c) => c.code)).toEqual(["170001250", "170001450"]);
  });
  it("候補は診療年月の 1 枚の、category で決めた表に実在するコードだけ。LLM が実在しない語を挙げても候補は空のまま（探す入口が出る）。前に選んだ対応も今の 1 枚になければ使わない", () => {
    const r = matchItem(rows("tokutei"), "tokutei", "熱傷処置", ["熱傷処置", "存在しない名前"], { tbl: "shinryo", code: "140032110" });
    expect(r).toEqual({ initial: null, candidates: [] });
    expect(matchItem(rows("shinryo"), "shinryo", "熱傷処置", [], { tbl: "shinryo", code: "160000190" }).initial).toBeNull();
    // 版のない診療年月・マスターがない
    expect(rowsFor(db, "shinryo", "1999-01")).toBeNull();
    expect(rowsFor(null, "shinryo", YM)).toBeNull();
    expect(matchItem(null, "shinryo", "熱傷処置", [], null)).toEqual({ initial: null, candidates: [] });
  });
  it("候補は 20 件まで。名前で探すのも名称の部分一致で 20 件まで", () => {
    const big = chartMasters();
    // 5 つの語に 6 行ずつ当たる表：語の輪で 1 件ずつ足し、30 件になるところを 20 件で切る
    for (let g = 0; g < 5; g++) for (let i = 0; i < 6; i++) put(big, "shinryo", "20261001", { code: `16${g}${String(i).padStart(6, "0")}`, name: `探す群${"アイウエオ"[g]}${"カ".repeat(i)}` });
    const terms = [..."アイウエオ"].map((x) => `探す群${x}`);
    expect(matchItem(rowsFor(big, "shinryo", YM), "shinryo", "探す群", terms, null).candidates).toHaveLength(MAX_CANDIDATES);
    const found = searchRows(rowsFor(big, "shinryo", YM), "探す群");
    expect(found).toHaveLength(20);
    // 前方一致の中はコードの順（v32。L-161）
    expect(found.slice(0, 7).map((f) => f.name)).toEqual(["探す群ア", "探す群アカ", "探す群アカカ", "探す群アカカカ", "探す群アカカカカ", "探す群アカカカカカ", "探す群イ"]);
    expect(searchRows(rowsFor(big, "shinryo", YM), " ")).toEqual([]);
  });
});

describe("確かめる画面の並べ方（C-221・C-213・C-233）", () => {
  const drug: ChartAct = { category: "投薬", written: "ハルシオン０．２５ｍｇ錠", lookup: [], quote: "x" };
  const proc = { tbl: "shinryo" as const, code: "120000710", name: "調剤料（内服薬・浸煎薬・屯服薬）", by: "name" as const };
  const matched = { tbl: "iyakuhin" as const, code: "611120055", name: "ハルシオン０．２５ｍｇ錠", by: "name" as const };
  it("院外処方だけ・分からないの施設では、投薬の薬は選ぶ一覧に出ない（見ない薬）。第5部に当たった投薬の手技は出る", () => {
    for (const d of ["outside", "unknown"] as const) {
      expect([foldOfAct(drug, matched, d, null), foldOfAct(drug, null, d, null), foldOfAct(drug, proc, d, null)]).toEqual(["hidden", "hidden", "show"]);
    }
  });
  it("院内処方もある施設：院内の日の薬は投薬の組に並び、名前で当たらない薬は選ぶのが任意。院外処方箋・分からない・選んでいない日の薬はたたむ", () => {
    expect([foldOfAct(drug, matched, "inside", "inside"), foldOfAct(drug, null, "inside", "inside")]).toEqual(["show", "optional"]);
    expect([foldOfAct(drug, matched, "inside", "outside"), foldOfAct(drug, matched, "inside", "unknown"), foldOfAct(drug, matched, "inside", null)]).toEqual(["hidden", "hidden", "hidden"]);
  });
  it("投薬でない行為は、施設の申告・その日の選択によらず出る（with の子の手技の薬も同じ側で出す）", () => {
    for (const d of ["outside", "inside", "unknown"] as const) expect(foldOfAct({ category: "注射" }, null, d, null)).toBe("show");
  });
});
