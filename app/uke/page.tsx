"use client";
// UKE の取り込み（月末。レセコンが書き出した提出用のファイルを読み込み、提出前の点検にかける）
// 今回はデモ用の 2 本（国保連・支払基金。合成データ・架空コード）を選んで取り込むだけ
import { useEffect, useState } from "react";
import { TopBar } from "../nav";
import { SignIn, useClerk } from "../clerk";
import { PageGuide } from "../page-guide";

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
      <PageGuide who="yusti" title="UKE 取り込み" tag="RULE ENGINE">
        月末にレセコンから書き出した UKE（提出用のファイル）を取り込むと、提出前に全件を決まった規則で点検します。このデモでは、用意した 2 本（合成データ・架空コード）から選んで取り込みます。
      </PageGuide>
      {err && <div className="notice warn">{err}</div>}
      <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
        {list.map((u) => (
          <article key={u.name} className="card">
            <div className="card-band" style={{ background: u.imported ? "var(--accent)" : "var(--surface)" }} />
            <div className="card-body">
              <div className="chips" style={{ alignItems: "center", justifyContent: "space-between" }}>
                <span className="badge">{u.payer}・{u.prefecture}</span>
                <span className={`badge ${u.imported ? "blue" : ""}`}>{u.imported ? "取り込み済み" : "未取り込み"}</span>
              </div>
              <h2 style={{ margin: "12px 0 4px", fontSize: 18, wordBreak: "break-all" }}>{u.name}</h2>
              <div style={{ display: "flex", gap: 24, margin: "8px 0" }}>
                <div><div className="muted">請求</div><span className="num" style={{ fontSize: 22 }}>{u.billingMonth}</span></div>
                <div><div className="muted">レセプト</div><span className="num" style={{ fontSize: 22 }}>{u.receipts.length}</span><span className="muted"> 件</span></div>
              </div>
              <div className="chips" style={{ margin: "8px 0 14px" }}>
                {u.receipts.map((r) => <span key={r.claimId} className="badge">{r.claimId.split("-")[0]} {r.patient}</span>)}
              </div>
              {u.imported ? <a href="/work">算定画面の「月末の点検」で点検する →</a> : <button className="primary" onClick={() => take(u.name)}>取り込む</button>}
            </div>
          </article>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 16 }}>ファイルを選んで読み込む機能は、まだありません。</p>
    </main>
  );
}
