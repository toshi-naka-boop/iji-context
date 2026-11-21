// 段 14：G09（適応・併用。design.md §12-3）。全部の指摘が条件つきで、正しい請求に出しすぎないこと、出どころを示すことを確かめる。
// データは同梱しないので、手で作った数行の表（tests/generic/small-checkmaster.ts。EM §2-11 の錨の事実と、仮の行）で確かめる。実データでの確認は tests/generic/tekio-real.test.ts
import { describe, expect, it } from "vitest";
import { CERTAIN, evaluateGeneric } from "../../src/generic";
import { r2026 } from "../../src/engine/revisions/r2026";
import { g09Look } from "../../src/generic/g09";
import { overlap } from "../../src/generic/overlap";
import { genericScopeOf } from "../../src/generic/scope";
import type { TimedClaim } from "../../src/generic/tensuhyo";
import type { GenericAboutMore } from "../../src/generic/types";
import { genericView } from "../../src/generic/view";
import { GENERIC_TEXT_CERTAIN } from "../../src/messages";
import { UNCODED_DISEASE } from "../../src/uke/diseases";
import { YM } from "../helpers/period";
import { checkMasters, M, S } from "./small-checkmaster";
import { D, K } from "./small-comments";
import { DISEASE, DRUG, GEN, put } from "./small-masters";

type Item = [kind: "SI" | "IY", code: string];
/** 単位ごとに、行と、算定のある日（1〜31）。日を省いた単位は、算定日が分からない */
const claimOf = (...units: [items: Item[], days?: number[]][]): TimedClaim => ({
  units: units.map(([items, days]) => ({ items: items.map(([kind, code]) => ({ kind, code })), ...(days ? { count: days.length, days: Array.from({ length: 31 }, (_, i) => (days.includes(i + 1) ? 1 : 0)) } : {}) })),
});
/** 傷病名つきの、請求について分かっていること。"?" を付けたコードは疑い病名 */
const withDiseases = (...codes: string[]): GenericAboutMore => ({ yearMonth: YM, generation: GEN, outpatient: true, diseases: codes.map((c) => (c.endsWith("?") ? { code: c.slice(0, -1), suspected: true } : { code: c })) });
const g09 = (c: TimedClaim, a: GenericAboutMore, db = checkMasters()) => evaluateGeneric(c, db, a).findings.filter((f) => f.check === "G09");
const keys = (c: TimedClaim, a: GenericAboutMore) => g09(c, a).map((f) => [f.messageKey, ...f.codes]);

describe("G09 適応（医薬品）：表にある薬で、表の傷病名がレセプトの傷病名に 1 つもない", () => {
  it("出る：条件つき、薬ごとに 1 件（当たる単位は全部）、表の傷病名は数と先頭だけ、出どころは表の名前と医薬品コード", () => {
    const f = g09(claimOf([[["IY", M.pentasa]], [1]], [[["IY", M.pentasa]], [15]]), withDiseases(DISEASE));
    expect(f).toEqual([
      {
        check: "G09",
        kind: "適応",
        certainty: "条件つき",
        units: [0, 1],
        codes: [M.pentasa],
        messageKey: "G09.iy_no_disease",
        params: { code: M.pentasa, name: "手作りの薬（適応の例）", count: "2", shown: `${S.crohn},${S.uc}`, diseases: `「手作りの傷病名Ａ」（${S.crohn}）、「手作りの傷病名Ｂ」（${S.uc}）` },
        source: { data: "チェックマスタ 医薬品適応関連マスタファイル", ref: `医薬品コード=${M.pentasa}` },
      },
    ]);
    const text = genericView({ findings: f, ran: [], notRun: [] }, null).findings[0].text;
    expect(text).toBe(`コード ${M.pentasa}（手作りの薬（適応の例））：レセプトの傷病名に、審査支払機関のチェック用の表にある傷病名が見当たりません（表の傷病名は 2 件：「手作りの傷病名Ａ」（${S.crohn}）、「手作りの傷病名Ｂ」（${S.uc}））。傷病名のもれか、表にない使い方かを確かめてください`);
  });

  it("出ない：表の傷病名のどれか 1 つがある（疑い病名でも、廃止の行の傷病名でも、当たりに数える）", () => {
    for (const d of [S.crohn, S.uc, `${S.crohn}?`, S.shinfuzen]) expect(keys(claimOf([[["IY", M.pentasa]], [1]]), withDiseases(DISEASE, d)), d).toEqual([]);
    expect(keys(claimOf([[["IY", M.riva]], [1]]), withDiseases(S.nvaf))).toEqual([]);
  });

  it("言わない：表に載っていない薬、廃止の行だけの薬、傷病名でない行（量だけ・外れ値）だけの薬。「問題なし」とも言わず、数を点検の範囲に出す", () => {
    const c = claimOf([[["IY", DRUG], ["IY", M.buscopan], ["IY", "999999999"], ["IY", M.pentasa]], [1]]);
    const a = withDiseases(S.uc);
    const db = checkMasters();
    expect(g09(c, a, db)).toEqual([]);
    expect(g09Look(c, db, a)).toMatchObject({ iy: { all: 4, inTable: 1 }, si: { all: 0, inTable: 0 }, why: null });
    const notes = genericScopeOf(c, db, a, evaluateGeneric(c, db, a)).g09!;
    expect(notes.some((t) => t.startsWith("適応の表にある薬 1／レセプトの薬 4、表にある診療行為 0／レセプトの診療行為 0。表にない薬・診療行為は、チェックの対象外なので見ていません"))).toBe(true);
  });

  it("言わない：表に性別・年齢の条件つきの行がある薬・診療行為（条件を読めないので、その薬・診療行為の適応は見ない）。数を点検の範囲に出す", () => {
    const c = claimOf([[["IY", M.aged], ["SI", M.seieki]], [1]]);
    const db = checkMasters();
    const a = withDiseases(DISEASE);
    expect(g09(c, a, db)).toEqual([]);
    expect(g09Look(c, db, a)).toMatchObject({ iy: { all: 1, inTable: 1, conditioned: 1 }, si: { all: 1, inTable: 1, conditioned: 1 } });
    expect(genericScopeOf(c, db, a, evaluateGeneric(c, db, a)).g09).toContain("表にある薬のうち 1、診療行為のうち 1 は、表に性別・年齢の条件つきの行があるので、適応を見ていません（条件の読み方を、公開元の仕様書で確かめられていないため）");
    // 条件のない薬なら、同じ傷病名で出る
    expect(keys(claimOf([[["IY", M.pentasa]], [1]]), a)).toEqual([["G09.iy_no_disease", M.pentasa]]);
  });

  it("言わない：未コード化の傷病名（0000999）か、マスターにない傷病名コードがあるレセプト（名前では当てない）。傷病名を持たない請求", () => {
    const c = claimOf([[["IY", M.pentasa]], [1]], [[["SI", M.bnp]], [1]]);
    const db = checkMasters();
    for (const [a, why, text] of [
      [withDiseases(DISEASE, UNCODED_DISEASE), "uncoded", "未コード化の傷病名（0000999）があるので、適応は点検していません（名称では当てません）"],
      [withDiseases(DISEASE, "9999998"), "unknown", "持っているマスターにない傷病名コードがあるので、適応は点検していません"],
    ] as const) {
      expect(g09(c, a, db), why).toEqual([]);
      expect(g09Look(c, db, a)).toMatchObject({ why, iy: { all: 1, inTable: 1 }, si: { all: 1, inTable: 1 } });
      expect(genericScopeOf(c, db, a, evaluateGeneric(c, db, a)).g09).toContain(text);
    }
    const bare: GenericAboutMore = { yearMonth: YM, generation: GEN };
    expect(g09(c, bare, db)).toEqual([]);
    expect(genericScopeOf(c, db, bare, evaluateGeneric(c, db, bare)).g09).toEqual(["適応・併用は、傷病名と薬の行を持つレセプトにだけ掛けます。ここの行には傷病名が付いていないので、点検していません"]);
    // 傷病名が 1 つもないレセプト（SY が空）は、点検する：表にある薬・診療行為の全部に出る
    expect(keys(c, withDiseases())).toEqual([["G09.iy_no_disease", M.pentasa], ["G09.si_no_disease", M.bnp]]);
  });

  it("傷病名が多いレセプト（表の側を読む道）でも、同じ結果になる", () => {
    const many = Array.from({ length: 60 }, () => DISEASE);
    const more = Array.from({ length: 60 }, (_, i) => String(9000000 + i));
    const db = checkMasters();
    const c = claimOf([[["IY", M.pentasa]], [1]], [[["SI", M.marker]], [1]]);
    const about = (codes: string[]): GenericAboutMore => ({ ...withDiseases(), diseases: codes.map((code) => ({ code })) });
    // マスターにないコードが混ざると言わないので、60 個とも同じコード（集合は 1 つ）の場合と、当たる傷病名を足した場合で比べる
    expect(g09(c, about(many), db).map((f) => f.messageKey)).toEqual(["G09.iy_no_disease", "G09.si_no_disease"]);
    for (const code of more) put(db, "shobyo", "20261001", { code, name: "手作り" });
    expect(g09(c, about(more), db).map((f) => f.messageKey)).toEqual(["G09.iy_no_disease", "G09.si_no_disease"]);
    expect(g09(c, about([...more, S.uc, S.igan]), db)).toEqual([]);
    expect(g09(c, { ...about(more), diseases: [...more.map((code) => ({ code })), { code: S.igan, suspected: true }, { code: S.uc }] }, db).map((f) => f.messageKey)).toEqual(["G09.si_suspected"]);
  });
});

describe("G09 適応（診療行為）", () => {
  it("表の傷病名が 1 つもないと出る。あれば出ない。表が確定・疑いとも対象にしている行は、疑い病名でも出ない", () => {
    const c = claimOf([[["SI", M.bnp]], [8]]);
    const f = g09(c, withDiseases(DISEASE));
    expect(f.map((x) => [x.messageKey, x.certainty, x.units, x.params.count, x.source])).toEqual([["G09.si_no_disease", "条件つき", [0], "2", { data: "チェックマスタ 医科診療行為傷病名関連マスタファイル", ref: `医科診療行為コード=${M.bnp}` }]]);
    expect(genericView({ findings: f, ran: [], notRun: [] }, null).findings[0].text).toBe(`コード ${M.bnp}（BNP）：レセプトの傷病名に、審査支払機関のチェック用の表にある傷病名が見当たりません（表の傷病名は 2 件：「特発性拡張型心筋症」（${S.dcm}）、「心不全」（${S.shinfuzen}））。傷病名のもれか、表にない場合の算定かを確かめてください`);
    for (const d of [S.shinfuzen, `${S.shinfuzen}?`, S.dcm]) expect(keys(c, withDiseases(d)), d).toEqual([]);
  });

  it("表が確定病名だけを対象にしている行：疑い病名としてだけあるときは、そのことを言う。確定の記載が 1 つでもあれば出ない", () => {
    const c = claimOf([[["SI", M.marker]], [8]]);
    const f = g09(c, withDiseases(`${S.igan}?`));
    expect(f.map((x) => [x.messageKey, x.params.found])).toEqual([["G09.si_suspected", `「胃癌」（${S.igan}）`]]);
    expect(genericView({ findings: f, ran: [], notRun: [] }, null).findings[0].text).toBe(`コード ${M.marker}（悪性腫瘍特異物質治療管理料（その他・１項目））：審査支払機関のチェック用の表にある傷病名が、レセプトには疑い病名としてだけあります（「胃癌」（${S.igan}））。表は、この項目には確定病名を対象にしています（表の傷病名は 1 件）。傷病名の記載を確かめてください`);
    expect(keys(c, withDiseases(S.igan))).toEqual([]);
    expect(keys(c, withDiseases(`${S.igan}?`, S.igan))).toEqual([]);
    expect(keys(c, withDiseases(DISEASE))).toEqual([["G09.si_no_disease", M.marker]]);
  });

  it("傷病名の要件（G08）と同じ診療行為に重なるときは、G08 だけを出す（2 回言わない）。G08 が言わないときは、G09 が出る", () => {
    const c = claimOf([[["SI", K.tokutei]], [8]]);
    const db = checkMasters();
    // 重なりの規則（overlap）を通したあとに消す。手書きのルールがこのコードを見ていない（行とコードの対応がない）請求
    const shown = (a: GenericAboutMore) => overlap({ findings: [] }, r2026, false, [], evaluateGeneric(c, db, a).findings).findings.map((f) => f.messageKey);
    // 対象の傷病名がない：G08 も G09 も当たるが、出るのは G08 だけ
    expect(shown(withDiseases(D.tounyou))).toEqual(["G08.no_target"]);
    // 対象の傷病名が疑い病名：G08 は数えるので言わない。G09 は、表が確定病名だけを対象にしていることを言う
    expect(shown(withDiseases(`${D.zensoku}?`))).toEqual(["G09.si_suspected"]);
    expect(shown(withDiseases(D.zensoku))).toEqual([]);
  });

  it("G08 が手書きのルール（R06）の判定済みとして消えたときは、G09 が残る（round-32 O-16）", () => {
    // 特定疾患処方管理加算（F400_N4。R06 が covers で申告）に、チェックマスタの行も足す（仮の行）
    const db = checkMasters();
    put(db, "cm_si_shobyo", "20261001", { code: K.shohoKasan, shobyo: D.zensoku, sex: "0", age_upper: 999.99, nyugai: "0", utagai: "0", change: "0" });
    const c = claimOf([[["SI", K.shohoKasan]], [8]]);
    const found = evaluateGeneric(c, db, withDiseases(D.tounyou)).findings;
    expect(found.map((f) => f.messageKey).sort()).toEqual(["G08.no_target", "G09.si_no_disease"]);
    // R06 が動いて、指摘も情報不足も出さなかった（判定して黙った）
    const o = overlap({ findings: [], applied: ["R06"] }, r2026, false, [{ kubun: "F400_N4", unit: 0, codes: [K.shohoKasan] }], found);
    expect([o.findings.map((f) => f.messageKey), o.judged]).toEqual([["G09.si_no_disease"], 1]);
    // R06 がこの請求を見ていない（試算の結果など。applied がない）なら、G08 が残り、G09 は消える
    expect(overlap({ findings: [] }, r2026, false, [{ kubun: "F400_N4", unit: 0, codes: [K.shohoKasan] }], found).findings.map((f) => f.messageKey)).toEqual(["G08.no_target"]);
  });
});

describe("G09 併用：表の組が、同じ日に両方ある", () => {
  it("同じ日に両方あると 1 件（組は両向きに載っているが、1 回だけ）。片方だけ・別の日・算定日の分からない単位・廃止の組は出ない", () => {
    const a = withDiseases(DISEASE);
    const f = g09(claimOf([[["IY", M.buscopan]], [3, 10]], [[["IY", M.primperan]], [10, 20]]), a);
    expect(f).toEqual([
      {
        check: "G09",
        kind: "適応",
        certainty: "条件つき",
        units: [0, 1],
        codes: [M.buscopan, M.primperan],
        messageKey: "G09.heiyo_kinki",
        params: { a: M.buscopan, b: M.primperan, nameA: "手作りの薬（併用Ｌ）", nameB: "手作りの薬（併用Ｒ）", days: "10" },
        source: { data: "チェックマスタ 医薬品併用禁忌関連マスタファイル", ref: `医薬品コード（Ｌ）=${M.buscopan}, 医薬品コード（Ｒ）=${M.primperan}` },
      },
    ]);
    expect(genericView({ findings: f, ran: [], notRun: [] }, null).findings[0].text).toBe(`コード ${M.buscopan}（手作りの薬（併用Ｌ））と ${M.primperan}（手作りの薬（併用Ｒ））は、審査支払機関の併用のチェック用の表にある組で、同じ日（10日）に両方あります。併用禁忌・併用注意などのどれに当たる組かは、表からは分かりません。処方の内容を確かめてください`);
    expect(keys(claimOf([[["IY", M.buscopan], ["IY", M.primperan]], [5]]), a)).toEqual([["G09.heiyo_kinki", M.buscopan, M.primperan]]);
    expect(keys(claimOf([[["IY", M.buscopan]], [3]]), a)).toEqual([]);
    expect(keys(claimOf([[["IY", M.buscopan]], [3]], [[["IY", M.primperan]], [4]]), a)).toEqual([]);
    expect(keys(claimOf([[["IY", M.buscopan]]], [[["IY", M.primperan]], [4]]), a)).toEqual([]);
    // 廃止の組（仮の行）。薬の適応は、傷病名を付けて黙らせる
    expect(keys(claimOf([[["IY", M.pentasa], ["IY", M.riva]], [5]]), withDiseases(S.uc, S.nvaf))).toEqual([]);
  });

  it("傷病名を持たない・未コード化の傷病名があるレセプトでも、併用は見る（傷病名に依らない）", () => {
    const c = claimOf([[["IY", M.buscopan], ["IY", M.primperan]], [5]]);
    expect(keys(c, withDiseases(UNCODED_DISEASE))).toEqual([["G09.heiyo_kinki", M.buscopan, M.primperan]]);
  });
});

describe("G09 は言い切らない。点検の範囲に、但し書きと、見られないものを出す", () => {
  it("言い切りの文を持たない。一覧（certain）に載せても、条件つきのまま", () => {
    expect(Object.keys(GENERIC_TEXT_CERTAIN).filter((k) => k.startsWith("G09"))).toEqual([]);
    expect([...CERTAIN].filter((k) => k.startsWith("G09"))).toEqual([]);
    const c = claimOf([[["IY", M.pentasa], ["IY", M.buscopan], ["IY", M.primperan], ["SI", M.bnp], ["SI", M.marker]], [5]]);
    const all = new Set(["G09.iy_no_disease", "G09.si_no_disease", "G09.si_suspected", "G09.heiyo_kinki"]);
    const f = evaluateGeneric(c, checkMasters(), withDiseases(`${S.igan}?`), undefined, all).findings.filter((x) => x.check === "G09");
    expect(f.map((x) => x.messageKey).sort()).toEqual([...all].sort());
    expect(f.every((x) => x.certainty === "条件つき")).toBe(true);
    // 医学的な助言の形にしない：「できません」「使えません」「付けてください」と書かない
    for (const x of genericView({ findings: f, ran: [], notRun: [] }, null).findings) expect(x.text).not.toMatch(/できません|使えません|付けてください|禁忌です/);
  });

  it("点検の範囲：但し書きの趣旨、表にある薬・診療行為の数、院外処方の薬は見られないこと（処方箋料があれば、そのこと）、作っていない点検、版の日付", () => {
    const db = checkMasters();
    const a = withDiseases(S.uc);
    const scope = (c: TimedClaim) => genericScopeOf(c, db, a, evaluateGeneric(c, db, a));
    const notes = scope(claimOf([[["IY", M.pentasa]], [5]])).g09!;
    expect(notes[0]).toMatch(/^適応・併用：審査支払機関のコンピュータチェックは、診療内容の適否を一律に決めるものではなく.*査定されると決まったわけではありません/);
    expect(notes).toContain("院外処方の薬の適応・量は、このレセプトからは見られません（医科のレセプトに薬が載らないため）");
    expect(notes.some((t) => t.startsWith("量と日数（最大投与量・最長投与日数）、傷病名との禁忌、性別・年齢の条件") && t.includes("点検していません"))).toBe(true);
    expect(notes.some((t) => t.startsWith("チェックマスタは 2026年10月1日 公開の版です"))).toBe(true);
    // G09 の説明は、ほかの点検の「していないこと」とは別に持つ
    expect(scope(claimOf([[["IY", M.pentasa]], [5]])).notDone.some((t) => t.includes("適応"))).toBe(false);
    // 処方箋料の行があるレセプト
    const rx = scope(claimOf([[["SI", M.shohosen]], [5]])).g09!;
    expect(rx).toContain("このレセプトには処方箋料があります。院外処方の薬の適応・量は、このレセプトからは見られません（医科のレセプトに薬が載らないため）");
    expect(rx.some((t) => t.startsWith("適応の表にある薬 0／レセプトの薬 0、表にある診療行為 0／レセプトの診療行為 1"))).toBe(true);
  });

  it("診療年月の世代のチェックマスタがなければ、動かさない（「指摘なし」にしない）", () => {
    const db = checkMasters();
    db.prepare("DELETE FROM sources WHERE dataset = 'checkmaster'").run();
    const r = evaluateGeneric(claimOf([[["IY", M.pentasa]], [5]]), db, withDiseases(DISEASE));
    expect(r.ran.some((x) => x.check === "G09")).toBe(false);
    expect(r.notRun.find((x) => x.check === "G09")).toMatchObject({ reason: "noSnapshot", detail: `診療年月の世代（${GEN}）のチェックマスタがありません` });
  });
});
