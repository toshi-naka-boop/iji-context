"use client";
// ログインしている本人（spec FR-72）。サーバーはセッションで本人を決めるので、画面から送る利用者 id は使われない
import { useEffect, useState } from "react";

/** tenant の中の本人の医療事務 id（サーバーの ME と同じ。画面の表示とキーにだけ使う） */
const ME = "new1";

/** いまログインしている人。していなければログイン画面へ移る */
export function useClerk() {
  const [clerk, setClerk] = useState<{ id: string; name: string; login: string } | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        if (u) setClerk({ id: ME, name: u.name, login: u.login });
        else window.location.href = "/login";
      })
      .catch(() => (window.location.href = "/login"))
      .finally(() => setReady(true));
  }, []);
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }
  return { clerk, ready, logout, switchUser: logout };
}

/** ログインしていないときの表示（すぐログイン画面へ移る） */
export function SignIn() {
  return (
    <div className="panel">
      <p>ログイン画面へ移ります。<a href="/login">移らないときはこちら</a></p>
    </div>
  );
}
