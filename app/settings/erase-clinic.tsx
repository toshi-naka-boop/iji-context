"use client";
// クリニックをまるごと消す（採点 r1 事務長 #8）：クリニックの持ち主にだけ、設定の画面が出す欄。デモでも実在のデータでも使う。
// 2 段で確かめる：①消すもの・消せないものを読んで「AI のサービスに送った内容は消せない」に印を付ける → ②自分のログイン ID とパスワードを打ち込んで消す（サーバーでも照合する）
import { useState } from "react";

export function EraseClinic({ login }: { login: string }) {
  const [open, setOpen] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function erase() {
    setErr("");
    setBusy(true);
    try {
      const r = await fetch("/api/tenant/erase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: typed, password }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setErr(d.error ?? "消せませんでした");
      window.location.href = "/";
    } catch {
      setErr("通信できませんでした。もう一度試してください");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  return (
    <div className="panel" style={{ margin: "16px 0" }}>
      <h3 style={{ marginTop: 0 }}>クリニックを消す</h3>
      <p className="muted">使うのをやめるときに、このクリニックのデータをまるごと消します。消せるのはクリニックの持ち主だけで、元に戻せません。</p>
      {!open ? (
        <p><button onClick={() => setOpen(true)}>クリニックを消す手続きに進む</button></p>
      ) : (
        <div className="notice warn">
          <strong>消すもの</strong>
          <ul style={{ margin: "4px 0 8px" }}>
            <li>このクリニックの全員のアカウント（ログインできなくなります）・招待</li>
            <li>取り込んだ UKE と査定・返戻のファイル、点検の記録、患者情報、訪問カルテ、医師確認、ベテランへの問い</li>
            <li>院内の知識・レセメン会議の記録・施設の申告・監査ログ</li>
            <li>メンターとのやり取り（このサーバーに残っているセッションの記録）</li>
          </ul>
          <strong>消せないもの</strong>
          <ul style={{ margin: "4px 0 8px" }}>
            <li>AI のサービス（Anthropic）と音声のサービス（ElevenLabs）に送った内容。保持の期間と扱いは、各サービスの規約によります</li>
            <li>ログインまわりの記録（いつ・誰の id が・何をしたか。名前・パスワードは入っていません）</li>
          </ul>
          <label style={{ display: "block", margin: "8px 0" }}>
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> 消すもの・消せないものを読みました。元に戻せないことを確かめました
          </label>
          {understood && (
            <div style={{ margin: "8px 0" }}>
              <label>
                確かめのため、あなたのログイン ID（{login}）を入れてください：
                <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="確かめのログイン ID" autoComplete="off" style={{ marginLeft: 4 }} />
              </label>
              <br />
              <label>
                あなたのパスワード：
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="確かめのパスワード" autoComplete="current-password" style={{ marginLeft: 4 }} />
              </label>
            </div>
          )}
          {err && <div className="notice warn">{err}</div>}
          <div className="chips">
            <button className="primary" disabled={!understood || typed !== login || password === "" || busy} onClick={erase}>{busy ? "消しています…" : "このクリニックをまるごと消す"}</button>
            <button onClick={() => { setOpen(false); setUnderstood(false); setTyped(""); setPassword(""); setErr(""); }} disabled={busy}>やめる</button>
          </div>
        </div>
      )}
    </div>
  );
}
