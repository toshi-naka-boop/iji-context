# GCP の VM に公開する手順

レセメンを Google Cloud の VM（Compute Engine）で公開する手順です。審査員などが各自の URL から登録・ログインして使えます。

## 前提と構成

- レセメンは、メンターの AI として Claude Code を裏で動かし、知識・会話・DB をファイルに保存します。そのため、ずっと動いているサーバーと、消えないディスクが要ります。Cloud Run のような、ディスクが消える仕組みには向きません。
- 構成は Docker Compose で 2 つ動かします。
  - **app**：レセメン本体（Next.js）。データはすべて `/data` に置き、Docker のボリュームで残します。
  - **caddy**：https の受け口。Let's Encrypt の証明書を自動で取ります。
- データの置き場所（ボリュームの中）は次のとおりです。
  - `/data/auth.db`：利用者とセッション
  - `/data/tenants/<利用者>/`：その人専用のクリニック（DB・知識・医師確認の記録）
  - `/data/workspaces/`：メンターの作業場所
  - `/data/home/`：Claude Code の会話の記録

## 1. VM を作る（GCP のコンソールか gcloud で、ご自身の操作）

| 項目 | 値の目安 |
|---|---|
| リージョン | asia-northeast1（東京） |
| マシン | e2-medium（2 vCPU・4 GB）以上。メンターは 1 回ごとに Claude Code を起動するので、同時に使う人が多いなら大きめにする（推測。負荷はまだ測っていない） |
| OS | Ubuntu 24.04 LTS |
| ディスク | 30 GB 以上（標準の永続ディスク） |
| ファイアウォール | HTTP と HTTPS のトラフィックを許可 |
| 外部 IP | 静的 IP を予約して付ける（IP が変わると URL と証明書が変わるため） |

料金はマシンの種類とリージョンで変わります。作る前に GCP の料金計算ツールで確かめてください。

## 2. Docker を入れる（VM に SSH して）

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER
```

入れたら一度ログアウトして、入り直します。

## 3. レセメンを置く

```bash
git clone https://github.com/toshi-naka-boop/iji-context.git
cd iji-context/deploy
cp app-settings.example app-settings
chmod 600 app-settings
nano app-settings
```

`app-settings` に `ANTHROPIC_API_KEY` を書きます。このファイルは git にも Docker のイメージにも入りません。より安全にするなら、Secret Manager に置き、起動時に読み出す形に変えます（今回は未対応）。

## 4. URL を決めて起動する

自分のドメインがなければ、IP アドレスをそのまま名前にできる sslip.io が使えます。外部 IP が `34.84.12.34` なら、`34-84-12-34.sslip.io` です。

```bash
export RESEMEN_DOMAIN=34-84-12-34.sslip.io
docker compose up -d --build
```

数分すると `https://34-84-12-34.sslip.io` で開けます。ログイン画面から「はじめて使う」で登録できます。

## 5. 更新・ログ・バックアップ

```bash
git pull && docker compose up -d --build
```

```bash
docker compose logs -f app
```

バックアップは、VM のディスクにスナップショットのスケジュールを設定するのが簡単です（データはすべてボリュームの中にあるため）。

## 気をつけること

- **登録は誰でもできる**：URL を知った人は誰でも登録して AI を呼べます。その利用料は `ANTHROPIC_API_KEY` の持ち主にかかります。Anthropic のコンソールで、利用額の上限を設定しておいてください。
- **パスワードの再発行はない**：忘れた人は、別のログイン ID で登録し直します。
- **実在の患者の情報を入れない**：レセメンは合成データ・架空コードで動きます。登録画面にもその旨を出しています。
- **データ**：止めてもボリュームは残ります。`docker compose down -v` はボリュームごと消すので使わないでください。
