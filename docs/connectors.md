# 連携（コネクタ）

電子カルテ・レセコンとつなぐための境界と、読み取りコネクタの説明（spec FR-104〜115）。
**実機にはつないでいない。** 相手は同梱の模擬サーバー（合成データ）だけで、画面や API への配線もまだない（境界とコネクタだけがある）。

## 境界の 3 つの型（`src/connect/types.ts`）

| 境界 | 返すもの | 持っているコネクタ |
|---|---|---|
| `PatientSource` | 患者基本情報 `ConnectorPatient`（氏名・性別・生年月日・保険と公費の一覧＝番号・記号・負担割合・有効期間） | fixture・orca・fhir |
| `ClaimSource` | 診療年月の請求 `ConnectorClaims`（`files` は UKE を読んだときと同じ `UkeFile`、`unmapped` は対応のないコードの行） | fixture |
| `ChartSource` | 診療年月のカルテ記載 `ConnectorChart`（訪問日ごとの記録・処方・傷病名） | fixture・fhir |

`Connector = { id, label, patient?, claims?, chart? }`。持っている能力だけを載せる。書き込みの口はない。

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
| `RESEMEN_CONNECT_ORCA_CODEMAP` | 診療行為コード → 区分 の対応表（JSON）のパス。既定は架空コードの表 | `/data/codemap.json` |
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
応答を読めたあとの写し方（`medicalMonthToLines`：class=03 の `Medication_Code` と `Perform_Calendar` → 算定行と `unmapped`）だけを、公式の項目名で置いてある（通信なし。どこからも呼ばれていない）。

## 模擬サーバー（FR-112）

`npx tsx scripts/mock-connect.ts [ポート]` で 127.0.0.1 に起動する（既定 8799）。認証の値は起動のたびに作られ、アプリに渡す環境変数の形で表示される。
返すのは合成データ（K1・K3・K4。`fixtures/connect/orca.json`・`fhir.json`）だけ。パスの頭に `/fault/<種類>` を付けると壊した応答を返す（`mock-server.ts` の `FAULTS`）。自動テストも同じサーバーを使う。

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
