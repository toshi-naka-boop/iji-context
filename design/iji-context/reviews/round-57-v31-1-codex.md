critic: codex（xhigh）／v31 の批評 1 巡目

実行モデル：**gpt-6.1-sol**（実行メタデータで確認）。

11月23日の利用者判断を前提に、重大度順で5件です。

1. **X-170｜high｜設計：施設での看取りを含めるかの分岐が欠落**
   
   承認済みの W-11・W-12 は「患家／施設／入院経由」の3欄と施設包含の分岐を求めますが、本文と段17jは2欄のままです。門以上・患家0・施設20・入院経由0・重症児0で他要件を満たすと、本来は読みで割れるのに、通常申告の下書きを作れてしまいます。3欄と独立した計算軸を受入条件まで反映する必要があります。
   
   根拠：[design.md §15-13 L2704](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2704)、§15-10 段17j L2588。[EM追記案 §0-2 W-11・W-12 L54–55](/Users/toshixa/Documents/iji-context/design/iji-context/sources/em-v31-draft.md:54)、[ledger.md L379](/Users/toshixa/Documents/iji-context/design/iji-context/ledger.md:379)。

2. **X-171｜high｜設計：注8との重ね行を含めた減算行の逆引きが一意でない**
   
   同じ通常区分に「注14だけ」と「注8＋注14」の両方が対応します。しかし D03 の入力には注8を選ぶ判断がなく、「減算なら組の減の行」を決められません。両方を導出対象にすると、既存の注8重ね行が落ち、注14だけの高い行へ変わる恐れがあります。注8の状態を保持し、決められなければ導出を保留する規則が必要です。
   
   根拠：[design.md §15-4 L2246](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2246)、同 L2311・2331–2332。実例：[EM §2-8-2 L846–847](/Users/toshixa/Documents/iji-context/design/iji-context/sources/evidence-master-iji-context.md:846) は同じ通常区分に1,071点と857点の減算行が対応。

3. **X-172｜high｜設計：申告と減算行の食い違いが算定プレビューで消える**
   
   「申告は通常・既存請求は減算」では R18 が申告確認を求めます。一方、プレビューは既存減算行を導出対象として除外し、D03 が通常行を生成してから評価します。そのため食い違いが消え、申告だけを根拠に高い側の算定行が表示されます。原請求との食い違いを導出にも渡し、解消まで保留するなどの接続が必要です。
   
   根拠：[design.md §15-4 L2277](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2277)、同 L2311・2332、[§2-8 L479](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:479)・L514。段17h L2586 にこの経路の検査がありません。

4. **X-173｜mid｜設計：月付きのレセプト鍵では3か月の実人数を数えられない**
   
   集計鍵には診療年月が含まれるため、同一患者を月をまたいでまとめられません。Aが1か月だけ在医総管、Bが3か月とも施医総管なら、実人数の割合は50％、月ごとの延べは75％です。指定の鍵だけでは両方が75％になり、本来「決めきれない」例を減算側に言い切れます。月内の請求重複排除と期間全体の患者同定を分ける必要があります。
   
   根拠：[design.md §15-13 L2705](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2705)、§15-10 段17g L2585・段17k L2589。[EM追記案 §4-2 U-33a L199](/Users/toshixa/Documents/iji-context/design/iji-context/sources/em-v31-draft.md:199)。

5. **X-174｜mid｜設計：「読みごと2欄」では U-33 の全組合せを計算できない**
   
   除外人数③と状態該当人数⑤は、自身の甲乙に加えて「実人数／延べ」にも依存します。例えば同じ患者が3か月とも施医総管、初月だけターミナルケア加算なら、③は組合せによって1・0・3・1になります。固定の2欄では必要な数を供給できません。③⑤を組合せ別に入力するか、月別の基礎集計から導く設計が必要です。
   
   根拠：[design.md §15-13 L2704](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2704)・L2711、§15-10 段17j L2588。[EM追記案 §4-2 U-33a〜c L199–201](/Users/toshixa/Documents/iji-context/design/iji-context/sources/em-v31-draft.md:199)。


