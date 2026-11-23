// 取り込んだレセプトの点検（design.md §11-11・§11-13）：UKE に書いてあるとおりのまま（行もコメントも入れ替えずに）判定した結果。
// 月末の点検（利用者が行を入力する問題。src/server/app/question-case.ts）とは別の道で、何も記録しない（開くたびに計算する）。
// 判定は、コメントを持つ請求（commentsKnown が真。摘要欄の記載の点検 R17 が動く）・カルテ側の記録がない請求（recordsKnown が偽）として行う。
// 点検の対象外の単位があれば partial で、出るのは申告のある種類の指摘だけ。合計は、UKE に書いてある請求の合計と、点検した行の小計を別々に返す。
// 基本マスター（masters.db）が入っていれば（design.md §12）：全部の行・コメント・傷病名に名称を付け、データで動く点検（G01〜）を掛け、partial で止めるルールを、対象外の行の区分番号でルールごとに決める。
// 試算（ukeTrial。design.md §11-12）は、版を名指しして同じことをする：診療年月に版がないレセプトも、診療年月の版と違う版でも読める。保存しない
import { partialBy } from "../../engine";
import { resolveRevision, revisionById, revisionChoices, UKE_TRIAL_REVISIONS } from "../../engine/revisions";
import type { Revision } from "../../engine/revisions/types";
import { trial } from "../../engine/trial";
import type { ClaimContext, ClaimLine, Finding } from "../../engine/types";
import type { DeclarationView } from "../../facility/declaration";
import { evaluateGeneric } from "../../generic";
import { g10MarksOf, sidelessOf } from "../../generic/g10";
import { outsideOf, rowNamesOf, sheetNotesOf } from "../../generic/lookup";
import { mappedLinesOf, type MappedLine } from "../../generic/overlap";
import { commentKanrenNotesOf, kisaiOf } from "../../generic/g07";
import { checkmasterNotesOf } from "../../generic/g09";
import { buildingScopeNotes, deferredNote, genericScopeOf } from "../../generic/scope";
import { tensuhyoNotesOf } from "../../generic/tensuhyo";
import type { GenericAboutMore } from "../../generic/types";
import { withMasters } from "../../masters/db";
import { diseaseCodeOf, SUSPECTED_MODIFIER } from "../../uke/diseases";
import type { UkeClaim, UkeOther } from "../../uke/types";
import { isDeductionUnit, mapClaim } from "../../uke/uke";
import { badRequest } from "../errors";
import type { Cases } from "./cases";
import { genericOut, type Hand } from "./generic";
import type { Patients } from "./patients";
import type { Uke } from "./uke";
import type { Torikawasure } from "./torikawasure";

/** 取り込んだ請求の B の欄（G11）を作る関数（src/server/app.ts が渡す。貼ったカルテと、同じ月の貼った患者の数を読む） */
export type TorikawasureOf = (claimId: string, clerkId: string | undefined, input: { claim: UkeClaim; base: ClaimContext; rev: Revision; hand: Finding[] }) => Torikawasure;

/**
 * 1〜31 日の回数を、算定のある日（"YYYY-MM-DD"）にする。回数ぶんは重ねない：1 日の欄は 999 まであり（投薬は処方した日に日数分が入る）、
 * 重ねると対象外の単位だけで数百万個の文字列になり得る。回数は count で別に返している
 */
const datesOf = (yearMonth: string, days: number[]): string[] => days.flatMap((n, i) => (n > 0 ? [`${yearMonth}-${String(i + 1).padStart(2, "0")}`] : []));

/** 試算で選べる版（画面の選択肢）。own は、その診療年月の版か */
const trialRevisions = (yearMonth: string) => revisionChoices(UKE_TRIAL_REVISIONS, yearMonth);

/** 点検と試算で同じ形にして返す部分：点検した行・対象外の単位・指摘・情報不足 */
function bodyOf(yearMonth: string, rev: Revision, lines: ClaimLine[], others: UkeOther[], all: Finding[]) {
  const findings = all.filter((f) => f.kind !== "情報不足");
  return {
    /** 点検した行（UKE の単位の並びのまま）。points は、その版の 1 回分 */
    lines: lines.map((l) => ({ kubun: l.kubun, no: rev.points[l.kubun].no, name: rev.points[l.kubun].name, count: l.count, dates: l.dates, points: rev.points[l.kubun].points })),
    /** 点検の対象外の単位（コード・1 回分の点数・回数・算定日）と、その行の数 */
    others: others.map((o) => ({ codes: o.codes, points: o.points, count: o.count, dates: datesOf(yearMonth, o.days) })),
    otherRows: others.reduce((s, o) => s + o.codes.length, 0),
    partial: others.length > 0,
    recordsKnown: false,
    commentsKnown: true,
    findings,
    /** 記載もれ（摘要欄の記載。R17）の件数 */
    commentMissingCount: findings.filter((f) => f.kind === "記載もれ").length,
    /** 情報不足（確かめる事実と、決められないこと） */
    missing: all.filter((f) => f.kind === "情報不足"),
  };
}

/**
 * マスターを引いて作る部分（design.md §12-4・§12-5）。点検と試算で同じ形：
 * names＝全部の行（対象外の単位の行も）・コメント・傷病名の名称（診療年月に使う 1 枚のマスターから。マスターがなければ持たない＝画面はコードだけ）／
 * sheetNotes＝使う 1 枚についての断り書き（診療年月より後の 1 枚で代えている／読み方を確かめた版より新しい。design.md §12-1）／
 * diseases＝傷病名（UKE の並びのまま。表にもマスターにもないコードは name が null）／
 * generic＝データで動く点検の指摘と、点検の範囲。指摘は、手書きの結果 hand と、行とコードの対応 mapped で、重なりの規則（src/generic/overlap.ts）を通したもの／
 * stopped＝対象外の単位があるために partial として扱ったルールと、そうさせた行（all が真＝ルールごとには決められず、どのルールも partial。
 * dropped が真＝そのルールの指摘を実際に捨てた＝情報不足 unsupportedLines が出ている）。partial のルールは、指摘がなくても「問題なし」とは言えない／
 * rows＝UKE の全部の算定単位（単位の並びのまま。画面の「レセプトの行」の表）。items は単位の行のコードと、区分番号・名称（マスターのもの。なければ版の表のもの。どちらもなければ null）、
 * kubun は手書きのルールの区分に引けた行の区分（引けない単位は空）、points は UKE に書いてある 1 回分の点数（正の数のまま）、
 * deduction は点数を請求の合計から引く単位か（薬剤料の逓減など、減じるコードだけの単位。src/uke/uke.ts の isDeductionUnit）、
 * checkedBy はその単位を見た点検：rules+generic／rules（データで動く点検が動いていない）／generic（手書きのルールの区分に引けない）／none（どちらも見ていない）
 */
/** 基本マスターの断り書きに、電子点数表・コメント関連テーブル・チェックマスタの分を足す */
type SheetNote = { later: boolean; newer: boolean };
const sheetNotesWith = (notes: { later: string[]; newer: string[] }, t: SheetNote, k: SheetNote, c: SheetNote) => ({
  later: [...notes.later, ...(t.later ? ["電子点数表"] : []), ...(k.later ? ["コメント関連テーブル"] : []), ...(c.later ? ["チェックマスタ"] : [])],
  newer: [...notes.newer, ...(t.newer ? ["電子点数表"] : []), ...(k.newer ? ["コメント関連テーブル"] : []), ...(c.newer ? ["チェックマスタ"] : [])],
});

/**
 * exceptions は、背反の特例条件の例外（G05。design.md §13-2・§13-3）に渡す、請求ごとの事実の答え（answers）とその請求の事実（facts）。
 * 取り込んだレセプトの点検だけが渡す（試算は渡さない：問いを出さない。L-76）
 */
function mastersPartOf(claim: UkeClaim, rev: Revision, ctx: ClaimContext, hand: Hand, mapped: MappedLine[], exceptions?: Pick<GenericAboutMore, "answers" | "facts" | "localKnowledge" | "level" | "pressed" | "declaration">) {
  // 行の属性（G03）が読むもの：読めたレセプトは入院外だけ（入院のレセプトは parseUke が「読めない」にする）。生年月日は UKE のもの。
  // 施設の種別は、設定が在宅療養支援診療所なら診療所（在宅療養支援診療所は診療所であることが要件で、病院は在宅療養支援病院）。そうでなければ決めない
  const diseaseCodes = claim.patient.diseases.map((d) => d.code ?? diseaseCodeOf(d.name));
  // 傷病名の要件（G08）・適応（G09）が読むもの：SY の傷病名コード（未コード化は 0000999）と、疑い病名かどうか（修飾語「の疑い」）。必須コメント（G07）は、請求のコメント（claim.comments）を読む
  const about: GenericAboutMore = { yearMonth: claim.yearMonth, generation: rev.generation, ...exceptions, ...(exceptions?.declaration ? { sideless: sidelessOf(rev) } : {}), outpatient: true, birth: claim.patient.birth, ...(ctx.facility.zaishishin ? { clinic: true } : {}), diseases: diseaseCodes.map((code, i) => ({ code, suspected: claim.patient.diseases[i].modifiers?.includes(SUSPECTED_MODIFIER) === true })), kisai: kisaiOf(rev, ctx.lines.filter((l) => l.count > 0).map((l) => l.kubun)) };
  return withMasters((db) => {
    const result = evaluateGeneric(claim, db, about);
    // 施設基準の印は、G10 が動いたときだけ（動かなければ「届出が要ります」のまま。design.md §15-5）
    const marks = db && result.ran.some((r) => r.check === "G10") ? g10MarksOf(claim, db, about) : null;
    const names = db ? rowNamesOf(db, about, { items: claim.units.flatMap((u) => u.items), comments: claim.comments.map((c) => c.code), diseases: diseaseCodes }, marks) : null;
    // データで動く点検は、動いた点検があれば全部の単位を見ている（マスターがなければ、どれも動かない）
    const genericRan = result.ran.length > 0;
    const scope = genericScopeOf(claim, db, about, result);
    // C〜I に回した区分の「見ていない」（design.md §15-4。L-92）も、同じ点検の範囲に出す（マスターがなくても出す）
    const deferred = deferredNote(ctx.lines, rev);
    // 単一建物の人数の次元で見ていないもの・みなしで読んだもの（design.md §15-4。段 17f）
    const building = buildingScopeNotes(ctx, rev, claim, db, about);
    const notes = [...(deferred ? [deferred] : []), ...building];
    return {
      ...(names ? { names } : {}),
      ...(db ? { sheetNotes: sheetNotesWith(sheetNotesOf(db, about), tensuhyoNotesOf(db, about), commentKanrenNotesOf(db, about), checkmasterNotesOf(db, about)) } : {}),
      diseases: claim.patient.diseases.map((d, i) => ({ code: diseaseCodes[i], name: d.name !== "" ? d.name : (names?.diseases[diseaseCodes[i]] ?? null), main: d.main === true })),
      // カルテ側の記録がない請求として判定している（recordsKnown は偽）。検算（G02）の数と、G02・G03 がしていないことを、点検の範囲に足す
      generic: { ...genericOut(result, names, hand, rev, false, mapped), scope: notes.length ? { ...scope, notDone: [...scope.notDone, ...notes] } : scope },
      /** 指摘に添えた承認済みの院内の知識の id（design.md §14-3。USED を出す） */
      localUsed: result.localUsed ?? [],
      rows: claim.units.map((u, i) => {
        const own = mapped.filter((m) => m.unit === i);
        const items = u.items.map(({ code }) => {
          const kubun = own.find((m) => m.codes.includes(code))?.kubun;
          const n = names?.items[code];
          return { code, no: n?.no ?? (kubun ? rev.points[kubun].no : null), name: n?.name ?? (kubun ? rev.points[kubun].name : null) };
        });
        const checkedBy: "rules+generic" | "rules" | "generic" | "none" = own.length > 0 ? (genericRan ? "rules+generic" : "rules") : genericRan ? "generic" : "none";
        return { unit: i, items, kubun: [...new Set(own.map((m) => m.kubun))], count: u.count, dates: datesOf(claim.yearMonth, u.days), points: u.points, deduction: isDeductionUnit(u), checkedBy };
      }),
      stopped: rev.rules.flatMap((rule) => {
        const by = partialBy(rule, rev, ctx);
        if (by === null) return [];
        const codes = Array.isArray(by) ? by.map((c) => ({ code: c.code, known: c.known, name: names?.items[c.code]?.name ?? null, no: names?.items[c.code]?.no ?? null })) : [];
        return [{ ruleId: rule.id, all: !Array.isArray(by), codes, dropped: hand.findings.some((f) => f.ruleId === rule.id && f.missing?.field === "unsupportedLines") }];
      }),
    };
  });
}

/**
 * answersOf は、請求ごとの事実のうち、背反の特例条件の例外の問いの答えを読む関数（src/server/app/claim-facts.ts）。
 * localOf は、背反の組の院内の知識・本人のレベル・押した事実の時刻（design.md §14-3。取り込んだレセプトの点検だけが渡す。試算は渡さない）。
 * declarationOf は、施設の申告の三値（G10。design.md §15-5。取り込んだレセプトの点検だけが渡す。試算は渡さない＝G10 は動かない）
 */
export function createUkeCheck(uke: Uke, cases: Cases, patientProfile: (claimId: string) => ReturnType<Patients["patientProfile"]>, answersOf: (claimId: string) => (key: string, date: string | null) => string | null, localOf?: (claimId: string, clerkId?: string) => Pick<GenericAboutMore, "localKnowledge" | "level" | "pressed">, declarationOf?: () => DeclarationView, torikawasureOf?: TorikawasureOf) {
  /** clerkId は、見ている本人（レベルで院内の知識の出し方を分ける。design.md §14-3） */
  function ukeCheck(claimId: string, clerkId?: string) {
    const { receipt: r, uploaded, claim } = uke.receiptOf(claimId);
    const head ={ claimId, yearMonth: r.yearMonth, patient: r.patient.name, patientNo: uploaded ? (r.patientNo ?? "") : null };
    // 読み直しで読めなかったレセプト（表が変わって点数が合わない）は、理由だけを返す
    if (r.unreadable) return { ...head, unreadable: r.unreadable };
    // 診療年月に版がないレセプトは、点検しない（近い版で代用しない）。画面は、選べる版から選んで試算する（ukeTrial）
    if (r.noRevision) return { ...head, unreadable: null, revisionId: null, revisions: trialRevisions(r.yearMonth) };
    const rev = resolveRevision(r.yearMonth);
    // UKE に書いてあることだけで点検する：行とコメントは UKE のまま、出来事は持たない（同梱の症例でも、カルテ側の記録は使わない）
    const ctx: ClaimContext = { ...cases.caseOf(claimId), events: [], recordsKnown: false };
    const result = cases.judge(ctx);
    const parsed = claim();
    const mapped = mapClaim(parsed, rev);
    // B の欄（G11。design.md §15-8・§15-9）：貼ったカルテの行ったことと UKE を突き合わせる。recordsKnown は偽のまま、手書きのルールの判定は変えない
    const torikawasure = torikawasureOf?.(claimId, clerkId, { claim: parsed, base: ctx, rev, hand: result.findings });
    // R01 の回数の区分誤りに、取り忘れを先に確かめる文を添える（条件つきに下げる。R01 の指摘は消さない）
    const handNotes = torikawasure && "handNotes" in torikawasure ? torikawasure.handNotes : [];
    const findings = result.findings.map((f) => {
      const n = handNotes.find((h) => h.messageKey === f.messageKey);
      return n ? { ...f, params: { ...f.params, g11First: n.text } } : f;
    });
    return {
      ...head,
      unreadable: null,
      revisionId: result.revisionId,
      revisions: trialRevisions(r.yearMonth),
      /** UKE に書いてある請求の合計（HO と、KO の並び） */
      declared: r.declared ?? { ho: null, ko: [] },
      ...bodyOf(r.yearMonth, rev, r.lines, r.others ?? [], findings),
      ...(torikawasure ? { torikawasure } : {}),
      // 背反の特例条件の例外の問いには、請求ごとの事実から作った答えと、その請求の事実を渡す（design.md §13-2 の入力。C-116）
      ...mastersPartOf(parsed, rev, ctx, result, mappedLinesOf(mapped.lines, mapped.origins), { answers: answersOf(claimId), facts: ctx.facts, ...localOf?.(claimId, clerkId), ...(declarationOf ? { declaration: declarationOf() } : {}) }),
      /** 点検した行の小計（請求の合計ではない） */
      subtotal: result.subtotal !== undefined ? result.subtotal : result.total,
      applied: result.applied,
      /** コメント（UKE に書いてある並びのまま）。text は文字データの原文 */
      comments: r.comments.map((c) => ({ code: c.code, text: c.raw })),
      /** 患者情報チェック（P 系。ユスティの指摘とは別の欄） */
      patientFindings: patientProfile(claimId).findings,
    };
  }

  /**
   * 試算（design.md §11-12）：一覧にあるレセプトを、名指しした版のコードの表・点数表・ルールで読んで判定する。その場で計算して返し、何も保存しない。
   * 診療年月に版がないレセプトでも、診療年月の版と違う版でも読める。選べるのは、コードの表を持つ版だけ。日付は UKE のまま動かさない。
   * UKE に書いてある 1 回分の点数が、選んだ版の点数と違う単位は、断らずに行を引き、違いを pointDiffs に並べる（行の点数・小計は、選んだ版の点数）。
   * 戻りは試算の型（TrialResult の trial・rulesAvailable を持ち、revisionId・applied を持たない）で、提出の確定・適用記録の入口には渡せない
   */
  function ukeTrial(claimId: string, revId: string) {
    const rev = revisionById(revId);
    if (!rev || !UKE_TRIAL_REVISIONS.includes(rev)) throw badRequest("選べる版ではありません", ["rev"]);
    const { receipt: r, uploaded, claim } = uke.receiptOf(claimId);
    const parsed = claim();
    const mapped = mapClaim(parsed, rev, true);
    // 事実・施設の設定は、レセプトの側にあるものだけ（選んだ版が読む事実がなければ、情報不足になる。埋め合わせの値を作らない）。出来事は持たない
    const { partial: _partial, outside: _outside, ...base } = cases.trialBaseOf(claimId);
    // 対象外の単位のコードは、選んだ版の世代のマスターで引く（design.md §12-1）。マスターがなければ渡さない
    const outside = mapped.others.length > 0 ? withMasters((db) => (db ? outsideOf(db, rev, parsed.yearMonth, mapped.others.flatMap((o) => o.codes)) : undefined)) : undefined;
    const ctx: ClaimContext = {
      ...base,
      events: [],
      recordsKnown: false,
      // 検査項目のコード（items）は UKE の側の持ち物で、エンジンには渡さない
      lines: mapped.lines.map(({ kubun, count, dates }) => ({ kubun, count, dates })),
      comments: mapped.comments,
      commentsKnown: true,
      ...(mapped.others.length > 0 ? { partial: true } : {}),
      ...(outside ? { outside } : {}),
    };
    const { findings, subtotal, ...result } = trial(ctx, rev);
    /** 単位ごとの、点数の違い。複数の区分がある単位は、区分ごとに分けず、単位の合算どうしを比べる（kubun・name は単位の区分を並べたもの） */
    const pointDiffs = mapped.units.flatMap((u, i) =>
      u.ok && u.revPoints !== undefined
        ? [{ kubun: u.lines.map((l) => l.kubun), name: u.lines.map((l) => rev.points[l.kubun].name).join("＋"), ukePoints: parsed.units[i].points, revPoints: u.revPoints, count: parsed.units[i].count }]
        : [],
    );
    return {
      ...result,
      yearMonth: r.yearMonth,
      patient: r.patient.name,
      patientNo: uploaded ? (r.patientNo ?? "") : null,
      /** 診療年月から決まる版（なければ null）と、選べる版 */
      ownRevisionId: r.noRevision ? null : resolveRevision(r.yearMonth).id,
      revisions: trialRevisions(r.yearMonth),
      revisionLabel: rev.label,
      /** UKE に書いてある請求の合計（HO と、KO の並び。UKE の点数のまま） */
      declared: { ho: parsed.total?.points ?? null, ko: parsed.kohiTotals },
      ...bodyOf(r.yearMonth, rev, mapped.lines, mapped.others, findings),
      ...(({ localUsed: _unused, ...rest }) => rest)(mastersPartOf(parsed, rev, ctx, { findings }, mappedLinesOf(mapped.lines, mapped.origins))),
      /** 点検した行の小計（選んだ版の点数で数えたもの。請求の合計ではない） */
      subtotal: subtotal !== undefined ? subtotal : result.total,
      pointDiffs,
      /** コメント（UKE に書いてある並びのまま）。text は文字データの原文 */
      comments: parsed.comments.map((c) => ({ code: c.code, text: c.raw })),
    };
  }

  return { ukeCheck, ukeTrial };
}

export type UkeCheck = ReturnType<typeof createUkeCheck>;
