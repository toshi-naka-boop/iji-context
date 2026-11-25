# GCP の VM に公開する手順

レセメンを Google Cloud の VM（Compute Engine）で公開する手順です。審査員などが各自の URL から登録・ログインして使えます。

## 前提と構成

- レセメンは、メンターの AI として Claude Code を裏で動かし、知識・会話・DB をファイルに保存します。そのため、ずっと動いているサーバーと、消えないディスクが要ります。Cloud Run のような、ディスクが消える仕組みには向きません。
- 構成は Docker Compose で 2 つ動かします。
  - **app**：レセメン本体（Next.js）。データはすべて `/data` に置き、Docker のボリュームで残します。
  - **caddy**：https の受け口。Let's Encrypt の証明書を自動で取ります。
- **API キーは Secret Manager に置きます**。VM は自分のサービスアカウントの権限で、起動のたびに読み出します（`deploy/start.sh`）。キーは git にも Docker のイメージにも VM のファイルにも書きません。
- データの置き場所（ボリュームの中）は次のとおりです。データベース・取り込んだ UKE・医師確認の記録は暗号化して置きます（下の「保存時の暗号化」）。
  - `/data/auth.db`：利用者とセッション
  - `/data/tenants/<利用者>/`：その人専用のクリニック（DB・知識・医師確認の記録。メンターとの会話の記録も DB の中）
  - `/data/workspaces/`：メンターの作業場所
- Claude Code が手元に置く会話の記録の写し（`CLAUDE_CONFIG_DIR=/tmp/claude`）と一時ファイルは、ディスクに残らない tmpfs（`/tmp`）に置きます。前の版は `/data/home/` に置いていました（移す手順で DB に写して消します）。

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

## 2b. 保存時の暗号化の鍵を作る（必須）

鍵は 32 バイトの乱数を 16 進 64 文字にしたものです。Secret Manager に、画面に出さない形で作ります。**鍵をなくすと、データは戻せません。** 鍵をデータの置き場（VM のディスク）に置くことはしません。

```bash
gcloud secrets create resemen-data-key --replication-policy=automatic --project <プロジェクト ID>
```

```bash
gcloud secrets add-iam-policy-binding resemen-data-key --member=serviceAccount:<プロジェクト番号>-compute@developer.gserviceaccount.com --role=roles/secretmanager.secretAccessor --project <プロジェクト ID>
```

```bash
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add resemen-data-key --data-file=- --project <プロジェクト ID>
```

**鍵の控えをサーバーの外に置きます。** Secret Manager の版を消さない（`versions destroy` しない）ことに加え、パスワード管理など、別の場所にも控えます。次のコマンドは鍵を画面に出すので、人のいない場所で、控えたらすぐに画面を消してください。

```bash
gcloud secrets versions access latest --secret=resemen-data-key --project <プロジェクト ID>
```

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

数分すると `https://34-85-108-51.sslip.io` で開けます。

登録は招待制で、既定では招待コードのない登録を受け付けません。最初の 1 人は、次の手順で作ります。

1. `sudo RESEMEN_DOMAIN=… RESEMEN_OPEN_SIGNUP=1 ./start.sh` で起動し、ログイン画面の「はじめて使う」で登録する。このとき「デモで試す」か「実在のデータで使う」かを選ぶ（後から変えられない）
2. `RESEMEN_OPEN_SIGNUP` を付けずに `start.sh` をもう一度実行する（招待なしの登録が閉じる）
3. 2 人目からは、「設定」で役割を選んで招待コードを出し、渡す

手順 1 と 2 のあいだは誰でも登録できるので、続けて行ってください。

## 4. 更新・ログ・バックアップ

更新は、手順 3 と同じくコードを送り直して、`start.sh` をもう一度実行します。データはボリュームに残ります。

```bash
sudo docker compose -f ~/resemen/deploy/docker-compose.yml logs -f app
```

バックアップは、VM のディスクにスナップショットのスケジュールを設定するのが簡単です（データはすべてボリュームの中にあるため）。データベースとファイルは暗号化してあるので、戻すときは同じ鍵が要ります。公開版は、まだ製品ではないのでバックアップを取っていません（2026-11-25 の判断。README「公開版で試す」）。

## 5. 保存時の暗号化

`start.sh` は Secret Manager の `resemen-data-key` を `RESEMEN_DATA_KEY` として渡します。アプリは起動のときに次を確かめ、通らなければ起動しません（`docker compose logs app` に理由が出ます）。

- 鍵がある（本番では鍵がなければ起動しない）
- 鍵が `auth.db` と合う（合わなければ止め、データベースは変えない）
- 暗号化していないデータベース・ファイル・前の版の会話の記録（`/data/home/.claude`）が置き場にない

### 今ある平文のデータを移す（この版より前から動かしていたとき）

アプリを止めてから、手で流します。スクリプトは開発用の依存（tsx）で動くので、`tools` のイメージで流します。ボリュームの名前は `docker volume ls` で確かめます（`deploy` のフォルダから起動していれば `deploy_resemen-data`）。

```bash
cd ~/resemen && sudo docker build --target tools -t resemen-tools . && sudo docker compose -f deploy/docker-compose.yml stop app
```

控えの置き場を作ります。スクリプトはアプリと同じ利用者（`node`。uid 1000）で流すので、その利用者が書ける場所にします（root で流すと、差し替えたファイルをアプリが書けなくなります）。

```bash
sudo mkdir -p /var/backups/resemen && sudo chown 1000:1000 /var/backups/resemen && sudo chmod 700 /var/backups/resemen
```

鍵は、この端末の環境変数にだけ置きます（コマンドの引数に書かない）。

```bash
export RESEMEN_DATA_KEY="$(gcloud secrets versions access latest --secret=resemen-data-key)"
```

まず `--dry-run` で対象の一覧を出します（何も変えません）。

```bash
sudo --preserve-env=RESEMEN_DATA_KEY docker run --rm --user node -e RESEMEN_DATA=/data -e RESEMEN_DATA_KEY -v deploy_resemen-data:/data -v /var/backups/resemen:/backup resemen-tools npx tsx scripts/encrypt-at-rest.ts --dry-run
```

一覧が合っていれば、控えの場所を付けて流します。流す前に、データの置き場を丸ごと `/var/backups/resemen/` の下に控えます。データベースは暗号化した写しを作り、整合性の検査・スキーマの版・表ごとの行数が元と合ってから差し替えます。二度流しても壊れません（済んだものは飛ばします）。

```bash
sudo --preserve-env=RESEMEN_DATA_KEY docker run --rm --user node -e RESEMEN_DATA=/data -e RESEMEN_DATA_KEY -v deploy_resemen-data:/data -v /var/backups/resemen:/backup resemen-tools npx tsx scripts/encrypt-at-rest.ts --backup /backup/before-encrypt
```

`unset RESEMEN_DATA_KEY` のあと、`start.sh` で起動し、ログインして今までのデータが見えることを確かめます。確かめたら、控え（平文のまま）を消します。それまでのスナップショットも平文なので、要らなければ消します。

```bash
sudo rm -r /var/backups/resemen/before-encrypt
```

### 鍵の入れ替え

自動の入れ替えはありません。アプリを止めてから、手で流します。新しい鍵を Secret Manager に新しい版として足し、今の鍵と新しい鍵の両方を環境変数に置きます。

```bash
export RESEMEN_DATA_KEY="$(gcloud secrets versions access latest --secret=resemen-data-key)" && openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add resemen-data-key --data-file=- && export RESEMEN_NEW_DATA_KEY="$(gcloud secrets versions access latest --secret=resemen-data-key)"
```

```bash
sudo docker compose -f ~/resemen/deploy/docker-compose.yml stop app && sudo --preserve-env=RESEMEN_DATA_KEY,RESEMEN_NEW_DATA_KEY docker run --rm --user node -e RESEMEN_DATA=/data -e RESEMEN_DATA_KEY -e RESEMEN_NEW_DATA_KEY -v deploy_resemen-data:/data -v /var/backups/resemen:/backup resemen-tools npx tsx scripts/rotate-key.ts --backup /backup/before-rotate
```

全部のデータベースの鍵を変え、ファイルを包み直します（`--dry-run` で対象の一覧だけを出せます）。`unset RESEMEN_DATA_KEY RESEMEN_NEW_DATA_KEY` のあと、`start.sh` で起動して開けることを確かめます。控え（古い鍵で暗号化したもの）を消すまでは、Secret Manager の古い版を消さないでください。


## 6. 前の版から更新する（公開版の差し替え）

保存時の暗号化より前の版から上げるときの通しの手順です。手順 2b（鍵）を先に済ませておきます。止めてから起動し直すまでのあいだ、公開版は開けません。

**1. 送るコードを作る（手元）**。送るのは、上げたい版を checkout したフォルダの `HEAD` です（別のブランチを checkout したフォルダで流すと、別の版が送られます）。

```bash
git -C <上げたい版のフォルダ> log --oneline -1 && git -C <上げたい版のフォルダ> archive HEAD | gzip > /tmp/resemen.tar.gz && gcloud compute scp /tmp/resemen.tar.gz resemen:~/ --zone=<VM のゾーン> --project <プロジェクト ID>
```

**2. 公開マスターを送る（手元）**。手元で作った `masters.db`（[masters.md](masters.md)）を送ります。公開のデータなので暗号化しません。

```bash
gcloud compute scp <手元の masters のフォルダ>/masters.db resemen:~/ --zone=<VM のゾーン> --project <プロジェクト ID>
```

**3. VM で展開し、アプリを止め、道具のイメージを作る**。前のコードは名前を変えて残します。

```bash
mv ~/resemen ~/resemen.prev && mkdir -p ~/resemen && tar -xzf ~/resemen.tar.gz -C ~/resemen && cd ~/resemen && sudo docker compose -f ~/resemen.prev/deploy/docker-compose.yml stop app && sudo docker build --target tools -t resemen-tools .
```

**4. 平文のデータを移す**。手順 5「今ある平文のデータを移す」の控えの置き場・鍵・`--dry-run`・本番の流しを、その順に行います。

**5. 古いデモのクリニックを退避する**。データの版の印が今と違うデモのクリニックは、名前を変えて退避します（消しません。次に開いたときに今の版で作り直されます）。実在のデータで使うクリニックは触りません。まず一覧だけを出し、合っていれば `--yes` を付けて流します。

```bash
sudo --preserve-env=RESEMEN_DATA_KEY docker run --rm --user node -e RESEMEN_DATA=/data -e RESEMEN_DATA_KEY -v deploy_resemen-data:/data resemen-tools npx tsx scripts/reset-demo.ts --retire-stale
```

```bash
sudo --preserve-env=RESEMEN_DATA_KEY docker run --rm --user node -e RESEMEN_DATA=/data -e RESEMEN_DATA_KEY -v deploy_resemen-data:/data resemen-tools npx tsx scripts/reset-demo.ts --retire-stale --yes
```

**6. 公開マスターを置き場に入れる**。置き場の `masters/` に入れます（アプリと同じ利用者の持ち物にします）。

```bash
sudo docker run --rm --user node -v deploy_resemen-data:/data -v ~/masters.db:/in/masters.db:ro resemen-tools sh -c 'mkdir -p /data/masters && cp /in/masters.db /data/masters/masters.db'
```

**7. 起動して確かめる**。`unset RESEMEN_DATA_KEY` のあと `start.sh` で起動し、ログを見ます。

```bash
unset RESEMEN_DATA_KEY && cd ~/resemen/deploy && sudo RESEMEN_DOMAIN=<ドメイン> ./start.sh && sudo docker compose -f ~/resemen/deploy/docker-compose.yml logs --tail 50 app
```

確かめること：ログインできる／今までのクリニックのデータが見える／事務長の「設定」でマスターが入っている／注意書きの同意を求められる（版 3 に上がったので、全員にもう一度求めます）。

**8. 片づける**。確かめたら、平文の控え（`/var/backups/resemen/before-encrypt`）・送ったファイル・前のコードを消します。

```bash
sudo rm -r /var/backups/resemen/before-encrypt && rm ~/resemen.tar.gz ~/masters.db && rm -r ~/resemen.prev
```

**戻すとき**：手順 7 で起動しないときは、`docker compose logs app` の理由を見ます。暗号化を済ませた置き場は前のコードでは開けません。戻すなら、`/var/backups/resemen/before-encrypt` の控えを置き場に書き戻してから、前のコード（`~/resemen.prev`）で起動します。

## 気をつけること

- **登録は招待制**：`RESEMEN_OPEN_SIGNUP=1` を付けているあいだは、URL を知った人が誰でも登録して AI を呼べます。その利用料は API キーの持ち主にかかります。AI の呼び出しの上限は、利用者ごとの上限と、サーバー全体の 1 日の上限（`perDayAll`。AI は 1,000 回、音声は 500 回のたたき台）があります（`config/limits.json`）。回数の上限なので金額は縛れません。Anthropic のコンソールで、利用額の上限も設定しておいてください。
- **パスワードを忘れた人**：事務長か持ち主が、設定の「職員」で仮のパスワードを出します（次のログインで本人が変えます）。実在のデータで使うクリニックの医師には出せないので、アカウントを停止し、医師の招待で登録し直してもらいます。
- **実在の患者の情報**：公開版も、注意書きへの同意を取ったうえで受け取ります。入れるかは、データを入れる医療機関が決めます（README・docs/security.md）。
- **データ**：止めてもボリュームは残ります。`docker compose down -v` はボリュームごと消すので使わないでください。
