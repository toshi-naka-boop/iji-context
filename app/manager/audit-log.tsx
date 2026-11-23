"use client";
// 監査ログの閲覧（spec FR-140）：事務長だけに出す欄。新しい順。操作の記録と、ログインまわりの記録の 2 つ（API が返すまま）。
// 出すのは日時・操作・対象の id・結果・誰が（役割と利用者 id）・デモの日付（デモのクリニックだけ）だけ。本文と氏名は API にも入っていない
import { useEffect, useState } from "react";
import { ROLE_LABELS, isRole } from "../../src/server/roles";

type LogRow = { id: number; at: string; demoNow: string | null; userId: string; role: string; action: string; target: string | null; result: string };
type AuthRow = { id: number; at: string; event: string; result: string; userId: string | null };
type Kind = "ok" | "denied" | "other";

/** API の件数の上限（src/server/schemas/auth.ts の auditQuery） */
const MAX = 500;
const STEP = 100;
const KIND_LABELS: Record<Kind, string> = { ok: "成功", denied: "拒否", other: "誤り" };
/** 「誤り」の内わけ */
const DETAIL: Record<string, string> = { invalid: "入力", limited: "回数制限", rejected: "受け付けず", error: "サーバー", fail: "失敗" };
const kindOf = (result: string): Kind => (result === "ok" ? "ok" : result === "denied" ? "denied" : "other");
const when = (iso: string) => new Date(iso).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Result({ result }: { result: string }) {
  const k = kindOf(result);
  return (
    <>
      <span className={`badge${k === "ok" ? " ok" : k === "denied" ? " warn" : ""}`}>{KIND_LABELS[k]}</span>
      {k === "other" && DETAIL[result] && <span className="muted"> {DETAIL[result]}</span>}
    </>
  );
}

export function AuditLog() {
  const [show, setShow] = useState(false);
  const [limit, setLimit] = useState(STEP);
  const [data, setData] = useState<{ log: LogRow[]; auth: AuthRow[] } | null>(null);
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [err, setErr] = useState("");
  // 実在のデータで使うクリニックでは、デモの日付の欄を出さない（日時と同じ日になる）
  const [demo, setDemo] = useState(false);
  // 事務長でなければ、欄を出さず、ログも取りにいかない（サーバー側でも断る）
  useEffect(() => {
    fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).then((u) => setShow(u?.role === "manager")).catch(() => {});
    fetch("/api/clock").then((r) => (r.ok ? r.json() : null)).then((d) => setDemo(d?.kind === "demo")).catch(() => {});
  }, []);
  useEffect(() => {
    if (!show) return;
    fetch(`/api/audit?limit=${limit}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "エラー");
        setErr("");
        setData(d);
      })
      .catch((e: Error) => setErr(e.message));
  }, [show, limit]);
  if (!show) return null;
  const pass = (r: { result: string }) => filter === "all" || kindOf(r.result) === filter;
  const log = data?.log.filter(pass) ?? [];
  const auth = data?.auth.filter(pass) ?? [];
  const full = !!data && (data.log.length >= limit || data.auth.length >= limit);
  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <h3 style={{ marginTop: 0 }}>操作の記録（監査ログ）</h3>
      <p className="muted">誰が・どの操作を・どの対象に・どうなったかを、新しい順に並べています。カルテや回答の本文、氏名は記録していません。</p>
      {err && <div className="notice warn">{err}</div>}
      <div className="chips" role="radiogroup" aria-label="結果で絞り込む" style={{ marginBottom: 8 }}>
        {(["all", "ok", "denied", "other"] as const).map((k) => (
          <button key={k} role="radio" aria-checked={filter === k} className={filter === k ? "primary" : ""} onClick={() => setFilter(k)}>{k === "all" ? "すべて" : KIND_LABELS[k]}</button>
        ))}
      </div>
      {data && (
        <>
          {log.length === 0 ? (
            <p className="muted">当てはまる記録はありません。</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ minWidth: 720 }}>
                <thead>
                  <tr><th>日時</th><th>操作</th><th>対象</th><th>結果</th><th>誰が</th>{demo && <th>デモの日付</th>}</tr>
                </thead>
                <tbody>
                  {log.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td>
                      <td>{r.action}</td>
                      <td style={{ overflowWrap: "anywhere" }}>{r.target ?? ""}</td>
                      <td style={{ whiteSpace: "nowrap" }}><Result result={r.result} /></td>
                      <td>{isRole(r.role) ? ROLE_LABELS[r.role] : r.role}<br /><span className="muted">{r.userId}</span></td>
                      {demo && <td style={{ whiteSpace: "nowrap" }}>{r.demoNow ? r.demoNow.slice(0, 10).replaceAll("-", ".") : ""}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h4 style={{ marginBottom: 4 }}>ログイン・登録・招待・役割の切替・ほかの画面から来て断った操作</h4>
          {auth.length === 0 ? (
            <p className="muted">当てはまる記録はありません。</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ minWidth: 520 }}>
                <thead>
                  <tr><th>日時</th><th>操作</th><th>結果</th><th>誰が</th></tr>
                </thead>
                <tbody>
                  {auth.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td>
                      <td>{r.event}</td>
                      <td style={{ whiteSpace: "nowrap" }}><Result result={r.result} /></td>
                      <td><span className="muted">{r.userId ?? "不明"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {full && limit < MAX && <p><button onClick={() => setLimit(Math.min(MAX, limit + STEP))}>さらに読む</button></p>}
          {full && limit >= MAX && <p className="muted">表示できるのは、新しいほうから {MAX} 件までです。</p>}
        </>
      )}
    </section>
  );
}
