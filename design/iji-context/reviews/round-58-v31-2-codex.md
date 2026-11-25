critic: codex（xhigh）／v31 の批評 2 巡目

実行モデル：**gpt-6.1-sol**（実行メタデータで確認、推論設定 `xhigh`）。

1. **X-180｜high｜設計：延べ患者数にレセプト種別が残り、通常申告を誤って下書きできる（X-173の直し漏れ）**

   期間の実人数は直りましたが、段17kは月別人数を種別込みのレセプト鍵で数えます。Aが1か月だけ在医総管を種別違いの2枚で請求し、Bが3か月とも施医総管を請求すると、延べ①②は誤って2・3（60％）、実人数は1・1（50％）になります。他要件を満たせば、両方70％以下として通常の下書きが出ます。正しい延べ人数は1・3（75％）なので、「決めきれない」が必要です。月別人数には、患者同定鍵に診療年月だけを加えた鍵が要ります。

   根拠：[§15-10 段17k・2601行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2601)、[§15-12 L-146・2689行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2689)、[EM追記案 §4-2 U-33a・200行](/Users/toshixa/Documents/iji-context/design/iji-context/sources/em-v31-draft.md:200)。

2. **X-181｜mid｜設計：導出保留後に `R18.note14_conflict` を残す接続がない（X-172の改訂で生じた不整合）**

   申告「通常」・原請求「減」の場合、原管理料を `manualLinesOf` で外し、D03も保留すると、評価対象から管理料がなくなります。R18は管理料行があるときだけ適用されるため、段17hが要求する「プレビューに `R18.note14_conflict` が残る」は成立しません。原請求の指摘を引き継ぐ経路を定義するか、受入条件をD03の食い違い理由つき保留へ合わせる必要があります。

   根拠：[§2-8・479行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:479)、[§15-4・2285行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2285)・[2323行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2323)、[§15-10 段17h・2598行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2598)。


