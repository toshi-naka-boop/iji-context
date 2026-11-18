# 連携（コネクタ）

電子カルテ・レセコンとつなぐための境界と、読み取りコネクタの説明（spec FR-104〜115）。
**実機にはつないでいない。** 相手は同梱の模擬サーバー（合成データ）だけで、コネクタを呼ぶ画面や API はまだない（境界とコネクタと、読んだ患者を患者マスタへ入れる処理だけがある）。
画面から使える連携は、UKE のアップロードだけ（下の「UKE のアップロード」）。

## 境界の 3 つの型（`src/connect/types.ts`）

| 境界 | 返すもの | 持っているコネクタ |
|---|---|---|
| `PatientSource` | 患者基本情報 `ConnectorPatient`（接続先での患者の id ＋ 患者マスタに取り込む形 `PatientRecord`：氏名・性別・生年月日 YYYYMMDD・加入情報 `CoverageInfo` の一覧） | fixture・orca・fhir |
| `ClaimSource` | 診療年月の請求 `ConnectorClaims`（`files` は UKE を読んだときと同じ `UkeFile`、`unmapped` は対応のないコードの行） | fixture |
| `ChartSource` | 診療年月のカルテ記載 `ConnectorChart`（訪問日ごとの記録・処方・傷病名） | fixture・fhir |

`Connector = { id, label, patient?, claims?, chart? }`。持っている能力だけを載せる。書き込みの口はない。

患者と加入情報の型は、患者マスタの型（`src/patient/profile.ts` の `PatientRecord`・`CoverageInfo`）を使う。連携だけの型は持たない（種類は「医保」「公費」、番号は `payerNumber`）。

## 読んだ患者の行き先（患者マスタと患者情報チェック）

`app.checkConnectorPatient(患者, 診療年月)`（`src/server/app/patients.ts`）が、コネクタで読んだ患者を患者マスタに取り込み、UKE から来た患者と同じ患者情報チェック（P01〜P08）にかける（spec FR-123）。

- 同じ人かどうかは、UKE のときと同じ鍵（医保の番号＋生年月日・性別、なければ氏名＋生年月日・性別）で決める。接続先での患者の id は鍵に使わない。
- 記号・番号は、患者マスタに入れる時点で半角にそろえる（全角で返す接続先と、半角の UKE を同じ人として重ねるため）。
- コネクタが負担割合・有効期間を持ってきたときは、医療事務がまだ確かめていない加入情報に限って履歴に 1 行足す（出所は「連携」）。確かめた記録は上書きしない。
- 請求を伴わないので、レセプト種別と診療日を使うチェック（P03・P04 の一部、P06 の診療日との照合）は働かない。
- いまは処理があるだけで、呼ぶ画面・API はない。

- `fixture`（`fixture.ts`）：同梱の合成データ（fixtures/ の UKE・症例・カルテ）。常に有効。通信しない。
- `orca`（`orca.ts`）：ORCA API 形式（日レセ API）。患者基本情報だけ。請求は持たない（下の「ORCA の請求」）。
- `fhir`（`fhir.ts`）：HL7 FHIR JP Core 形式。Patient・Coverage と、Encounter・MedicationRequest・Condition の検索。

## コネクタの足し方

1. `src/connect/<id>.ts` に `create<Id>Connector()` を書き、持てる境界だけを実装する。
2. 外へ出る通信は、必ず `connectJson(id, 相対パス)`（`fetch.ts`）を通す。`fetch` や `http.request` を直接呼ばない。
3. 応答は zod のスキーマで検査してから境界の型に写す。合わなければ `formatError`（取り込まない）。
4. 通信の形（パス・項目名・スキーマ）と、その出典・未確認の点をファイルの冒頭に集め、模擬サーバー（`fixtures/connect/mock-server.ts`）も同じ定義を使う。
5. `src/connect/index.ts` の `EXTERNAL` に足し、`tests/connect/` に模擬サーバーとの結合テストを書く。

## 設定（環境変数。既定はすべて空＝外部コネクタは無効）

| 名前 | 意味 | 例（架空） |
|---|---|---|
| `RESEMEN_CONNECTORS` | 有効にする外部コネクタの id（カンマ区切り） | `orca,fhir` |
| `RESEMEN_CONNECT_ALLOW` | 接続を許す `host:port`（完全一致・カンマ区切り） | `recept.example.test:443` |
| `RESEMEN_CONNECT_<ID>_URL` | 接続先。WebORCA の `/api` はここに書く。認証情報・クエリは書けない | `https://recept.example.test/api` |
| `RESEMEN_CONNECT_<ID>_USER`／`_PASSWORD` | Basic 認証（ORCA） | Secret Manager から渡す |
| `RESEMEN_CONNECT_<ID>_TOKEN` | Bearer 認証（FHIR） | 同上 |
| `RESEMEN_CONNECT_FHIR_PATIENT_SYSTEM` | 患者番号の identifier system（医療機関コードを含む全体。必須） | `urn:oid:1.2.392.100495.20.3.51.19999999999` |
| `RESEMEN_CONNECT_FHIR_KOHI_SYSTEM` | 公費負担者番号の identifier system | 未確認。既定は仮の値 |
| `RESEMEN_CONNECT_TIMEOUT_MS`／`RESEMEN_CONNECT_MAX_BYTES` | タイムアウト（既定 10 秒）・応答の上限（既定 2 MB） | `10000`／`2097152` |

接続先はリクエストから受け取らない。コネクタ id から、この環境変数だけを引く。

## 通信の守り（`src/connect/fetch.ts`）

防ぐもの：
- 許可リストにない接続先（`host:port` の完全一致。既定は空）。
- https 以外。http は「本番でない・ループバック・許可リストにある」がそろったときだけ（模擬サーバー用。本番ではこの例外を持てない）。
- リダイレクト（従わない）、遅い応答（全体にタイムアウト）、大きい応答（content-length と実際に読んだ量の両方）、content-type・JSON・スキーマの違い。
- 本番での内部アドレス宛て：10/8・100.64/10・127/8・0/8・169.254/16（クラウドのメタデータ）・172.16/12・192.168/16・198.18/15・224/4・240/4、::・::1・64:ff9b::/96・fc00::/7・fe80::/10・ff00::/8。答えの IP が 1 つでも当たれば出ない。
- **DNS リバインディング**：名前解決は 1 回だけで、検査を通った IP にそのまま接続する（`node:https` の `request` に、その IP だけを返す `lookup` を渡す。接続は毎回新しく張る）。ホスト名は元のまま渡すので、証明書の検証・SNI・Host ヘッダは元のホスト名で働く。
- 相手が返した URL（FHIR の next リンク）で、設定した接続先の範囲（同じ origin・同じパスの下）の外へ出ること。
- 認証情報・接続先のパス・応答の本文が、エラーやログに出ること（エラーに載るのはコネクタ id・原因の種類・定型文・HTTP ステータスだけ）。

失敗は `ConnectError` で、`kind` に原因が入る：`config`／`not_allowed`／`redirect`／`timeout`／`too_large`／`format`／`auth`／`upstream`／`network`／`not_found`。

残るもの：
- 本番でない環境では、内部アドレスの検査をしない（許可リストと https の検査、IP の固定はする）。
- 許可リストに載せた相手そのものが内部を中継する場合（相手のサーバーの側のリダイレクトや代理）は防げない。
- 上に挙げていない特殊な範囲（192.0.0.0/24、文書用の 192.0.2.0/24 など）は検査しない。IPv6 に IPv4 を埋め込む形は ::ffff: と 64:ff9b:: だけを見る。
- クライアント証明書（WebORCA クラウド・SSL クライアント認証）には未対応。プロキシ経由の接続にも未対応（環境変数のプロキシ設定を見ない）。
- 相手が正しい形で返した誤ったデータは見抜けない（スキーマは形しか見ない）。

## 対応のないコードの扱い（FR-111）と ORCA の請求

診療行為コードは対応表で区分に写す。同梱の対応表は架空コード（`src/engine/codes-fictional.ts`）だけで、実在のマスターとの対応表は同梱しない。
対応表にないコード、対応先がこのアプリの区分にないコードは、例外にせず `unmapped`（請求 id・コード・日付）に入れ、算定行には入れない。`unmapped` が 1 件以上あるレセプトは「判定の対象外 n 件」と表示し、合計を出さない（表示とエンジン側は後の工程）。

**ORCA の請求は未対応。** 診療行為（`medicalgetv2`）と患者病名（`diseasegetv2`）は、公式仕様で要求・応答とも xml2 形式だけ（`format=json` の記載がない）。XML パーサは自作せず、依存の追加（承認が要る。FR-115）もしていないので、ORCA コネクタは `ClaimSource` を持たない。

## 模擬サーバー（FR-112）

`npx tsx scripts/mock-connect.ts [ポート]` で 127.0.0.1 に起動する（既定 8799）。認証の値は起動のたびに作られ、アプリに渡す環境変数の形で表示される。
返すのは合成データ（K1・K3・K4。`fixtures/connect/orca.json`・`fhir.json`）だけ。この 2 つは、症例と同じ合成データ（`fixtures/uke/patients.json`・`fixtures/cases/`・`fixtures/charts/`）から `npx tsx scripts/gen-connect.ts` で作る（手で直さない。診療年月は `config/demo.json`）。パスの頭に `/fault/<種類>` を付けると壊した応答を返す（`mock-server.ts` の `FAULTS`）。自動テストも同じサーバーを使う。

## UKE のアップロード（FR-106〜109）

`POST /api/uke/upload`（multipart/form-data の `file`。事務・ベテランの役割）。見本は `GET /api/uke/sample?name=…` で取れる。

受け取る条件（1 つでも満たさなければファイルごと断り、何も保存しない。理由は「n 行目：…」の定型文で、ファイルの中の値は返さない）：
- 大きさ 1 MB・5,000 行・1 項目 100 文字まで（`src/uke/limits.ts`。値はたたき台）。回数は 1 分 6 回・1 日 60 回まで（`config/limits.json`）。
- Shift_JIS・CRLF・末尾 EOF。レコードの種類・列数・順が記録条件仕様（このアプリが書き出す主要列）どおり。
- 数字の項目が数字だけで範囲の中。1 日の回数は 9 回まで。請求 id は英数字とハイフン 20 文字まで。
- 診療行為コードがすべて架空コードの表にある。傷病名は未コード化（名称だけ）。診療年月に当たる版がある。
- 同梱の症例（K1〜K7）の請求 id を使うファイルは、見本と同じ内容のときだけ受け取る。すでに受け取った別のファイルと同じ請求 id を持つファイルも断る（どちらを点検しているのかが、クリニックの中で食い違うため。差し替えには対応していない）。

上の条件を通ったものは、見本と違う内容（同梱の症例にない患者・請求 id、複数のレセプト、国保連あて・支払基金あて）でも受け取る。

保存先は、クリニックごとの置き場（`<データの置き場>/tenants/<クリニック>/uke/`）で、名前は内容の SHA-256（`<ハッシュ>.UKE`）。送られたファイル名と請求 id は、パスに使わない。点検では、この置き場のハッシュ名のファイルだけを読み返す（受け取ったファイルの一覧は `app_settings` の `uke-uploads`。DB の形は変えていない）。受け取った UKE は取り込みの一覧に並び、同じクリニックの利用者がそれぞれ取り込む。

### 同梱の症例にないレセプトの扱い

UKE に載るのは請求の中身と患者・保険の情報だけで、判定に要るカルテ側の事実は載らない。同梱の症例にないレセプトは、次の形で月末の点検に並ぶ（`src/server/app/cases.ts`）：
- 事実はどれも「不明」。年齢・保険種別だけは、UKE から作った患者マスタで分かる。傷病名の主傷病の印からも主病を埋めない。足りない事実は「情報不足」の指摘として、医療事務か医師への確認に出る。
- 出来事（訪問・往診・処方・退院・死亡・管理料の算定開始月）の記録と過去月の算定はない。施設の設定は `config/facility.json` の標準。
- 出来事の記録を読んで決めるルール（R05・R06・R07・R09・R14）は、記録から出る指摘を出さず、そのルールを情報不足（訪問の記録がそろっているか）として返す。エンジンは載っていない出来事を「なかった」と読むので、そのままでは「要件不足」「区分誤り」と決めつけてしまうため。
- 合計と行ごとの点数は、行だけで決まるので出る。患者情報チェック（P01〜P08）は UKE の患者・保険の情報で動く。
- 対象外：訪問カルテ（書く患者の一覧・訪問の記録に並ばず、保存は断る）、選択モード（始めるときに断る）、練習問題、カルテとの照合（合成カルテがないので不一致は出ない）、査定・返戻の通知の対応づけ（患者は同梱の合成データからだけ引く）。

残るもの：
- コメントコード（CO）には架空コードの表がない。形（数字 9 桁）だけを見ている。
- 受け取った UKE を消す・差し替える手段がない。受け取れる本数にも上限がない（回数制限だけ）。
- 患者は、保険者番号と番号、または氏名・生年月日・性別が同じなら、患者マスタの同じ人にまとめる。受け取った UKE の患者が同梱の症例の患者と重なると、その患者の加入情報に行が足される。
- IR の審査支払機関と保険者番号の食い違い、医療機関コードは確かめていない。
- 「カルテ側の記録がない」を表す専用の事実がないので、情報不足の項目は「訪問の記録がそろっているか」を借りている。画面で入力しても、記録そのものは入らないので、この情報不足は消えない。

## 公式仕様との照合（確認日 2026-11-17）

確認済み（一次資料を読んで、スキーマと模擬サーバーを合わせた）：
- 日レセ API 概要（呼び出し方・BASIC 認証・WebORCA の `/api`）：https://www.orca.med.or.jp/receipt/tec/api/
- 患者基本情報 patientgetv2（更新履歴の最新 2026-08-25）。`format=json`、`patientinfores`、`Api_Result`（ゼロ以外エラー。10＝患者なし）、氏名・生年月日（YYYY-MM-DD）・性別（1 男 2 女）、保険組合せ（保険者番号・記号・番号・適用開始日・終了日・外来負担割合）、公費（負担者番号・受給者番号・適用開始日・終了日）：https://www.orca.med.or.jp/receipt/tec/api/patientget.html
- 診療行為 medicalgetv2（更新履歴の最新 2026-07-28）。xml2 形式だけ、class=03 の項目名と算定日区分：https://www.orca.med.or.jp/receipt/tec/api/medicalinfo.html
- 患者病名 diseasegetv2。xml2 形式だけ：https://www.orca.med.or.jp/receipt/tec/api/disease.html
- JP_Patient（V1.2.0、2025-07-30）。患者番号の検索（SHALL）：https://jpfhir.jp/fhir/core/1.2.0/StructureDefinition-jp-patient.html
- JP_HumanName（V1.2.0）。漢字・カナの見分け（拡張 iso21090-EN-representation、IDE｜SYL）：https://jpfhir.jp/fhir/core/1.2.0/StructureDefinition-jp-humanname.json
- JP_Coverage（V1.2.0、2024-12-30）。被保険者識別子の 2 つの形と system、記号・番号の拡張（valueString）、有効期間、`beneficiary` 検索、payor は Organization への参照：https://jpfhir.jp/fhir/core/1.2.0/StructureDefinition-jp-coverage.html
- JP_Organization（V1.2.0）。保険者番号の identifier system：https://jpfhir.jp/fhir/core/1.2.0/StructureDefinition-jp-organization.json
- JP_Encounter（`date`＋`patient` 検索）：https://jpfhir.jp/fhir/core/1.2.0/StructureDefinition-jp-encounter.html
- JP_MedicationRequest（`patient`＋`authoredon` 検索、medication[x] は CodeableConcept）：https://jpfhir.jp/fhir/core/1.2.0/StructureDefinition-jp-medicationrequest.html
- JP_Condition（`patient` 検索）：https://jpfhir.jp/fhir/core/1.2.0/StructureDefinition-jp-condition.html

未確認のまま形を決めている（実機の前に確かめる。詳しくは `orca.ts`・`fhir.ts` の冒頭）：
- ORCA：`format=json` のときの JSON の形（仕様にあるのは xml2 のサンプルだけ。同じ項目名で、繰り返しは配列と仮定）。記号・番号が全角で返るか。適用終了日 9999-12-31 の意味。公費の負担率の単位（写していない）。
- FHIR：公費負担者番号の置き場所と identifier system（既定は `urn:example:…` の仮の値）、公費の受給者番号の置き場所（`subscriberId` と仮定）、payor を論理参照で読むこと。
- FHIR：負担割合の値の単位（置き場所 `costToBeneficiary` は確認。写していない）。訪問診療の Encounter の見分け方。表示名を `text` から読むこと。
- FHIR：検索の SHOULD の項目と、日付に ge／le を並べる書き方を相手が受けるか。ページ送り（next リンク）は FHIR R4 本体の仕様で、JP Core の文書では確かめていない。
- 共通：相手の認証方式（Bearer で足りるか）、応答の大きさと所要時間、患者番号の文字種（いまは英数字 20 文字まで）。
