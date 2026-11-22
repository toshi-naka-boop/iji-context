"use client";
// 使い方が未定のクリニック（種類を持つ前に作られたもの）で、どの画面にも出す（2026-11-22 利用者の判断）。
// 事務長（1 人で使っているクリニックは持ち主）には、一度だけ「デモで試す／実在のデータで使う」を選ぶ画面を出す。ほかの人には「お待ちください」を出す。
// 閉じるボタンは置かない（使い方が決まるまで、点検などの操作はサーバーでも断る。src/server/http.ts）
import { useEffect, useState } from "react";
import { TENANT_KINDS, TENANT_KIND_LABELS, TENANT_KIND_NOTES, type TenantKind } from "../src/server/tenant-kind";

export function TenantKindGate() {
  const [state, setState] = useState<{ undecided: boolean; canChoose: boolean }>({ undecided: false, canChoose: false });
  const [kind, setKind] = useState<TenantKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    // ログインしていなければ 401（ログインの画面など）。何も出さない
    fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).then((u) => { if (u?.tenantKind === "undecided") setState({ undecided: true, canChoose: u.canChooseKind === true }); }).catch(() => {});
  }, []);
  async function choose() {
    if (!kind) return setErr("「デモで試す」か「実在のデータで使う」かを選んでください");
    if (!window.confirm(`このクリニックを「${TENANT_KIND_LABELS[kind]}」にします。あとから変えられません。よろしいですか？`)) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/tenant/kind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) });
      const d = await r.json().catch(() => null);
      if (!r.ok) return setErr(d?.error ?? "選べませんでした。時間をおいて、もう一度試してください");
      // 断られた読み込みをやり直すため、画面を読み込み直す
      window.location.reload();
    } catch {
      setErr("選べませんでした。通信の状態を確かめて、もう一度試してください");
    } finally {
      setBusy(false);
    }
  }
  if (!state.undecided) return null;
  return (
    <div className="consent-overlay" role="dialog" aria-modal="true" aria-label="クリニックの使い方">
      <div className="panel consent-panel">
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>このクリニックの使い方を選んでください</h2>
        {state.canChoose ? (
          <>
            <p className="muted">このクリニックは、使い方を選ぶ前に作られました。一度だけ選びます（あとから変えられません）。選ぶまでは、点検などの操作はできません。</p>
            {TENANT_KINDS.map((k) => (
              <label key={k} style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "8px 0" }}>
                <input type="radio" name="tenant-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                <span><strong>{TENANT_KIND_LABELS[k]}</strong><br /><span className="muted">{TENANT_KIND_NOTES[k]}</span></span>
              </label>
            ))}
            {err && <div className="notice warn">{err}</div>}
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <button className="primary" onClick={choose} disabled={busy}>{busy ? "…" : "この使い方にする"}</button>
            </div>
          </>
        ) : (
          <p>事務長がこのクリニックの使い方を選ぶまでお待ちください。選ぶまでは、点検などの操作はできません。</p>
        )}
      </div>
    </div>
  );
}
