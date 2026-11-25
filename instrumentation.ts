// サーバーが立ち上がるときに 1 回だけ呼ばれる（Next.js の instrumentation）。保存時の暗号化の確かめ（spec FR-216）が通らなければ、起動を止める
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertAtRest } = await import("./src/server/at-rest");
  try {
    assertAtRest();
  } catch (e) {
    console.error(`[at-rest] 起動を止めます: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
