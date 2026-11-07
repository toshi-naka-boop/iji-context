"use client";
// 設定（2026-11-07 ユーザー判断）：メンターのキャラと話し方を変える。算定画面からは変えない
import { useEffect, useState } from "react";
import { TopBar } from "../nav";
import { SignIn, useClerk } from "../clerk";
import { MentorPicker, type MentorChoice } from "../mentor-picker";

export default function Settings() {
  const { clerk: user, ready } = useClerk();
  const [choice, setChoice] = useState<MentorChoice | null>(null);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => {
    if (!user) return;
    fetch(`/api/character?clerkId=${user.id}`).then((r) => r.json()).then(setChoice).catch((e: Error) => setErr(e.message));
  }, [user]);
  if (!ready) return <main className="shell"><TopBar /></main>;
  if (!user) return <main className="shell"><TopBar /><SignIn /></main>;
  return (
    <main className="shell">
      <TopBar />
      {err && <div className="notice warn">{err}</div>}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>設定</h2>
        <h3>メンター</h3>
        <p className="muted">今のメンター：{choice?.current.name ?? ""}。変えると、メンターとの会話は新しく始まります。</p>
        {saved && <div className="notice ok">{saved}</div>}
        {choice && (
          <MentorPicker
            choice={choice}
            clerkId={user.id}
            onError={setErr}
            onChange={(c) => { setChoice(c); setErr(""); setSaved(`保存しました（メンター：${c.current.name}）`); }}
          />
        )}
      </div>
    </main>
  );
}
