"use client";
// 施設の設定（spec FR-148。design.md §2-7・§6-1）：事務長にだけ、設定の画面が出す欄。三値の項目を、このクリニックの値として残す（「分からない」に戻すこともできる）。
// 残した値は、症例ごとの上書きがない請求の判定に効く。残した操作は監査ログに項目の名前で残る（値は残さない）
import { useEffect, useState } from "react";
import type { FacilityFactKey } from "../../src/engine/types";
import { FACILITY_LABEL } from "../../src/messages";
import { getJson, postJson } from "../get-json";

type Value = string | boolean | null;
type Settings = { items: { key: FacilityFactKey; value: Value; saved: boolean }[] };

const YES_NO: [string, string][] = [["true", "はい"], ["false", "いいえ"]];
/** 項目ごとの選択肢（値の文字列 → 表示）。どの項目にも「分からない」を足す */
const OPTIONS: Record<FacilityFactKey, [string, string][]> = {
  dxTier: [["1", "加算1"], ["2", "加算2"], ["なし", "届出なし"]],
  baseUp: [["通常", "通常の区分"], ["注5", "注5 の区分"], ["なし", "届出なし"]],
  priceResponse: YES_NO,
  note16Met: YES_NO,
  revisitBaseUpSameDay: YES_NO,
  revisitPriceSameDay: YES_NO,
};
const UNKNOWN = "unknown";
const toText = (v: Value) => (v === null ? UNKNOWN : String(v));
const fromText = (key: FacilityFactKey, s: string): Value => (s === UNKNOWN ? null : key === "dxTier" || key === "baseUp" ? s : s === "true");
const labelOf = (key: FacilityFactKey, v: Value) => (v === null ? "分からない" : (OPTIONS[key].find(([x]) => x === String(v))?.[1] ?? String(v)));

function Item(props: { item: Settings["items"][number]; onSaved: (s: Settings) => void }) {
  const { key, value, saved } = props.item;
  const [pick, setPick] = useState(toText(value));
  const [err, setErr] = useState("");
  async function save() {
    setErr("");
    try {
      props.onSaved(await postJson<Settings>("/api/facility", { key, value: fromText(key, pick) }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <li id={`facility-${key}`} style={{ marginBottom: 8 }}>
      <div>{FACILITY_LABEL[key]}</div>
      <div className="muted">いまの値：{labelOf(key, value)}（{saved ? "このクリニックで残した値" : "既定値のまま"}）</div>
      <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <select aria-label={FACILITY_LABEL[key]} value={pick} onChange={(e) => setPick(e.target.value)}>
          {OPTIONS[key].map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          <option value={UNKNOWN}>分からない</option>
        </select>
        <button disabled={pick === toText(value)} onClick={() => void save()}>残す</button>
        {err && <span className="notice warn">{err}</span>}
      </span>
    </li>
  );
}

export function Facility() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<Settings>("/api/facility").then(setSettings).catch((e: Error) => setErr(e.message));
  }, []);
  // 案内のリンク（#facility-<項目>）で開いたときは、読み込んだあとにその項目まで動かす
  useEffect(() => {
    if (settings && location.hash.startsWith("#facility-")) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [settings]);
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>施設の設定</h3>
      <p className="muted">判定に使う、このクリニックの届出と基準です。確かめられないものは「分からない」にします（その項目に関わる点検は「情報不足」になります）。残した操作は記録に残ります。</p>
      {err && <div className="notice warn">{err}</div>}
      {settings && (
        <ul style={{ paddingLeft: 18 }}>
          {settings.items.map((it) => <Item key={`${it.key}-${toText(it.value)}-${it.saved}`} item={it} onSaved={setSettings} />)}
        </ul>
      )}
    </div>
  );
}
