// 段 13：G07（必須コメント）・G08（傷病名の要件）と、手書きの R17・R06 との重なり（design.md §12-2・§12-3）。
// データは同梱しないので、手で作った数行の表（tests/generic/small-comments.ts。EM §2-11 の錨の事実だけ）で確かめる。実データでの確認は tests/generic/comments-real.test.ts
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { r2026 } from "../../src/engine/revisions/r2026";
import type { ClaimContext } from "../../src/engine/types";
import { evaluateGeneric } from "../../src/generic";
import { commentGroupsOf } from "../../src/generic/g07";
import { claimOfLines, overlap } from "../../src/generic/overlap";
import { genericScopeOf } from "../../src/generic/scope";
import type { GenericAboutMore, GenericClaim } from "../../src/generic/types";
import { genericView } from "../../src/generic/view";
import { UNCODED_DISEASE } from "../../src/uke/diseases";
import { line, loadCase, withFact, withLines, without } from "../engine/helpers";
import { day, month, YM } from "../helpers/period";
import { DISEASE, GEN, put } from "./small-masters";
import { checkUke, claimsOf, commentMasters, D, K } from "./small-comments";

const about: GenericAboutMore = { yearMonth: YM, generation: GEN, outpatient: true };
type Item = [kind: "SI" | "IY" | "TO", code: string];
/** comments が null＝コメントを持たない請求 */
const claimOf = (units: Item[][], comments: string[] | null = []): GenericClaim => ({ units: units.map((items) => ({ items: items.map(([kind, code]) => ({ kind, code })) })), ...(comments ? { comments: comments.map((code) => ({ code })) } : {}) });
const g07 = (c: GenericClaim, a: GenericAboutMore = about, db = commentMasters()) => evaluateGeneric(c, db, a).findings.filter((f) => f.check === "G07");
/** 傷病名（SY のコード）つきの、請求について分かっていること */
const withDiseases = (...codes: string[]): GenericAboutMore => ({ ...about, diseases: codes.map((code) => ({ code })) });
const g08 = (codes: string[], diseases: string[] | undefined, db = commentMasters()) =>
  evaluateGeneric(claimOf(codes.map((code) => [["SI", code]])), db, diseases ? withDiseases(...diseases) : about).findings.filter((f) => f.check === "G08");

describe("G07 必須コメント：算定すれば必ず要る記載が、レセプトのどこにもない", () => {
  it("コメントが 1 つに決まる組：ないと出る（条件つき）。あれば出ない。置き場所は見ない", () => {
    const f = g07(claimOf([[["SI", K.kokyu]], [["SI", K.kokyu]]]));
    expect(f).toEqual([
      {
        check: "G07",
        kind: "記載もれ",
        certainty: "条件つき",
        units: [0, 1],
        codes: [K.kokyu],
        messageKey: "G07.missing",
        params: { code: K.kokyu, sheet: "別表Ⅰ", kouban: "351", comment: `「算定開始年月日（呼吸心拍監視等）」（${K.kokyuStart}）`, comments: K.kokyuStart },
        source: { data: "コメント関連テーブル", ref: `コメント記載通知等=1, 項番=0351, 枝番=00, コード=${K.kokyu}` },
      },
    ]);
    expect(g07(claimOf([[["SI", K.kokyu]]], [K.kokyuStart]))).toEqual([]);
  });

  it("言い切りの候補：一覧（certain）に載せれば確定になる種類。出荷の時点では条件つき", () => {
    const db = commentMasters();
    const sure = evaluateGeneric(claimOf([[["SI", K.kokyu]]]), db, about, undefined, new Set(["G07.missing"])).findings.filter((f) => f.check === "G07");
    expect(sure.map((f) => f.certainty)).toEqual(["確定"]);
    expect(genericView({ findings: sure, ran: [], notRun: [] }, null).findings[0].text).toBe(`摘要欄に「算定開始年月日（呼吸心拍監視等）」（${K.kokyuStart}）の記載がありません。コード ${K.kokyu} を算定するときは、必ず要る記載です（記載要領 別表Ⅰ 項番 351）`);
  });

  it("同じ枝番にコメントが複数ある組：1 つもないときだけ出る。どれか 1 つがあれば出ない（選択か全部かを決めない）", () => {
    expect(g07(claimOf([[["SI", K.sanso]]])).map((f) => [f.messageKey, f.params.kouban, f.params.comments])).toEqual([["G07.missing_any", "216", `${K.spo2},${K.pao2}`]]);
    expect(g07(claimOf([[["SI", K.sanso]]], [K.spo2]))).toEqual([]);
    expect(g07(claimOf([[["SI", K.sanso]]], [K.pao2]))).toEqual([]);
    expect(g07(claimOf([[["SI", K.enkaku]]], [K.shokai]))).toEqual([]);
    expect(g07(claimOf([[["SI", K.echo]]], [K.echoF]))).toEqual([]);
  });

  it("別の枝番に分かれた記載は、それぞれ要る：片方だけあれば、ないほうだけが出る", () => {
    expect(g07(claimOf([[["SI", K.tokubetsu]]])).map((f) => f.params.comments)).toEqual([K.jusho, K.jikan]);
    expect(g07(claimOf([[["SI", K.tokubetsu]]], [K.jusho])).map((f) => f.params.comments)).toEqual([K.jikan]);
    expect(g07(claimOf([[["SI", K.tokubetsu]]], [K.jusho, K.jikan]))).toEqual([]);
  });

  it("言わない行：条件が文章にある行（00）、算定しなかった場合のコメント、診療年月より後に変わった行、入院か入院外かが分からないときの 02", () => {
    // 往診料の「往診が必要となった理由」（条件は、訪問診療料と同じ日。R17 が見る）
    expect(g07(claimOf([[["SI", K.oushin]]]))).toEqual([]);
    expect(g07(claimOf([[["SI", K.shoshin]]]))).toEqual([]);
    // 変更年月日が、診療年月の初月（基準月）の行：前の月の請求には使わない
    expect(g07(claimOf([[["SI", K.shoshin2]]])).map((f) => f.params.comments)).toEqual([K.ka1]);
    expect(g07(claimOf([[["SI", K.shoshin2]]]), { ...about, yearMonth: month(-1) })).toEqual([]);
    // 入院外で算定した場合（02・入外区分 2）は、入院外のレセプトと分かっているときだけ
    expect(g07(claimOf([[["SI", K.ninchi]]])).map((f) => f.params.comments)).toEqual([K.ninchiDate]);
    expect(g07(claimOf([[["SI", K.ninchi]]]), { yearMonth: YM, generation: GEN })).toEqual([]);
  });

  it("医薬品は別表Ⅱ、特定器材は別表Ⅳ の行で見る。行の種類と表が合わない行は使わない", () => {
    expect(g07(claimOf([[["IY", K.adtralza]], [["TO", K.inatsu]]])).map((f) => [f.codes, f.params.sheet, f.params.kouban])).toEqual([[[K.adtralza], "別表Ⅱ", "8"], [[K.inatsu], "別表Ⅳ", "6"]]);
    expect(g07(claimOf([[["IY", K.adtralza]], [["TO", K.inatsu]]], [K.ishi, K.shochi]))).toEqual([]);
    // 同じコードが、別の種類の行として書いてあっても（あり得ない形）、表が合わないので言わない
    expect(g07(claimOf([[["SI", K.adtralza]]]))).toEqual([]);
  });

  it("コメントを持たない請求（区分キーから作った行）には掛けない。点検の範囲に「していない」と出す", () => {
    const db = commentMasters();
    const c = claimOf([[["SI", K.kokyu]]], null);
    const r = evaluateGeneric(c, db, about);
    expect(r.findings.filter((f) => f.check === "G07")).toEqual([]);
    expect(genericScopeOf(c, db, about, r).notDone).toContain("必須コメントは、コメントを持つレセプトにだけ掛けます。ここの行にはコメントが付いていないので、点検していません");
  });

  it("点検の範囲：見た組の数（コメントが複数ある組の数も）、記載が要ることがある項目（条件区分 00）の数、判定していない組の数を、3 つの文に分けて出す（design.md §17-4）", () => {
    const db = commentMasters();
    const c = claimOf([[["SI", K.kokyu]], [["SI", K.sanso]], [["SI", K.oushin]], [["SI", K.shoshin]]], [K.kokyuStart, K.spo2]);
    expect(commentGroupsOf(c, db, about)).toMatchObject({ groups: [{ code: K.kokyu, found: true }, { code: K.sanso, found: true, comments: [K.spo2, K.pao2] }], conditional: [{ code: K.oushin, kouban: "0162", edaban: "03" }], notUsed: 0 });
    const scope = genericScopeOf(c, db, about, evaluateGeneric(c, db, about));
    const i = scope.notDone.findIndex((t) => t.startsWith("必須コメント"));
    expect(scope.notDone.slice(i, i + 3)).toEqual([
      "必須コメント：このレセプトの行について見たのは、算定すれば必ず要る記載 2 組です（記載があるか・ないかだけで、中身は見ていません）。そのうち、同じ項番・枝番にコメントコードが複数ある 1 組は、どれか 1 つがあれば指摘しません（全部が要る組か、選択かを、表からは決められないため）",
      "記載が要ることがある項目 1 件は、判定していません（条件は記載要領の文章にあります。条件に当たるかは記載要領で確かめてください）",
      "判定していない組（複数回算定したときの記載・診療年月の後に変わった行・DPC など）は 0 組です",
    ]);
    expect(scope.conditional?.items.map((x) => [x.sheet, x.kouban, x.codes.map((y) => y.code), x.branches])).toEqual([["別表Ⅰ", "162", [K.oushin], [{ edaban: "03", comments: [`コメントコード ${K.oushinReason}`] }]]]);
  });

  it("文：コメントマスターの名称（定型文）とコメントコード。選択式は候補を並べ、多ければ先頭の 3 つと残りの数。コメントの文字データは出さない", () => {
    const db = commentMasters();
    for (const code of ["820100682", "820100683"]) put(db, "comment_kanren", "20261001", { change: "0", changed_on: "20260601", abolished_on: "99999999", hisantei: "0", nyugai: "0", joken: "01", tsuchi: "1", kouban: "0347", edaban: "01", code: K.echo, comment_code: code });
    const c = { ...claimOf([[["SI", K.echo]], [["SI", K.kokyu]]]), comments: [{ code: "810000001", raw: "患者の氏名など" }] };
    const texts = genericView(evaluateGeneric(c, db, about), null).findings.filter((f) => f.check === "G07").map((f) => f.text);
    expect(texts).toEqual([
      `摘要欄に、次のどれかの記載が要りますが、どれも見当たりません：「手作りの定型文0681」（${K.echoA}）、コメントコード 820100682、コメントコード 820100683 ほか 1 個。コード ${K.echo} を算定するときに要る記載として、コメント関連テーブルに載っています（記載要領 別表Ⅰ 項番 347）。記載要領を確かめてください`,
      `摘要欄に「算定開始年月日（呼吸心拍監視等）」（${K.kokyuStart}）の記載が見当たりません。コード ${K.kokyu} を算定するときに要る記載として、コメント関連テーブルに載っています（記載要領 別表Ⅰ 項番 351）。記載要領を確かめてください`,
    ]);
    expect(texts.join("")).not.toContain("患者の氏名など");
  });

  it("準備ができていない（錨がない）・世代の 1 枚がないときは、動かさない（「指摘なし」にしない）", () => {
    const db = commentMasters();
    db.prepare("UPDATE checks_ready SET ready = 0, reason = '錨がない：手作りの表' WHERE check_id = 'G07'").run();
    const r = evaluateGeneric(claimOf([[["SI", K.kokyu]]]), db, about);
    expect([r.findings.filter((f) => f.check === "G07"), r.notRun.find((n) => n.check === "G07")]).toEqual([[], { check: "G07", kind: "記載もれ", reason: "notReady", detail: "錨がない：手作りの表" }]);
    const db2 = commentMasters();
    db2.prepare("DELETE FROM sources WHERE dataset = 'comment_kanren'").run();
    expect(evaluateGeneric(claimOf([[["SI", K.kokyu]]]), db2, about).notRun.find((n) => n.check === "G07")).toMatchObject({ reason: "noSnapshot" });
  });
});

describe("G07 と R17：同じ記載を 2 回言わない（design.md §12-2）", () => {
  it("kisaimore.UKE（在宅酸素の飽和度の記載を欠いたもの）：R17 が 1 件、G07 の同じ記載は出さない（合わせて 1 件）", () => {
    const [claim] = claimsOf("kisaimore.UKE");
    const r = checkUke(claim, commentMasters());
    expect(r.hand.findings.filter((f) => f.kind === "記載もれ").map((f) => [f.messageKey, f.params?.rule])).toEqual([["R17.comment_missing", "T216-spo2"]]);
    expect(r.generic.map((f) => [f.codes, f.params.kouban])).toEqual([[[K.sanso], "216"]]);
    expect([r.shown, r.duplicate, r.judged]).toEqual([[], 1, 0]);
  });

  it("必須のコメントが付いた同梱の UKE（K1）：R17 も G07 も出ない", () => {
    const k1 = claimsOf("kokuhoren.UKE")[0];
    const r = checkUke(k1, commentMasters());
    expect([r.hand.findings.filter((f) => f.kind === "記載もれ"), r.generic, r.duplicate]).toEqual([[], [], 0]);
  });

  it("同じ行為の、R17 の表にない別の記載は、R17 が指摘していても・黙っていても、G07 が出す（区分ではなく、記載で重ねる）", () => {
    const db = commentMasters();
    // 仮の行：在宅酸素療法指導管理料に、R17 の表（EM §2-10 表 1）にないコメントコードの組を足す
    put(db, "comment_kanren", "20261001", { change: "0", changed_on: "20260601", abolished_on: "99999999", hisantei: "0", nyugai: "0", joken: "01", tsuchi: "1", kouban: "0999", edaban: "00", code: K.sanso, comment_code: K.kokyuStart });
    const missing = checkUke(claimsOf("kisaimore.UKE")[0], db);
    expect([missing.shown.map((f) => f.params.kouban), missing.duplicate, missing.judged]).toEqual([["999"], 1, 0]);
    const present = checkUke(claimsOf("kokuhoren.UKE")[0], db);
    expect([present.shown.map((f) => f.params.kouban), present.duplicate, present.judged]).toEqual([["999"], 0, 0]);
  });

  it("手書きの表にないコード（対象外の単位）の記載もれは、そのまま出す", () => {
    const [claim] = structuredClone(claimsOf("kokuhoren.UKE"));
    claim.units.push({ line: 9000, items: [{ line: 9000, kind: "SI", code: K.kokyu, quantity: "", shikibetsu: "60" }], points: 150, count: 1, days: [1], futan: "1", shikibetsu: "60" });
    const r = checkUke(claim, commentMasters());
    expect([r.shown.map((f) => f.codes), r.duplicate, r.judged]).toEqual([[[K.kokyu]], 0, 0]);
  });
});

describe("G08 傷病名の要件：対象の傷病名が要る行為に、対象の傷病名コードが SY にない（条件つきだけ）", () => {
  it("特定疾患療養管理料：対象の傷病名（05・08）がなければ出る。あれば出ない", () => {
    expect(g08([K.tokutei], [D.tounyou])).toEqual([
      {
        check: "G08",
        kind: "傷病名",
        certainty: "条件つき",
        units: [0],
        codes: [K.tokutei],
        messageKey: "G08.no_target",
        params: { code: K.tokutei, name: "特定疾患療養管理料", what: "特定疾患療養管理料・特定疾患処方管理加算" },
        source: { data: "医科診療行為マスター・傷病名マスター", ref: `診療行為コード=${K.tokutei}, 傷病名関連区分=5, 特定疾患等対象区分=05・08` },
      },
    ]);
    expect(g08([K.tokutei], [D.tounyou, D.zensoku])).toEqual([]);
    expect(g08([K.tokutei], [D.nousotchuTenkan])).toEqual([]);
    // 言い切りの一覧に載せても、確定にはならない（言い切りの文を持たない）
    const sure = evaluateGeneric(claimOf([[["SI", K.tokutei]]]), commentMasters(), withDiseases(D.tounyou), undefined, new Set(["G08.no_target"]));
    expect(sure.findings.filter((f) => f.check === "G08").map((f) => f.certainty)).toEqual(["条件つき"]);
  });

  it("区分ごとの対応：皮膚科(Ⅰ)は 03、(Ⅱ)は 04、てんかん指導料は 07・08。別の区分の傷病名は当たりに数えない", () => {
    expect(g08([K.hifu1, K.hifu2, K.tenkan], [D.tenpousou]).map((f) => f.codes[0])).toEqual([K.hifu2, K.tenkan]);
    expect(g08([K.hifu1, K.hifu2, K.tenkan], [D.taijou, D.tenkan]).map((f) => f.codes[0])).toEqual([K.hifu1]);
    expect(g08([K.tenkan], [D.nousotchuTenkan])).toEqual([]);
    expect(g08([K.tokutei], [D.tenkan]).map((f) => f.codes[0])).toEqual([K.tokutei]);
  });

  it("言わない：未コード化の傷病名（0000999）があるレセプト、マスターにない傷病名コードがあるレセプト、傷病名を持たない請求、難病外来指導管理料（区分 9）", () => {
    expect(g08([K.tokutei], [D.tounyou, UNCODED_DISEASE])).toEqual([]);
    expect(g08([K.tokutei], [D.tounyou, "9999998"])).toEqual([]);
    expect(g08([K.tokutei], undefined)).toEqual([]);
    expect(g08([K.nanbyo], [D.tounyou])).toEqual([]);
    // 傷病名関連区分のない行為（在宅酸素療法指導管理料）には、何も言わない
    expect(g08([K.sanso], [D.tounyou])).toEqual([]);
    const db = commentMasters();
    const a = withDiseases(UNCODED_DISEASE);
    const c = claimOf([[["SI", K.tokutei]]]);
    expect(genericScopeOf(c, db, a, evaluateGeneric(c, db, a)).notDone).toContain("未コード化の傷病名（0000999）があるので、傷病名の要件は点検していません（名称では当てません）");
  });

  it("文：行為の名称と、どの管理料の対象かを言う。傷病名そのものは出さない", () => {
    const r = evaluateGeneric(claimOf([[["SI", K.tokutei]]]), commentMasters(), withDiseases(D.tounyou));
    expect(genericView(r, null).findings.filter((f) => f.check === "G08").map((f) => f.text)).toEqual([
      `コード ${K.tokutei}（特定疾患療養管理料）は、対象の傷病名が要る項目ですが、傷病名マスターで特定疾患療養管理料・特定疾患処方管理加算の対象とされている傷病名が、このレセプトの傷病名に見当たりません。傷病名と、告示（特掲診療料の施設基準等の別表）を確かめてください`,
    ]);
  });
});

describe("G08 と R06（特定疾患処方管理加算）：逆のことを言わない（design.md §12-2。批評 C-101）", () => {
  // 症例 K2（管理料のない月の処方）に、特定疾患処方管理加算を足す。SY は糖尿病だけ（対象の傷病名コードがない）
  const base = withLines(without(loadCase("K1"), "C002_2I1", "C002_N15_RENKEI"), line("F400_3", 1, [day(6)]), line("F400_N4", 1, [day(6)]));
  const both = (ctx: ClaimContext, diseases: string[]) => {
    const hand = evaluate(ctx);
    const { claim, mapped } = claimOfLines(ctx.lines, r2026);
    const generic = evaluateGeneric(claim, commentMasters(), withDiseases(...diseases)).findings.filter((f) => f.check === "G08");
    return { r06: hand.findings.filter((f) => f.ruleId === "R06").map((f) => (f.kind === "情報不足" ? `情報不足:${f.missing!.field}` : f.messageKey)), generic: generic.map((f) => f.codes), ...overlap(hand, r2026, ctx.recordsKnown, mapped, generic) };
  };

  it("R06 が「対象外の主病」と指摘した請求：G08 は同じことを言わない（重複）", () => {
    const r = both(withFact(base, "mainDisease", { known: true, value: "２型糖尿病" }), [D.tounyou]);
    expect(r.r06).toContain("R06.excluded_disease");
    expect([r.generic, r.findings, r.duplicate, r.judged]).toEqual([[[K.shohoKasan]], [], 1, 0]);
  });

  it("R06 が判定して黙った請求（主病が対象外でないと確かめてある）：G08 は出さず、「手書きのルールが判定済み」に数える（逆のことを言わない）", () => {
    const r = both(withFact(base, "mainDisease", { known: true, value: "慢性心不全" }), [D.tounyou]);
    expect(r.r06.filter((k) => k === "R06.excluded_disease" || k.startsWith("情報不足"))).toEqual([]);
    expect([r.generic, r.findings, r.duplicate, r.judged]).toEqual([[[K.shohoKasan]], [], 0, 1]);
  });

  it("R06 が「確かめてください」で止まった請求（主病が不明）：G08 は出す", () => {
    const r = both(withFact(base, "mainDisease", { known: false }), [D.tounyou]);
    expect(r.r06).toEqual(["情報不足:mainDisease"]);
    expect([r.findings.map((f) => f.codes), r.duplicate, r.judged]).toEqual([[[K.shohoKasan]], 0, 0]);
  });

  it("対象の傷病名コードが SY にあれば、G08 は何も言わない（R06 の結果によらない）", () => {
    expect(both(withFact(base, "mainDisease", { known: true, value: "２型糖尿病" }), [D.tounyou, D.zensoku]).generic).toEqual([]);
    // 小さな表の傷病名（区分なし）だけ：対象でない
    expect(both(withFact(base, "mainDisease", { known: false }), [DISEASE]).generic).toEqual([[K.shohoKasan]]);
  });
});
