"use client";
// 画面上部の共通ナビ（デモの時計を含む）
import Link from "next/link";
import { useEffect, useState } from "react";

export function TopBar({ right }: { right?: React.ReactNode }) {
  const [now, setNow] = useState<string>("");
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    fetch("/api/clock").then((r) => r.json()).then((d) => { setNow(d.now); setInput(d.now); });
  }, []);
  async function advance() {
    const r = await fetch("/api/clock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ now: input }) });
    const d = await r.json();
    if (!r.ok) return setMsg(d.error);
    setNow(d.now);
    setMsg(d.meeting ? "レセメン会議の整理を回しました" : "");
  }
  return (
    <div className="top">
      <nav>
        <strong>レセメン</strong>
        <Link href="/work">算定</Link>
        <Link href="/doctor">医師確認</Link>
        <Link href="/meeting">レセメン会議</Link>
        <Link href="/knowledge">知識</Link>
        <Link href="/manager">事務長</Link>
      </nav>
      <div className="chips" style={{ alignItems: "center" }}>
        <span className="muted">デモの時計 {now}</span>
        <input value={input} onChange={(e) => setInput(e.target.value)} style={{ width: 230 }} aria-label="時計を進める" />
        <button onClick={advance}>時計を進める</button>
        {msg && <span className="muted">{msg}</span>}
        {right}
      </div>
    </div>
  );
}
