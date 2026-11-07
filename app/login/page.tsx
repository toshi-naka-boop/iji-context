"use client";
// ログイン・登録（spec FR-72）。登録は誰でもできる。登録するとその人専用のクリニック（合成データ）が用意される（FR-73）
import { useState } from "react";

export default function Login() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [login, setLogin] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "login" ? { login, password } : { login, name, password }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "エラー");
      window.location.href = "/work";
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <div className="phone" style={{ marginTop: 48 }}>
        <h1 style={{ margin: 0 }}>レセメン</h1>
        <p className="muted" style={{ marginTop: 0 }}>医療事務一人ひとりに、隣で働く同僚としての AI メンターを。</p>
        <div className="chips" role="tablist">
          <button role="tab" aria-selected={mode === "login"} className={mode === "login" ? "primary" : ""} onClick={() => setMode("login")}>ログイン</button>
          <button role="tab" aria-selected={mode === "register"} className={mode === "register" ? "primary" : ""} onClick={() => setMode("register")}>はじめて使う</button>
        </div>
        <form onSubmit={submit} className="chart-field" style={{ gap: 10 }}>
          <label className="chart-field">
            <span>ログイン ID（英数字と _ . - の 3〜32 文字）</span>
            <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required />
          </label>
          {mode === "register" && (
            <label className="chart-field">
              <span>呼ばれたい名前（メンターはこの名前に「さん」を付けて呼びます）</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required />
            </label>
          )}
          <label className="chart-field">
            <span>パスワード{mode === "register" ? "（8 文字以上）" : ""}</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} required />
          </label>
          <button className="primary" type="submit" disabled={busy}>{busy ? "…" : mode === "login" ? "ログイン" : "登録してはじめる"}</button>
        </form>
        {err && <div className="notice warn">{err}</div>}
        {mode === "register" && (
          <p className="muted">登録すると、あなた専用のクリニック（合成データ・架空コード）が用意されます。ほかの人の操作とは混ざりません。実在の患者の情報は入力しないでください。</p>
        )}
      </div>
    </main>
  );
}
