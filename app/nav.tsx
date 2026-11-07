"use client";
// 共通のメニュー：左の縦メニュー（2026-11-08 ユーザー判断で案 C+）。上から本人のステータス・メニュー・デモの日付。
// 名前は今までどおり TopBar（各画面はそのまま使う）。日付は日付だけ出す（時刻は出さない：2026-11-07 ユーザー判断）
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import LEVELS from "../config/levels.json";

export type Status = { level: number; count: number; streak: number };

const LINKS: [string, string][] = [
  ["/work", "算定"],
  ["/chart", "カルテを書く"],
  ["/doctor", "医師確認"],
  ["/uke", "UKE 取り込み"],
  ["/meeting", "レセメン会議"],
  ["/knowledge", "知識"],
  ["/manager", "事務長"],
  ["/guide", "手引き"],
  ["/settings", "設定"],
];

/** 次のレベルまでの進み具合（0〜100）。しきい値は config/levels.json */
function progress(s: Status): number {
  const t = LEVELS.thresholds;
  const lo = t[s.level - 1] ?? 0;
  const hi = t[s.level];
  if (hi === undefined) return 100;
  return Math.max(0, Math.min(100, ((s.count - lo) / (hi - lo)) * 100));
}

/**
 * 画面を移るたびにメニューが空から描き直されて崩れないよう、最後に取れた値をこのページの間だけ覚えておく
 * （ブラウザの中だけ。サーバーには何も残さない。2026-11-08）
 */
const memo: { now: string; who: string; status: Status | null } = { now: "", who: "", status: null };

/** status を渡す画面（算定）はその値を、渡さない画面は自分で取りにいく */
export function TopBar({ status }: { status?: Status | null }) {
  const path = usePathname();
  const [now, setNow] = useState<string>(memo.now);
  const [input, setInput] = useState(memo.now.slice(0, 10));
  const [msg, setMsg] = useState("");
  const [who, setWho] = useState(memo.who);
  const [own, setOwn] = useState<Status | null>(memo.status);
  useEffect(() => {
    fetch("/api/clock").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) { memo.now = d.now; setNow(d.now); setInput(d.now.slice(0, 10)); } });
    fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).then((u) => { memo.who = u?.name ?? ""; setWho(memo.who); }).catch(() => {});
    fetch("/api/me").then((r) => (r.ok ? r.json() : null)).then((s) => { if (s) { memo.status = { level: s.level, count: s.count, streak: s.streak }; setOwn(memo.status); } }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (status) memo.status = status;
  const s = status ?? own;
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
    <aside className="side" aria-label="メニュー">
      <Link href="/work" className="side-logo">RESEMEN</Link>
      {(
        <div className="side-status">
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span className="lv">Lv.{s?.level ?? "-"}</span>
            <span style={{ fontSize: 13, color: "var(--hud-muted)" }}>連続 {s?.streak ?? "-"}</span>
          </div>
          <div className="gauge" role="img" aria-label={`次のレベルまで ${s ? Math.round(progress(s)) : 0}%`}>
            <div style={{ width: `${s ? progress(s) : 0}%` }} />
          </div>
          <div style={{ fontSize: 12, color: "var(--hud-muted)", marginTop: 6 }}>処理 {s?.count ?? "-"} 件</div>
        </div>
      )}
      <nav className="side-nav">
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href} className={path === href ? "active" : ""} aria-current={path === href ? "page" : undefined}>{label}</Link>
        ))}
      </nav>
      <div className="side-date">
        <span>デモの日付</span>
        <span className="num">{now ? now.slice(0, 10).replaceAll("-", ".") : "----.--.--"}</span>
        <input type="date" value={input} onChange={(e) => setInput(e.target.value)} aria-label="デモの日付" />
        <button onClick={advance}>日付を進める</button>
        {msg && <span>{msg}</span>}
      </div>
      {(
        <div className="side-user">
          <span>{who ? `${who}さん` : ""}</span>
          <button onClick={logout}>ログアウト</button>
        </div>
      )}
    </aside>
  );
}
