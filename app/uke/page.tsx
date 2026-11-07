"use client";
// UKE の取り込み（月末。レセコンが書き出した提出用のファイルを読み込み、提出前の点検にかける）
// 今回はデモ用の 2 本（国保連・支払基金。合成データ・架空コード）を選んで取り込むだけ
import { useEffect, useState } from "react";
import { TopBar } from "../nav";
import { SignIn, useClerk } from "../clerk";

type Uke = { name: string; payer: string; prefecture: string; billingMonth: string; receipts: { claimId: string; patient: string }[]; imported: boolean };

export default function UkeImport() {
  const { clerk: user, ready } = useClerk();
  const [list, setList] = useState<Uke[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!user) return;
    fetch(`/api/uke?clerkId=${user.id}`).then((r) => r.json()).then(setList).catch((e) => setErr(String(e)));
  }, [user]);
  async function take(name: string) {
    if (!user) return;
    setErr("");
    const r = await fetch("/api/uke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clerkId: user.id, name }) });
    const d = await r.json();
    if (!r.ok) return setErr(d.error ?? "エラー");
    setList(d);
  }
  if (!ready) return <main className="shell"><TopBar /></main>;
  if (!user) return <main className="shell"><TopBar /><SignIn /></main>;
  return (
    <main className="shell">
      <TopBar />
      {err && <div className="notice warn">{err}</div>}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>UKE を取り込む</h2>
        <p>月末にレセコンから書き出した UKE（提出用のファイル）を取り込むと、算定画面の「月末の点検（UKE・提出前）」に並びます。</p>
        <p className="muted">このデモでは、用意した 2 本（合成データ・架空コード）から選んで取り込みます。ファイルを選んで読み込む機能は、まだありません。</p>
        {list.map((u) => (
          <div key={u.name} className={`notice ${u.imported ? "ok" : ""}`}>
            <strong>{u.name}</strong>　{u.payer}（{u.prefecture}）・請求 {u.billingMonth}・レセプト {u.receipts.length} 件
            <div className="muted">{u.receipts.map((r) => `${r.claimId.split("-")[0]} ${r.patient}`).join("、")}</div>
            <div style={{ marginTop: 6 }}>{u.imported ? <span>取り込み済み　<a href="/work">算定画面で点検する</a></span> : <button className="primary" onClick={() => take(u.name)}>取り込む</button>}</div>
          </div>
        ))}
      </div>
    </main>
  );
}
