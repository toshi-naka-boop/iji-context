"use client";
// 注意書きと、同意の画面（design.md §11-11）。文は config/notice.json の 1 か所。
// Notice：入力欄の上に出す注意書き（ログイン・UKE の取り込み・カルテを書く・通知の取り込み）。
// ConsentGate：どの画面にも 1 つ置く。API が「同意がまだ」（403 と consent の印）を返したら、注意書きと「同意する」を出す
import { useEffect, useState } from "react";
import NOTICE from "../config/notice.json";

/** 注意書きの本文 */
export function Notice() {
  return (
    <div className="notice warn" role="note" aria-label="注意書き">
      <strong>{NOTICE.lead}</strong>
      <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
        {NOTICE.body.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  );
}

/** 応答が「注意書きへの同意がまだ」か（src/server/http.ts が 403 と一緒に返す印） */
async function needsConsent(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const d = await res.clone().json().catch(() => null);
  return d?.consent === "required";
}

export function ConsentGate() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    // 画面のどの操作で断られても同じ画面を出せるよう、API の応答をここで 1 か所だけ見る（応答そのものは変えない）
    const original = window.fetch;
    window.fetch = async (...args) => {
      const res = await original(...args);
      if (await needsConsent(res)) setOpen(true);
      return res;
    };
    return () => {
      window.fetch = original;
    };
  }, []);
  async function accept() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: NOTICE.version }) });
      const d = await r.json().catch(() => null);
      if (!r.ok) return setErr(d?.error ?? "同意を記録できませんでした。時間をおいて、もう一度試してください");
      // 断られた読み込みをやり直すため、画面を読み込み直す
      window.location.reload();
    } catch {
      setErr("同意を記録できませんでした。通信の状態を確かめて、もう一度試してください");
    } finally {
      setBusy(false);
    }
  }
  if (!open) return null;
  return (
    <div className="consent-overlay" role="dialog" aria-modal="true" aria-label="注意書きへの同意">
      <div className="panel consent-panel">
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>はじめに確かめてください</h2>
        <Notice />
        <p className="muted">同意すると、患者の情報を扱う操作と、AI・音声を使う操作ができるようになります。同意しないままでも、取り込んだファイルを消すことはできます。</p>
        {err && <div className="notice warn">{err}</div>}
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button onClick={() => setOpen(false)} disabled={busy}>あとで</button>
          <button className="primary" onClick={accept} disabled={busy}>{busy ? "…" : "同意する"}</button>
        </div>
      </div>
    </div>
  );
}
