"use client";
// 改定の比較（design.md §11-2）：同じ訪問と患者の状態を、2 つの版の点数表で導出して並べる。
// 比べるのは、カルテの記録から導いた算定行（UKE の行ではない）。ルールの指摘は比べず、要件の違いは「変わった点」の文で見せる。読むだけで、何も記録しない
import { useEffect, useState } from "react";
import { unsupportedText } from "../../src/chart/claim";
import type { CompareResult, CompareRow, Side } from "../../src/engine/compare";
import type { Pending } from "../../src/engine/derive";
import { needLabel } from "../../src/messages";
import { SignIn, useClerk } from "../clerk";
import { getJson } from "../get-json";
import { TopBar } from "../nav";
import { PageGuide } from "../page-guide";

type Rev = { id: string; label: string };
type Compared = {
  claims: { claimId: string; patient: string }[];
  revisions: Rev[];
  result: (CompareResult & { claimId: string; yearMonth: string; from: Rev; to: Rev }) | null;
};

const num = (n: number) => n.toLocaleString("ja-JP");
const signed = (n: number) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : "0");
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const pendingText = (p: Pending) => (p.kind === "要選択" ? `選んでいない項目：${p.question}` : `確かめていない事実：${needLabel(p.need)}${p.date ? `（${md(p.date)}）` : ""}`);

/** 片方の版の欄：回数 × 点数 と小計。行がなければ「—」 */
function SideCell({ s }: { s: Side | null }) {
  if (!s) return <td className="muted">—</td>;
  return (
    <td>
      {s.points === null ? "点数は 1 つに決まりません" : <>{num(s.points)} 点 × {s.count} 回 ＝ {num(s.subtotal as number)}</>}
      {s.tentative && <span className="badge sky" style={{ marginLeft: 6 }}>見込み</span>}
    </td>
  );
}

function Row({ r }: { r: CompareRow }) {
  // 新設・廃止は、行のない側を 0 として差を出す。行が立たなかっただけの側（保留など）は、差を出さない
  const sub = (s: Side | null) => (s ? s.subtotal : r.change === "新設" || r.change === "廃止" ? 0 : null);
  const [a, b] = [sub(r.from), sub(r.to)];
  const diff = a !== null && b !== null ? b - a : null;
  return (
    <tr>
      <td>
        {/* 区分の変更は、1 行に両方の名前を出す */}
        {r.change === "区分の変更" ? <>{r.from!.name} → {r.to!.name}</> : (r.to ?? r.from)!.name}
      </td>
      <SideCell s={r.from} />
      <SideCell s={r.to} />
      <td>{diff === null ? "—" : signed(diff)}</td>
      <td>{r.change === "同じ" ? <span className="muted">同じ</span> : <span className="badge">{r.change}</span>}</td>
    </tr>
  );
}

export default function RevisionCompare() {
  const { clerk: user, ready } = useClerk();
  const [data, setData] = useState<Compared | null>(null);
  const [claimId, setClaimId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!user) return;
    const q = new URLSearchParams({ ...(claimId ? { claimId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
    setErr("");
    getJson<Compared>(`/api/revision/compare${q ? `?${q}` : ""}`)
      .then((d) => {
        setData(d);
        // 最初は、一覧の先頭の請求を選ぶ
        if (!claimId && d.claims.length) setClaimId(d.claims[0].claimId);
      })
      .catch((e: Error) => setErr(e.message));
  }, [user, claimId, from, to]);

  if (!ready) return <main className="shell"><TopBar /></main>;
  if (!user) return <main className="shell"><TopBar /><SignIn /></main>;
  const r = data?.result ?? null;
  const sides = r ? ([["from", r.from], ["to", r.to]] as const) : [];
  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="yusti" title="改定の比較" tag="RULE ENGINE">
        同じ訪問と患者の状態を、2 つの版の点数表で算定した場合に、どの行がどう変わるかを並べます。決まった規則で導いた行だけを比べ、何も記録しません。
      </PageGuide>
      {err && <div className="notice warn">{err}</div>}
      <section className="card">
        <div className="card-body" style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "end" }}>
          <label>
            <div className="muted">症例</div>
            <select value={claimId} onChange={(e) => setClaimId(e.target.value)}>
              {(data?.claims ?? []).map((c) => <option key={c.claimId} value={c.claimId}>{c.claimId.split("-")[0]} {c.patient}</option>)}
            </select>
          </label>
          <label>
            <div className="muted">前の版</div>
            <select value={r?.from.id ?? from} onChange={(e) => setFrom(e.target.value)}>
              {(data?.revisions ?? []).map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>
          <label>
            <div className="muted">後の版</div>
            <select value={r?.to.id ?? to} onChange={(e) => setTo(e.target.value)}>
              {(data?.revisions ?? []).map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>
        </div>
      </section>

      {r && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>カルテの記録から導いた算定行の比較</h2>
            <p className="muted" style={{ margin: 0 }}>
              同じ訪問と患者の状態を、仮に{r.from.label}の点数表で算定した場合。実際にその年度に請求した結果ではありません。
              UKE の行（請求した行）ではなく、記録から決まった規則で導いた行を比べています。
            </p>
            <table className="emr-table">
              <thead>
                <tr><th>区分</th><th>{r.from.label}</th><th>{r.to.label}</th><th>差</th><th>変わり方</th></tr>
              </thead>
              <tbody>
                {r.rows.map((row, i) => <Row key={i} r={row} />)}
                {r.rows.length === 0 && <tr><td colSpan={5} className="muted">導いた行はありません。</td></tr>}
              </tbody>
            </table>

            {r.totals.from !== null && r.totals.to !== null ? (
              <div className="notice ok">
                <strong>合計：{num(r.totals.from)} 点 → {num(r.totals.to)} 点（{signed(r.totals.to - r.totals.from)}）</strong>
              </div>
            ) : (
              <div className="notice warn">
                <strong>合計は出していません。</strong>
                <div>どちらかの版に、まだ決まっていない行か、その版では導いていない区分があります。</div>
              </div>
            )}
            {sides.map(([key, rev]) => (
              <div key={key}>
                {r.pending[key].map((p) => <div key={p.id} className="notice warn">{rev.label}：{pendingText(p)}</div>)}
                {r.unsupported[key].map((u, i) => <div key={i} className="notice warn">{rev.label}：{unsupportedText(u)}</div>)}
              </div>
            ))}

            <h2 style={{ margin: "8px 0 0", fontSize: 18 }}>変わった点</h2>
            <p className="muted" style={{ margin: 0 }}>
              {r.to.label}で、前の改定から変わった点のうち、上の行に関わるものです。要件の違いは、行の比較には入れず、ここに文で出しています。
            </p>
            {r.changes.length === 0 && <p className="muted" style={{ margin: 0 }}>この版に、上の行に関わる記載はありません。</p>}
            {r.changes.map((c) => (
              <div key={c.id} className="notice">
                <span className="badge">{c.kind}</span> {c.summary}
                <div className="muted">出典（採用値の表）：{c.id}／{c.em}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
