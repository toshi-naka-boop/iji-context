critic: codex/gpt-6.1-sol xhigh（round-94 反証・安全性と正しさ。対象 git diff 90e2fe4..feat/v44-gh）

1. **X-470｜P1｜実装・正しさ：三段検算の前に正しい請求を拒否する**  
   [uke.ts:580](/Users/toshixa/Documents/iji-context/.claude/worktrees/v44-gh/src/uke/uke.ts:580) が包括表との完全一致を強制しています。FT3・FT4・コルチゾールを素の合算363点にすると、G02単体では設計どおり(2)の条件つきですが、通常の取り込みはファイル全体を拒否します。保存済み請求も読み直しで `unreadable` になります。

2. **X-471｜P1｜実装・安全性：後月の酸素上限でも確定する**  
   [g12.ts:116](/Users/toshixa/Documents/iji-context/.claude/worktrees/v44-gh/src/generic/g12.ts:116) はマスターの `later`・`changed_on` を考慮しません。11月の請求を12月変更のマスターで点検しても、上限超過が「確定」になることを再現しました。後日上限が引き下げられた場合、診療月には正しい請求を誤指摘します。共通設計§12-1の条件つき化が必要です。

3. **X-472｜P2｜実装・正しさ：実効単価が同じでも照合を飛ばす**  
   [oxygen.ts:45](/Users/toshixa/Documents/iji-context/.claude/worktrees/v44-gh/src/facility/oxygen.ts:45) は上限適用前の単価で期間分割を判定します。届出が3.00→4.00円、上限が2.36円なら実効単価は同じですが、`split=true` になります。記載単価2.00円でもG12は指摘せず、単価欄が空ならG02も対象外になります。§19-3に反します。

4. **X-473｜P2｜実装・監査：取り消した区分が記録されない**  
   [route.ts:11](/Users/toshixa/Documents/iji-context/.claude/worktrees/v44-gh/app/api/facility/oxygen-prices/route.ts:11) の監査対象は処理後に評価されます。その時点では取り消した行が有効行一覧から消えており、成功した取り消しは必ず `oxygenPrice:取り消し:?` になります。§19-3が要求する区分を履歴から取得する必要があります。

5. **X-474｜P3｜実装・入力検証：不正月が400ではなく500になる**  
   [facility.ts:68](/Users/toshixa/Documents/iji-context/.claude/worktrees/v44-gh/src/server/schemas/facility.ts:68) が使う既存の日付検証は、`2026-13-01` で `RangeError` を投げます。新APIでも入力エラーが500になることを確認しました。無効な日付は例外を投げず、zodの検証失敗にする必要があります。


