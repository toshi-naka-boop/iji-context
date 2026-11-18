"use client";
// UKE の取り込み（月末。レセコンが書き出した提出用のファイルを読み込み、提出前の点検にかける）
// 見本の 2 本（国保連・支払基金。合成データ・架空コード）を選んで取り込むか、ファイルを選んでアップロードする（spec FR-71・FR-106〜109）
import { useEffect, useState } from "react";
import { payerLabel } from "../../src/messages";
import { UKE_LIMITS } from "../../src/uke/limits";
import { TopBar } from "../nav";
import { SignIn, useClerk } from "../clerk";
import { PageGuide } from "../page-guide";

type Uke = { name: string; uploaded: boolean; payer: string; prefecture: string; billingMonth: string; receipts: { claimId: string; patient: string }[]; imported: boolean };

export default function UkeImport() {
  const { clerk: user, ready } = useClerk();
  const [list, setList] = useState<Uke[]>([]);
  const [err, setErr] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  useEffect(() => {
    if (!user) return;
    fetch("/api/uke").then((r) => r.json()).then(setList).catch((e) => setErr(String(e)));
  }, [user]);
  async function take(name: string) {
    if (!user) return;
    setErr("");
    const r = await fetch("/api/uke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const d = await r.json();
    if (!r.ok) return setErr(d.error ?? "エラー");
    setList(d);
  }
  /** 選んだファイルを送る。大きすぎるファイルは送る前に断る（サーバーでも同じ上限で確かめる） */
  async function upload() {
    if (!user || !file) return;
    setErr("");
    setDone("");
    if (file.size > UKE_LIMITS.maxBytes) return setErr(`ファイルが大きすぎます（上限 ${UKE_LIMITS.maxBytes / 1024 / 1024} MB）`);
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const r = await fetch("/api/uke/upload", { method: "POST", body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setErr(d.error ?? "アップロードできませんでした");
      setList(d);
      setDone("取り込みました。算定画面の「月末の点検」に並びます。");
    } catch {
      setErr("アップロードできませんでした。通信の状態を確かめて、もう一度試してください");
    } finally {
      setBusy(false);
    }
  }
  if (!ready) return <main className="shell"><TopBar /></main>;
  if (!user) return <main className="shell"><TopBar /><SignIn /></main>;
  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="yusti" title="UKE 取り込み" tag="RULE ENGINE">
        月末にレセコンから書き出した UKE（提出用のファイル）を取り込むと、提出前に全件を決まった規則で点検します。見本の 2 本（合成データ・架空コード）から選ぶか、ファイルを選んでアップロードします。
      </PageGuide>
      {err && <div className="notice warn">{err}</div>}
      <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
        {list.map((u) => (
          <article key={u.name} className="card">
            <div className="card-band" style={{ background: u.imported ? "var(--accent)" : "var(--surface)" }} />
            <div className="card-body">
              <div className="chips" style={{ alignItems: "center", justifyContent: "space-between" }}>
                <span className="badge">{payerLabel(u.payer)}・{u.prefecture}</span>
                <span className={`badge ${u.imported ? "blue" : ""}`}>{u.imported ? "取り込み済み" : "未取り込み"}</span>
              </div>
              <h2 style={{ margin: "12px 0 4px", fontSize: 18, wordBreak: "break-all" }}>{u.uploaded ? `アップロードした UKE（${u.name.slice(0, 8)}）` : u.name}</h2>
              <div style={{ display: "flex", gap: 24, margin: "8px 0" }}>
                <div><div className="muted">請求</div><span className="num" style={{ fontSize: 22 }}>{u.billingMonth}</span></div>
                <div><div className="muted">レセプト</div><span className="num" style={{ fontSize: 22 }}>{u.receipts.length}</span><span className="muted"> 件</span></div>
              </div>
              <div className="chips" style={{ margin: "8px 0 14px" }}>
                {u.receipts.map((r) => <span key={r.claimId} className="badge">{r.claimId.split("-")[0]} {r.patient}</span>)}
              </div>
              <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                {u.imported ? <a href="/work">算定画面の「月末の点検」で点検する →</a> : <button className="primary" onClick={() => take(u.name)}>取り込む</button>}
                {!u.uploaded && <a href={`/api/uke/sample?name=${encodeURIComponent(u.name)}`} download={u.name}>見本をダウンロード</a>}
              </div>
              {u.uploaded && <p className="muted" style={{ margin: "12px 0 0" }}>カルテ側の記録がないレセプトです。足りない事実は「情報不足」として出ます。訪問カルテ・選択モード・練習問題の対象外です。</p>}
            </div>
          </article>
        ))}
      </div>
      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-body">
          <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>ファイルを選んでアップロード</h2>
          <p className="muted" style={{ margin: "0 0 12px" }}>
            受け取るのは、架空コードだけで作られた合成データの UKE です。実在の患者のデータは入れないでください（架空コードの表にないコードを含むファイルは、ファイルごと断ります）。
            同梱の症例にないレセプトは、カルテ側の記録（訪問・処方など）がないまま点検に並び、足りない事実は「情報不足」として出ます。同梱の症例や、すでに取り込んだ UKE と同じ請求 id で内容が違うファイルは断ります。
          </p>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <input type="file" accept=".UKE,.uke" aria-label="アップロードする UKE のファイル" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setDone(""); setErr(""); }} />
            <button className="primary" disabled={!file || busy} onClick={upload}>{busy ? "確かめています…" : "アップロードして取り込む"}</button>
          </div>
          {done && <p style={{ margin: "12px 0 0" }}>{done} <a href="/work">点検する →</a></p>}
        </div>
      </section>
    </main>
  );
}
