// 画面からの GET。成功でない応答（役割が足りない 403 など）は例外にして、応答の本文を画面の状態に入れない
export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error ?? "読み込めませんでした。時間をおいて、もう一度試してください");
  return d as T;
}

// 画面からの POST（JSON の本文）。getJson と同じく、成功でない応答は例外にする。本文が JSON でない応答（ゲートウェイの 502・504 の HTML など）でも、決まった文にする
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error ?? "うまくいきませんでした。時間をおいて、もう一度試してください");
  return d as T;
}
