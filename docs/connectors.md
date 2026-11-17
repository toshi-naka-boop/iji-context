# 連携（コネクタ）

電子カルテ・レセコンとつなぐための境界と、読み取りコネクタの説明（spec FR-104〜115）。
**実機にはつないでいない。** 相手は同梱の模擬サーバー（合成データ）だけで、画面や API への配線もまだない（境界とコネクタだけがある）。

## 境界の 3 つの型（`src/connect/types.ts`）

| 境界 | 返すもの | 持っているコネクタ |
|---|---|---|
| `PatientSource` | 患者基本情報 `ConnectorPatient`（氏名・性別・生年月日・保険と公費の一覧＝番号・記号・負担割合・有効期間） | fixture・orca・fhir |
| `ClaimSource` | 診療年月の請求 `ConnectorClaims`（`files` は UKE を読んだときと同じ `UkeFile`、`unmapped` は対応のないコードの行） | fixture・orca |
| `ChartSource` | 診療年月のカルテ記載 `ConnectorChart`（訪問日ごとの記録・処方・傷病名） | fixture・fhir |

`Connector = { id, label, patient?, claims?, chart? }`。持っている能力だけを載せる。書き込みの口はない。

| id | 中身 | ファイル |
|---|---|---|
| `fixture` | 同梱の合成データ（fixtures/ の UKE・症例・カルテ）。常に有効。通信しない | `src/connect/fixture.ts` |
| `orca` | ORCA API 形式（日レセ API）。患者基本情報と診療月の診療行為 | `src/connect/orca.ts` |
| `fhir` | HL7 FHIR JP Core 形式。Patient・Coverage と、Encounter・MedicationRequest・Condition の検索 | `src/connect/fhir.ts` |

## コネクタの足し方

1. `src/connect/<id>.ts` に `create<Id>Connector()` を書き、持てる境界だけを実装する。
2. 外へ出る通信は、必ず `connectJson(id, 相対パス)`（`src/connect/fetch.ts`）を通す。`fetch` を直接呼ばない。
3. 応答は zod のスキーマで検査してから境界の型に写す。合わなければ `formatError`（取り込まない）。
4. 通信の形（パス・項目名・スキーマ）はファイルの冒頭に集め、模擬サーバー（`fixtures/connect/mock-server.ts`）も同じ定義を使う。
5. `src/connect/index.ts` の `EXTERNAL` に足し、`tests/connect/` に模擬サーバーとの結合テストを書く。

## 設定（環境変数。既定はすべて空＝外部コネクタは無効）

| 名前 | 意味 | 例（架空） |
|---|---|---|
| `RESEMEN_CONNECTORS` | 有効にする外部コネクタの id（カンマ区切り） | `orca,fhir` |
| `RESEMEN_CONNECT_ALLOW` | 接続を許す `host:port`（完全一致・カンマ区切り） | `recept.example.test:443` |
| `RESEMEN_CONNECT_<ID>_URL` | 接続先。WebORCA の `/api` はここに書く。認証情報・クエリは書けない | `https://recept.example.test/api` |
| `RESEMEN_CONNECT_<ID>_USER`／`_PASSWORD` | Basic 認証（ORCA） | Secret Manager から渡す |
| `RESEMEN_CONNECT_<ID>_TOKEN` | Bearer 認証（FHIR） | 同上 |
| `RESEMEN_CONNECT_ORCA_CODEMAP` | 診療行為コード → 区分 の対応表（JSON）のパス。既定は架空コードの表 | `/data/codemap.json` |
| `RESEMEN_CONNECT_FHIR_PATIENT_SYSTEM` | 患者番号の identifier system（医療機関コードを含む全体。必須） | `urn:oid:1.2.392.100495.20.3.51.19999999999` |
| `RESEMEN_CONNECT_FHIR_INSURER_SYSTEM`／`_KOHI_SYSTEM` | 保険者番号・公費負担者番号の identifier system | 未確認。既定は仮の値 |
| `RESEMEN_CONNECT_TIMEOUT_MS`／`RESEMEN_CONNECT_MAX_BYTES` | タイムアウト（既定 10 秒）・応答の上限（既定 2 MB） | `10000`／`2097152` |

接続先はリクエストから受け取らない。コネクタ id から、この環境変数だけを引く。

## 通信の守り（`src/connect/fetch.ts`）

防ぐもの：
- 許可リストにない接続先（`host:port` の完全一致。既定は空）。
- https 以外。http は「本番でない・ループバック・許可リストにある」がそろったときだけ（模擬サーバー用。本番ではこの例外を持てない）。
- リダイレクト（従わない）、遅い応答（全体にタイムアウト）、大きい応答（content-length と実際に読んだ量の両方）、content-type・JSON・スキーマの違い。
- 本番での内部アドレス宛て。名前解決した IP が 10/8・172.16/12・192.168/16・169.254/16（クラウドのメタデータ）・127/8・0/8・::1・fc00::/7・fe80::/10 なら出ない。
- 相手が返した URL（FHIR の next リンク）で、設定した接続先の範囲（同じ origin・同じパスの下）の外へ出ること。
- 認証情報・接続先のパス・応答の本文が、エラーやログに出ること（エラーに載るのはコネクタ id・原因の種類・定型文・HTTP ステータスだけ。このファイルはログを書かない）。

失敗は `ConnectError` で、`kind` に原因が入る：`config`／`not_allowed`／`redirect`／`timeout`／`too_large`／`format`／`auth`／`upstream`／`network`／`not_found`。

残るもの：
- **DNS リバインディング**。IP を検査したあと、fetch がもう一度名前解決して接続する。そのあいだに DNS の答えを変えられると、内部の IP に届きうる。検査した IP に固定するには接続処理の差し替え（依存の追加）が要り、入れていない。許可リストに載せるのは、DNS を自分で管理している名前か、IP の直書きに限ること。
- 本番でない環境では、内部アドレスの検査をしない（許可リストと https の検査だけ）。
- 100.64/10（CGNAT）など、上に挙げていない範囲は検査しない。
- クライアント証明書（WebORCA クラウド・SSL クライアント認証）には未対応。
- 相手が正しい形で返した誤ったデータは見抜けない（スキーマは形しか見ない）。

## 対応のないコードの扱い（FR-111）

ORCA 形式で読んだ診療行為コードは、対応表で区分に写す。同梱の対応表は架空コード（`src/engine/codes-fictional.ts`）だけで、実在のマスターとの対応表は同梱しない。
対応表にないコード、対応先がこのアプリの区分にないコードは、例外にせず `unmapped`（請求 id・コード・日付）に入れ、算定行には入れない。
`unmapped` が 1 件以上あるレセプトは「判定の対象外 n 件」と表示し、合計を出さない（表示とエンジン側は後の工程）。

## 模擬サーバー（FR-112）

`npx tsx scripts/mock-connect.ts [ポート]` で 127.0.0.1 に起動する（既定 8799）。認証の値は起動のたびに作られ、アプリに渡す環境変数の形で表示される。
返すのは合成データ（K1・K3・K4。`fixtures/connect/orca.json`・`fhir.json`）だけ。パスの頭に `/fault/<種類>` を付けると壊した応答を返す（種類は `mock-server.ts` の `FAULTS`）。自動テストも同じサーバーを使う。

## 実機につなぐ前に確かめること

確認済みなのは EM §2-6 の事実だけ（日レセ API のパス・BASIC 認証・患者基本情報の `format=json`、JP Core のプロファイルの canonical・患者番号の検索・Coverage の記号と番号の拡張）。
次は**公式仕様で未確認のまま形を決めている**。実機の前に一次資料で確かめ、EM に行を足してから直す。

ORCA（`src/connect/orca.ts` の `ORCA_WIRE` とスキーマ）：
- `medicalgetv2` が JSON を受け付け、JSON を返すか（EM O-5 は未確認）。**JSON が使える前提で止めている。** xml2 形式だけなら XML パーサの依存追加（承認が要る。FR-115）が要る。
- 要求・応答の項目名のすべて、性別の値、日付の書式、成功を表す `Api_Result` の値、class=03 の応答が日付まで返すか。
- 負担割合・レセプト種別・摘要コメント・傷病名（`diseasegetv2`）は写していない（請求の `receiptType` は空文字、`diseases`・`comments` は空）。

FHIR（`src/connect/fhir.ts` の `FHIR_WIRE` とスキーマ）：
- 保険者番号・公費負担者番号の identifier system と置き場所（EM F-5 は未確認。既定は `urn:example:…` の仮の値）。
- 記号・番号の拡張の値の型、公費の受給者番号の置き場所、負担割合の置き場所（負担割合は写していない）。
- 検索パラメータを相手が受けるか、氏名の漢字・カナの区別、訪問診療の Encounter の見分け方（いまは期間内のすべてを訪問日として返す）。

共通：相手の認証方式（Bearer で足りるか）、応答の大きさと所要時間（上限の既定値で足りるか）、患者番号の文字種（いまは英数字 20 文字まで）。
