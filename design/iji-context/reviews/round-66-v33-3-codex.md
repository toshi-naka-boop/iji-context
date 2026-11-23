critic: codex/gpt-6.1-sol xhigh（v33 の批評 3 巡目。ID は呼び出し側が X-250〜 を振った：番号順に X-250・X-251…）

1. **高／設計（C-412の修正残り）：院内・院外が混在する文章で、注2を誤提案します。**  
   [§16-4-5(e)](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2920)は初期値が院外になるかで検出しますが、「定期薬は院外処方箋発行、湿布は院内で投薬」は現行 `rxDefault` で **unknown** になると実行確認しました。院内オーダーだけがあり、処方箋料の行為が抽出されなければ検出を抜け、注2が出ます。院外語の検出を三択の初期値判定から分ける必要があります。[留意事項 C002(12)](https://www.mhlw.go.jp/content/12400000/001757385.pdf#page=258)

2. **高／設計：請求済みの処方箋料と矛盾しても、注2を提案します。**  
   [注2の条件](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2915)には、当月請求のF400を見る条件がありません。院外処方のオーダーが抜け、文章にも記載がなく、請求には処方箋料がある場合、院内オーダー1件だけで注2を勧めます。現行R05も処方イベントが必要で、この経路を塞ぎません。請求との矛盾があれば確認待ちにする必要があります。

3. **中／設計（新規）：機器の独自コード対応を保存・再利用できません。**  
   [FIELD_TABLES](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2862)は機器の対応先をマスター外の `DEVICE_KINDS` としますが、[対応API](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3033)はマスターへの実在を必須にしています。例えば `local:O2-C → C158` は保存条件を満たしません。機器には種類を選ぶ入口と専用の検証が必要です。

4. **中／設計：C150の変更案を受理しても、必要な区分を記録できません。**  
   [患者機器行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2994)には測定回数区分・患者区分が必要ですが、[受理API](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3032)には両方ありません。初回のC150案を受理すると、区分不足で「見ていません」のまま、機器は確認済み扱いとなり入力案内も消えます。受理時に両区分を選択・保存する契約が必要です。


