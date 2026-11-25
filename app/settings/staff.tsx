"use client";
// 職員（採点 r1 事務長 #2）：事務長とクリニックの持ち主にだけ、設定の画面が出す欄。2 人以上で使っているクリニックで出す（1 人のあいだは「役割」の欄で切り替える）。
// 役割を変える・停止する・再開する・持ち主を引き継ぐ（持ち主だけ。パスワードを入れ直す）。停止した人はログインできず、いまのセッションも切れる。事務長がいなくなる操作はサーバーが断る
import { useEffect, useState } from "react";
import { ROLES, ROLE_LABELS, type Role } from "../../src/server/roles";

type Member = { id: string; login: string; name: string; role: Role; owner: boolean; self: boolean; disabled: boolean };

/** isOwner は、自分がクリニックの持ち主か（持ち主だけが、持ち主をほかの事務長に引き継げる） */
export function Staff({ real, isOwner, onOwnerChanged }: { real: boolean; isOwner: boolean; onOwnerChanged: () => void }) {
  const [list, setList] = useState<Member[]>([]);
  /** 持ち主を引き継ぐ相手と、確かめに入れ直す自分のパスワード */
  const [handTo, setHandTo] = useState<Member | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () =>
    fetch("/api/staff")
      .then((r) => (r.ok ? r.json() : []))
      .then(setList)
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);
  async function send(url: string, body?: unknown) {
    setErr("");
    setBusy(true);
    try {
      const r = await fetch(url, { method: "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setErr(d.error ?? "エラー");
    } catch {
      setErr("通信できませんでした。もう一度試してください");
    } finally {
      setBusy(false);
      load();
    }
  }
  async function transfer() {
    if (!handTo) return;
    setErr("");
    setBusy(true);
    try {
      const r = await fetch(`/api/staff/${handTo.id}/owner`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setErr(d.error ?? "引き継げませんでした");
      setHandTo(null);
      onOwnerChanged();
    } catch {
      setErr("通信できませんでした。もう一度試してください");
    } finally {
      setPassword("");
      setBusy(false);
      load();
    }
  }
  function suspend(m: Member) {
    if (!window.confirm(`${m.name}（${m.login}）を停止します。この人はログインできなくなり、いま開いている画面も使えなくなります。再開すると、また使えます。停止しますか？`)) return;
    send(`/api/staff/${m.id}/suspend`);
  }
  /** 実在のデータで使うクリニックでは、医師の役割は招待で決まる（変えない・変えさせない） */
  const choices = (m: Member) => (real ? (m.role === "doctor" ? [] : ROLES.filter((r) => r !== "doctor")) : ROLES);
  return (
    <div className="panel" style={{ margin: "16px 0" }}>
      <h3 style={{ marginTop: 0 }}>職員</h3>
      <p className="muted">
        このクリニックで使っている人の一覧です。辞めた人は停止してください（ログインできなくなり、いまのセッションも切れます）。役割の変更・停止・再開は記録に残ります。
        事務長がいなくなる操作はできません。{real ? "実在のデータで使うクリニックでは、医師の役割は医師の招待で入った人だけで、ここでは変えられません。" : ""}
      </p>
      {err && <div className="notice warn">{err}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ minWidth: 520 }}>
          <thead>
            <tr><th>名前</th><th>ログイン ID</th><th>役割</th><th>状態</th><th></th></tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.id}>
                <td>{m.name}{m.self ? "（自分）" : ""}{m.owner ? <span className="badge" style={{ marginLeft: 4 }}>持ち主</span> : null}</td>
                <td>{m.login}</td>
                <td>
                  {choices(m).length === 0 ? (
                    ROLE_LABELS[m.role]
                  ) : (
                    <select aria-label={`${m.name}の役割`} value={m.role} disabled={busy} onChange={(e) => send(`/api/staff/${m.id}/role`, { role: e.target.value })}>
                      {choices(m).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  )}
                </td>
                <td>{m.disabled ? <span className="badge warn">停止中</span> : <span className="badge sky">使用中</span>}</td>
                <td>
                  {m.disabled ? (
                    <button onClick={() => send(`/api/staff/${m.id}/resume`)} disabled={busy}>再開する</button>
                  ) : (
                    !m.self && !m.owner && <button onClick={() => suspend(m)} disabled={busy}>停止する</button>
                  )}
                  {isOwner && !m.self && !m.disabled && m.role === "manager" && (
                    <button onClick={() => { setHandTo(m); setPassword(""); setErr(""); }} disabled={busy} style={{ marginLeft: 4 }}>持ち主を引き継ぐ</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isOwner && handTo && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          <p style={{ marginTop: 0 }}>
            持ち主を {handTo.name}（{handTo.login}）に引き継ぎます。引き継ぐと、クリニックを消す操作と持ち主の引き継ぎは {handTo.name} だけができるようになり、あなたは職員の 1 人になります（役割は今のまま。停止もできるようになります）。自分では元に戻せません。
          </p>
          <label>
            確かめのため、あなたのパスワードを入れてください：
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="確かめのパスワード" autoComplete="current-password" style={{ marginLeft: 4 }} />
          </label>
          <div className="chips" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy || password === ""} onClick={transfer}>持ち主を引き継ぐ</button>
            <button onClick={() => { setHandTo(null); setPassword(""); }} disabled={busy}>やめる</button>
          </div>
        </div>
      )}
    </div>
  );
}
