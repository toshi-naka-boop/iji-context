"use client";
// 訪問カルテを書く（FR-69）：患者を選ぶ → 訪問したていでカルテを書く → AI が算定に要る事実を取り出す → 本人が確かめる → レセメン（訪問の記録）へ
// 自由に書いて Haiku に SOAP の欄へ振り分けさせることも、見本（足りないカルテ・ちゃんとしたカルテ）を入れることもできる（2026-11-07 ユーザー判断）
// 見た目はスマホで書く一般的な訪問カルテ。特定の製品に似せない
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChartNote, ExtractedFact } from "../../src/chart/extract";
import type { VisitKind } from "../../src/chart/notes";
import { TopBar } from "../nav";
import { SignIn, useClerk } from "../clerk";
import SAMPLES from "../../fixtures/charts/samples.json";

type Patient = { claimId: string; name: string; sex: string; age: number | null; insurance: string | null; mainDisease: string | null; diseases: string[]; careLevel: number | null; table7: boolean | null; table8_2: boolean | null; homeOxygen: boolean | null };
type Extracted = { id: number; date: string; facts: ExtractedFact[]; dropped: { fact: unknown; why: string }[] };
type Row = ExtractedFact & { keep: boolean };

type Sample = { lacking: string; complete: string };
const sampleOf = (claimId: string) => (SAMPLES as unknown as Record<string, Sample | undefined>)[claimId];

const EMPTY: ChartNote = { s: "", o: "", a: "", p: "", rx: "" };
const yesNo = (b: boolean | null, yes: string, no: string) => (b === null ? "分からない" : b ? yes : no);

async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "エラー");
  return d as T;
}

export default function Chart() {
  const router = useRouter();
  const { clerk: user, ready } = useClerk();
  const CLERK = user?.id ?? "";
  const [patients, setPatients] = useState<Patient[]>([]);
  const [p, setP] = useState<Patient | null>(null);
  const [kind, setKind] = useState<VisitKind>("訪問診療");
  const [note, setNote] = useState<ChartNote>(EMPTY);
  const [ex, setEx] = useState<Extracted | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  /** 自由記述（SOAP に整える前） */
  const [free, setFree] = useState("");
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Patient[]>("/api/patients").then(setPatients).catch((e) => setErr(e.message));
  }, []);

  async function read() {
    if (!p) return;
    setErr("");
    setBusy(true);
    try {
      const r = await api<Extracted>("/api/chart", { claimId: p.claimId, clerkId: CLERK, kind, note });
      setEx(r);
      setRows(r.facts.map((f) => ({ ...f, keep: true })));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function toSoap() {
    setErr("");
    setBusy(true);
    try {
      const r = await api<{ note: ChartNote; unmatched: string[] }>("/api/chart/soap", { text: free });
      setNote(r.note);
      setUnmatched(r.unmatched);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function hand() {
    if (!ex || !p) return;
    setErr("");
    try {
      const r = await api<{ claimId: string; date: string }>(`/api/chart/${ex.id}`, { facts: rows.filter((x) => x.keep).map(({ keep: _k, ...f }) => f) });
      router.push(`/work?visit=${encodeURIComponent(`${r.claimId}|${r.date}`)}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  if (!ready) return <main className="shell"><TopBar /></main>;
  if (!user) return <main className="shell"><TopBar /><SignIn /></main>;

  const field = (k: keyof ChartNote, label: string, rows = 2) => (
    <label className="chart-field">
      <span>{label}</span>
      <textarea rows={rows} value={note[k]} disabled={!!ex} onChange={(e) => setNote({ ...note, [k]: e.target.value })} />
    </label>
  );

  return (
    <main className="shell">
      <TopBar />
      {err && <div className="notice warn">{err}</div>}
      <div className="phone">
        {!p && (
          <>
            <h2>訪問する患者</h2>
            <p className="muted">デモ用のカルテ記載ができます。</p>
            {patients.map((x) => (
              <button key={x.claimId} className="patient-card" onClick={() => { setP(x); setNote(EMPTY); setEx(null); setFree(""); setUnmatched([]); }}>
                <strong>{x.name}</strong>
                <span>{x.sex}・{x.age ?? "?"} 歳・{x.insurance ?? ""}</span>
                <span className="muted">主病：{x.mainDisease ?? "不明"}</span>
              </button>
            ))}
          </>
        )}
        {p && (
          <>
            <button onClick={() => { setP(null); setEx(null); }}>← 患者を選び直す</button>
            <h2>{p.name}　<span className="muted">{p.sex}・{p.age ?? "?"} 歳</span></h2>
            <div className="notice">
              <div>保険：{p.insurance ?? "不明"}　主病：{p.mainDisease ?? "不明"}</div>
              <div>傷病名：{p.diseases.join("、")}</div>
              <div>
                要介護度：{p.careLevel === null ? "分からない" : p.careLevel === 0 ? "要支援・非該当" : `要介護${p.careLevel}`}　別表第七：{yesNo(p.table7, "当たる", "当たらない")}　別表第八の二：{yesNo(p.table8_2, "当たる", "当たらない")}　在宅酸素：{yesNo(p.homeOxygen, "している", "していない")}
              </div>
            </div>
            <div className="chips" role="group" aria-label="訪問の種類">
              {(["訪問診療", "往診"] as VisitKind[]).map((k) => (
                <button key={k} className={kind === k ? "primary" : ""} disabled={!!ex} onClick={() => setKind(k)}>{k}</button>
              ))}
            </div>
            <label className="chart-field">
              <span>自由に書く（AI が SOAP の欄に振り分けます）</span>
              <textarea rows={4} value={free} disabled={!!ex} onChange={(e) => setFree(e.target.value)} />
            </label>
            {sampleOf(p.claimId) && !ex && (
              <div className="chips" role="group" aria-label="見本を入れる">
                <button onClick={() => setFree(sampleOf(p.claimId)!.lacking)}>見本：足りないカルテ</button>
                <button onClick={() => setFree(sampleOf(p.claimId)!.complete)}>見本：ちゃんとしたカルテ</button>
              </div>
            )}
            {!ex && (
              <button disabled={busy || !free.trim()} onClick={toSoap}>{busy ? "整えています…" : "SOAP に整える"}</button>
            )}
            {unmatched.length > 0 && <div className="notice warn">元の文にない言い回しがあります。確かめて直してください：{unmatched.join("、")}</div>}
            {field("s", "S（主訴）")}
            {field("o", "O（所見）")}
            {field("a", "A（評価）")}
            {field("p", "P（計画）")}
            {field("rx", "処方")}
            {!ex && (
              <button className="primary" disabled={busy || !Object.values(note).some((v) => v.trim())} onClick={read}>
                {busy ? "読み取っています…" : "保存して、算定に要る事実を読み取る"}
              </button>
            )}
            {ex && (
              <div>
                <h3>読み取った事実（確かめてください）</h3>
                <p className="muted">AI が読み取ったものです。違うものは外し、分類は直せます。どれもカルテに書かれた言葉から取っています。判定はこのあとユスティが行います。</p>
                {rows.length === 0 && <div className="muted">算定に要る事実は見つかりませんでした（訪問の記録としては残ります）。</div>}
                {rows.map((r, i) => (
                  <div key={i} className="notice">
                    <label>
                      <input type="checkbox" checked={r.keep} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))} /> {r.kind}：
                    </label>
                    <input value={r.value} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} style={{ width: 160 }} />
                    <div className="muted">カルテの「{r.quote}」から</div>
                  </div>
                ))}
                {ex.dropped.length > 0 && (
                  <div className="notice warn">カルテに書かれていない言葉から取ったものなど {ex.dropped.length} 件は、使わずに捨てました。</div>
                )}
                <button className="primary" onClick={hand}>これでレセメンに渡す（{ex.date} の訪問）</button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
