// API Route の共通処理：例外を 400 の JSON にする
export async function handle(fn: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function body<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}
