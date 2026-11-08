critic: codex/gpt-6.1-sol xhigh（反証・正しさレンズ、§4-4。2026-11-04）

codex
更新後のコードで再現した5件です。既存の対象テスト158件は通過しています。

1. **高／実装：知識への反映失敗後、結果を再処理できない**  
   [applications.ts:106](/Users/toshixa/Documents/iji-context/src/lifecycle/applications.ts:106)、[store.ts:151](/Users/toshixa/Documents/iji-context/src/lifecycle/store.ts:151)  
   **再現：** 要再検証・allow の知識に当たる提出を確定→「通過」を `importResult`→返されたイベントを `applyEvent` で反映するとき、書き込みを一度失敗させる→同じ結果を再取り込み。  
   **実際：** `duplicate: true, events: []` となり、知識は要再検証のまま。結果の保存だけが完了し、未反映イベントを回収できません。イベント計算を保存前に移した修正後も残ります。

2. **高／実装：照合後に状態が変わると、古いイベントで新しい再検証を解除できる**  
   [applications.ts:125](/Users/toshixa/Documents/iji-context/src/lifecycle/applications.ts:125)、[store.ts:147](/Users/toshixa/Documents/iji-context/src/lifecycle/store.ts:147)  
   **再現：** 要再検証中に提出を確定→通過を取り込み、`RECHECK_PASS` を受け取る→反映前にベテラン確認で承認済みへ戻し、その後のトリガーで再び要再検証にする→先ほどのイベントを `applyEvent`。  
   **実際：** 新しい要再検証も承認済みになります。取り込み時の照合はありますが、返却イベントに照合対象の版・状態起点がなく、反映時には検証されません。

3. **高／実装：空の `kubunAll` で無条件に再承認される**  
   [store.ts:82](/Users/toshixa/Documents/iji-context/src/lifecycle/store.ts:82)、[match.ts:21](/Users/toshixa/Documents/iji-context/src/lifecycle/match.ts:21)  
   **再現：** ベテラン層に `match: { kubunAll: [] }` を作成→承認→要再検証→算定行が空の請求を確定→通過を取り込み、イベントを反映。  
   **実際：** `[].every(...)` が真になり、`final`→`RECHECK_PASS`→承認済み。条件を何も持たない知識が、空配列の有無だけで自動再承認の対象になります。

4. **中／設計：事実が不明になっただけでも「助言どおり修正した」と記録される**  
   [design.md:250](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:250)、[match.ts:31](/Users/toshixa/Documents/iji-context/src/lifecycle/match.ts:31)  
   **再現：** avoid の条件を `kubunAll: ["C001"], facts: { careLevelMin: 3 }` とする→要介護度3で評価→算定行を変えず、要介護度だけ `known: false` にして提出確定→「査定・C001」を取り込む。  
   **実際：** `avoided`→`USED` となり、`last_hit_at` が更新されます。条件の解消と判定不能を同じ偽として扱うため、修正していない知識にも生存確認が付きます。

5. **中／前提：`earlier` に別請求の履歴が混ざると、誤った利用実績が付く**  
   [applications.ts:79](/Users/toshixa/Documents/iji-context/src/lifecycle/applications.ts:79)  
   **再現：** avoid の条件を `kubunAll: ["C001", "C002"]` とする→確定版は請求A・C001のみ、`earlier` は請求B・C001＋C002として渡す→Aの結果を取り込む。  
   **実際：** Aには一度も適用されていない知識が `avoided`→`USED` になります。再現には呼出側の履歴混入が必要ですが、§4-4の「その請求の評価途中」という前提をこのAPIは検証していません。


tokens used
