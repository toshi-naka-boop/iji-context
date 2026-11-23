"use client";
// 注14 の計算の道具（design.md §15-13。FR-204）：確認月の期間の回数を数え、注14 の基準に当たるかを確かめる。判定を変えない入力の画面で、申告は書き換えない（L-132）。
// 点数・金額は出さない（回数・人数・割合の比較だけ）。結果を残せるのは事務長と責任者
import { useEffect, useMemo, useState } from "react";
import { TopBar } from "../nav";
import { PageGuide } from "../page-guide";
import { getJson, postJson } from "../get-json";
import type { Declarations } from "../settings/facility";
import { NOTE14_TEXT } from "../../src/facility/note14";
import { evaluate, FIELD_LABEL, type Evaluation, type Institution, type Note14Consts, type Period, type WorksheetInput } from "../../src/note14/evaluate";

type Auto = { month: string; state: "ok" | "none" | "no_table" | "overlap"; receipts: number; kou?: number; otsuExtra?: number; text?: string };
type Saved = { id: number; checkMonth: string; isCheckMonth: boolean; period: Period; result: "meets" | "not_meets" | "undecided"; splits: string[]; lines: string[]; reasons: string[]; remaining: number | null; checkedBy: string; checkedOn: string; draft: boolean; note?: string };
type Tool = { month: string | null; outOfScope: boolean; text?: string; isCheckMonth?: boolean; note?: string; period?: Period; consts?: Note14Consts; auto?: Auto[]; worksheets?: Saved[] };

const RESULT_LABEL = { meets: "基準に当たる（減算になりません）", not_meets: "基準に当たらない（減算になります）", undecided: "決めきれない" } as const;
type MonthInput = { confirmed: boolean; kou: string; otsuExtra: string };
type InstInput = { openedOn: string; changed: boolean; ownerChangedFrom: string; count: string };

const num = (s: string): number | null => (s.trim() === "" || !/^\d+$/.test(s.trim()) ? null : Number(s.trim()));
const periodText = (p: Period) => `3 か月 ${p.short.from}〜${p.short.to}・1 年 ${p.long.from}〜${p.long.to}`;

function NumberInput(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      {props.label}
      <input inputMode="numeric" aria-label={props.label} style={{ width: 90 }} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </label>
  );
}

function ResultView(props: { e: Evaluation }) {
  const { e } = props;
  if (e.status === "incomplete") return <div className="notice warn">空の欄があるので、結果を出していません：{e.missing.join("、")}</div>;
  return (
    <div className={`notice ${e.result === "undecided" ? "warn" : ""}`}>
      <div>
        {RESULT_LABEL[e.result]}
        {e.reasons.length > 0 && e.result === "undecided" ? `（${e.reasons.join("・")}）` : ""}
      </div>
      {e.remaining !== null && <div>門まであと {e.remaining} 回（読みのうち小さいほう）</div>}
      {e.lines.map((l) => <div key={l}>{l}</div>)}
    </div>
  );
}

export default function Note14Page() {
  const [month, setMonth] = useState("");
  const [tool, setTool] = useState<Tool | null>(null);
  const [decl, setDecl] = useState<Declarations | null>(null);
  const [err, setErr] = useState("");
  const [months, setMonths] = useState<Record<string, MonthInput>>({});
  const [gansou, setGansou] = useState("");
  const [second, setSecond] = useState("");
  const [special, setSpecial] = useState<"none" | "some" | "unknown">("none");
  const [insts, setInsts] = useState<InstInput[]>([]);
  const [saved, setSaved] = useState<Saved | null>(null);

  function load(m?: string) {
    setErr("");
    getJson<Tool>(`/api/note14${m ? `?month=${encodeURIComponent(m)}` : ""}`)
      .then((t) => {
        setTool(t);
        if (t.month) setMonth(t.month);
        setMonths(Object.fromEntries((t.auto ?? []).map((a) => [a.month, { confirmed: false, kou: "", otsuExtra: "" }])));
        setSaved(null);
      })
      .catch((e: Error) => setErr(e.message));
  }
  useEffect(() => {
    const q = new URLSearchParams(location.search).get("month");
    load(q ?? undefined);
    getJson<Declarations>("/api/facility/declaration").then(setDecl).catch(() => {});
  }, []);

  const input: WorksheetInput | null = useMemo(() => {
    if (!tool?.auto) return null;
    return {
      stage1: {
        months: tool.auto.map((a) => {
          const m = months[a.month] ?? { confirmed: false, kou: "", otsuExtra: "" };
          return m.confirmed && a.state === "ok" ? { month: a.month, kou: a.kou!, otsuExtra: a.otsuExtra!, source: "auto" as const } : { month: a.month, kou: num(m.kou), otsuExtra: num(m.otsuExtra), source: "manual" as const };
        }),
        gansou: num(gansou),
        secondPatient: num(second),
        special,
        institutions: insts.map((i): Institution => ({ openedOn: i.openedOn || null, ownerChangedFrom: i.changed ? i.ownerChangedFrom || null : null, count: num(i.count) })),
      },
    };
  }, [tool, months, gansou, second, special, insts]);
  const e = input && tool?.consts ? evaluate(input, tool.consts) : null;

  async function save() {
    if (!input || !tool?.month) return;
    setErr("");
    try {
      const body = {
        checkMonth: tool.month,
        stage1: { ...input.stage1, months: tool.auto!.map((a) => ({ month: a.month, confirmed: (months[a.month]?.confirmed ?? false) && a.state === "ok", kou: num(months[a.month]?.kou ?? ""), otsuExtra: num(months[a.month]?.otsuExtra ?? "") })) },
      };
      const s = await postJson<Saved>("/api/note14/worksheets", body);
      setSaved(s);
      setTool((t) => (t ? { ...t, worksheets: [...(t.worksheets ?? []), s] } : t));
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  const blocked = decl?.note14.state === "block";
  const setM = (m: string, patch: Partial<MonthInput>) => setMonths((p) => ({ ...p, [m]: { ...(p[m] ?? { confirmed: false, kou: "", otsuExtra: "" }), ...patch } }));

  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="suit" title="注14 の計算表">
        確認月ごとに、注14（単一建物 10 人以上の区分の点数）の基準に当たるかを数えます。取り込んだ UKE から数えた回数は、月ごとに「全患者分を取り込んだ」を確かめた月だけ使います。明文のない点は、読みの両方で計算し、割れたら「決めきれない」と出します。この画面は申告を書き換えません。
      </PageGuide>
      {err && <div className="notice warn">{err}</div>}
      <div className="panel">
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          確認月
          <input type="month" aria-label="確認月" value={month} onChange={(x) => setMonth(x.target.value)} />
        </label>
        <button style={{ marginLeft: 6 }} disabled={month === ""} onClick={() => load(month)}>この月で開く</button>
        {tool?.outOfScope && <div className="notice warn">{tool.text}</div>}
        {tool?.note && <div className="notice">{tool.note}</div>}
        {tool?.period && <p className="muted">使った期間：{periodText(tool.period)}</p>}
      </div>
      {tool?.auto && tool.consts && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>1 段目：回数の門</h3>
          <ul style={{ paddingLeft: 18 }}>
            {tool.auto.map((a) => {
              const m = months[a.month] ?? { confirmed: false, kou: "", otsuExtra: "" };
              return (
                <li key={a.month} style={{ marginBottom: 6 }}>
                  <strong>{a.month}</strong>
                  {a.state === "ok" ? (
                    <>
                      取り込んだレセプト {a.receipts} 件から数えた：甲 {a.kou} 回・乙 {a.kou! + a.otsuExtra!} 回
                      <label><input type="checkbox" checked={m.confirmed} onChange={(x) => setM(a.month, { confirmed: x.target.checked })} />この月は全患者分を取り込んだ</label>
                    </>
                  ) : (
                    <span className="muted">{a.text}</span>
                  )}
                  {!(m.confirmed && a.state === "ok") && (
                    <span style={{ display: "inline-flex", gap: 6, marginLeft: 6 }}>
                      <NumberInput label="C001 の行の回数" value={m.kou} onChange={(v) => setM(a.month, { kou: v })} />
                      <NumberInput label="C001-2 の行の回数" value={m.otsuExtra} onChange={(v) => setM(a.month, { otsuExtra: v })} />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <h4>読み乙だけで数に入るもの（期間の合計。空の欄は 0 と数えません）</h4>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <NumberInput label={FIELD_LABEL.gansou} value={gansou} onChange={setGansou} />
            <NumberInput label={FIELD_LABEL.secondPatient} value={second} onChange={setSecond} />
            <button onClick={() => { setGansou("0"); setSecond("0"); }}>どちらも 0（ない）にする</button>
          </div>
          <h4>特別の関係にある保険医療機関</h4>
          <select aria-label="特別の関係にある保険医療機関" value={special} onChange={(x) => setSpecial(x.target.value as typeof special)}>
            <option value="none">ない</option>
            <option value="some">ある</option>
            <option value="unknown">分からない</option>
          </select>
          <span className="muted">　特別の関係に当たるかは、アプリは判定しません。</span>
          {special === "some" && (
            <ul style={{ paddingLeft: 18 }}>
              {insts.map((i, n) => {
                const up = (patch: Partial<InstInput>) => setInsts((p) => p.map((x, j) => (j === n ? { ...x, ...patch } : x)));
                return (
                  <li key={n} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    機関 {n + 1}
                    <label>開設日 <input type="date" aria-label={`機関 ${n + 1} の開設日`} value={i.openedOn} onChange={(x) => up({ openedOn: x.target.value })} /></label>
                    <label><input type="checkbox" checked={i.changed} onChange={(x) => up({ changed: x.target.checked })} />開設者の変更がある</label>
                    {i.changed && <label>元の機関が最初に開設した日 <input type="date" aria-label={`機関 ${n + 1} の元の開設日`} value={i.ownerChangedFrom} onChange={(x) => up({ ownerChangedFrom: x.target.value })} /></label>}
                    <NumberInput label="期間の回数" value={i.count} onChange={(v) => up({ count: v })} />
                    <button onClick={() => setInsts((p) => p.filter((_, j) => j !== n))}>外す</button>
                  </li>
                );
              })}
              <li style={{ listStyle: "none" }}><button onClick={() => setInsts((p) => [...p, { openedOn: "", changed: false, ownerChangedFrom: "", count: "" }])}>機関を足す</button></li>
            </ul>
          )}
        </div>
      )}
      {e && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>結果（まだ残していません）</h3>
          <ResultView e={e} />
          <button className="primary" disabled={e.status !== "done"} onClick={() => void save()}>結果を残す</button>
        </div>
      )}
      {tool?.worksheets && tool.worksheets.length > 0 && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>この確認月の結果（残した順）</h3>
          <ul style={{ paddingLeft: 18 }}>
            {tool.worksheets.map((w) => (
              <li key={w.id} style={{ marginBottom: 6 }}>
                {w.checkedOn}　{w.checkedBy}：{RESULT_LABEL[w.result]}{w.reasons.length > 0 && w.result === "undecided" ? `（${w.reasons.join("・")}）` : ""}　使った期間：{periodText(w.period)}
                {w.lines.map((l) => <div key={l} className="muted">{l}</div>)}
                {w.note && <div className="muted">{w.note}</div>}
                {w.draft && <div><a href={`/settings?note14Draft=${w.id}#declaration-note14`}>申告の下書きを開く</a></div>}
              </li>
            ))}
          </ul>
          {saved && <div className="notice ok">結果を残しました。</div>}
          {/* 道具の結果によらず note14 を「変わりなし」で確かめ直せる（round-57 C-320）。ただし減算になる結果のまま申告が通常なら出さない（C-342。L-155） */}
          {decl && (blocked ? <div className="notice warn">{NOTE14_TEXT.differs}。<a href="/settings#declaration-note14">申告の画面を開く</a></div> : <div><a href={`/settings?confirmMonth=${encodeURIComponent(decl.today.slice(0, 7))}&item=note14#declaration-confirm`}>今の請求の仕方は変わりなし（注14 の申告を確かめ直す）</a>{decl.note14.state === "differs" ? `（${NOTE14_TEXT.differs}）` : ""}</div>)}
        </div>
      )}
    </main>
  );
}
