"use client";
// 独自コードの対応表を選ぶ欄（design.md §16-2・16-6・16-7。C-443）：判定の外になった電子カルテの独自コードを、接続先・入力欄の種類・表示名・件数で並べ（患者・日は出さない。GET /api/code-maps）、
// 本人が名前で探す入口（GET /api/masters/search）からコードを選んで残す（POST /api/code-maps）。機器の欄は機器の種類の一覧から選ぶ。独自コードの種類ごとに 1 回。初期値は出さない
import { useEffect, useState } from "react";
import type { TableKey } from "../src/chart/acts";
import { DEVICE_KEYS, DEVICE_KINDS } from "../src/structured/devices";
import { getJson, postJson } from "./get-json";

type Unmapped = { connectorId: string; field: "薬" | "材料" | "行為" | "指導管理" | "機器"; extCode: string; names: string[]; count: number };
type Hit = { tbl: string; code: string; name: string };

const TABLE_OF: Record<Exclude<Unmapped["field"], "機器">, TableKey> = { 薬: "iyakuhin", 材料: "tokutei", 行為: "shinryo", 指導管理: "shinryo" };

export function CodeMapPanel({ yearMonth }: { yearMonth: string }) {
  const [list, setList] = useState<Unmapped[] | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    getJson<Unmapped[]>("/api/code-maps").then(setList).catch(() => setList(null));
  }, [n]);
  if (!list || list.length === 0) return null;
  return (
    <details>
      <summary>対応表にないコード：{list.reduce((s, x) => s + x.count, 0)} 件（{list.length} 種類。選ぶと次の点検から判定に使います）</summary>
      {list.map((u) => <MapRow key={`${u.connectorId}|${u.field}|${u.extCode}`} u={u} yearMonth={yearMonth} onSaved={() => setN((x) => x + 1)} />)}
    </details>
  );
}

function MapRow({ u, yearMonth, onSaved }: { u: Unmapped; yearMonth: string; onSaved: () => void }) {
  const [q, setQ] = useState(u.names[0] ?? "");
  const [hits, setHits] = useState<Hit[]>([]);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  async function search() {
    if (u.field === "機器" || q.trim() === "") return;
    setMsg("");
    try {
      setHits(await getJson<Hit[]>(`/api/masters/search?${new URLSearchParams({ table: TABLE_OF[u.field], ym: yearMonth, q })}`));
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function save() {
    setMsg("");
    try {
      await postJson("/api/code-maps", { connectorId: u.connectorId, field: u.field, extCode: u.extCode, code, yearMonth });
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div className="notice">
      <div>{u.field}：{u.names.length > 0 ? u.names.map((x) => `「${x}」`).join("") : "（表示名なし）"}（独自コード {u.extCode}・{u.count} 件）</div>
      <div className="chips">
        {u.field === "機器" ? (
          <select value={code} aria-label="機器の種類" onChange={(e) => setCode(e.target.value)}>
            <option value="">機器の種類を選ぶ</option>
            {DEVICE_KEYS.map((k) => <option key={k} value={k}>{DEVICE_KINDS[k].names[0]}</option>)}
          </select>
        ) : (
          <>
            <input value={q} aria-label="名前で探す" onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
            <button onClick={search}>探す</button>
            <select value={code} aria-label="対応するコード" onChange={(e) => setCode(e.target.value)}>
              <option value="">選ぶ</option>
              {hits.map((h) => <option key={`${h.tbl}:${h.code}`} value={h.code}>{h.name}</option>)}
            </select>
          </>
        )}
        <button disabled={code === ""} onClick={save}>対応を残す</button>
      </div>
      {msg && <div className="muted">{msg}</div>}
    </div>
  );
}
