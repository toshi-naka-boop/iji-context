# GCP の VM に公開する手順

レセメンを Google Cloud の VM（Compute Engine）で公開する手順です。審査員などが各自の URL から登録・ログインして使えます。

## 前提と構成

- レセメンは、メンターの AI として Claude Code を裏で動かし、知識・会話・DB をファイルに保存します。そのため、ずっと動いているサーバーと、消えないディスクが要ります。Cloud Run のような、ディスクが消える仕組みには向きません。
- 構成は Docker Compose で 2 つ動かします。
  - **app**：レセメン本体（Next.js）。データはすべて `/data` に置き、Docker のボリュームで残します。
  - **caddy**：https の受け口。Let's Encrypt の証明書を自動で取ります。
- **API キーは Secret Manager に置きます**。VM は自分のサービスアカウントの権限で、起動のたびに読み出します（`deploy/start.sh`）。キーは git にも Docker のイメージにも VM のファイルにも書きません。
- データの置き場所（ボリュームの中）は次のとおりです。
  - `/data/auth.db`：利用者とセッション
  - `/data/tenants/<利用者>/`：その人専用のクリニック（DB・知識・医師確認の記録）
  - `/data/workspaces/`：メンターの作業場所
  - `/data/home/`：Claude Code の会話の記録

## 1. プロジェクトと VM を作る

```bash
gcloud projects create <プロジェクト ID>
```

```bash
gcloud billing projects link <プロジェクト ID> --billing-account=<請求先アカウント>
```

```bash
gcloud services enable compute.googleapis.com secretmanager.googleapis.com --project <プロジェクト ID>
```

```bash
gcloud compute addresses create resemen-ip --region=asia-northeast1 --project <プロジェクト ID>
```

```bash
gcloud compute firewall-rules create resemen-web --allow=tcp:80,tcp:443 --target-tags=resemen-web --project <プロジェクト ID>
```

VM は、初回起動で Docker を入れるスクリプトを付けて作ります。`--scopes=cloud-platform` は、Secret Manager を読むために要ります（読める範囲は、次の手順で付ける権限で絞ります）。

```bash
gcloud compute instances create resemen --zone=asia-northeast1-b --machine-type=e2-medium --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=30GB --address=resemen-ip --tags=resemen-web --scopes=cloud-platform --metadata=startup-script='#!/bin/bash
command -v docker >/dev/null || (apt-get update && apt-get install -y docker.io docker-compose-v2 && systemctl enable --now docker)' --project <プロジェクト ID>
```

マシンは e2-medium（2 vCPU・4 GB）以上にします。メンターは 1 回ごとに Claude Code を起動するので、同時に使う人が多いなら大きめにします（推測。負荷はまだ測っていない）。料金は、作る前に GCP の料金計算ツールで確かめてください。

## 2. API キーを Secret Manager に置く

シークレットの入れ物を作り、VM のサービスアカウント（`<プロジェクト番号>-compute@developer.gserviceaccount.com`）に、そのシークレットだけを読む権限を付けます。

```bash
gcloud secrets create resemen-anthropic-api-key --replication-policy=automatic --project <プロジェクト ID>
```

```bash
gcloud secrets add-iam-policy-binding resemen-anthropic-api-key --member=serviceAccount:<プロジェクト番号>-compute@developer.gserviceaccount.com --role=roles/secretmanager.secretAccessor --project <プロジェクト ID>
```

キーの値は、画面に出さない形で登録します（入力した文字は表示されません）。

```bash
read -rs K && printf %s "$K" | gcloud secrets versions add resemen-anthropic-api-key --data-file=- --project <プロジェクト ID> && unset K
```

音声（ElevenLabs）を使う場合は、`resemen-elevenlabs-api-key` を同じ手順で作ります。なくても動きます（音声だけが使えません）。

キーを入れ替えるときは、新しい版を `versions add` で足して、VM で `deploy/start.sh` をもう一度実行します。

## 3. コードを置いて起動する

コードは、リポジトリから clone するか、手元から送ります（リポジトリが非公開のときは送るほうが簡単です）。

```bash
git archive HEAD | gzip > /tmp/resemen.tar.gz && gcloud compute scp /tmp/resemen.tar.gz resemen:~/ --zone=asia-northeast1-b --project <プロジェクト ID>
```

VM に入り、展開して起動します。自分のドメインがなければ、IP アドレスをそのまま名前にできる sslip.io が使えます。外部 IP が `34.85.108.51` なら `34-85-108-51.sslip.io` です。

```bash
gcloud compute ssh resemen --zone=asia-northeast1-b --project <プロジェクト ID>
```

```bash
mkdir -p ~/resemen && tar -xzf ~/resemen.tar.gz -C ~/resemen && cd ~/resemen/deploy && sudo RESEMEN_DOMAIN=34-85-108-51.sslip.io ./start.sh
```

数分すると `https://34-85-108-51.sslip.io` で開けます。ログイン画面の「はじめて使う」で登録できます。

## 4. 更新・ログ・バックアップ

更新は、手順 3 と同じくコードを送り直して、`start.sh` をもう一度実行します。データはボリュームに残ります。

```bash
sudo docker compose -f ~/resemen/deploy/docker-compose.yml logs -f app
```

バックアップは、VM のディスクにスナップショットのスケジュールを設定するのが簡単です（データはすべてボリュームの中にあるため）。

## 気をつけること

- **登録は誰でもできる**：URL を知った人は誰でも登録して AI を呼べます。その利用料は API キーの持ち主にかかります。Anthropic のコンソールで、利用額の上限を設定しておいてください。
- **パスワードの再発行はない**：忘れた人は、別のログイン ID で登録し直します。
- **実在の患者の情報を入れない**：レセメンは合成データ・架空コードで動きます。登録画面にもその旨を出しています。
- **データ**：止めてもボリュームは残ります。`docker compose down -v` はボリュームごと消すので使わないでください。
