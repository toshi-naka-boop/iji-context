"use client";
// ログイン・登録（spec FR-72）。登録は招待制（FR-137）。招待コードで、招待されたクリニックに入る
import { useState } from "react";

export default function Login() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [login, setLogin] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
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
        body: JSON.stringify(mode === "login" ? { login, password } : { login, name, password, inviteCode: inviteCode.trim() || undefined }),
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
    <main className="login-page">
      {/* 左：レセメンとユスティ。幅の狭い画面では絵を小さくする（2026-11-08 案 C+） */}
      <section className="login-hero" aria-label="レセメン">
        <div className="hud-tag">RESEMEN</div>
        <h1>レセメン</h1>
        <p>医療事務一人ひとりに、隣で働く同僚としての AI メンターを。</p>
        <div className="login-cast">
          {["makki", "black-hair", "bob", "suit"].map((c) => <img key={c} src={`/characters/${c}-select.png`} alt="" />)}
          <img className="rule" src="/characters/yusti.png" alt="ユスティ" />
        </div>
      </section>
      <div className="login-card">
        <h2 style={{ margin: 0 }}>{mode === "login" ? "ログイン" : "はじめて使う"}</h2>
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
          {mode === "register" && (
            <label className="chart-field">
              <span>招待コード（事務長から受け取ったもの）</span>
              <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} maxLength={64} autoComplete="off" />
            </label>
          )}
          <button className="primary" type="submit" disabled={busy}>{busy ? "…" : mode === "login" ? "ログイン" : "登録してはじめる"}</button>
        </form>
        {err && <div className="notice warn">{err}</div>}
        {mode === "register" && (
          <p className="muted">招待コードで登録すると、招待されたクリニック（合成データ・架空コード）に入ります。ほかのクリニックの操作とは混ざりません。実在の患者の情報は入力しないでください。</p>
        )}
      </div>
    </main>
  );
}
