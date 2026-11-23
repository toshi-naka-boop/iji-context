"use client";
// 査定・返戻の突き合わせ（spec FR-202 の I-1。design/iji-context/plan-i1.md）：事務長とベテランだけ。
// 取り込み → 当てられなかったものを選ぶ → 当て方を確かめる → 結果と理由を選ぶ → 報告。AI は使わない（当て方は決まった規則、結果と理由は人が選ぶ）
import { useEffect, useState } from "react";
import { payerLabel } from "../../src/messages";
import { REVIEW_MAX_BYTES } from "../../src/review/format";
import { getJson, postJson } from "../get-json";
import { Notice } from "../consent";
import { TopBar } from "../nav";
import { PageGuide } from "../page-guide";

type Upload = { sha256: string; label: string; paper: boolean; payer: string; processedMonth: string; fingerprint: string; items: number };
type Item = { id: number; upload: string; kind: string; receiptNo: string; uketsuke: string; name: string; kasho: string; points: number | null; amount: number | null; jiyu: string[]; jiyuText: string; seikyu: string; claimId: string | null; claimPatient: string | null; claimNote: string | null; line: string | null; confirmed: boolean; excluded: string | null; state: string; judgment: { result: string; reason: string | null } | null };
type List = { fingerprint: string; uploads: Upload[]; items: Item[] };
type Finding = { key: string; system: string; id: string; certainty: string; text: string; related: boolean };
type Detail = {
  id: number; label: string; claimId: string | null; claimBy: string | null; claimNote: string | null; claimLevel: boolean; line: string | null; lineBy: string | null; confirmed: boolean; excluded: string | null; humanExcluded: string | null; pending: string | null;
  row: { name: string; receiptNo: string; uketsuke: string; kasho1: string; kasho2: string; points: number | null; amount: number | null; jiyu: string[]; jiyuText: string; seikyu: string; satei: string };
  claims: { claimId: string; patient: string; yearMonth: string; billingMonth: string; receiptNo: string; patientNo: string; nameMatch: boolean; insurerMatch: boolean }[];
  lines: { code: string; name: string | null; shikibetsu: string; hit: boolean }[];
  lineOthers: string[]; revisionId: string | null; findings: Finding[]; fingerprint: string; fixedFingerprint: string;
  judgments: { fingerprint: string; revisionId: string | null; result: string; reason: string | null; finding: { system: string; id: string; certainty: string } | null; at: string }[];
  choices: { results: string[]; reasons: string[]; exclusions: string[] };
};
type Count = { items: number; receipts: number };
type Report = {
  total: Count; byKind: { kind: string; count: Count }[]; excluded: { reason: string; count: Count }[]; pending: { unmatched: Count; unconfirmed: Count }; target: Count;
  byJiyu: { jiyu: string; count: Count }[]; deductedPoints: number;
  runs: { fingerprint: string; fixedAtImport: boolean; revisions: string[]; judged: Count; unjudged: Count; same: Record<string, Count>; other: Count; none: Count; reasons: { reason: string; count: Count }[] }[];
};

const STATES: [string, string][] = [["unmatched", "当てられなかったもの"], ["unconfirmed", "確かめるもの"], ["unjudged", "判定するもの"], ["judged", "判定済み"], ["excluded", "対象外"], ["all", "全部"]];
const STATE_LABEL: Record<string, string> = { unmatched: "請求を選ぶ", unconfirmed: "確かめる", unjudged: "判定する", judged: "判定済み", excluded: "対象外" };
const n = (c: Count) => `${c.items} 件（レセプト ${c.receipts} 件）`;
const pts = (i: { points: number | null; amount: number | null }) => (i.points !== null ? `${i.points > 0 ? "+" : ""}${i.points}` : i.amount !== null ? `${i.amount} 円` : "");
/** 判定した日（日本時間。ISO の先頭 10 文字は世界標準時の日付で、朝 9 時前は前の日になる） */
const day = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });

export default function ReviewPage() {
  const [list, setList] = useState<List | null>(null);
  const [err, setErr] = useState("");
  const [denied, setDenied] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("unmatched");
  const [open, setOpen] = useState<Detail | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [judge, setJudge] = useState<{ result: string; reason: string; finding: string }>({ result: "", reason: "", finding: "" });

  const reload = () => getJson<List>("/api/review").then(setList).catch((e: Error) => (/役割/.test(e.message) ? setDenied(true) : setErr(e.message)));
  useEffect(() => {
    reload();
  }, []);

  async function upload() {
    if (!file) return;
    setErr("");
    if (file.size > REVIEW_MAX_BYTES) return setErr("ファイルが大きすぎます");
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const r = await fetch("/api/review/upload", { method: "POST", body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setErr(d.error ?? "取り込めませんでした");
      setList(d);
      setFile(null);
    } catch {
      setErr("取り込めませんでした。通信の状態を確かめて、もう一度試してください");
    } finally {
      setBusy(false);
    }
  }
  async function remove(u: Upload) {
    if (!window.confirm(`この ${u.label}（明細 ${u.items} 件）を消します。明細と、明細ごとに選んだ当て方・判定が消え、元に戻せません。消しますか？`)) return;
    const r = await fetch(`/api/review/uploads/${u.sha256}`, { method: "DELETE" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setErr(d.error ?? "消せませんでした");
    setOpen(null);
    setReport(null);
    reload();
  }
  async function rematch(u: Upload) {
    setErr("");
    await postJson<List>(`/api/review/uploads/${u.sha256}/rematch`, {}).then(setList).catch((e: Error) => setErr(e.message));
  }
  async function show(id: number) {
    setErr("");
    setJudge({ result: "", reason: "", finding: "" });
    await getJson<Detail>(`/api/review/items/${id}`)
      .then((d) => {
        setOpen(d);
        // 明細は一覧の下に出るので、開いたところへ移る（押しても何も起きないように見えないため）
        requestAnimationFrame(() => document.getElementById("review-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      })
      .catch((e: Error) => setErr(e.message));
  }
  async function act(body: Record<string, unknown>) {
    if (!open) return;
    setErr("");
    try {
      setOpen(await postJson<Detail>(`/api/review/items/${open.id}`, body));
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const items = (list?.items ?? []).filter((i) => tab === "all" || i.state === tab);
  const same = judge.result === open?.choices.results[0];
  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="yusti" title="査定・返戻の突き合わせ" tag="RULE ENGINE">
        審査支払機関の増減点連絡書・返戻内訳書の CSV を取り込み、提出した UKE の請求と行に決まった規則で当てます。当てた請求を今の点検で点検し直した指摘を並べるので、事前に指摘していたかと、指摘しなかった理由を選んでください。AI は使いません。報告は件数だけです。
      </PageGuide>
      {denied && <p className="muted">この画面は、事務長とベテランの役割の人が使います。</p>}
      {err && <div className="notice warn">{err}</div>}
      {!denied && (
        <>
          <section className="card">
            <div className="card-body">
              <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>CSV を取り込む</h2>
              <p className="muted" style={{ margin: "0 0 12px" }}>
                オンライン請求システムからダウンロードした増減点連絡書（RIzogn…csv）・返戻内訳書（RIhenr…csv）を、ダウンロードしたときの名前のまま選んでください。審査支払機関と処理年月はファイル名から読みます。
                この画面は AI を使わず、取り込んだ明細を外部のサービスに送りません。原本のファイルは残さず、読んだ明細だけを持ちます。2026年6月診療分より前の請求は、版がないので対象外として数えます。
              </p>
              <Notice />
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <input type="file" accept=".csv,.CSV" aria-label="取り込む CSV のファイル" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <button className="primary" disabled={!file || busy} onClick={upload}>{busy ? "読んでいます…" : "取り込む"}</button>
              </div>
            </div>
          </section>

          {(list?.uploads ?? []).length > 0 && (
            <section className="card" style={{ marginTop: 16 }}>
              <div className="card-body">
                <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>取り込んだ CSV</h2>
                <table>
                  <thead><tr><th>種類</th><th>審査支払機関</th><th>処理年月</th><th>明細</th><th>固定した指紋</th><th /></tr></thead>
                  <tbody>
                    {list!.uploads.map((u) => (
                      <tr key={u.sha256}>
                        <td>{u.label}{u.paper ? "（紙レセプト分）" : ""}</td>
                        <td>{payerLabel(u.payer)}</td>
                        <td className="num">{u.processedMonth}</td>
                        <td className="num">{u.items}</td>
                        <td className="num">{u.fingerprint}{u.fingerprint !== list!.fingerprint ? "（今のコードと違う）" : ""}</td>
                        <td style={{ whiteSpace: "nowrap" }}><button onClick={() => rematch(u)}>当て直す</button> <button onClick={() => remove(u)}>消す</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {list && list.items.length > 0 && (
            <section className="card" style={{ marginTop: 16 }}>
              <div className="card-body">
                <div className="chips" style={{ marginBottom: 12 }}>
                  {STATES.map(([k, label]) => (
                    <button key={k} className={tab === k ? "primary" : ""} onClick={() => setTab(k)}>{label}（{k === "all" ? list.items.length : list.items.filter((i) => i.state === k).length}）</button>
                  ))}
                </div>
                <table>
                  <thead><tr><th>番号</th><th>氏名</th><th>箇所</th><th>事由</th><th>増減</th><th>請求内容</th><th>当てた請求</th><th>行</th><th>状態</th><th /></tr></thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.id} style={open?.id === i.id ? { background: "var(--surface)" } : undefined}>
                        <td className="num">{i.kind === "zogen" ? i.receiptNo : i.uketsuke}</td>
                        <td>{i.name}</td>
                        <td>{i.kasho}</td>
                        <td>{i.jiyu.join("")}{i.jiyuText ? ` ${i.jiyuText}` : ""}</td>
                        <td className="num">{pts(i)}</td>
                        <td style={{ maxWidth: 280 }}>{i.seikyu}</td>
                        <td>{i.claimId ? `${i.claimId} ${i.claimPatient ?? ""}` : <span className="muted">{i.claimNote ?? "—"}</span>}</td>
                        <td className="num">{i.line ?? "—"}</td>
                        <td>{i.excluded ?? STATE_LABEL[i.state]}{i.judgment ? `：${i.judgment.result}${i.judgment.reason ? `（${i.judgment.reason}）` : ""}` : ""}</td>
                        <td><button onClick={() => show(i.id)}>開く</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {open && (
            <section id="review-detail" className="card" style={{ marginTop: 16 }}>
              <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>{open.label}の明細（{open.row.name}）</h2>
                <div className="muted">請求内容：{open.row.seikyu || "—"}／補正・査定後内容：{open.row.satei || "—"}／事由：{open.row.jiyu.join("") || "—"} {open.row.jiyuText}／増減：{pts(open.row)}</div>
                {open.excluded && <div className="notice">対象外：{open.excluded}</div>}

                <div>
                  <h3 style={{ margin: "0 0 6px" }}>1. 請求</h3>
                  {open.claimNote && !open.claimId && <p className="muted" style={{ margin: "0 0 6px" }}>自動では当てられませんでした（{open.claimNote}）。当たる請求を選ぶか、「当てられない」を選んでください。</p>}
                  <select aria-label="当てる請求" value={open.claimId ?? (open.claimBy === "none" ? "none" : "")} onChange={(e) => act({ action: "claim", claimId: e.target.value === "none" ? null : e.target.value })}>
                    <option value="" disabled>選んでください</option>
                    {open.claims.map((c) => <option key={c.claimId} value={c.claimId}>{c.claimId} {c.patient}（診療 {c.yearMonth}・請求 {c.billingMonth}・番号 {c.receiptNo}{c.nameMatch ? "・氏名が合う" : ""}{c.insurerMatch ? "・保険者番号が合う" : ""}）</option>)}
                    <option value="none">当てられない</option>
                  </select>
                  {open.claimBy === "auto" && <span className="muted"> 自動で当てました</span>}
                </div>

                {open.claimId && !open.claimLevel && (
                  <div>
                    <h3 style={{ margin: "0 0 6px" }}>2. 行</h3>
                    {open.lineBy !== "human" && open.line === null && <p className="muted" style={{ margin: "0 0 6px" }}>名称から 1 つに決まりませんでした（印は名称が含まれていた行）。行を選んでください。</p>}
                    <select aria-label="当てる行" value={open.line ?? ""} onChange={(e) => act({ action: "line", line: e.target.value })}>
                      <option value="" disabled>選んでください</option>
                      {open.lines.map((l) => <option key={l.code} value={l.code}>{l.hit ? "★ " : ""}{l.code} {l.name ?? ""}（診療識別 {l.shikibetsu || "—"}）</option>)}
                      {open.lineOthers.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                    {open.lineBy === "auto" && <span className="muted"> 自動で当てました</span>}
                  </div>
                )}
                {open.claimId && open.claimLevel && <p className="muted" style={{ margin: 0 }}>2. 行：この明細は請求単位です（合計の行・金額・事由 F・G・H・返戻）。</p>}

                {open.claimId && (
                  <div>
                    <h3 style={{ margin: "0 0 6px" }}>3. 当て方を確かめる</h3>
                    {open.confirmed ? <span>確かめました</span> : <button className="primary" onClick={() => act({ action: "confirm" })}>この当て方でよい</button>}
                  </div>
                )}

                <div>
                  <h3 style={{ margin: "0 0 6px" }}>対象外の印</h3>
                  <select aria-label="対象外の印" value={open.humanExcluded ?? ""} onChange={(e) => act({ action: "exclude", reason: e.target.value || null })}>
                    <option value="">印なし</option>
                    {open.choices.exclusions.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>

                {open.confirmed && !open.excluded && (
                  <div>
                    <h3 style={{ margin: "0 0 6px" }}>4. 結果と理由</h3>
                    <p className="muted" style={{ margin: "0 0 6px" }}>今の点検（版 {open.revisionId ?? "—"}・指紋 {open.fingerprint}）で、当てた請求を点検し直した指摘です。★は当てた行に関わる指摘です。</p>
                    {open.findings.length === 0 && <p style={{ margin: "0 0 6px" }}>指摘はありません。</p>}
                    <ul style={{ margin: "0 0 8px", paddingLeft: 20 }}>
                      {open.findings.map((f) => <li key={f.key}>{f.related ? "★ " : ""}<span className="badge">{f.system} {f.id}・{f.certainty}</span> {f.text}</li>)}
                    </ul>
                    <div className="chips">
                      {open.choices.results.map((r) => <label key={r}><input type="radio" name="result" checked={judge.result === r} onChange={() => setJudge({ result: r, reason: "", finding: "" })} /> {r}</label>)}
                    </div>
                    {same && (
                      <div className="chips" style={{ marginTop: 6 }}>
                        {open.findings.map((f) => <label key={f.key}><input type="radio" name="finding" checked={judge.finding === f.key} onChange={() => setJudge({ ...judge, finding: f.key })} /> {f.system} {f.id}（{f.certainty}）</label>)}
                      </div>
                    )}
                    {judge.result && !same && (
                      <div style={{ marginTop: 6 }}>
                        <div className="muted">指摘しなかった理由（複数当たるときは、上にあるものを選ぶ）</div>
                        {open.choices.reasons.map((r) => <div key={r}><label><input type="radio" name="reason" checked={judge.reason === r} onChange={() => setJudge({ ...judge, reason: r })} /> {r}</label></div>)}
                      </div>
                    )}
                    <p style={{ margin: "8px 0 0" }}>
                      <button className="primary" disabled={!judge.result || (same ? !judge.finding : !judge.reason)} onClick={() => act({ action: "judge", result: judge.result, ...(same ? { finding: judge.finding } : { reason: judge.reason }) })}>残す</button>
                    </p>
                  </div>
                )}
                {open.judgments.length > 0 && (
                  <div className="muted">
                    これまでの判定：{open.judgments.map((j, i) => <div key={i}>{day(j.at)} {j.result}{j.reason ? `（${j.reason}）` : ""}{j.finding ? `（${j.finding.system} ${j.finding.id}・${j.finding.certainty}）` : ""} 指紋 {j.fingerprint}{j.fingerprint !== open.fixedFingerprint ? "（取り込んだときと違うコード：別の回）" : ""}</div>)}
                  </div>
                )}
              </div>
            </section>
          )}

          {list && list.items.length > 0 && (
            <section className="card" style={{ marginTop: 16 }}>
              <div className="card-body">
                <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>報告（件数だけ）</h2>
                <button onClick={() => getJson<Report>("/api/review/report").then(setReport).catch((e: Error) => setErr(e.message))}>報告を出す</button>
                {report && (
                  <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                    <div>明細の全部：{n(report.total)}（{report.byKind.map((k) => `${k.kind === "zogen" ? "増減点連絡書" : "返戻内訳書"} ${n(k.count)}`).join("／")}）</div>
                    <div>対象：{n(report.target)}</div>
                    <div>対象外：{report.excluded.length === 0 ? "なし" : report.excluded.map((x) => `${x.reason} ${n(x.count)}`).join("／")}</div>
                    {(report.pending.unmatched.items > 0 || report.pending.unconfirmed.items > 0) && <div className="notice warn">まだ決めていないもの：請求を選ぶ {n(report.pending.unmatched)}／確かめる {n(report.pending.unconfirmed)}</div>}
                    <div>事由ごと（対象）：{report.byJiyu.map((j) => `${j.jiyu} ${n(j.count)}`).join("／") || "なし"}</div>
                    <div>減点の点数の合計（社内の報告にだけ使う）：{report.deductedPoints} 点</div>
                    {report.runs.map((r) => (
                      <div key={r.fingerprint} className="notice">
                        <strong>回：指紋 {r.fingerprint}{r.fixedAtImport ? "（取り込んだときに固定）" : "（取り込んだ後に変えたコード：別の回）"}</strong>
                        <div>点検に使った版：{r.revisions.join("、") || "—"}／判定した {n(r.judged)}／まだ判定していない {n(r.unjudged)}</div>
                        <div>同じ論点で指摘していた：確定 {n(r.same["確定"])}／条件つき {n(r.same["条件つき"])}／患者情報 {n(r.same["患者情報"])}</div>
                        <div>別の論点で指摘していた {n(r.other)}／指摘なし {n(r.none)}</div>
                        <div>指摘しなかった理由：{r.reasons.map((x) => `${x.reason} ${n(x.count)}`).join("／") || "なし"}</div>
                      </div>
                    ))}
                    <p className="muted" style={{ margin: 0 }}>今の点検で点検し直しているので、提出の後に足した決まりで「指摘していた」になることがあります。コードを変えたら別の回として数えます。</p>
                  </div>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
