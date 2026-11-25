"use client";
// パスワード（採点 r2 事務長 #4）：自分のパスワードを変える欄（設定の画面）と、仮のパスワードでログインした人にどの画面にも出す欄。
// 仮のパスワードのあいだは、ほかの操作をサーバーが断る（src/server/http.ts）。閉じるボタンは置かない
import { useEffect, useState } from "react";

/** 今のパスワード（仮のパスワードを含む）と新しいパスワードを入れて変える。変えたら onDone を呼ぶ */
export function ChangePassword({ temporary, onDone }: { temporary: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  async function change() {
    setErr("");
    setOk("");
    if (next !== again) return setErr("新しいパスワードが、確かめの欄と違います");
    setBusy(true);
    try {
      const r = await fetch("/api/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ current, next }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setErr(d.error ?? "変えられませんでした");
      setOk("パスワードを変えました。ほかの端末のログインは切れています");
      onDone();
    } catch {
      setErr("通信できませんでした。もう一度試してください");
    } finally {
      setCurrent("");
      setNext("");
      setAgain("");
      setBusy(false);
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 360 }}>
      <label>{temporary ? "仮のパスワード" : "今のパスワード"}<br /><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" style={{ width: "100%" }} /></label>
      <label>新しいパスワード（8 文字以上）<br /><input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" style={{ width: "100%" }} /></label>
      <label>新しいパスワード（確かめ）<br /><input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" style={{ width: "100%" }} /></label>
      {err && <div className="notice warn">{err}</div>}
      {ok && <div className="notice ok">{ok}</div>}
      <div><button className="primary" onClick={change} disabled={busy || current === "" || next === ""}>{busy ? "…" : "パスワードを変える"}</button></div>
    </div>
  );
}

/** 仮のパスワードでログインしている人に、どの画面にも出す */
export function PasswordGate() {
  const [must, setMust] = useState(false);
  useEffect(() => {
    // ログインしていなければ 401（ログインの画面など）。何も出さない
    fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).then((u) => setMust(u?.mustChangePassword === true)).catch(() => {});
  }, []);
  if (!must) return null;
  return (
    <div className="consent-overlay" role="dialog" aria-modal="true" aria-label="パスワードを変える">
      <div className="panel consent-panel">
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>自分のパスワードに変えてください</h2>
        <p className="muted">事務長が発行した仮のパスワードでログインしています。自分のパスワードに変えるまで、ほかの操作はできません。</p>
        {/* 断られた読み込みをやり直すため、変えたら画面を読み込み直す */}
        <ChangePassword temporary onDone={() => window.location.reload()} />
      </div>
    </div>
  );
}
