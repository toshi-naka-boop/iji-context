critic: codex/gpt-6.1-sol xhigh（v33 の批評 1 巡目。ID は呼び出し側が X-230〜X-234 を振った：1→X-230、2→X-231、3→X-232、4→X-233、5→X-234）

1. **高／設計：内服6コード以下でも処方料3とは決まりません。**  
   [§16-4-2](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2883)は6以下なら3としますが、EM R8-240には向精神薬の長期処方による区分2があります。対象薬1種類でも誤った区分を提案します。長期処方の条件を確認し、不明なら区分を確定しない必要があります。[厚労省留意事項 F100(6)](https://www.mhlw.go.jp/content/12400000/001757385.pdf#page=474)

2. **高／設計：注2の過去処方チェックが、候補を出す・隠す両方向に誤ります。**  
   [§16-4-5](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2899)の具体手順には「30日超」の絞り込みがなく、前月の14日処方が当月にかかるだけでも候補を隠します。逆に、8月25日の120日処方が続く12月でも、前3か月だけでは見落として候補を出します。日数条件と、当月に効く処方履歴の取得範囲を修正する必要があります。[厚労省留意事項 C002(13)](https://www.mhlw.go.jp/content/12400000/001757385.pdf#page=258)

3. **高／設計：同一患家の2人目の時間加算を検出できません。**  
   [§16-4-6](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2904)は訪問診療料・往診料の基本行を必須にしています。しかしEM R8-207では、2人目は初再診料等のみでも時間加算の対象になります。「2人目・70分・再診料のみ」が必ず除外され、2906行の注意書きにも届きません。基本行必須条件に例外が必要です。[厚労省留意事項 C001(5)](https://www.mhlw.go.jp/content/12400000/001757385.pdf#page=251)

4. **高／設計：「機器なし」にしても旧機器が有効なまま残ります。**  
   [§16-5](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2953)は種類ごとに最新行を選び、`none` は確認済みの判定に使うだけです。10月から終了月なしの`C158`に、11月から`none`を追記しても、11月の濃縮装置加算候補が出ます。「機器なし」で既存機器を終了させる規則が必要です。

5. **中／設計：コードなしの名称一致を、入力型で表現できません。**  
   [§16-1](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2821)では`name`が`CodeRef`内にしかなく、薬・処置・機器の`code:null`では名称も失われます。そのため[§16-2の規則4](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2851)とFR-206の名称一致を実行できません。表示名をコードとは別に保持する必要があります。


