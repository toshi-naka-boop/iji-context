"use client";
// 設定（2026-11-07 ユーザー判断）：メンターのキャラと話し方を変える。算定画面からは変えない
import { useEffect, useState } from "react";
import { TopBar } from "../nav";
import { SignIn, useClerk } from "../clerk";
import { MentorPicker, type MentorChoice } from "../mentor-picker";
import { PageGuide } from "../page-guide";
import { ROLES, ROLE_LABELS, type Role } from "../../src/server/roles";
import { Invites } from "./invites";
import { Facility } from "./facility";
import { Masters } from "./masters";

export default function Settings() {
  const { clerk: user, ready } = useClerk();
  const [choice, setChoice] = useState<MentorChoice | null>(null);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");
  // 役割（1 人で使っているクリニックだけ、自分で切り替えられる）
  const [me, setMe] = useState<{ role: Role; canSwitchRole: boolean; canInvite: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => {});
  }, []);
  async function switchRole(role: Role) {
    setErr("");
    const r = await fetch("/api/auth/role", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) });
    const d = await r.json();
    if (!r.ok) return setErr(d.error ?? "エラー");
    setMe((m) => (m ? { ...m, role: d.role } : m));
  }
  useEffect(() => {
    if (!user) return;
    fetch("/api/character").then((r) => r.json()).then(setChoice).catch((e: Error) => setErr(e.message));
  }, [user]);
  if (!ready) return <main className="shell"><TopBar /></main>;
  if (!user) return <main className="shell"><TopBar /><SignIn /></main>;
  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="mine" title="設定">
        一緒に働くメンターと、話し方の好みをここで変えられます。変えると、メンターとの会話は新しく始まります。{me?.canInvite ? "一緒に使う人への招待コードも、ここで発行できます。" : ""}
      </PageGuide>
      {err && <div className="notice warn">{err}</div>}
      {me && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>役割</h3>
          <p className="muted">今の役割：{ROLE_LABELS[me.role]}。{me.canSwitchRole ? "1 人で使っているあいだは、ここで役割を切り替えて、すべての画面を通して使えます。切り替えは記録に残ります。" : "役割は、招待のときに決まったものです。"}</p>
          {me.canSwitchRole && (
            <div className="chips" role="radiogroup" aria-label="役割">
              {ROLES.map((r) => (
                <button key={r} role="radio" aria-checked={me.role === r} className={me.role === r ? "primary" : ""} onClick={() => switchRole(r)}>{ROLE_LABELS[r]}</button>
              ))}
            </div>
          )}
        </div>
      )}
      {me?.canInvite && <Invites />}
      {(me?.role === "manager" || me?.role === "veteran") && <Facility />}
      {me?.role === "manager" && <Masters />}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>メンター</h3>
        <p className="muted">今のメンター：{choice?.current.name ?? ""}。変えると、メンターとの会話は新しく始まります。</p>
        {saved && <div className="notice ok">{saved}</div>}
        {choice && (
          <MentorPicker
            choice={choice}
            onError={setErr}
            onChange={(c) => { setChoice(c); setErr(""); setSaved(`保存しました（メンター：${c.current.name}）`); }}
          />
        )}
      </div>
    </main>
  );
}
