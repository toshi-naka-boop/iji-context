"use client";
// ログイン・登録（spec FR-72）。登録は招待制（FR-137）。招待コードで、招待されたクリニックに入る。
// 招待なしで新しいクリニックを作るときは、「デモで試す」か「実在のデータで使う」かを選ぶ（選ばないと登録できない。後から変えない。2026-11-22 利用者の判断）
import { useState } from "react";
import { TENANT_KINDS, TENANT_KIND_LABELS, TENANT_KIND_NOTES as KIND_NOTES, type TenantKind } from "../../src/server/tenant-kind";
import { Notice } from "../consent";

export default function Login() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [login, setLogin] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [kind, setKind] = useState<TenantKind | null>(null);
  /** 招待コードがあれば、招待したクリニックに入る（種類は選ばない） */
  const invited = inviteCode.trim() !== "";
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (mode === "register" && !invited && !kind) return setErr("「デモで試す」か「実在のデータで使う」かを選んでください");
    setBusy(true);
    try {
      const r = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "login" ? { login, password } : invited ? { login, name, password, inviteCode: inviteCode.trim() } : { login, name, password, kind: kind ?? undefined }),
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
        <Notice />
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
          {mode === "register" && !invited && (
            <fieldset className="chart-field" style={{ border: "none", padding: 0, margin: 0 }}>
              <legend>新しいクリニックの使い方（作ったあとは変えられません）</legend>
              {TENANT_KINDS.map((k) => (
                <label key={k} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                  <span><strong>{TENANT_KIND_LABELS[k]}</strong><br /><span className="muted">{KIND_NOTES[k]}</span></span>
                </label>
              ))}
            </fieldset>
          )}
          <button className="primary" type="submit" disabled={busy}>{busy ? "…" : mode === "login" ? "ログイン" : "登録してはじめる"}</button>
        </form>
        {err && <div className="notice warn">{err}</div>}
        {mode === "register" && (
          <p className="muted">招待コードで登録すると、招待されたクリニックに入ります（クリニックの使い方は、招待したクリニックのものになります）。ほかのクリニックの操作とは混ざりません。同梱のデータは合成データです。</p>
        )}
      </div>
    </main>
  );
}
