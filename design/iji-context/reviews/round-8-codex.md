critic: codex/gpt-6.1-sol xhigh（批評 round-8、v11、解決策付き。2026-11-05）

解決済みの方針を前提とし、v11 の追加・変更から生じる問題を4件挙げます。

1. **改定前の `recheck` 回答で、改定後の再検証を解除できる**
   
   **種別：設計／重大度：high**  
   根拠：[トリガー条件](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:242)、[recheck の照合・回答](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:338)
   
   **破綻シナリオ：** 制度層の知識が5月に外れで要再検証となり、問いが作られる。ベテランが改定前に答えた回答1が、6月1日の改定後に遅れて届く。要再検証中は改定トリガーが発火せず、状態・`status_since`・`rev` も変わらないため、回答は照合を通って承認済みに戻す。その際の `status_since` は改定後となり、改定トリガーも再発火しない。C-35 の請求側の制限では、この新しい回答経路を防げない。
   
   **解決策：** 問いに改定・改選の世代を記録し、回答反映時にも照合する。世代が変わっていれば旧回答では再承認せず、現在の基準について問い直す。

2. **`recheck` の「修正が必要」という回答を、修正前の請求結果が覆せる**
   
   **種別：設計／重大度：high**  
   根拠：[請求による再承認](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:284)、[recheck 回答2](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:343)
   
   **破綻シナリオ：** 要再検証中に提出 S を記録する。その後、ベテランが回答2で「条件が不足しており、修正が必要」と判断しても、元知識の状態・`status_since`・`rev` は変わらない。S の最初の当たりが届くと照合を通り、条件不足の元知識がそのまま再承認される。修正候補は未検証のまま残る。
   
   **解決策：** `recheck` の回答2を、請求による自動再承認を保留する判断として保存する。修正の検証、またはベテランによる明示的な再承認まで解除しない。これは、解決済み C-36 の **`ignored` 回答2で降格させない方針**とは別の問題。

3. **拡張された `rev` が問いを失効させても、代わりの問いが作られない**
   
   **種別：設計／重大度：mid**  
   根拠：[rev の範囲](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:143)、[問いの生成・取消条件](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:338)
   
   **破綻シナリオ：** 要再検証に入って問いを作った後、`polarity`・`matchApprox`・`conditionNote` を訂正する。v11 では `rev` が変わるため、旧問いへの回答1は正しく拒否される。しかし、問いの生成契機は「要再検証に入ったとき」だけで、内容変更時の再発行規則がない。特に提出結果による自動検証の対象外となった制度層では、設計された問い合わせ経路から復帰できなくなる。
   
   **解決策：** 要再検証中の `rev` 変更では、旧問いを取り消して新しい問いを作る。知識・内容版・再検証の回を識別できるキーで重複を防ぐ。

4. **状態の保存後に問いの保存が失敗すると、`recheck` が欠落したままになる**
   
   **種別：設計／重大度：mid**  
   根拠：[ファイルと SQLite の分担](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:13)、[反映待ちの復旧手順](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:293)、[問いの生成](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:338)
   
   **破綻シナリオ：** `store` がファイルへ要再検証を保存した直後、SQLite への問いの挿入前に停止する。再起動後は既に要再検証なので、承認済み向けトリガーから問いは再生成されない。請求由来でも、遷移前の照合値を持つ `pendingEvent` の再照合だけでは、保存済み遷移に対する問いの欠落を修復できない。
   
   **解決策：** 遷移ごとの識別子と永続的な反映待ち記録を設け、状態保存と問い生成の完了を個別に追跡する。再試行では、遷移済みの場合も問いの生成を完了させる。


