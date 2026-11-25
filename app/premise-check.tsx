"use client";
// 条件つきの指摘の「前提を確かめた」（採点 r4 医療事務課長 P1-1。POST /api/uke/claims/[claimId]/premise）。取り込んだレセプトの点検の画面で、条件つきの指摘の下に出す。
// 確かめた指摘は、全件の一覧の「残り」から外れる。誰がいつ確かめたかを出し、取り消せる。残せるのは医療事務（事務・ベテラン）。ほかの役割には状態だけを出す
import { useState } from "react";
import { PREMISE_OUTCOME_LABEL, PREMISE_OUTCOMES, type PremiseOutcome } from "../src/uke/premise";
import { useRole } from "./fact-input";

export type PremiseCheckView = { key: string; outcome: PremiseOutcome; by: string; at: string };

/** keys は、その指摘（まとめて出す指摘はその全部）の鍵。checks は、その請求でいま効いている確かめ */
export function PremiseCheckInput(props: { claimId: string; keys: string[]; checks: PremiseCheckView[]; onSaved: () => void }) {
  const role = useRole();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (props.keys.length === 0) return null;
  const done = props.keys.map((k) => props.checks.find((c) => c.key === k));
  const all = done.every((c) => c !== undefined) ? (done as PremiseCheckView[]) : null;
  const editable = role === "clerk" || role === "veteran";
  async function save(outcome: PremiseOutcome | null) {
    setErr("");
    setBusy(true);
    try {
      for (const key of props.keys) {
        const r = await fetch(`/api/uke/claims/${encodeURIComponent(props.claimId)}/premise`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, outcome }) });
        if (!r.ok) {
          const d = await r.json().catch(() => null);
          return setErr(d?.error ?? "エラー");
        }
      }
      props.onSaved();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ marginTop: 6 }}>
      {all ? (
        <span>
          <span className="badge ok">確かめ済み</span> {PREMISE_OUTCOME_LABEL[all[0].outcome]}（{all[0].by}・{all[0].at.slice(0, 10)}）。全件の一覧の「残り」には数えません。
          {all[0].outcome === "fix" && " レセコンの側で直して、取り込み直してください。"}
          {editable && <> <button disabled={busy} onClick={() => void save(null)}>取り消す</button></>}
        </span>
      ) : editable ? (
        <span>
          <span className="muted">前提を確かめたら残してください（全件の一覧の「残り」から外れます）：</span>{" "}
          {PREMISE_OUTCOMES.map((o) => <button key={o} disabled={busy} onClick={() => void save(o)} style={{ marginRight: 4 }}>{PREMISE_OUTCOME_LABEL[o]}</button>)}
        </span>
      ) : (
        <span className="muted">前提はまだ確かめていません（確かめるのは医療事務です）。</span>
      )}
      {err && <span className="notice warn">{err}</span>}
    </div>
  );
}
