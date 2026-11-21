critic: codex/gpt-6.1-sol xhigh

**新規 high はありません。** 解消済みの指摘を除き、未解消・新規の欠陥は4件です。§14は未実装のため、設計と既存コードの整合性を確認しました。

1. **[設計/medium] 再承認後に、古い確認が復活する。**  
   [§14-3の確認記録](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1960)は`rev`に結び付きますが、`rev`は内容ハッシュで、再承認だけでは変わりません。既存の状態遷移でも確認しました。例えば、確認済みの請求がidleによる要再検証で再表示された後、会議で「今も正しい」と再承認すると、押し直さずにG05が消えます。「再承認後は押し直す」という完了条件を満たせません。確認記録には承認時点の`status_since`なども結び付ける必要があります。根拠：[revの定義](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:522)、[状態遷移](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/lifecycle/machine.ts:183)。

2. **[設計/medium] 「ウ」の例外が、院内知識の対象から漏れる。**  
   [§14-3の対象](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1947)は「HPに当たらない」か「問いに答えて決まらない」ものだけです。例えばC157×C158（HP-23／HX-23）はHPに入り、`kind=none`なので問いがありません。どちらの条件も満たさず、作成入口もサーバーの受付も対象外になります。§14が目的に挙げた「ウを一度確認して次回から使う」を実現できません。「未決の問いがなく、kind=noneを含めて決まらない」場合を明示する必要があります。根拠：[kind=noneの処理](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/generic/g05.ts:112)。

3. **[設計/medium] 同一月の組でも、保存時に同日の算定を要求する。**  
   [確認記録のdate](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1960)は同一月なら空ですが、[サーバー検査](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1961)は一律に「その日に両方がある」を要求しています。文言どおり実装すると、同一月の対象組を3日と15日に算定した請求で、Lv.5が条件を確認しても400になります。同日検査は`tani=1・3`に限定し、`tani=2`は請求内の存在を照らす必要があります。

4. **[前提/medium] 現行のマスター取り込みでは、比較用の2世代を保持できない。**  
   [§14-4](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1973)は改定前後の世代を同じDBから比較しますが、現行処理は[全スナップショットに単一の`config.generation`を付与](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/masters/build.ts:123)し、[DBを作り直して置換](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/scripts/build-masters.ts:44)します。例えば旧・新両方のファイルを保管して新世代の設定で再構築しても、旧世代として引けません。その結果、比較不能の扱いで差のない知識まで全部要再検証になります。段16に、世代別の取り込み・保持の変更を含める必要があります。
