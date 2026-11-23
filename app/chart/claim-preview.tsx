"use client";
// カルテを確定したあと、同じ画面に出す算定プレビュー（FR-101）：算定行・点数・根拠・合計・ユスティの指摘・患者情報の指摘・ローカルルール欄。
// 算定行はコードで導出したもの（GET /api/chart/[id]/claim）。試算で選べる版の一覧も、同じ応答に入っている。看取り加算などは本人が選ぶまで行にしない。宛先は医療事務（医師向けの画面には出さない）
import { useEffect, useState, type ReactNode } from "react";
import type { ClaimPreview as Preview, CommentInput } from "../../src/chart/claim";
import { postJson } from "../get-json";
import type { GenericView } from "../../src/generic/view";
import { COMMENT_CHECK_NOTE } from "../../src/messages";
import { GenericFindings } from "../generic-findings";
import { Torikawasure, type TorikawasureView } from "../torikawasure";

type PatientFinding = { checkId: string; kind: string; text: string };
/** trial・rulesAvailable・notInRevision は、版を選んだ試算のときだけ付く（design.md §11-12） */
type Claim = Preview & {
  claimId: string;
  date: string;
  patientFindings: PatientFinding[];
  /** 試算で選べる版（own は、この請求の診療年月の版） */
  revisions: Rev[];
  trial?: { revisionId: string; claimYearMonth: string; inPeriod: boolean };
  rulesAvailable?: boolean;
  notInRevision?: string[];
  /** データで動く点検（G01〜）を、導出した行の区分をコードに直して掛けた結果（design.md §12-5） */
  generic: GenericView & { skippedLines: number };
  /** B の欄（取り忘れ。G11。design.md §15-9） */
  torikawasure?: TorikawasureView;
};
type Rev = { id: string; label: string; own: boolean };

const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const num = (n: number) => n.toLocaleString("ja-JP");
const ym = (yearMonth: string) => `${Number(yearMonth.slice(0, 4))}年${Number(yearMonth.slice(5, 7))}月`;

/** 値の形の案内（コードの先頭 3 桁で決まる。EM §2-10 表 3）。820 は文字データを持たない */
const FORMAT_HINT: Record<string, string> = { "830": "文で書く", "842": "数値", "850": "和暦の年月日 7 桁（令和は 5。例 5081015）", "851": "時刻 4 桁（例 1430）" };

/** 「入力が要る」摘要欄の記載に、値を入れる欄（POST /api/chart/[id]/comments）。形が合わなければ残らず、文言が出る。edit は、入れた値を直すとき */
function CommentForm(props: { noteId: number; input: CommentInput; code: string | null; edit?: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(!props.edit);
  const [code, setCode] = useState(props.code ?? (props.input.codes.length === 1 ? props.input.codes[0] : ""));
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  if (!open) return <> <button onClick={() => setOpen(true)}>直す</button></>;
  const prefix = code.slice(0, 3);
  async function save() {
    setErr("");
    try {
      await postJson(`/api/chart/${props.noteId}/comments`, { slot: props.input.slot, code, text: prefix === "820" ? "" : text });
      setText("");
      props.onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginLeft: 6 }}>
      {props.input.codes.length > 1 && (
        <select aria-label="コメントコード" value={code} onChange={(e) => setCode(e.target.value)}>
          <option value="">コードを選ぶ</option>
          {props.input.codes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      {code !== "" && prefix !== "820" && <input aria-label={`コード ${code} の値`} placeholder={FORMAT_HINT[prefix] ?? ""} value={text} maxLength={200} onChange={(e) => setText(e.target.value)} style={{ width: 220, maxWidth: "100%" }} />}
      <button disabled={code === "" || (prefix !== "820" && text.trim() === "")} onClick={() => void save()}>残す</button>
      {err && <span className="notice warn">{err}</span>}
    </span>
  );
}

/** localRules は、ローカルルール欄を差し込む場所（中身は呼び出し側が渡す） */
export function ClaimPreview({ noteId, localRules }: { noteId: number; localRules?: ReactNode }) {
  const [claim, setClaim] = useState<Claim | null>(null);
  /** 要選択への答え（pending の id → 選択肢の id）と、選んだ選択肢の名前。保存はしない */
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState("");
  /** 試算に使う版（"" は選ばない＝診療年月の版での、今までどおりの判定） */
  const [rev, setRev] = useState("");
  /** 摘要欄の記載を入れたあとに読み直す */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ ...(Object.keys(choices).length ? { choices: JSON.stringify(choices) } : {}), ...(rev ? { rev } : {}) }).toString();
    const q = params ? `?${params}` : "";
    fetch(`/api/chart/${noteId}/claim${q}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "エラー");
        if (alive) setClaim(d as Claim);
      })
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [noteId, choices, rev, tick]);

  if (err) return <div className="notice warn">{err}</div>;
  if (!claim) return <div className="muted">算定行を組み立てています…</div>;

  const lacks = claim.pending.filter((p) => p.kind === "事実不足");
  const asks = claim.pending.filter((p) => p.kind === "要選択");
  const revisions = claim.revisions;

  return (
    <section aria-label="算定の見込み" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0 }}>
        算定行（{md(claim.date)} まで）{claim.totalStatus === "tentative" && <span className="badge sky" style={{ marginLeft: 8 }}>見込み</span>}
      </h3>
      <p className="muted" style={{ margin: 0 }}>
        確かめた事実と記録された出来事から、決まった規則で組み立てた行です。記録にないものは行にしていません。この確定は提出ではなく、件数にも数えません。
      </p>
      {revisions.length > 0 && (
        <label>
          <span className="muted">版を選んで試算する：</span>
          <select value={rev} onChange={(e) => { setRev(e.target.value); setChoices({}); setPicked([]); }} aria-label="試算に使う版">
            <option value="">選ばない（診療年月の版で判定）</option>
            {revisions.map((v) => <option key={v.id} value={v.id}>{v.label}{v.own ? "（診療年月の版）" : ""}</option>)}
          </select>
        </label>
      )}
      {claim.trial && (
        <div className="notice warn" role="note">
          <strong>
            診療年月 {ym(claim.trial.claimYearMonth)} の記録を、{revisions.find((v) => v.id === claim.trial!.revisionId)?.label ?? claim.trial.revisionId}の点数表とルールで試算しています。実際の請求の判定ではありません。
          </strong>
          {!claim.trial.inPeriod && <div>この診療年月は、この版の適用期間の外です。日付は記録のまま動かしていません。</div>}
          {(claim.notInRevision ?? []).length > 0 && <div>この版の点数表にない区分は、行にしていません：{claim.notInRevision!.join("、")}</div>}
        </div>
      )}
      <table className="emr-table">
        <thead>
          <tr><th>算定行</th><th>回数</th><th>点数</th><th>小計</th><th>根拠</th></tr>
        </thead>
        <tbody>
          {claim.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.name}
                {l.basis?.tentative && <span className="badge sky" style={{ marginLeft: 6 }}>見込み</span>}
                {/* 摘要欄に書くこと（コメントコードと値）。決まっていない記載は、医療事務がその場で値を入れる（FR-176） */}
                {l.comments.map((c, n) => (
                  <div key={n} className="muted" style={{ marginTop: 4 }}>
                    摘要欄に書くこと：{c.what}
                    {c.entries.map((e, m) => (
                      <div key={m} style={{ marginLeft: 12 }}>
                        {e.status === "ready"
                          ? <>コード {e.code}{e.text ? `「${e.text}」` : ""}{e.input && <>（入れた値）<CommentForm noteId={noteId} input={e.input} code={e.code} edit onSaved={() => setTick((t) => t + 1)} /></>}</>
                          : <><span className="badge warn">入力が要ります</span> {e.code ? `コード ${e.code}` : "当たるコードを選びます"}{e.input && <CommentForm noteId={noteId} input={e.input} code={null} onSaved={() => setTick((t) => t + 1)} />}</>}
                      </div>
                    ))}
                  </div>
                ))}
              </td>
              <td>{l.count}</td>
              <td>{l.points === null ? "—" : num(l.points)}</td>
              <td>{l.subtotal === null ? "—" : num(l.subtotal)}</td>
              <td className="muted">
                {l.basis ? (
                  <>
                    <div>{l.basis.events.join("、")}</div>
                    <div>{l.basis.rule}</div>
                    {l.basis.needs.length > 0 && <div>使った事実：{l.basis.needs.join("、")}</div>}
                  </>
                ) : (
                  "入力された行をそのまま通しています"
                )}
              </td>
            </tr>
          ))}
          {claim.lines.length === 0 && <tr><td colSpan={5} className="muted">行はまだありません。</td></tr>}
        </tbody>
      </table>

      {claim.total !== null ? (
        <div className="notice ok">
          <strong>合計{claim.totalStatus === "tentative" ? "（見込み）" : ""}：{num(claim.total)} 点</strong>
          {claim.totalStatus === "tentative" && <div>月の途中です。管理料の区分など、月末までに変わり得る行があります。</div>}
        </div>
      ) : (
        <div className="notice warn">
          <strong>合計は出していません。</strong>
          <div>まだ決まっていない行か、扱っていない区分があります。下の項目を確かめてください。</div>
        </div>
      )}

      {asks.map((p) => p.kind === "要選択" && (
        <div key={p.id} className="notice">
          <div><strong>選んでください：</strong>{p.text}</div>
          <div className="chips" role="group" aria-label={p.text} style={{ marginTop: 6 }}>
            {p.options.map((o) => (
              <button key={o.id} onClick={() => { setChoices({ ...choices, [p.id]: o.id }); setPicked([...picked, o.label]); }}>{o.label}</button>
            ))}
          </div>
          <div className="muted">選ぶまで、行にしません。</div>
        </div>
      ))}
      {picked.length > 0 && (
        <div className="muted">
          選んだ答え：{picked.join("、")}　<button onClick={() => { setChoices({}); setPicked([]); }}>選び直す</button>
        </div>
      )}
      {claim.staleChoices.length > 0 && <div className="notice warn">前の答えは使っていません（日付が変わったか、ほかの答えや確かめた事実で、その問いがなくなったため）。</div>}
      {lacks.map((p) => p.kind === "事実不足" && (
        <div key={p.id} className="notice warn">
          <div><strong>{p.reason ? "決められないこと：" : "確かめる事実："}</strong>{p.text}</div>
          {p.reason === "note14_conflict" || p.reason === "declaration_conflict" ? <div><a href={`/settings#declaration-${p.reason === "note14_conflict" ? "note14" : "building"}`}>施設の申告を見る</a></div> : p.reason ? null : <div>{p.target === "doctor" ? "医師確認で確かめます。" : p.text.startsWith("施設の設定") ? "事務長か責任者に確かめて、施設の設定に入力します。" : "医療事務が確かめて、患者情報に入力します。"}</div>}
          {p.blocks.length > 0 && <div className="muted">決まるまで行にしないもの：{p.blocks.join("、")}</div>}
        </div>
      ))}
      {claim.unsupported.map((u, i) => (
        <div key={i} className="notice warn"><strong>扱っていない区分：</strong>{u.text}</div>
      ))}
      {claim.notBilled.map((t, i) => (
        <div key={i} className="notice">{t}</div>
      ))}

      <h3 style={{ margin: 0 }}>ユスティの指摘</h3>
      <p className="muted" style={{ margin: 0 }}>{COMMENT_CHECK_NOTE}</p>
      {claim.rulesAvailable === false
        ? <p className="notice warn" style={{ margin: 0 }}>この版のルールは持っていません（算定行と点数だけ）。</p>
        : claim.findings.length === 0 && <p className="muted" style={{ margin: 0 }}>指摘はありません。</p>}
      {claim.findings.map((f, i) => (
        <div key={i} className="notice warn">
          <span className="badge warn">{f.kind}</span> {f.text}
          {f.lines.length > 0 && <div className="muted">対象の行：{f.lines.join("、")}</div>}
        </div>
      ))}

      <GenericFindings generic={claim.generic} scope="line" skippedLines={claim.generic.skippedLines} />
      <Torikawasure data={claim.torikawasure} />

      <h3 style={{ margin: 0 }}>患者情報の指摘</h3>
      {claim.patientFindings.length === 0 && <p className="muted" style={{ margin: 0 }}>確かめる点はありません。</p>}
      {claim.patientFindings.map((f, i) => (
        <div key={i} className="notice warn"><span className="badge">{f.kind}</span> {f.text}</div>
      ))}

      {localRules && <section aria-label="ローカルルール">{localRules}</section>}
    </section>
  );
}
