"use client";
// 招待（spec FR-137）：招待を作れる人（事務長と、1 人で使っているクリニックの持ち主）にだけ、設定の画面が出す欄。
// 招待コードは発行した直後の 1 回だけ表示する（サーバーはハッシュしか持たないので、あとから表示し直せない）。一覧にコードは出ない
import { useEffect, useState } from "react";
import { ROLES, ROLE_LABELS, type Role } from "../../src/server/roles";

type Invite = { id: string; role: Role; createdAt: string; expiresAt: string; used: boolean; expired: boolean };
type Issued = { code: string; role: Role; expiresAt: string };

const when = (iso: string) => new Date(iso).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export function Invites() {
  const [role, setRole] = useState<Role>("clerk");
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState("");
  const [list, setList] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () =>
    fetch("/api/invites")
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
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error ?? "エラー");
        return null;
      }
      return d;
    } catch {
      setErr("通信できませんでした。もう一度試してください");
      return null;
    } finally {
      setBusy(false);
      load();
    }
  }
  async function issue() {
    const d = (await send("/api/invites", { role })) as Issued | null;
    if (!d) return;
    setCopied("");
    setIssued(d);
  }
  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied("コピーしました");
    } catch {
      setCopied("コピーできませんでした。コードを選んでコピーしてください");
    }
  }
  return (
    <div className="panel" style={{ margin: "16px 0" }}>
      <h3 style={{ marginTop: 0 }}>招待</h3>
      <p className="muted">招待コードを受け取った人は、このクリニックに、選んだ役割で登録できます。コードは 1 回だけ使え、期限があります。</p>
      {err && <div className="notice warn">{err}</div>}
      <div className="chips" role="radiogroup" aria-label="招待する人の役割">
        {ROLES.map((r) => (
          <button key={r} role="radio" aria-checked={role === r} className={role === r ? "primary" : ""} onClick={() => setRole(r)}>{ROLE_LABELS[r]}</button>
        ))}
      </div>
      <p><button onClick={issue} disabled={busy}>{ROLE_LABELS[role]}の招待コードを発行する</button></p>
      {issued && (
        <div className="notice ok" aria-live="polite">
          <div>招待コード（{ROLE_LABELS[issued.role]}）</div>
          <div className="num" style={{ fontSize: 18, overflowWrap: "anywhere", userSelect: "all", margin: "4px 0" }}>{issued.code}</div>
          <div className="chips" style={{ alignItems: "center" }}>
            <button onClick={() => copy(issued.code)}>コピーする</button>
            <button onClick={() => { setIssued(null); setCopied(""); }}>表示を消す</button>
            {copied && <span>{copied}</span>}
          </div>
          <div style={{ fontSize: 13, marginTop: 6 }}>このコードが表示されるのは今だけです。あとから表示し直すことはできません。期限は {when(issued.expiresAt)} まで。1 回だけ使えます。</div>
        </div>
      )}
      <h4 style={{ marginBottom: 4 }}>発行済みの招待</h4>
      {list.length === 0 ? (
        <p className="muted">発行済みの招待はありません。</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ minWidth: 480 }}>
            <thead>
              <tr><th>役割</th><th>発行</th><th>期限</th><th>状態</th><th></th></tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id}>
                  <td>{ROLE_LABELS[i.role]}</td>
                  <td>{when(i.createdAt)}</td>
                  <td>{when(i.expiresAt)}</td>
                  <td>{i.used ? <span className="badge">使用済み</span> : i.expired ? <span className="badge warn">期限切れ</span> : <span className="badge sky">未使用</span>}</td>
                  <td>{!i.used && <button onClick={() => send(`/api/invites/${i.id}/revoke`)} disabled={busy}>取り消す</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
