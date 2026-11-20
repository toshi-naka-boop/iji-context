"use client";
// UKE の取り込み（月末。レセコンが書き出した提出用のファイルを読み込み、提出前の点検にかける）
// 見本の 2 本（国保連・支払基金。合成データ）を選んで取り込むか、ファイルを選んでアップロードする（spec FR-71・FR-106〜109）
import { useEffect, useState } from "react";
import { payerLabel } from "../../src/messages";
import { UKE_LIMITS } from "../../src/uke/limits";
import { TopBar } from "../nav";
import { SignIn, useClerk } from "../clerk";
import { Notice } from "../consent";
import { PageGuide } from "../page-guide";
import { getJson } from "../get-json";

type Uke = {
  name: string;
  uploaded: boolean;
  /** いまの形式では読めないファイル（理由つき）。読めれば null */
  unreadable: { reason: string } | null;
  payer: string | null;
  prefecture: string | null;
  billingMonth: string | null;
  /** otherRows は点検の対象外の行の数。unreadable は、読み直しで読めなかったレセプトの理由 */
  receipts: { claimId: string; patient: string; patientNo: string | null; sameMonth: boolean; otherRows: number; unreadable: string | null }[];
  imported: boolean;
};

export default function UkeImport() {
  const { clerk: user, ready } = useClerk();
  const [list, setList] = useState<Uke[]>([]);
  const [err, setErr] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  /** 消せるのは事務長とベテラン（サーバーでも確かめる） */
  const [canDelete, setCanDelete] = useState(false);
  useEffect(() => {
    if (!user) return;
    getJson<typeof list>("/api/uke").then(setList).catch((e: Error) => setErr(e.message));
    getJson<{ role: string }>("/api/auth/me").then((me) => setCanDelete(me.role === "veteran" || me.role === "manager")).catch(() => {});
  }, [user]);
  /** 取り込んだファイルを消す（確かめてから）。原本と、そのファイルのレセプトにぶら下がる記録が消える */
  async function remove(u: Uke) {
    if (!window.confirm(`このファイル（レセプト ${u.receipts.length} 件）を消します。原本と、このファイルのレセプトの点検の記録・医師確認・メンターとのやり取りが消え、元に戻せません。AI のサービス側に送った内容は消せません。消しますか？`)) return;
    setErr("");
    setDone("");
    const r = await fetch(`/api/uke/uploads/${u.name.slice(0, 64)}`, { method: "DELETE" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setErr(d.error ?? "消せませんでした");
    getJson<typeof list>("/api/uke").then(setList).catch((e: Error) => setErr(e.message));
  }
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
      setDone("取り込みました。算定画面の「月末の点検」に並びます。UKE に書いてあるとおりの点検は、上の一覧から開けます。");
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
        月末にレセコンから書き出した UKE（提出用のファイル）を取り込むと、提出前に全件を決まった規則で点検します。見本の 2 本（合成データ）から選ぶか、ファイルを選んでアップロードします。
      </PageGuide>
      {err && <div className="notice warn">{err}</div>}
      <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
        {list.map((u) => u.unreadable || u.payer === null ? (
          <article key={u.name} className="card">
            <div className="card-band" style={{ background: "var(--surface)" }} />
            <div className="card-body">
              <div className="chips"><span className="badge">読めません</span></div>
              <h2 style={{ margin: "12px 0 4px", fontSize: 18, wordBreak: "break-all" }}>アップロードした UKE（{u.name.slice(0, 8)}）</h2>
              <p className="muted" style={{ margin: "8px 0 0" }}>{u.unreadable?.reason}（取り込み直しが要ります）。点検には並びません。</p>
              {canDelete && <p style={{ margin: "12px 0 0" }}><button onClick={() => remove(u)}>消す</button></p>}
            </div>
          </article>
        ) : (
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
                {u.receipts.map((r) => (
                  <span key={r.claimId} className="badge">
                    {u.uploaded ? r.claimId : r.claimId.split("-")[0]} {r.patient}{r.patientNo ? `（患者の番号 ${r.patientNo}）` : ""}
                  </span>
                ))}
              </div>
              {u.receipts.some((r) => r.unreadable) && (
                <div className="notice warn">
                  いまは点検できないレセプトがあります（{u.receipts.filter((r) => r.unreadable).map((r) => `${r.claimId} ${r.patient}：${r.unreadable}`).join("、")}）。ほかのレセプトは今までどおり点検できます。
                </div>
              )}
              {u.receipts.some((r) => r.otherRows > 0) && (
                <div className="notice warn">
                  点検の対象外の行があるレセプトがあります（{u.receipts.filter((r) => r.otherRows > 0).map((r) => `${u.uploaded ? r.claimId : r.claimId.split("-")[0]} ${r.patient}：${r.otherRows} 行`).join("、")}）。対応していないコードの行は点検せず、点検した行の小計と、UKE に書いてある合計を別々に出します。
                </div>
              )}
              {u.imported && (
                <div style={{ margin: "0 0 14px" }}>
                  <div className="muted">UKE に書いてあるとおりの点検（摘要欄の記載を含む）</div>
                  <div className="chips">
                    {u.receipts.map((r) => <a key={r.claimId} href={`/uke/${encodeURIComponent(r.claimId)}`}>{u.uploaded ? r.claimId : r.claimId.split("-")[0]} を開く →</a>)}
                  </div>
                </div>
              )}
              {u.receipts.some((r) => r.sameMonth) && (
                <div className="notice warn">
                  同じ月のレセプトがすでにあります（{u.receipts.filter((r) => r.sameMonth).map((r) => `${u.uploaded ? r.claimId : r.claimId.split("-")[0]} ${r.patient}`).join("、")}）。どちらが正しいかを確かめて、要らないファイルを消してください。
                </div>
              )}
              <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                {u.imported ? <a href="/work">算定画面の「月末の点検」で点検する →</a> : <button className="primary" onClick={() => take(u.name)}>取り込む</button>}
                {!u.uploaded && <a href={`/api/uke/sample?name=${encodeURIComponent(u.name)}`} download={u.name}>見本をダウンロード</a>}
                {u.uploaded && canDelete && <button onClick={() => remove(u)}>消す</button>}
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
            対応していないコードの行があっても断らず、その行（算定の単位）を点検の対象外として残します。対象外の行があるレセプトは、合計を 2 つ（UKE に書いてある合計と、点検した行の小計）出し、出す指摘を絞ります。
            形式が違う・対応しているコードの点数が点数表と合わない・合計が合わないファイルは、行番号つきで断ります。取り込んだレセプトには、アプリが請求の番号（U1-1 など）を振ります。UKE のカルテ番号は、患者の番号として表示にだけ使います。カルテ側の記録（訪問・処方など）がないまま点検に並び、足りない事実は「情報不足」として出ます。同じファイルの取り込み直しは断ります。
          </p>
          <Notice />
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
