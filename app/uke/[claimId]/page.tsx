"use client";
// 取り込んだレセプトの点検（design.md §11-11・§11-13）：UKE に書いてあるとおりのまま（行もコメントも入れ替えずに）点検した結果を見せる。
// 上から：注意の帯 → 指摘（記載もれを含む。種類ごと）→ 情報不足 → 点検した行と小計 → 対象外の行 → UKE の合計 → 摘要欄の記載 → 患者情報の指摘。
// 点検は読むだけで、何も記録しない（GET /api/uke/claims/[claimId]/check）。情報不足の項目に残した答えだけが残る（app/fact-input.tsx）。月末の点検（行を入力する問題）とは別の画面。
// 版を替えると試算（design.md §11-12。GET /api/uke/claims/[claimId]/trial?rev=）：選んだ版の点数表とルールで読み、UKE の点数との違いを並べる。
// 診療年月に版がないレセプトは点検できないので、開くと選べる版の最初（コードの表を持つ、いちばん古い版）が選ばれた状態で試算を見せる
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { Finding } from "../../../src/engine/types";
import type { RowNames } from "../../../src/generic/lookup";
import type { GenericView } from "../../../src/generic/view";
import { COMMENT_CHECK_NOTE, findingText } from "../../../src/messages";
import { SignIn, useClerk } from "../../clerk";
import { CheckedFacts, FactInput } from "../../fact-input";
import { GenericFindings } from "../../generic-findings";
import { getJson } from "../../get-json";
import { TopBar } from "../../nav";
import { PageGuide } from "../../page-guide";

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
};
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
/** 入力では消えない情報不足（カルテ側の記録がない・点検の対象外の行がある）。ルールごとに同じ文で返るので、画面では 1 件にまとめる */
const SHARED_MISSING = ["chartRecord", "unsupportedLines"];
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

  if (!ready) return <main className="shell"><TopBar /></main>;
  if (!user) return <main className="shell"><TopBar /><SignIn /></main>;
  const head = check;
  /** 見せる中身：試算していれば試算、していなければ点検（版のないレセプトは、試算が届くまで中身がない） */
  const c = trial ?? (check && check.revisionId !== null ? check : null);
  const findings = c?.findings ?? [];
  const lines = c?.lines ?? [];
  const others = c?.others ?? [];
  const nameOf = (kubun: string) => lines.find((l) => l.kubun === kubun)?.name ?? kubun;
  /** 対象外の行に左右されるルールを、そうさせた行が同じものどうしでまとめる */
  const stoppedGroups: { ruleIds: string[]; all: boolean; codes: Stopped["codes"] }[] = [];
  for (const s of c?.stopped ?? []) {
    const key = (x: { all: boolean; codes: Stopped["codes"] }) => `${x.all}:${x.codes.map((y) => y.code).join(",")}`;
    const same = stoppedGroups.find((g) => key(g) === key(s));
    if (same) same.ruleIds.push(s.ruleId);
    else stoppedGroups.push({ ruleIds: [s.ruleId], all: s.all, codes: s.codes });
  }
  /** コードに、マスターの名称（診療行為は区分番号も）を添える。マスターがない・マスターにないコードは、コードだけ。施設基準のある行には「届出が要ります」と添える（指摘ではない） */
  const coded = (code: string) => {
    const n = c?.names?.items[code];
    return n ? `${code} ${n.name}${n.no ? `（${n.no}）` : ""}${n.todokede ? "　届出が要ります" : ""}` : code;
  };
  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="yusti" title="取り込んだレセプトの点検" tag="RULE ENGINE">
        取り込んだ UKE に書いてあるとおりのまま、決まった規則で点検した結果です。行もコメントも入れ替えていません。点検の結果は記録しません。「情報不足」の項目に、確かめた答えを残すと、その答えだけが残り、点検をやり直します。
      </PageGuide>
      <p style={{ margin: "0 0 12px" }}><a href="/uke">← UKE 取り込みに戻る</a></p>
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
              <div className="notice">カルテ側の記録がないため、記録を読む点検（訪問・処方・退院などの記録で決まる点）はしていません。</div>

              <h3 style={{ margin: 0 }}>ユスティの指摘</h3>
              {trial && !trial.rulesAvailable ? <p className="muted" style={{ margin: 0 }}>この版のルールは持っていません（算定行と点数だけ）。</p> : findings.length === 0 && <p className="muted" style={{ margin: 0 }}>指摘はありません。</p>}
              {(c.commentMissingCount ?? 0) > 0 && <p style={{ margin: 0 }}>記載もれを {c.commentMissingCount} 件見つけました。</p>}
              {KINDS.filter((k) => findings.some((f) => f.kind === k)).map((k) => (
                <div key={k} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {findings.filter((f) => f.kind === k).map((f, i) => (
                    <div key={i} className="notice warn">
                      <span className="badge warn">{f.kind}</span> {findingText(f)}
                      {f.lineRefs.length > 0 && <div className="muted">対象の行：{f.lineRefs.map(nameOf).join("、")}</div>}
                    </div>
                  ))}
                </div>
              ))}

              {c.generic && (
                <>
                  <h3 style={{ margin: 0 }}>データで動く点検</h3>
                  <p className="muted" style={{ margin: 0 }}>公開されているマスターで、全部の行（点検の対象外の行も）を点検します。「条件つき」は、言い切れない指摘です。打ち間違いや、マスターの更新もれがないかを確かめてください。</p>
                  <GenericFindings generic={c.generic} scope="full" />
                  {(c.sheetNotes?.later ?? []).length > 0 && <p className="muted" style={{ margin: 0 }}>診療年月より前の版のマスターを持っていないので、後の版で代えています：{c.sheetNotes!.later.join("、")}。名称や区分番号は、診療年月の後に変わっていることがあります。</p>}
                  {(c.sheetNotes?.newer ?? []).length > 0 && <p className="muted" style={{ margin: 0 }}>読み方を確かめた版より新しいデータです：{c.sheetNotes!.newer.join("、")}。</p>}
                </>
              )}

              <h3 style={{ margin: 0 }}>情報不足</h3>
              {(c.missing ?? []).length === 0 && <p className="muted" style={{ margin: 0 }}>確かめる点はありません。</p>}
              {groupMissing(c.missing ?? []).map(({ finding: f, ruleIds, lineRefs }, i) => (
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

              <h3 style={{ margin: 0 }}>点検した行</h3>
              <table className="emr-table">
                <thead>
                  <tr><th>区分</th><th>名称</th><th>回数</th><th>日</th><th>点数</th><th>小計</th></tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.no}</td>
                      <td>{l.name}</td>
                      <td>{l.count}</td>
                      <td>{days(l.dates)}</td>
                      <td>{l.points === null ? "—" : num(l.points)}</td>
                      <td>{l.points === null ? "—" : num(l.points * l.count)}</td>
                    </tr>
                  ))}
                  {lines.length === 0 && <tr><td colSpan={6} className="muted">点検した行はありません。</td></tr>}
                </tbody>
              </table>
              <div className="notice">
                <strong>点検した行の小計{trial ? "（この版の点数）" : ""}：{pts(c.subtotal)}</strong>
                {others.length > 0 && <div>対象外の行を含まない小計です。請求の合計は、下の「UKE に書いてある合計」です。</div>}
              </div>

              {others.length > 0 && (
                <>
                  <h3 style={{ margin: 0 }}>点検の対象外の行（{c.otherRows} 行）</h3>
                  <p className="muted" style={{ margin: 0 }}>対応していないコードを含む算定の単位です。UKE に書いてあるコード・点数・回数・日をそのまま出しています（{c.names ? "名称と区分番号は、マスターのものです。マスターにないコードは、コードだけを出します" : "マスターが入っていないので、名称は出せません"}）。</p>
                  <table className="emr-table">
                    <thead>
                      <tr><th>コード{c.names ? "・名称" : ""}</th><th>回数</th><th>日</th><th>点数（1 回分）</th></tr>
                    </thead>
                    <tbody>
                      {others.map((o, i) => (
                        <tr key={i}>
                          <td>{c.names ? o.codes.map((code, n) => <div key={n}>{coded(code)}</div>) : o.codes.join("、")}</td>
                          <td>{o.count}</td>
                          <td>{days(o.dates)}</td>
                          <td>{o.points === null ? "—" : num(o.points)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <div className={`notice ${others.length > 0 ? "warn" : "ok"}`}>
                <strong>UKE に書いてある合計：{pts(c.declared?.ho)}</strong>
                {(c.declared?.ko ?? []).map((k, i) => <div key={i}>公費 {i + 1}：{pts(k)}</div>)}
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
                </>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}
