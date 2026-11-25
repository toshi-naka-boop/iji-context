// Agent SDK の差し替え（テストは AI を呼ばない）。query だけを置き換え、送られたもの（プロンプトと options）を残す。
// 外部へ送る処理は src/llm/outbound.ts だけが SDK を呼ぶので、ここで見えるものが「AI に送る文」の全部になる
export type SdkCall = { prompt: unknown; options: Record<string, unknown> };

/**
 * real（本物の SDK）の query を差し替えたものを返す。respond が返した値の structured を、返事（structured_output）として 1 つ流す。
 * 添付つきのプロンプト（画像・PDF）は、流れを読み切って中身を残す
 */
export function fakeSdk<T extends object>(real: T, respond: (call: SdkCall) => unknown, calls: SdkCall[] = []): T {
  const query = ({ prompt, options }: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) =>
    (async function* () {
      let sent: unknown = prompt;
      if (typeof prompt !== "string") {
        const parts: unknown[] = [];
        for await (const m of prompt) parts.push(m);
        sent = parts;
      }
      const call = { prompt: sent, options: options ?? {} };
      calls.push(call);
      const r = (await respond(call)) as { structured?: unknown } | null | undefined;
      yield { type: "result", subtype: "success", session_id: "s-test", structured_output: r?.structured ?? null, result: "" };
    })();
  return { ...real, query };
}
