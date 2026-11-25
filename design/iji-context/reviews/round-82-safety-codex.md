critic: codex/gpt-6.1-sol xhigh（round-82 反証・安全性。1 回目は model at capacity で答えなし、やり直しで答えを得た）

1. **X-390｜Major｜実装（入力検証・可用性）** — [care.ts:181](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/src/server/app/care.ts:181)  
   短期入所の開始日 `2026-10-00` が Zod と保存時の検査を通ります。保存後、日付計算が `RangeError` となり、聞き取り API と別患者の請求読み込みも継続的に失敗します。保存前に実在日の検証が必要です。

2. **X-391｜Major｜実装（再確認の欠落）** — [app.ts:278](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/src/server/app.ts:278)  
   ほかの機関は、行の存在だけで回答済み扱いになります。管理料のある請求で `kanriSide: "分からない"` を保存すると、他の問いに回答済みなら患者カードが消えます。判定は「見ていません」のままですが、再確認・更新の入口が失われます。§18-5 に従い、判定に必要な項目の不明も聞き取り対象に含める必要があります。

両件とも SQLite のメモリ内 DB で再現しました。ファイル変更はありません。


