# 同梱の合成データでしか動かない箇所（src/ のうち src/server/ を除く・config/）

- 調べた日：2026-11-22
- 対象：`.claude/worktrees/integration`（ブランチ feat/integration、83d1442）の `src/`（`src/server/` を除く）と `config/`
- 方法：コードを読んで呼び出し先まで追った。コードは変えていない。推測は「推測」と書く
- 重さ：高＝実在の運用で誤る・黙る／中＝使えない機能がある（断りが出るものを含む）／低＝表示だけ

## 1. 直すもの

| # | 場所（file:line） | 何をしているか | 実在のデータで何が起きるか | 重さ | 直し方の案 |
|---|---|---|---|---|---|
| H1 | src/notice/notice.ts:99 | 返戻・査定の通知の患者を `src.patients`（同梱の patients.json）の氏名＋保険者番号だけで探す（既知） | 取り込んだ UKE・コネクタの請求に当たらない。claimId が null で候補にできない（断りが出る） | 高 | 患者マスタと取り込んだ請求（UkeReceipt.patient）から探す |
| H2 | src/notice/notice.ts:107 | 項目名を、版の点数表の手書きの名称（約 50 区分）と完全一致で照らす（既知） | 通知の名称はマスターの省略名称なので、表の 50 区分の中でも当たらないことが多い。表の外の項目は区分にできない | 高 | 基本マスターの名称→コード→区分の順で引き、区分に引けない項目はコードのまま候補にする |
| H3 | src/lifecycle/seed-local.ts:22-50・:82（呼び出しは src/server/instance.ts:109） | 院内ルールの種 12 件（中身を伏せた合成。承認済み・使用済みの状態つき。`kubunAll` は C002_2I1・C001_N13_DX・O001_3I など実在の区分）を、どのクリニックにも入れる | 実在のクリニックの請求のローカルルール欄に、架空の承認済みルールが当たる。提出の記録（applications）・会議の議題にも数えられる（誤った結果） | 高 | 種はデモの tenant にだけ入れる（設定かデータの版の印で分ける） |
| H4 | src/notice/sample.ts:5-9（入れるのは src/server/app/knowledge.ts:79） | 合成の K6 増減点連絡書（架空の患者・保険者番号 01139997・BNP の査定）から作った地域ルール（東京都・支払基金・BNP を避ける）を、どのクリニックにも入れる | 東京都の実在のクリニックで、支払基金の BNP の請求に、架空の査定に基づく「避ける」知識が当たる（誤った結果） | 高 | H3 と同じく、デモの tenant にだけ入れる |
| H5 | config/facility.json（読むのは src/engine/facility.ts:15） | 施設の設定の既定値が、デモの医療機関の値で「分かっている」になっている：note16Met=true、dxTier="1"、baseUp="通常"、priceResponse=true、zaishishin=true、kyokagata=false、prefecture="東京都" | 設定画面で直さない限り、R01（注16）・R12（DX 加算の区分）・導出 D06・D07・R10（在支診か）が聞かずに判定する。注16 を満たさない医療機関などで区分の指摘を誤る。導出の ctx.prefecture（engine/derive.ts:129）も東京都になる（誤った結果） | 高 | 実在の運用の既定は三値の項目を null（不明）にし、初回に設定を求める。デモ用の値は別のファイルに分ける |
| H6 | src/uke/diseases.ts:9-16・src/uke/uke.ts:450-455・src/uke/crosscheck.ts:47 | 傷病名コード→名称の表は 6 件だけ。表にないコードの傷病名は name を空にして持つ。照合（M01）は name を正規表現で見る | 実在の UKE の傷病名（発作性心房細動・持続性心房細動など別コード）は name が空で、照合の対象にならず、不一致が出ない（黙って空） | 高 | 基本マスター（傷病名）があれば名称を引いて照合に渡し、なければ「照合していない」と画面に出す |
| H7 | src/uke/crosscheck.ts:50・src/connect/fhir.ts:248・src/chart/extract.ts:45 | 照合は処方の `category === "DOAC"` の完全一致。合成カルテは分類名で持つ | FHIR は薬剤の表示名（例：商品名）を category に入れるので当たらない。カルテの読み取り（LLM）も「抗凝固薬」など別の言い方を返すと当たらない（黙って空） | 高 | 医薬品コード（YJ・薬効分類）で DOAC を決める表にし、名称の一致はやめる |
| H8 | src/connect/orca.ts:302（照らすのは src/lifecycle/match.ts:37） | ORCA の請求は都道府県を空文字で返す | `ctx.prefecture` が "" になり、都道府県つきの地域ルールがどれも当たらない（黙る）。通知の都道府県の食い違いも見ない。地域層の候補（candidateOf）も作れない | 高 | 施設の設定の都道府県を入れる（医療機関の情報は施設の設定から埋める） |
| H9 | src/lifecycle/match.ts:75-80・src/mentor/tools.ts:23・src/uke/cases.ts:103 | 過去月の算定（history）は同梱の症例（fixtures/cases）からしか来ない。取り込んだ請求は history を持たない | 連月の条件（consecutiveMonths）の知識は、実在の請求ではいつも「1 か月目」で当たらない（黙る）。メンターの query_history は空を返し、過去月の算定がないように見える | 高 | 同じ患者の前月以前の取り込み（UKE・コネクタ）から history を作る。作れないときは「過去月は分からない」として扱う |
| H10 | src/patient/profile.ts:58-68（UKE 側は src/uke/uke.ts:385・:413） | UKE の患者を患者マスタの形にするとき、医保の加入情報を必ず 1 件作る。HO のないレセプト（公費単独。生活保護など）は保険者番号が空 | 公費単独の患者に、保険者番号が空の医保ができ、P01（保険者番号の桁数）・P06 の指摘が出る（誤った結果）。`payerOfInsurer("")`（src/uke/cases.ts:41）を呼ぶ処理は例外になる | 高 | HO がなければ医保の行を作らない。P01・P06 は公費単独を区別する |
| H11 | src/mentor/prompt.ts:97-131 | メンターに毎回渡す「いまの判定」は、手書きのルールの指摘と applied だけ。点検の対象外の単位（partial・others）とデータで動く点検（G01〜G09）の結果は渡さない（src/server/app/question-case.ts:47 の note も練習問題と訪問の時点だけ） | 実在の請求で行の多くが対象外でも、手書きのルールの指摘が 0 件なら「気にしているルールはない……背中を押す」と伝える（黙って問題なしに見せる） | 高 | partial のとき「点検していない行が N 単位ある」と、G01〜G09 の指摘の数を文脈に足す |
| M1 | src/connect/orca.ts:135-150・:296-297 | 患者基本情報の保険組合せを、有効期間で絞らずに全部、加入情報にする。請求を読むとき医保が 1 件でなければ例外 | 保険が替わった患者（75 歳で後期高齢者医療へ、など）は過去の医保も数えて 2 件になり、例外になる。例外は患者ごとのループの中なので、頼んだ全員の請求が読めない（動かない） | 中 | 診療年月に有効な医保（coveragesIn と同じ規則）だけで数え、決まらない患者だけを外して続ける |
| M2 | src/connect/orca.ts:296-297 | 同上。公費単独の患者（医保なし）も例外 | 生活保護などの患者がいると、その回の請求の取り込みが全部止まる（動かない） | 中 | 公費単独は公費負担者番号から審査支払機関を決める |
| M3 | src/connect/orca.ts:234 | 包括分（Medical_Class_code=1）の行が 1 つでもあれば応答ごと断る（どう返るか未確認。docs/connectors.md） | 推測：在医総管の月は包括分の行が返る患者が多く、その患者の請求が読めない（動かない） | 中 | 包括分の行は算定行にせず残す（対象外の単位にする）。実機で返り方を確かめる |
| M4 | src/connect/fhir.ts:120-122・:240-251 | MedicationRequest は medicationCodeableConcept だけを受け、Encounter は period.start を必須にする。期間内の Encounter をすべて訪問日にし、Condition の状態（疑い・治癒）を見ない（どれも未確認。docs/connectors.md） | medicationReference で返す相手・period のない Encounter が 1 件でもあると、その患者のカルテが読めない（断り）。外来・電話の Encounter も訪問日になる | 中 | medicationReference を読む。Encounter は class で訪問を見分ける。Condition は verificationStatus を写す |
| M5 | src/uke/limits.ts:4-6 | UKE の上限が 1MB・5,000 行（たたき台） | 推測：患者が数百人の在宅のクリニックの月の UKE は、医薬品の行を含めると 5,000 行を超え、ファイルごと断られる（動かない） | 中 | 実在の UKE の大きさを測って上限を決め直す（数万行） |
| M6 | src/notice/notice.ts:104 | 通知の診療年月に版がなければ区分を引かない | 令和8年5月以前（令和6年度の版）の診療分の通知は、区分に引けず候補にできない（断り） | 中 | 比較用の版（r2024）の名称でも引けるようにし、候補にするかは本人が決める |
| M7 | src/prevented/prevented.ts:43・:119-121 | 事務長向けの「見逃した額」と、版の印のない記録は、基準月（config/demo.json の 2026-10）の版の点数で数える | 2027年6月以降の診療分などは、別の版の点数で数える。その版にない区分は 0 点になる（誤った金額） | 中 | 見逃した行に診療年月を持たせ、その月の版で数える |
| M8 | src/visit/as-of.ts:16-21 | 訪問の時点の点検は、訪問の日を出来事（events）からだけ取る | 取り込んだ請求は出来事を持たない（recordsKnown が偽）ので、訪問の日がなく、この点検が使えない | 中 | 出来事がなければ算定行の日付を使う。使えないときは画面で断る |
| M9 | src/chart/notes.ts:24・:46 | 書いた訪問カルテから訪問診療の出来事と行を足すとき、前の訪問の出来事がなければ同一建物の人数を 1、区分を visitKubun[0]（同一建物居住者以外）にする | 取り込んだ請求（出来事なし）にカルテを足すと、施設・同一建物の患者でも C001_1I の行が足される（誤った結果。プレビューには出る） | 中 | 同一建物の人数は請求の訪問診療料の行のコード、なければ本人に聞く |
| M10 | src/patient/checks.ts:107-114 | レセプト種別は EM §2-5 L-3 の 6 コードだけを照らし、ほかのコードは何も見ない | 家族（1116）・公費併用（1122・1126 など）の患者は P03・P04 が働かない。推測：画面に「見ていない」と出なければ、問題なしに見える（黙って空） | 中 | 照らさなかったことを患者パネルに出す。コードを増やすなら EM に行を足してから |
| M11 | src/official/registry.ts:12・src/lifecycle/store.ts:101・src/lifecycle/match.ts:32-35 | 知識と公的文書の区分は、版の点数表の区分（約 50）だけ。請求の行も表で引けた行（ctx.lines）だけ | 実在の返戻・査定の多くの項目（表の外）は、知識にも公的文書の対象にもできない。対象外の単位の行には、知識が当たらない | 中 | 区分のほかに、診療行為コードでも条件を書けるようにする |
| M12 | src/lifecycle/review.ts:107-110・:126-131 | 提出結果の区分（kubun）を、知識の対象区分と照らす。関係のない査定は通過と同じに扱う | 推測：表の外の項目の査定・返戻は区分に表せず「関係なし」になり、通過と同じに数えられる。避ける知識が miss と数えられることがある（誤った結果） | 中 | 提出結果に診療行為コードを持たせ、区分に引けない結果は「判定できない」として数えない |
| M13 | config/calendar.json:4-6（読むのは src/lifecycle/calendar.ts:46-49） | 国保連の改選日は東京都が null、ほかの道府県は項目なし | どの都道府県でも、国保連の地域ルールの改選のトリガーが発火しない（黙る） | 中 | 医療機関の都道府県の改選日を入れるまで、画面で「改選日が未設定」と出す |
| L1 | config/business-days.json:4-8 | 祝日は 2026・2027 年分だけ | 2028 年以降、医師確認のリマインド・保留の営業日に祝日を数える（期日の表示がずれる） | 低 | 毎年の祝日を足す手順を docs に書く。表の外の年は警告する |

## 2. デモ専用で問題ないもの

| 場所 | 何をしているか | 問題ない理由 |
|---|---|---|
| src/demo/period.ts:20-32（dayOf・mdOf・claimIdOf・monthFrom・dateFrom） | 基準月（config/demo.json）から日付・請求 id を作る | 呼ぶのは練習問題・種・同梱の通知の名前・scripts だけ。実在の請求の判定は請求の yearMonth を使う（monthRange・YEAR_MONTH は基準月によらない） |
| src/practice/drills.ts・src/practice/doctor-drills.ts | K1〜K4 の合成の明細に間違いを入れた練習問題 | 練習問題は合成の明細で作るもの。実在の請求には触れない |
| src/connect/fixture.ts | 同梱の合成の UKE・症例・カルテを境界の型で返す | 同梱データのためのコネクタ。:56 の注「表にないコードは readUke が拒否する」は古い（今は対象外の単位として残す）が、動きには関わらない |
| src/uke/cases.ts:25-78（commentsOfCase・buildUkeFiles）・src/uke/uke.ts:193-277（formatUke・SYNTHETIC） | 症例から合成の UKE を書き出す（摘要欄の値・資格確認などは合成の設定） | 呼ぶのは scripts/gen-uke.ts だけ。実在の UKE は書き出さない |
| src/uke/crosscheck.ts:29-41（MISMATCH_RULES が M01 だけ） | 照合の規則は EM 5-1 K4 の 1 件だけ | 規則の数は仕様の範囲（現場例は創作しない）。実在のデータで動かない点は H6・H7 に挙げた |
| src/engine/derive.ts:129 | 述語に渡す ctx の payer を "国保連" の仮の値にする | 述語は payer を読まない（コメントのとおり。predicates.ts を確かめた） |
| src/lifecycle/seed-local.ts:53 | 種の名前を基準月の版から取る | 種そのものの問題は H3。名前の引き方はデモの中で閉じている |
| config/demo.json | 基準月・請求月・時計の初期値・データの版の印 | 固定条件のとおり 1 か所で持つ。実在の請求の判定は請求の診療年月で版を決めている（engine/index.ts:72・uke.ts:654）。時計の初期値の使われ方は担当の外（下のメモ） |
| config/characters.json・voice-lines.json・levels.json・choice-groups.json | キャラ・定型の声・レベル・選択モードの仲間の区分 | 請求のデータに依らない設定 |
| src/engine/revisions/index.ts:56・:72（版のない診療年月は判定しない） | 令和8年6月より前は版がなく、試算だけ | 固定条件どおり。断りが出る（noRevision） |
| src/uke/uke.ts:571-574（医薬品・特定器材の単位は対象外） | IY・TO を含む単位は点検の対象外の単位にする | 設計どおりで、対象外として画面に出る（UkeReceipt.others）。基本マスターがあればデータで動く点検が掛かる |
| src/engine/index.ts:95-131（recordsKnown が偽） | 出来事で決める指摘を捨て、情報不足（chartRecord）を 1 件返す | ルールごとに recordFindings を申告していて、黙って「問題なし」にはならない。R05・R06・R07・R09・R14・R17 を確かめた |

## 3. 担当の外で気づいたこと（一行メモ）

- src/server/app/clock.ts:9：時計の既定が config/demo.json の clockStart（2026-10-13）。実在の運用でも、P06・P07 の「今日」、要介護度の期限切れ、公的文書のトリガー④の世代（official/match.ts:118）がデモの日付で決まる
- src/server/app/cases.ts:58：症例のない請求は事実をすべて不明、出来事なし（recordsKnown 偽）。H9 の history もここで undefined になる
- app/api/mentor-check/route.ts:43：施設の設定を config/facility.json から直に読み、設定画面で残した値（app_settings）を見ない
- src/server/instance.ts:109：H3・H4 の種を、どのクリニックを開いても入れる
- app/api/master/route.ts:13：診療年月の既定が基準月
- src/server/app/doctor.ts:54：照合のカルテ（chartOf）の出どころを確かめていない。推測：同梱の fixtures/charts と本人が書いたカルテだけ
