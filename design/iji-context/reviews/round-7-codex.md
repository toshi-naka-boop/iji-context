critic: codex/gpt-6.1-sol xhigh（批評 round-7、v10、解決策付き。2026-11-05。初回はネットワーク障害で失敗し再実行）

codex
**新しい high はありません。medium 3件です。** 「1回の外れで要再検証」は前提として扱い、台帳の解決済み方針は再批評していません。

1. **medium／設計：判定の意味を変えるメタ項目が `rev` に含まれない**

   **箇所：** [§3 meta](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:143)、[§4-4 照合](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:282)。

   **破綻シナリオ：** 要再検証の allow 知識を提出時に記録した後、`polarity` だけを avoid に訂正する。変更禁止の規定がなく、本文・match が同じなら `rev` も変わらない。その提出の「関係ある査定」が新しい polarity で当たりと解釈され、旧定義での適用記録から自動再承認される。

   **推奨修正：** §3 の `rev` を、本文・match・`polarity`・`matchApprox`・`conditionNote` のハッシュに変更する。既存の rev 照合で意味の変更も遮断し、§7 #5(f) に「polarity だけ変更した旧記録でも状態が動かない」を追加する。

2. **medium／前提：同一提出の再訂正を、新しい反例として数えるかが未定義**

   **箇所：** [§4-4 手順4](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:283)、[§7 #5(j)](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:375)。

   **破綻シナリオ：** 承認済みで記録した一つの提出に「外れ→当たり→外れ」が届く。現行文面では、最初の外れで要再検証、次の当たりで `lastStateEffect` が当たりに更新され、最後の外れで停止する。今有効な外れは1件でも、同じ提出から二段階降格する。

   **推奨修正：** §4-4 に「同一提出・同一知識 rev からの `COUNTER_EXAMPLE` は最大1回」と明記する。「外れ→当たり」では集計用 `effect` だけを更新し、`lastStateEffect` は外れを保持する。§7 #5(j) にこの再訂正経路を加え、最終状態が要再検証であることを確認する。巻き戻さない方針は維持できる。

3. **medium／設計：問い合わせ回答の照合失敗時に、本文と完了条件が食い違う**

   **箇所：** [§4-4 回答反映](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:322)、[§7 #11](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:381)。

   **破綻シナリオ：** 問いを出した後に知識が変わり、回答2が届く。本文は照合失敗でも候補作成を要求する一方、#11 後半の「回答は記録だけ」は候補作成まで禁止するように読める。回答1の `USED` も同様で、正しい実装を受入試験が拒否し得る。

   **推奨修正：** #11 の該当文を「照合失敗時は元知識の状態・外れ件数を変更しない。回答1の `USED` は現在の状態が許す場合に実行し、回答2の候補は作成する」に置き換える。提出の superseded による**取り消し後の回答**については、別に「記録だけ」と検証する。


