"use client";
// 取り込んだレセプトの点検（design.md §11-11・§11-13）：UKE に書いてあるとおりのまま（行もコメントも入れ替えずに）点検した結果を見せる。
// 上から：注意の帯 → 指摘（記載もれを含む。種類ごと）→ 情報不足 → 点検した行と小計 → 対象外の行 → UKE の合計 → 摘要欄の記載 → 患者情報の指摘。
// 読むだけで、何も記録しない（GET /api/uke/claims/[claimId]/check）。月末の点検（行を入力する問題）とは別の画面
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { Finding } from "../../../src/engine/types";
import { COMMENT_CHECK_NOTE, findingText } from "../../../src/messages";
import { SignIn, useClerk } from "../../clerk";
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
};

const num = (n: number) => n.toLocaleString("ja-JP");
const pts = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${num(n)} 点`);
const days = (dates: string[]) => [...new Set(dates)].map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`).join("、");
/** 指摘を出す順（種類ごと） */
const KINDS = ["背反", "区分誤り", "要件不足", "不一致", "取り忘れ", "記載もれ"];

export default function UkeClaimCheck() {
  const { clerk: user, ready } = useClerk();
  const { claimId } = useParams<{ claimId: string }>();
  const [check, setCheck] = useState<Check | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!user) return;
    getJson<Check>(`/api/uke/claims/${encodeURIComponent(claimId)}/check`).then(setCheck).catch((e: Error) => setErr(e.message));
  }, [user, claimId]);

  if (!ready) return <main className="shell"><TopBar /></main>;
  if (!user) return <main className="shell"><TopBar /><SignIn /></main>;
  const c = check;
  const findings = c?.findings ?? [];
  const lines = c?.lines ?? [];
  const others = c?.others ?? [];
  const nameOf = (kubun: string) => lines.find((l) => l.kubun === kubun)?.name ?? kubun;
  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="yusti" title="取り込んだレセプトの点検" tag="RULE ENGINE">
        取り込んだ UKE に書いてあるとおりのまま、決まった規則で点検した結果です。行もコメントも入れ替えていません。何も記録しません。
      </PageGuide>
      <p style={{ margin: "0 0 12px" }}><a href="/uke">← UKE 取り込みに戻る</a></p>
      {err && <div className="notice warn">{err}</div>}
      {c && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>
            {c.claimId} {c.patient}{c.patientNo ? `（患者の番号 ${c.patientNo}）` : ""}　<span className="muted">診療年月 {c.yearMonth}</span>
          </h2>
          {c.unreadable ? (
            <div className="notice warn">
              <strong>このレセプトは、いまは点検できません。</strong>
              <div>{c.unreadable.reason}</div>
            </div>
          ) : (
            <>
              {others.length > 0 && (
                <div className="notice warn">
                  <strong>この請求には、点検の対象外の行が {c.otherRows} 行あります。</strong>
                  <div>対応していないコードを含む行は、点検していません。ほかの行の有無や回数で決まる点は「決められません」と出し、下の小計は請求の合計ではありません。</div>
                </div>
              )}
              <div className="notice">カルテ側の記録がないため、記録を読む点検（訪問・処方・退院などの記録で決まる点）はしていません。</div>

              <h3 style={{ margin: 0 }}>ユスティの指摘</h3>
              {findings.length === 0 && <p className="muted" style={{ margin: 0 }}>指摘はありません。</p>}
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

              <h3 style={{ margin: 0 }}>情報不足</h3>
              {(c.missing ?? []).length === 0 && <p className="muted" style={{ margin: 0 }}>確かめる点はありません。</p>}
              {(c.missing ?? []).map((f, i) => (
                <div key={i} className="notice">
                  <span className="badge">{f.ruleId}</span> {findingText(f)}
                  {f.lineRefs.length > 0 && <div className="muted">対象の行：{f.lineRefs.map(nameOf).join("、")}</div>}
                </div>
              ))}

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
                <strong>点検した行の小計：{pts(c.subtotal)}</strong>
                {others.length > 0 && <div>対象外の行を含まない小計です。請求の合計は、下の「UKE に書いてある合計」です。</div>}
              </div>

              {others.length > 0 && (
                <>
                  <h3 style={{ margin: 0 }}>点検の対象外の行（{c.otherRows} 行）</h3>
                  <p className="muted" style={{ margin: 0 }}>対応していないコードを含む算定の単位です。UKE に書いてあるコード・点数・回数・日をそのまま出しています（名称は持っていません）。</p>
                  <table className="emr-table">
                    <thead>
                      <tr><th>コード</th><th>回数</th><th>日</th><th>点数（1 回分）</th></tr>
                    </thead>
                    <tbody>
                      {others.map((o, i) => (
                        <tr key={i}>
                          <td>{o.codes.join("、")}</td>
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
                    <tr><th>コメントコード</th><th>文字データ</th></tr>
                  </thead>
                  <tbody>
                    {(c.comments ?? []).map((x, i) => <tr key={i}><td>{x.code}</td><td>{x.text}</td></tr>)}
                  </tbody>
                </table>
              )}

              <h3 style={{ margin: 0 }}>患者情報の指摘</h3>
              {(c.patientFindings ?? []).length === 0 && <p className="muted" style={{ margin: 0 }}>確かめる点はありません。</p>}
              {(c.patientFindings ?? []).map((f, i) => (
                <div key={i} className="notice warn"><span className="badge">{f.kind}</span> {f.text}</div>
              ))}
            </>
          )}
        </section>
      )}
    </main>
  );
}
