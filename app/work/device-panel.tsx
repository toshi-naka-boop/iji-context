"use client";
// 患者の情報の「在宅療養で使っている機器」欄（design.md §16-5・16-7。段 19e）：診療年月に効く行（出どころの印つき）・変更の記録・「機器なし」・電子カルテからの変える案。
// 正は患者の情報の 1 か所。電子カルテの指示は変える案として並べ、医療事務が「入れる／入れない」を選ぶまで判定に使わない（黙って上書きしない）。材料加算の候補はこの欄の行だけから出す
import { useEffect, useState } from "react";
import { C150_BANDS, DEVICE_KEYS, DEVICE_KINDS, type DeviceKey } from "../../src/structured/devices";
import { getJson, postJson } from "../get-json";

type Live = { kind: DeviceKey; fromMonth: string; endMonth: string | null; c150?: { band: string; patientClass: "イ" | "ロ" }; source: string };
type Hist = Omit<Live, "kind"> & { kind: DeviceKey | "none" };
type Proposal = { id: number; kind: DeviceKey | null; startedOn: string | null; endedOn: string | null; type: "start" | "end" | "choose"; receivedAt: string };
type View = { yearMonth: string; checked: boolean; live: Live[]; history: Hist[]; proposals: Proposal[] };

const nameOf = (k: DeviceKey | "none") => (k === "none" ? "機器なし" : DEVICE_KINDS[k].names[0]);
const C150_LABEL: Record<string, string> = { C150_1: "月 20 回以上", C150_2: "月 30 回以上", C150_3: "月 40 回以上", C150_4: "月 60 回以上", C150_5: "月 90 回以上", C150_6: "月 120 回以上", C150_7: "間歇スキャン式持続血糖測定器" };
const c150Text = (c?: { band: string; patientClass: string }) => (c ? `（${C150_LABEL[c.band] ?? c.band}・${c.patientClass}）` : "");

/** 血糖自己測定器の区分と患者の区分を選ぶ欄 */
function C150Pick(props: { band: string; cls: string; onBand: (v: string) => void; onCls: (v: string) => void }) {
  return (
    <>
      <select value={props.band} onChange={(e) => props.onBand(e.target.value)}>
        <option value="">測定回数の区分を選ぶ</option>
        {Object.keys(C150_BANDS).map((b) => <option key={b} value={b}>{C150_LABEL[b]}</option>)}
      </select>
      <select value={props.cls} onChange={(e) => props.onCls(e.target.value)}>
        <option value="">患者の区分を選ぶ</option>
        <option value="イ">イ（1 型糖尿病・膵全摘後以外）</option>
        <option value="ロ">ロ（1 型糖尿病等）</option>
      </select>
    </>
  );
}

function ProposalRow({ claimId, p, onDone }: { claimId: string; p: Proposal; onDone: () => void }) {
  const [kind, setKind] = useState<string>(p.kind ?? "");
  const [band, setBand] = useState("");
  const [cls, setCls] = useState("");
  const [err, setErr] = useState("");
  const answer = async (action: "accept" | "reject") => {
    setErr("");
    try {
      await postJson(`/api/patient/device-proposals/${p.id}`, { claimId, action, ...(p.kind === null && kind ? { kind } : {}), ...(kind === "C150" && band && cls ? { c150: { band, patientClass: cls } } : {}) });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "エラー");
    }
  };
  const what = p.type === "end" ? `${nameOf(p.kind!)}の終わり${p.endedOn ? `（${p.endedOn}）` : "（指示にありません）"}` : p.type === "choose" ? "種類を選んでください" : `${nameOf(p.kind!)}${p.startedOn ? `（${p.startedOn} から）` : ""}`;
  return (
    <li>
      電子カルテから：{what}{" "}
      {p.kind === null && (
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">種類を選ぶ</option>
          {DEVICE_KEYS.map((k) => <option key={k} value={k}>{nameOf(k)}</option>)}
        </select>
      )}
      {kind === "C150" && <C150Pick band={band} cls={cls} onBand={setBand} onCls={setCls} />}
      <button onClick={() => void answer("accept")}>入れる</button> <button onClick={() => void answer("reject")}>入れない</button>
      {err && <span className="notice warn">{err}</span>}
    </li>
  );
}

export function DevicePanel(props: { claimId: string; editable: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [kind, setKind] = useState<string>("");
  const [fromMonth, setFromMonth] = useState("");
  const [endMonth, setEndMonth] = useState("");
  const [band, setBand] = useState("");
  const [cls, setCls] = useState("");
  const [err, setErr] = useState("");
  const load = () => getJson<View>(`/api/patient/devices?claimId=${encodeURIComponent(props.claimId)}`).then(setView).catch(() => setView(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.claimId]);
  if (!view) return null;
  // 「機器なし」を入れる前に、終わらせる行を見せる（16-5）
  const ending = kind === "none" ? view.live : [];
  async function save() {
    setErr("");
    if (kind === "none" && ending.length > 0 && !window.confirm(`${ending.map((r) => nameOf(r.kind)).join("・")}の ${ending.length} 件を ${fromMonth} で終わらせます`)) return;
    try {
      await postJson("/api/patient/devices", { claimId: props.claimId, kind, fromMonth, ...(endMonth ? { endMonth } : {}), ...(kind === "C150" && band && cls ? { c150: { band, patientClass: cls } } : {}) });
      setKind("");
      setEndMonth("");
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "エラー");
    }
  }
  return (
    <div id="patient-devices">
      <h4>在宅療養で使っている機器（{view.yearMonth} の診療月）</h4>
      {!view.checked && <p className="muted" style={{ margin: 0 }}>機器を確かめていません。確かめるまで、在宅療養指導管理材料加算は見ていません。</p>}
      {view.checked && view.live.length === 0 && <p className="muted" style={{ margin: 0 }}>この月に効く機器はありません（機器なし）。</p>}
      <ul>
        {view.live.map((r) => (
          <li key={r.kind}>
            {nameOf(r.kind)}{c150Text(r.c150)}：{r.fromMonth} の診療月から{r.endMonth ? `、${r.endMonth} まで` : ""}（{r.source}）
          </li>
        ))}
      </ul>
      {view.proposals.length > 0 && (
        <>
          <p style={{ margin: 0 }}>電子カルテから届いた変える案：{view.proposals.length} 件（入れるまで判定に使いません）</p>
          <ul>{view.proposals.map((p) => <ProposalRow key={p.id} claimId={props.claimId} p={p} onDone={() => void load()} />)}</ul>
        </>
      )}
      {props.editable && (
        <div className="row">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">機器の種類を選ぶ</option>
            {DEVICE_KEYS.map((k) => <option key={k} value={k}>{nameOf(k)}</option>)}
            <option value="none">機器なし</option>
          </select>
          {kind === "C150" && <C150Pick band={band} cls={cls} onBand={setBand} onCls={setCls} />}
          <label>いつの診療月から <input type="month" value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} /></label>
          {kind !== "none" && <label>終わりの月 <input type="month" value={endMonth} onChange={(e) => setEndMonth(e.target.value)} /></label>}
          <button disabled={!kind || !fromMonth} onClick={() => void save()}>残す</button>
          {err && <span className="notice warn">{err}</span>}
        </div>
      )}
      {view.history.length > 0 && (
        <details>
          <summary>変更の記録：{view.history.length} 件</summary>
          <ul>{view.history.map((r, i) => <li key={i}>{nameOf(r.kind)}{c150Text(r.c150)}：{r.fromMonth} から{r.endMonth ? `、${r.endMonth} まで` : ""}（{r.source}）</li>)}</ul>
        </details>
      )}
    </div>
  );
}
