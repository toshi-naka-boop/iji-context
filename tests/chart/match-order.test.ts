// 段 18d（design.md §15-10。v32）：候補の並べ方の 4（語の輪・前方一致→部分一致・コードの順・重なりの決まり）と名前で探す入口（L-161）、
// 指示文の 5 文（L-162）、候補出しの評価の 1 対 1 の数え方（L-163）。LLM は呼ばない。マスターは手で作った小さな表
import { describe, expect, it } from "vitest";
import { EXTRACT_PROMPT } from "../../src/chart/extract";
import { matchItem, rowsFor, searchRows, MAX_CANDIDATES, type ItemMatch } from "../../src/chart/match";
import { countActs, maxPairing } from "../../eval/acts-count";
import { put } from "../generic/small-masters";
import { ABBREV_CASES, abbrevOf, chartMasters } from "./small-chart-masters";
import { YM } from "../helpers/period";

const SNAP = "20261001";

describe("候補の並べ方の 4（L-161）", () => {
  it("lookup の語「在宅患者訪問診療料」から、名称の長い基本の区分が上位に入る（前方一致が部分一致より先、同じ強さの中はコードの順）", () => {
    const db = chartMasters();
    // 名称が短く、コードが小さい部分一致の行（v31 の「短い順」なら先頭に来た）
    put(db, "shinryo", SNAP, { code: "114000010", name: "加算（在宅患者訪問診療料）", alpha: "C" });
    // 書かれた名前「訪診」はどの名称にも当たらない（語の輪で枠を使わない）
    const r = matchItem(rowsFor(db, "shinryo", YM), "shinryo", "訪診", ["在宅患者訪問診療料"], null);
    expect(r.candidates.map((c) => c.code)).toEqual([
      "114001110", // 在宅患者訪問診療料（１）１（同一建物居住者以外）：前方一致
      "114030310", // 在宅患者訪問診療料(Ⅰ)1ロ 同一建物居住者：前方一致
      "114000010", // 部分一致（コードの順）
      "114001470",
    ]);
    // 書かれた名前が当たる語なら、語の輪の最後の語として交互に入る（入った行は飛ばす）
    const w = matchItem(rowsFor(db, "shinryo", YM), "shinryo", "訪問診療", ["在宅患者訪問診療料"], null);
    expect(w.candidates.map((c) => c.code)).toEqual(["114001110", "114000010", "114030310", "114001470", "180725910", "180726010", "180820110", "180854010", "180854110"]);
    expect(r.initial).toBeNull();
  });

  it("語の輪：当たりの多い 1 語が 20 件を独占せず、ほかの語の当たりも交互に入る。当たりのない語は枠を使わない", () => {
    const db = chartMasters();
    for (let i = 0; i < 25; i++) put(db, "shinryo", SNAP, { code: `16900${String(i).padStart(4, "0")}`, name: `多い語の行${"カ".repeat(i + 1)}` });
    put(db, "shinryo", SNAP, { code: "169100001", name: "少ない語の行その一" });
    put(db, "shinryo", SNAP, { code: "169100002", name: "少ない語の行その二" });
    const rows = rowsFor(db, "shinryo", YM);
    const r = matchItem(rows, "shinryo", "x", ["多い語", "どこにもない語", "少ない語"], null);
    const codes = r.candidates.map((c) => c.code);
    expect(codes).toHaveLength(MAX_CANDIDATES);
    expect(codes.slice(0, 4)).toEqual(["169000000", "169100001", "169000001", "169100002"]);
    // 当たりのない語は枠を使わない：多い語の 18 件と少ない語の 2 件で 20 件
    expect(codes.filter((c) => c.startsWith("16900"))).toHaveLength(18);
  });

  it("すでに候補に入った行は、その語の番を使わずに飛ばし、その語のまだ入っていない次の行を出す。normName で同じになる語は語の輪に 1 回だけ", () => {
    const db = chartMasters();
    put(db, "shinryo", SNAP, { code: "169200001", name: "重なる語ア" });
    put(db, "shinryo", SNAP, { code: "169200002", name: "重なる語アカ" });
    put(db, "shinryo", SNAP, { code: "169200003", name: "重なる語アキ" });
    put(db, "shinryo", SNAP, { code: "169200004", name: "重なる語イ" });
    put(db, "shinryo", SNAP, { code: "169300001", name: "別の行一" });
    put(db, "shinryo", SNAP, { code: "169300002", name: "別の行二" });
    const rows = rowsFor(db, "shinryo", YM);
    // 「重なる語ア」は 3 の lookup の完全一致で入る。語の輪 1 周目：「重なる語」は入った行を飛ばしてアカ、「重なる語ア」はアカを飛ばしてアキ、「別の行」は一。
    // 2 周目：「重なる語」がイ、「重なる語ア」は尽きて飛ばし、「別の行」は二（番を使って飛ばすと、一がアキより先に出る）
    expect(matchItem(rows, "shinryo", "x", ["重なる語", "重なる語ア", "別の行"], null).candidates.map((c) => c.code)).toEqual(["169200001", "169200002", "169200003", "169300001", "169200004", "169300002"]);
    // 空白・全角で書き分けても同じ語は 1 回：輪の番を 2 つ取らない
    const once = matchItem(rows, "shinryo", "x", ["重なる語", "少ない"], null).candidates.map((c) => c.code);
    expect(matchItem(rows, "shinryo", "x", ["重なる語", "重なる 語", "少ない"], null).candidates.map((c) => c.code)).toEqual(once);
    // 書かれた名前が lookup の語と同じなら、輪に 1 回だけ（先に出た lookup の語の位置）
    expect(matchItem(rows, "shinryo", "重なる語", ["重なる語"], null).candidates.map((c) => c.code)).toEqual(["169200001", "169200002", "169200003", "169200004"]);
  });

  it("今までの決まりは変わらない：前に選んだもの → 名前の完全一致 → lookup の完全一致が先、同じコードは 1 回、診療年月の 1 枚にないコードは出ない", () => {
    const db = chartMasters();
    const rows = rowsFor(db, "shinryo", YM);
    const r = matchItem(rows, "shinryo", "創傷処置（１００ｃｍ２未満）", ["熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）", "処置"], { tbl: "shinryo", code: "150054110" });
    expect(r.candidates.slice(0, 3).map((c) => [c.code, c.prior])).toEqual([
      ["150054110", true],
      ["140000610", false],
      ["140032110", false],
    ]);
    expect(r.initial).toMatchObject({ code: "150054110", by: "alias" });
    const codes = r.candidates.map((c) => `${c.tbl}|${c.code}`);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of r.candidates) expect(rows!.some((x) => x.tbl === c.tbl && x.code === c.code)).toBe(true);
    // 別の 1 枚（版のない診療年月）は引かない
    expect(matchItem(rowsFor(db, "shinryo", "1999-01"), "shinryo", "創傷処置", ["処置"], null)).toEqual({ initial: null, candidates: [] });
  });

  it("名前で探す入口も同じ並べ方：前方一致を先・部分一致を後、同じ強さの中はコードの順", () => {
    const db = chartMasters();
    put(db, "shinryo", SNAP, { code: "114000010", name: "加算（在宅患者訪問診療料）", alpha: "C" });
    expect(searchRows(rowsFor(db, "shinryo", YM), "在宅患者訪問診療料").map((c) => c.code)).toEqual(["114001110", "114030310", "114000010", "114001470"]);
  });
});

describe("区切りでつないだ lookup の語（§15-7 の 3b。v35。L-218）", () => {
  it("空白・「・」・括弧でつないだ語は、分けた語をすべて含む行を候補に入れる（normName で 1 語にすると当たらない形）", () => {
    const db = chartMasters();
    put(db, "shinryo", SNAP, { code: "179000001", name: "他医撮影の写真診断（単純撮影）" });
    put(db, "shinryo", SNAP, { code: "179000002", name: "写真診断（特殊撮影）" });
    const rows = rowsFor(db, "shinryo", YM);
    // 1 語のままでは当たらない
    expect(matchItem(rows, "shinryo", "x", ["写真診断単純撮影"], null).candidates.map((c) => c.code)).not.toContain("179000001");
    // 空白・括弧・「・」で分けると、分けた語をすべて含む行だけが入る（「特殊撮影」の行は単純撮影を含まないので入らない）
    for (const l of ["写真診断 単純撮影", "写真診断（他医撮影・単純撮影）", "単純撮影・写真診断"]) {
      const codes = matchItem(rows, "shinryo", "x", [l], null).candidates.map((c) => c.code);
      expect(codes).toContain("179000001");
      expect(codes).not.toContain("179000002");
    }
  });
  it("分けた語が 1 つだけのときは何も足さず、今までの並べ方のまま", () => {
    const db = chartMasters();
    const rows = rowsFor(db, "shinryo", YM);
    expect(matchItem(rows, "shinryo", "訪診", ["在宅患者訪問診療料 "], null).candidates).toEqual(matchItem(rows, "shinryo", "訪診", ["在宅患者訪問診療料"], null).candidates);
  });
});

describe("指示文の 5 文（L-162）", () => {
  const FIVE = [
    "訪問診療・往診を行ったと書かれていれば、それも行為として出す。",
    "処方の欄に書かれた薬は、1 つずつ投薬として acts にも出す（rx への写しとは別に出す）。",
    "酸素などのガスや材料は、薬ではなく器材として出す（with の中でも同じ）。",
    "まとめて書かれた複数の検査・項目は、1 つずつ分けて出す。",
    "挙げたい言い方が複数あるときは、空白でつながず、別々の lookup の語に分ける。",
  ];
  it("5 文（round-63 で改めた後の文）が入り、外した後半は入らない", () => {
    for (const s of FIVE) expect(EXTRACT_PROMPT).toContain(s);
    expect(EXTRACT_PROMPT).not.toContain("処方箋の交付や薬を渡したことも投薬として出す");
    expect(EXTRACT_PROMPT).not.toContain("空白で区切らない");
  });
  it("K8〜K11 の合成カルテの固有の語（行為・薬・器材の書かれた名前）を含まない", () => {
    const names = new Set<string>();
    for (const k of ABBREV_CASES) for (const e of abbrevOf(k).entries) for (const a of e.acts) for (const w of [a.written, ...(a.with ?? []).map((x) => x.written)]) names.add(w);
    expect(names.size).toBeGreaterThan(30);
    for (const n of names) expect(EXTRACT_PROMPT, n).not.toContain(n);
  });
});

describe("候補出しの評価の数え方（1 対 1。L-163）", () => {
  const item = (codes: string[], initial: string | null = null): ItemMatch => ({
    initial: initial ? { tbl: "shinryo", code: initial, name: "", by: "name" } : null,
    candidates: codes.map((code) => ({ tbl: "shinryo", code, name: "", prior: false })),
  });
  const want = (...codes: string[]) => codes.map((code) => ({ tbl: "shinryo" as const, code }));

  it("1 つの行為から 2 つの正解を稼がない（まとめ書きを分けなければ 1 つだけ入る）", () => {
    expect(countActs([item(["A", "B"])], want("A", "B")).in20).toBe(1);
    expect(countActs([item(["A"]), item(["B"])], want("A", "B")).in20).toBe(2);
  });
  it("正解と行為の組み合わせは最大のものを取る（先に組んだ正解を組み替える）", () => {
    // 正解 A は行為 0 か 1、正解 B は行為 0 だけ：A を 1、B を 0 に組めば 2
    expect(maxPairing([item(["A", "B"]), item(["A"])], want("A", "B"), 20)).toEqual([1, 0]);
  });
  it("上位 5 件は候補の上から 5 件と初期値だけ。内訳は名前で当たった・候補から選べる・組めない", () => {
    const n = countActs([item(["x1", "x2", "x3", "x4", "x5", "A"]), item([], "B"), item(["C"])], want("A", "B", "C", "D"));
    expect([n.in20, n.top5, n.name, n.lookup, n.unmatched]).toEqual([3, 2, 1, 2, 1]);
  });
  it("参考の割合は印を付けた正解を除いて数える（合否の数は変えない）", () => {
    const n = countActs([item(["A"])], want("A", "B"), [{ code: "B", why: "設計で取り出さない" }]);
    expect([n.total, n.in20, n.ref, n.refIn20]).toEqual([2, 1, 1, 1]);
  });
});
