"use client";
// 画面上部の共通ナビ（デモの日付を含む。時刻は出さない：2026-11-07 ユーザー判断）
import Link from "next/link";
import { useEffect, useState } from "react";

export function TopBar({ right }: { right?: React.ReactNode }) {
  const [now, setNow] = useState<string>("");
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState("");
  const [who, setWho] = useState("");
  useEffect(() => {
    fetch("/api/clock").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) { setNow(d.now); setInput(d.now.slice(0, 10)); } });
    fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).then((u) => setWho(u?.name ?? "")).catch(() => {});
  }, []);
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }
  async function advance() {
    // 日付だけを進める（時刻はその日の朝 9 時にそろえる）
    const r = await fetch("/api/clock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ now: `${input}T09:00:00+09:00` }) });
    const d = await r.json();
    if (!r.ok) return setMsg(d.error);
    setNow(d.now);
    setMsg(d.meeting ? "レセメン会議の整理を回しました" : "");
  }
  return (
    <div className="top">
      <nav>
        <strong>レセメン</strong>
        <Link href="/chart">カルテを書く</Link>
        <Link href="/work">算定</Link>
        <Link href="/guide">手引き</Link>
        <Link href="/uke">UKE 取り込み</Link>
        <Link href="/doctor">医師確認</Link>
        <Link href="/meeting">レセメン会議</Link>
        <Link href="/knowledge">知識</Link>
        <Link href="/manager">事務長</Link>
        <Link href="/settings">設定</Link>
      </nav>
      <div className="chips" style={{ alignItems: "center" }}>
        <span className="muted">デモの日付 {now.slice(0, 10)}</span>
        <input type="date" value={input} onChange={(e) => setInput(e.target.value)} aria-label="デモの日付" />
        <button onClick={advance}>日付を進める</button>
        {msg && <span className="muted">{msg}</span>}
        {who && <span className="muted">{who}さん <button onClick={logout}>ログアウト</button></span>}
        {right}
      </div>
    </div>
  );
}
