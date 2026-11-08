critic: codex/gpt-6.1-sol xhigh（批評 round-6、v8。2026-11-04）

codex
新しい **high は1件**です。

1. **[high／設計] 照合に失敗した結果が、次の結果の照合を通してしまう**  
   対象：[§4-4 手順4](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:283)。round-5 C-26／X-22 の対応不足です。

   照合失敗時は状態を動かさない一方、「判定のたびに `statusSinceAfter` を更新する」とあるため、次の破綻が起きます。

   - **t0**：承認済みの知識で提出 S を確定する。
   - **t1**：別理由のトリガーで知識が要再検証になる。
   - **t2**：S に「関係のない返戻」が届く。効果は「なし」。照合は失敗するが、`statusSinceAfter` が **t1** に更新される。`lastStateEffect` は未設定のまま。
   - **t3**：S の訂正結果として「通過」が届く。今度は `statusSinceAfter=t1` で照合を通り、「最初に効く当たり」として `RECHECK_PASS{claim}` が出る。

   結果、**要再検証に入る前の提出で再承認できてしまい**、[§7 #5](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:375)に反します。追加された (f) も、照合失敗後にさらに結果が届く経路を検証していません。

   照合失敗時は `lastStateEffect`・`statusSinceAfter` を保持し、後者を更新できるのは照合に成功した処理だけ、と明記する必要があります。(f) に上記の「なし→当たり」を追加してください。


