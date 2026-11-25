"use client";
// 取り込んだレセプトの全件の一覧（採点 r1 医療事務課長 P1-1）：月末に、何件に確定の指摘があり、何件が残っているかを 1 画面で見る。
// 件数は UKE に書いてあるとおりの点検（/uke/[claimId]）と同じ数え方。行の「開く」から、その請求の点検へ進む（GET /api/uke/summary。読むだけ）
import { useEffect, useState } from "react";
import { getJson } from "../get-json";

type Row = { claimId: string; label: string; patient: string; patientNo: string | null; state: "checked" | "unreadable" | "noRevision"; confirmed: number; conditional: number; missing: number; unchecked: number; patientFindings: number; reviewed?: boolean };

const STATE: Record<Row["state"], string> = { checked: "点検しました", unreadable: "読めません（点検していません）", noRevision: "版がありません（試算だけ）" };

/** tick が変わるたびに読み直す（取り込み・消したあと） */
export function ClaimsSummary({ tick }: { tick: unknown }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<Row[]>("/api/uke/summary").then(setRows).catch((e: Error) => setErr(e.message));
  }, [tick]);
  if (err) return <div className="notice warn">全件の一覧を読めませんでした：{err}</div>;
  if (!rows || rows.length === 0) return null;
  const real = rows.some((r) => r.reviewed !== undefined);
  const sum = (k: "confirmed" | "conditional" | "missing" | "unchecked" | "patientFindings") => rows.reduce((s, r) => s + r[k], 0);
  const withConfirmed = rows.filter((r) => r.confirmed > 0).length;
  const withPatient = rows.filter((r) => r.patientFindings > 0).length;
  return (
    <section className="card" style={{ margin: "0 0 16px" }}>
      <div className="card-body">
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>取り込んだレセプトの全件（{rows.length} 件）</h2>
        <p className="muted" style={{ margin: "0 0 8px" }}>
          UKE に書いてあるとおりに点検した結果の件数です。確定の指摘があるレセプト {withConfirmed} 件。患者情報の指摘（保険者番号など。ユスティの指摘とは別に数えます）があるレセプト {withPatient} 件。
          「見ていない行」は、どの点検も見ていない行の数です（指摘がなくても、問題なしとは言えません）。{real ? "「確かめ済み」は、あなたが「この請求の点検を確かめた」を押したレセプトです。" : ""}
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ minWidth: 640 }}>
            <thead>
              <tr><th>請求</th><th>患者</th><th>状態</th><th>確定</th><th>条件つき</th><th>情報不足</th><th>見ていない行</th><th>患者情報</th>{real && <th>確かめ済み</th>}<th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.claimId}>
                  <td className="num">{r.label}</td>
                  <td>{r.patient}{r.patientNo ? `（${r.patientNo}）` : ""}</td>
                  <td>{STATE[r.state]}</td>
                  <td className="num">{r.state === "checked" ? r.confirmed : "－"}</td>
                  <td className="num">{r.state === "checked" ? r.conditional : "－"}</td>
                  <td className="num">{r.state === "checked" ? r.missing : "－"}</td>
                  <td className="num">{r.state === "checked" ? r.unchecked : "－"}</td>
                  <td className="num">{r.state === "checked" ? r.patientFindings : "－"}</td>
                  {real && <td>{r.reviewed ? "済み" : "まだ"}</td>}
                  <td><a href={`/uke/${encodeURIComponent(r.claimId)}`}>開く →</a></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><th colSpan={3}>合計</th><th className="num">{sum("confirmed")}</th><th className="num">{sum("conditional")}</th><th className="num">{sum("missing")}</th><th className="num">{sum("unchecked")}</th><th className="num">{sum("patientFindings")}</th>{real && <th>{rows.filter((r) => r.reviewed).length} / {rows.length}</th>}<th></th></tr>
            </tfoot>
          </table>
        </div>
      </div>
    </section>
  );
}
