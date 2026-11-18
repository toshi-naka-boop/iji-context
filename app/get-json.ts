// 画面からの GET。成功でない応答（役割が足りない 403 など）は例外にして、応答の本文を画面の状態に入れない
export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error ?? "読み込めませんでした。時間をおいて、もう一度試してください");
  return d as T;
}
