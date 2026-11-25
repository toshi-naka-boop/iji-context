"use client";
// 取り込んだレセプトの点検（design.md §11-11・§11-13）：UKE に書いてあるとおりのまま（行もコメントも入れ替えずに）点検した結果を見せる。
// 上から：注意の帯 → 指摘（記載もれを含む。種類ごと）→ 情報不足 → レセプトの行（全部の単位を UKE の並びで 1 つの表に。単位ごとに見た点検と指摘の印）→ 小計と UKE の合計 → 摘要欄の記載 → 患者情報の指摘。
// 点検は読むだけで、何も記録しない（GET /api/uke/claims/[claimId]/check）。情報不足の項目に残した答えだけが残る（app/fact-input.tsx）。月末の点検（行を入力する問題）とは別の画面。
// 版を替えると試算（design.md §11-12。GET /api/uke/claims/[claimId]/trial?rev=）：選んだ版の点数表とルールで読み、UKE の点数との違いを並べる。
// 診療年月に版がないレセプトは点検できないので、開くと選べる版の最初（コードの表を持つ、いちばん古い版）が選ばれた状態で試算を見せる
import { useParams } from "next/navigation";
import { handMarksOf } from "../../../src/uke/marks";
import { useEffect, useState } from "react";
import type { Finding } from "../../../src/engine/types";
import type { RowNames } from "../../../src/generic/lookup";
import type { GenericView } from "../../../src/generic/view";
import { COMMENT_CHECK_NOTE, findingText } from "../../../src/messages";
import { SignIn, useClerk } from "../../clerk";
import { CheckedFacts, FactInput } from "../../fact-input";
import { GenericFindings } from "../../generic-findings";
import { FindingLevels } from "../../finding-levels";
import { ConfirmedFixes } from "../../chart/confirmed-fixes";
import { Torikawasure, type TorikawasureView } from "../../torikawasure";
import { RecordPaste } from "../record-paste";
import { LocalReturn } from "../../local-pair";
import { returnsOutside } from "../../../src/generic/local-pair";
import { getJson } from "../../get-json";
import { TopBar } from "../../nav";
import { PageGuide } from "../../page-guide";

/** 施設基準の印（design.md §15-5）。G10 が動いたときは申告の三値、動かないときは「届出が要ります」 */
const KIJUN_MARK = { held: "申告あり", not: "申告では持たない", unknown: "申告が分からない" } as const;
const kijunMark = (n: { todokede?: true; kijun?: keyof typeof KIJUN_MARK } | undefined): string => (n?.kijun ? `　施設基準：${KIJUN_MARK[n.kijun]}` : n?.todokede ? "　届出が要ります" : "");

type Line = { kubun: string; no: string; name: string; count: number; dates: string[]; points: number | null };
type Check = {
  claimId: string;
  yearMonth: string;
  patient: string;
  patientNo: string | null;
  unreadable: { reason: string } | null;
  /** 診療年月から決まる版（なければ null）と、試算で選べる版 */
  revisionId?: string | null;
  revisions?: { id: string; label: string }[];
  declared?: { ho: number | null; ko: number[] };
  lines?: Line[];
  subtotal?: number | null;
  others?: { codes: string[]; points: number | null; count: number; dates: string[] }[];
  otherRows?: number;
  findings?: Finding[];
  commentMissingCount?: number;
  /** 条件つきの指摘（R20・R21）の件数 */
  conditionalCount?: number;
  missing?: Finding[];
  comments?: { code: string; text: string }[];
  patientFindings?: { checkId: string; kind: string; text: string }[];
  /** マスターの名称（マスターが入っているときだけ。design.md §12-5）：行（区分番号つき）・コメント・傷病名 */
  names?: RowNames;
  /** 使う 1 枚についての断り書き（マスターの名前）：later＝診療年月より後の 1 枚で代えている／newer＝読み方を確かめた版より新しい */
  sheetNotes?: { later: string[]; newer: string[] };
  diseases?: { code: string; name: string | null; main: boolean }[];
  /** データで動く点検（G01〜）の指摘と、点検の範囲 */
  generic?: GenericView;
  /** 対象外の行に左右されるルール（partial として扱ったルール）と、そうさせた行（all＝ルールごとには決められず、どのルールも） */
  stopped?: Stopped[];
  /** UKE の全部の算定単位（単位の並びのまま）と、その単位を見た点検 */
  rows?: Row[];
  /** 「この請求のこの組が返戻・査定された」を出す組（承認済みの allow の院内の知識がある組。design.md §14-4） */
  localReturns?: { a: string; b: string; tani: number; ids: string[] }[];
  /** 作る入口が断る向き（その組の院内の知識がすでにある向き）。作る入口を出す G05 の指摘の組ごと（design.md §14-2） */
  localPairTaken?: { a: string; b: string; tani: number; polarities: ("allow" | "avoid")[] }[];
  /** 本人がこの請求の点検を確かめたか（実在用のクリニックだけ載る。確かめていなければ null。design.md §14-3・段 17g） */
  reviewed?: { at: string } | null;
  /** B の欄（取り忘れ。G11。design.md §15-9）。貼ったカルテで動く */
  torikawasure?: TorikawasureView;
};
/** deduction は点数を請求の合計から引く単位（薬剤料の逓減など。points は UKE のまま正の数） */
type Row = { unit: number; items: { code: string; no: string | null; name: string | null }[]; kubun: string[]; count: number; dates: string[]; points: number; deduction?: boolean; checkedBy: "rules+generic" | "rules" | "generic" | "none" };
type Stopped = { ruleId: string; all: boolean; codes: { code: string; known: boolean; name: string | null; no: string | null }[] };
/** 試算の結果。点検と同じ項目に、選んだ版と、点数の違いが付く */
type Trial = Check & {
  trial: { revisionId: string; claimYearMonth: string; inPeriod: boolean };
  rulesAvailable: boolean;
  revisionLabel: string;
  pointDiffs: { kubun: string[]; name: string; ukePoints: number; revPoints: number; count: number }[];
};

const num = (n: number) => n.toLocaleString("ja-JP");
const pts = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${num(n)} 点`);
/** 診療年月（YYYY-MM）を、画面の文に出す形にする */
const monthLabel = (yearMonth: string) => `${yearMonth.slice(0, 4)}年${Number(yearMonth.slice(5, 7))}月`;
const signed = (n: number) => (n > 0 ? `+${num(n)}` : num(n));
const days = (dates: string[]) => [...new Set(dates)].map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`).join("、");
/** 入力では消えない情報不足（点検の対象外の行がある）。ルールごとに同じ文で返るので、画面では 1 件にまとめる */
const SHARED_MISSING = ["unsupportedLines"];
/**
 * カルテ側の記録がない（chartRecord）は、取り込んだレセプトに記録を足す手段がなく、入力で消えない。情報不足には出さず、「見ていません」の帯にルールを並べる
 * （採点 r2 医療事務課長 P1-2。全件の一覧の「見ていないこと」と同じ扱い。src/server/app/uke-summary.ts）
 */
const UNSEEN_MISSING = "chartRecord";
/** 情報不足を、画面に出す形にまとめる：同じ文になる項目は最初の 1 件に寄せ、ルールと対象の行は合わせて出す。ほかの項目はそのまま */
function groupMissing(missing: Finding[]): { finding: Finding; ruleIds: string[]; lineRefs: string[] }[] {
  const out: { finding: Finding; ruleIds: string[]; lineRefs: string[] }[] = [];
  for (const f of missing) {
    const same = SHARED_MISSING.includes(f.missing?.field ?? "") ? out.find((g) => g.finding.missing?.field === f.missing?.field) : undefined;
    if (same) {
      same.ruleIds = [...new Set([...same.ruleIds, f.ruleId])];
      same.lineRefs = [...new Set([...same.lineRefs, ...f.lineRefs])];
    } else out.push({ finding: f, ruleIds: [f.ruleId], lineRefs: [...f.lineRefs] });
  }
  return out;
}
/** ユスティの指摘の段階。申告のとおりならの指摘（R20・R21）と、取り忘れの条件つきの添え書き（g11First）は条件つき、ほかは確定（src/server/app/review.ts の handCertaintyOf と同じ） */
const certaintyOf = (f: Finding): "確定" | "条件つき" => (f.params?.g11First || f.params?.conditional === "1" ? "条件つき" : "確定");
/** 指摘を出す順（種類ごと） */
const KINDS = ["背反", "区分誤り", "要件不足", "不一致", "取り忘れ", "記載もれ"];

export default function UkeClaimCheck() {
  const { clerk: user, ready } = useClerk();
  const { claimId } = useParams<{ claimId: string }>();
  const [check, setCheck] = useState<Check | null>(null);
  const [err, setErr] = useState("");
  /** 情報不足の項目に答えを残すたびに増やし、点検（と試算）をやり直す */
  const [tick, setTick] = useState(0);
  /** 選んでいる版。診療年月の版なら点検、ほかの版なら試算 */
  const [rev, setRev] = useState("");
  const [trial, setTrial] = useState<Trial | null>(null);
  const [reviewMsg, setReviewMsg] = useState("");
  useEffect(() => {
    if (!user) return;
    getJson<Check>(`/api/uke/claims/${encodeURIComponent(claimId)}/check`)
      .then((d) => {
        setCheck(d);
        // 診療年月に版がないレセプトは、選べる版の最初（コードの表を持つ、いちばん古い版。いまの版の並びでは、改定前のレセプトの次に来た改定の版に当たる）を選んだ状態にする。
        // 最後の版（まだ先の値の変更の版）を初期値にすると、「今の算定」ではない点数が先に出る。
        // 答えを残して読み直すとき（tick）は、選んでいる版を変えない
        setRev((cur) => cur || (d.revisionId ?? d.revisions?.[0]?.id ?? ""));
      })
      .catch((e: Error) => setErr(e.message));
  }, [user, claimId, tick]);
  useEffect(() => {
    setTrial(null);
    if (!user || !check || rev === "" || rev === check.revisionId) return;
    setErr("");
    getJson<Trial>(`/api/uke/claims/${encodeURIComponent(claimId)}/trial?rev=${encodeURIComponent(rev)}`).then(setTrial).catch((e: Error) => setErr(e.message));
  }, [user, claimId, check, rev, tick]);

  /** 「この請求の点検を確かめた」（実在用のクリニックで、本人の処理件数に 1 件数える。同じ請求は 1 回だけ） */
  async function sendReviewed() {
    setReviewMsg("");
    const r = await fetch(`/api/uke/claims/${encodeURIComponent(claimId)}/reviewed`, { method: "POST" });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setReviewMsg(d?.error ?? "エラー");
    setTick((t) => t + 1);
  }

  if (!ready) return <main className="shell"><TopBar /></main>;
  if (!user) return <main className="shell"><TopBar /><SignIn /></main>;
  const head = check;
  /** 見せる中身：試算していれば試算、していなければ点検（版のないレセプトは、試算が届くまで中身がない） */
  const c = trial ?? (check && check.revisionId !== null ? check : null);
  const findings = c?.findings ?? [];
  /** 入力で消える情報不足（カルテ側の記録がない分は「見ていません」に回す） */
  const missing = (c?.missing ?? []).filter((f) => f.missing?.field !== UNSEEN_MISSING);
  const unseenRules = [...new Set((c?.missing ?? []).filter((f) => f.missing?.field === UNSEEN_MISSING).map((f) => f.ruleId))];
  const lines = c?.lines ?? [];
  const others = c?.others ?? [];
  const rows = c?.rows ?? [];
  const nameOf = (kubun: string) => lines.find((l) => l.kubun === kubun)?.name ?? kubun;
  /** 行（区分）から、その行のある最初の単位への、ページ内のリンク先 */
  const unitHref = (kubun: string) => {
    const r = rows.find((x) => x.kubun.includes(kubun));
    return r ? `#uke-unit-${r.unit}` : undefined;
  };
  const codeHref = (code: string) => {
    const r = rows.find((x) => x.items.some((it) => it.code === code));
    return r ? `#uke-unit-${r.unit}` : undefined;
  };
  /** 行のコードの名称（マスターの名称、なければ行に付いた名称。どちらもなければ null） */
  const rowName = (code: string) => c?.names?.items[code]?.name ?? rows.flatMap((r) => r.items).find((it) => it.code === code)?.name ?? null;
  /** 単位に当たる指摘を、種類ごとの件数にする（手書きのルールは行の区分で、データで動く点検は行のコードで当てる） */
  const countBy = (kinds: string[]) => [...new Set(kinds)].map((k) => `${k} ${kinds.filter((x) => x === k).length}`).join("・");
  const marksOf = (r: Row) => ({
    // 条件つきの指摘（申告のとおりなら。R20・R21 など）は確定の指摘と分けて数える（判断 F。round-82 C-531）
    hand: Object.entries(handMarksOf(findings, r.kubun).kinds).map(([k, n]) => `${k} ${n}`).join("・"),
    conditional: handMarksOf(findings, r.kubun).conditional,
    generic: countBy((c?.generic?.findings ?? []).filter((f) => f.codes.some((x) => r.items.some((it) => it.code === x.code))).map((f) => f.kind)),
  });
  const CHECKED_BY: Record<Row["checkedBy"], string> = {
    "rules+generic": "手書きのルール＋データで動く点検",
    rules: "手書きのルール",
    generic: "データで動く点検",
    none: c?.names ? "点検していない" : "マスターがなく、点検していない",
  };
  const recalc = c?.generic?.scope?.recalc;
  /** 対象外の行に左右されるルールを、そうさせた行が同じものどうしでまとめる */
  const stoppedGroups: { ruleIds: string[]; all: boolean; codes: Stopped["codes"] }[] = [];
  for (const s of c?.stopped ?? []) {
    const key = (x: { all: boolean; codes: Stopped["codes"] }) => `${x.all}:${x.codes.map((y) => y.code).join(",")}`;
    const same = stoppedGroups.find((g) => key(g) === key(s));
    if (same) same.ruleIds.push(s.ruleId);
    else stoppedGroups.push({ ruleIds: [s.ruleId], all: s.all, codes: s.codes });
  }
  /**
   * コードに、マスターの名称（診療行為は区分番号も）を添える。マスターがない・マスターにないコードは、コードだけ。
   * 施設基準のある行には、G10 が動いたときは申告の印（申告あり／申告では持たない／申告が分からない）、動かないときは「届出が要ります」と添える（指摘ではない。design.md §15-5）
   */
  const coded = (code: string) => {
    const n = c?.names?.items[code];
    return n ? `${code} ${n.name}${n.no ? `（${n.no}）` : ""}${kijunMark(n)}` : code;
  };
  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="yusti" title="取り込んだレセプトの点検" tag="RULE ENGINE">
        取り込んだ UKE に書いてあるとおりのまま、決まった規則で点検した結果です。行もコメントも入れ替えていません。点検の結果は記録しません。「情報不足」の項目に、確かめた答えを残すと、その答えだけが残り、点検をやり直します。
      </PageGuide>
      <p style={{ margin: "0 0 12px" }}><a href="/uke">← UKE 取り込みに戻る</a></p>
      <FindingLevels />
      {err && <div className="notice warn">{err}</div>}
      {head && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>
            {head.claimId} {head.patient}{head.patientNo ? `（患者の番号 ${head.patientNo}）` : ""}　<span className="muted">診療年月 {head.yearMonth}</span>
          </h2>
          {head.unreadable && (
            <div className="notice warn">
              <strong>このレセプトは、いまは点検できません。</strong>
              <div>{head.unreadable.reason}</div>
            </div>
          )}
          {!head.unreadable && (head.revisions ?? []).length > 0 && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>点数表とルールの版</span>
              <select value={rev} onChange={(e) => setRev(e.target.value)}>
                {(head.revisions ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}{r.id === head.revisionId ? "（診療年月の版）" : "（試算）"}</option>)}
              </select>
            </label>
          )}
          {!head.unreadable && head.revisionId === null && (
            <div className="notice">この診療年月の版はありません。月末の点検と提出には並びません。版を選んで試算できます。</div>
          )}
          {trial && (
            <div className="notice warn">
              <strong>診療年月 {monthLabel(trial.trial.claimYearMonth)} のレセプトを、{trial.revisionLabel}の点数表とルールで試算しています。実際の請求の判定ではありません。</strong>
              <div>日付は UKE のままで、何も記録しません。この版が読む事実がレセプトの側にないときは「情報不足」として出ます。</div>
            </div>
          )}
          {!head.unreadable && c && (
            <>
              {trial && (
                <>
                  <h3 style={{ margin: 0 }}>点数の違い</h3>
                  {trial.pointDiffs.length === 0 ? <p className="muted" style={{ margin: 0 }}>UKE に書いてある点数と、この版の点数が違う行はありません。</p> : (
                    <table className="emr-table">
                      <thead>
                        <tr><th>名称</th><th>回数</th><th>UKE の点数</th><th>この版の点数</th><th>差</th></tr>
                      </thead>
                      <tbody>
                        {trial.pointDiffs.map((d, i) => (
                          <tr key={i}>
                            <td>{d.name}</td>
                            <td>{d.count}</td>
                            <td>{num(d.ukePoints)}</td>
                            <td>{num(d.revPoints)}</td>
                            <td>{signed(d.revPoints - d.ukePoints)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
              {others.length > 0 && (
                <div className="notice warn">
                  <strong>この請求には、点検の対象外の行が {c.otherRows} 行あります。</strong>
                  <div>対応していないコードを含む行は、ユスティの点検（決まった規則）の対象外です。対象外の行に左右される点は「決められません」と出し、下の小計は請求の合計ではありません。</div>
                </div>
              )}
              <div className="notice">
                <span className="badge">見ていません</span> カルテ側の記録がないため、記録を読む点検（訪問・処方・退院などの記録で決まる点）はしていません。入力では変わりません。
                {unseenRules.length > 0 && <div className="muted">記録で決まる点を見ていないルール：{unseenRules.join("・")}</div>}
              </div>

              <h3 id="yusti-findings" style={{ margin: 0 }}>ユスティの指摘</h3>
              {trial && !trial.rulesAvailable ? <p className="muted" style={{ margin: 0 }}>この版のルールは持っていません（算定行と点数だけ）。</p> : findings.length === 0 && <p className="muted" style={{ margin: 0 }}>指摘はありません。</p>}
              {(c.commentMissingCount ?? 0) > 0 && <p style={{ margin: 0 }}>記載もれを {c.commentMissingCount} 件見つけました。</p>}
              {(c.conditionalCount ?? 0) > 0 && <p style={{ margin: 0 }}>条件つきの指摘が {c.conditionalCount} 件あります（医療事務が確かめた申告のとおりなら当たるもの。指摘の数・直した件数の集計には入りません）。</p>}
              {KINDS.filter((k) => findings.some((f) => f.kind === k)).map((k) => (
                <div key={k} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {findings.filter((f) => f.kind === k).map((f, i) => (
                    <div key={i} className="notice warn">
                      <span className={`badge ${certaintyOf(f) === "確定" ? "warn" : ""}`}>{certaintyOf(f)}</span> <span className="badge">{f.kind}</span> {findingText(f)}
                      {f.params?.g11First && <div className="muted">（条件つき）{f.params.g11First}</div>}
                      {f.lineRefs.length > 0 && <div className="muted">対象の行：{f.lineRefs.map((k, n) => <span key={n}>{n > 0 && "、"}{unitHref(k) ? <a href={unitHref(k)}>{nameOf(k)}</a> : nameOf(k)}</span>)}</div>}
                      {f.reference && <div className="muted">根拠：{f.reference}</div>}
                    </div>
                  ))}
                </div>
              ))}

              {c.generic && (
                <>
                  <h3 id="generic-findings" style={{ margin: 0 }}>データで動く点検</h3>
                  <GenericFindings
                    generic={c.generic}
                    scope="full"
                    rowHref={codeHref}
                    laterSheets={c.sheetNotes?.later ?? []}
                    answer={trial ? undefined : { claimId: c.claimId, onSaved: () => setTick((t) => t + 1), localReturns: check?.localReturns ?? [], localPairTaken: check?.localPairTaken ?? [], handAsked: (c.missing ?? []).flatMap((m) => (m.missing ? [{ field: m.missing.field, date: m.missing.date ?? null }] : [])) }}
                    notes={[
                      "公開されているマスターで、全部の行（点検の対象外の行も）を点検します。「条件つき」は、言い切れない指摘です。打ち間違いや、マスターの更新もれがないかを確かめてください。",
                      ...((c.sheetNotes?.later ?? []).length > 0 ? [`診療年月より前の版のマスターを持っていないので、後の版で代えています：${c.sheetNotes!.later.join("、")}。名称や区分番号は、診療年月の後に変わっていることがあります。`] : []),
                      ...((c.sheetNotes?.newer ?? []).length > 0 ? [`読み方を確かめた版より新しいデータです：${c.sheetNotes!.newer.join("、")}。`] : []),
                    ]}
                  />
                  {/* その組の G05 の指摘がない（押して条件に当たるにした）組だけ、ここに出す（指摘があれば、指摘のカードの中。design.md §14-4） */}
                  {!trial && returnsOutside(check?.localReturns ?? [], c.generic.findings.filter((f) => f.check === "G05").map((f) => f.localPair)).map((p) => <LocalReturn key={`${p.a}:${p.b}:${p.tani}`} claimId={c.claimId} pair={p} names={{ a: rowName(p.a), b: rowName(p.b) }} onSaved={() => setTick((t) => t + 1)} />)}
                </>
              )}

              {!trial && (
                <>
                  <Torikawasure data={check?.torikawasure} claimId={claimId} chartHref="#chart-fixes" />
                  <RecordPaste claimId={c.claimId} yearMonth={c.yearMonth} onSaved={() => setTick((t) => t + 1)} />
                  {/* 貼って確かめたカルテの処方の日の印・「同じ／違う」を付け直す（design.md §16-7。C-441） */}
                  <ConfirmedFixes claimId={c.claimId} tick={tick} />
                </>
              )}

              <h3 style={{ margin: 0 }}>情報不足</h3>
              {missing.length === 0 && <p className="muted" style={{ margin: 0 }}>確かめる点はありません。</p>}
              {groupMissing(missing).map(({ finding: f, ruleIds, lineRefs }, i) => (
                <div key={i} className="notice">
                  {ruleIds.map((id) => <span key={id} className="badge" style={{ marginRight: 4 }}>{id}</span>)} {findingText(f)}
                  {lineRefs.length > 0 && <div className="muted">対象の行：{lineRefs.map(nameOf).join("、")}</div>}
                  <FactInput claimId={c.claimId} finding={f} patientHref="/work" patientInline onSaved={() => setTick((t) => t + 1)} />
                </div>
              ))}
              {stoppedGroups.length > 0 && (
                <div className="notice">
                  <strong>対象外の行に左右されるルール</strong>
                  <div className="muted">次のルールは、行の有無や回数で決まる点を決めていません（指摘がなくても、問題なしとは言えません）。ここにないルールは、対象外の行と関係がないので、今までどおり点検しています。</div>
                  {stoppedGroups.map((g, i) => (
                    <div key={i}>
                      {g.ruleIds.map((id) => <span key={id} className="badge" style={{ marginRight: 4 }}>{id}</span>)}
                      {g.all
                        ? "マスターが入っていない（か、ルールの読む行の区分番号を引けない）ので、対象外の行が 1 行でもあれば、どのルールもこの扱いにしています。"
                        : g.codes.map((x) => (x.known ? `${coded(x.code)} が、ルールの読む行と同じ区分番号です。` : `${x.code} は、マスターにないコードです（何の行か分かりません）。`)).join("")}
                    </div>
                  ))}
                </div>
              )}
              <CheckedFacts claimId={c.claimId} tick={tick} onSaved={() => setTick((t) => t + 1)} />

              <h3 style={{ margin: 0 }}>レセプトの行（{rows.length} 単位）</h3>
              <p className="muted" style={{ margin: 0 }}>UKE に書いてある全部の行を、単位の並びのまま出しています。コード・点数・回数・日は UKE のままです（名称と区分番号は{c.names ? "マスターのもの。マスターにないコードは版の表の名称、どちらにもなければコードだけ" : "版の表のもの。マスターが入っていないので、版の表にないコードはコードだけ"}）。「点検」の列は、その単位を見た点検です。「減点」の印の行は、点数を請求の合計から引く行です。</p>
              <table className="emr-table">
                <thead>
                  <tr><th>区分番号</th><th>名称</th><th>回数</th><th>日</th><th>点数（1 回分）</th><th>点検</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const m = marksOf(r);
                    return (
                      <tr key={r.unit} id={`uke-unit-${r.unit}`}>
                        <td>{r.items.map((it, n) => <div key={n}>{it.no ?? "—"}</div>)}</td>
                        <td>{r.deduction && <span className="badge warn">減点</span>}{r.items.map((it, n) => <div key={n}>{it.name ?? it.code}{kijunMark(c.names?.items[it.code])}</div>)}</td>
                        <td>{r.count}</td>
                        <td>{days(r.dates)}</td>
                        <td>{r.deduction ? `−${num(r.points)}` : num(r.points)}</td>
                        <td>
                          <span className="muted">{CHECKED_BY[r.checkedBy]}</span>
                          {m.hand !== "" && <div><a href="#yusti-findings" className="badge warn">ユスティ：{m.hand}</a></div>}
                          {m.conditional > 0 && <div><a href="#yusti-findings" className="badge">ユスティ：条件つき {m.conditional}</a></div>}
                          {m.generic !== "" && <div><a href="#generic-findings" className="badge">データ：{m.generic}</a></div>}
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && <tr><td colSpan={6} className="muted">行はありません。</td></tr>}
                </tbody>
              </table>
              <div className={`notice ${others.length > 0 ? "warn" : "ok"}`}>
                <strong>手書きのルールで点検した行の小計{trial ? "（この版の点数）" : ""}：{pts(c.subtotal)}　／　UKE に書いてある合計：{pts(c.declared?.ho)}</strong>
                {(c.declared?.ko ?? []).map((k, i) => <div key={i}>公費 {i + 1}：{pts(k)}</div>)}
                {others.length > 0 && <div>小計は、手書きのルールの区分に引けない行（{c.otherRows} 行）を含みません。請求の合計は「UKE に書いてある合計」です。</div>}
                {recalc && <div>データで動く点検の検算：点数の書いてある {recalc.units} 単位のうち、再計算できた {recalc.checked} 単位、UKE の点数と合った {recalc.matched} 単位。</div>}
              </div>

              <h3 style={{ margin: 0 }}>摘要欄の記載</h3>
              <p className="muted" style={{ margin: 0 }}>{COMMENT_CHECK_NOTE}</p>
              {(c.comments ?? []).length === 0 ? <p className="muted" style={{ margin: 0 }}>コメントはありません。</p> : (
                <table className="emr-table">
                  <thead>
                    <tr><th>コメントコード</th>{c.names && <th>名称（定型文）</th>}<th>文字データ</th></tr>
                  </thead>
                  <tbody>
                    {(c.comments ?? []).map((x, i) => <tr key={i}><td>{x.code}</td>{c.names && <td>{c.names.comments[x.code] ?? "—"}</td>}<td>{x.text}</td></tr>)}
                  </tbody>
                </table>
              )}

              <h3 style={{ margin: 0 }}>傷病名</h3>
              {(c.diseases ?? []).length === 0 ? <p className="muted" style={{ margin: 0 }}>傷病名はありません。</p> : (
                <table className="emr-table">
                  <thead>
                    <tr><th>傷病名コード</th><th>名称</th><th>主傷病</th></tr>
                  </thead>
                  <tbody>
                    {(c.diseases ?? []).map((d, i) => <tr key={i}><td>{d.code}</td><td>{d.name ?? "—（名称を出せません）"}</td><td>{d.main ? "主" : ""}</td></tr>)}
                  </tbody>
                </table>
              )}

              {!trial && (
                <>
                  <h3 style={{ margin: 0 }}>患者情報の指摘</h3>
                  {(c.patientFindings ?? []).length === 0 && <p className="muted" style={{ margin: 0 }}>確かめる点はありません。</p>}
                  {(c.patientFindings ?? []).map((f, i) => (
                    <div key={i} className="notice warn"><span className="badge">{f.kind}</span> {f.text}</div>
                  ))}
                  {check?.reviewed !== undefined && (
                    <div className="notice">
                      {check.reviewed ? (
                        <span>この請求の点検を確かめました（{days([check.reviewed.at.slice(0, 10)])}）。あなたの処理件数に数えています。</span>
                      ) : (
                        <>
                          <div className="muted">ここまでの点検を確かめたら押してください。あなたの処理件数に 1 件数えます（同じ請求は 1 回だけ。指摘の数や結果では数えません）。</div>
                          <span><button onClick={() => void sendReviewed()}>この請求の点検を確かめた</button> {reviewMsg && <span className="notice warn">{reviewMsg}</span>}</span>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}
