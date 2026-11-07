# ハッカソン動画の冒頭（37 秒）

文字で「医療事務って大変」を見せる冒頭部分。ナレーションはなし。背景は、生成したピクトグラム風の画像と、`index.html` で描く図形の 2 種類。

## 書き出し方

```bash
npx tsx video/opening/render.ts --bgm video/opening/bgm/hope-1.wav   # 確認表を出してから out/opening.mp4 を書き出す（約 1 分半）
npx tsx video/opening/render.ts --check    # 長さ・読む速さ・文字サイズの確認だけ
npx tsx video/opening/render.ts --stills   # 各画面の終わり際の静止画（out/stills/）
```

手元の Google Chrome（ヘッドレス）と ffmpeg を使う。Chrome の場所が違う場合は `CHROME_PATH` で指定する。`out/` は Git に入れない。

### BGM（Lyria 2）

```bash
npx tsx video/opening/gen-bgm.ts --name hope-3 --prompt "..." --negative "..."   # bgm/hope-3.wav と .json（プロンプト）ができる
```

採用は `bgm/hope-1.wav`。Lyria 2 の曲は 32.8 秒固定なので、画面 3 の頭（6 秒）から鳴らす（`scenes.json` の `bgmStartScene`・`bgmVolume`）。課金先は GCP プロジェクト `cuc-opening-movie`（`GCP_PROJECT` で変更可）。`--bgm` を付けないと `bgm.ts` の合成音で書き出す。

### 背景画像（Codex CLI）

```bash
npx tsx video/opening/gen-image.ts              # image-prompts.json のうち、まだ無い画像を作る
npx tsx video/opening/gen-image.ts s07-chart    # 指定した画像を作り直す
```

画像を使う画面は `scenes.json` の `bg` で指定する。薄さは `bgOpacity`。人物は顔のないピクトグラムにする。正しさが要る文字（略語・日付の印・役職名）は画像に入れず、`index.html` で上に重ねる。

| 画面 | 背景 |
| --- | --- |
| 1・2・3・4・6・7 | 生成画像（`images/`）。画面 2 は診療所から請求書が飛び、コインが戻って積まれる動きを図形で重ねる（金額は出さない）。画面 7 は略語 PD・DM・Do を図形で重ねる |
| 5 | 図形：業務名が出るたびに、その業務の物（書類・電話・呼び鈴・窓口・ファイル・封筒）が机に落ちて積み上がる |
| 8 | 図形：モニターの縁の付箋と、モニターの前にひとり（後ろ姿のピクトグラム）、左右の空いた椅子（孤独） |
| 9・10 | 図形：カレンダーの印／積み上がる付箋 |
| 11 | 図形：米国の役職の階段と「米国では、資格の先に役職が続く。」 |

## ファイル

| ファイル | 中身 |
| --- | --- |
| `scenes.json` | 各画面の文言・秒数・背景と、文字サイズなどの見た目の値 |
| `us-ladder.json` | 画面 11 の米国の役職の階段（**出典確認中の仮の値**） |
| `image-prompts.json` | 背景画像のプロンプト |
| `index.html` | 画面の描画。`renderAt(t)` が t 秒時点の 1 コマを描く |
| `render.ts` | 確認表の出力、コマの撮影、mp4 への書き出し |
| `gen-image.ts` | Codex CLI で背景画像を作る（horimovie の `gen_image.sh` を移植） |
| `gen-bgm.ts` | Lyria 2 で BGM を作る（horimovie の `gen_bgm.py` を移植） |
| `bgm.ts` | 予備の BGM をその場で合成して WAV に書く |
| `images/` | 生成した背景画像と、そのプロンプト・Codex のスレッド ID |
| `bgm/` | 生成した BGM と、そのプロンプト |

### 画面 11 の役職を差し替える・外す

`us-ladder.json` の `steps` を書き換える。確認が取れなかった段は `"include": false` にすると外れ、残りの段で階段を描き直す。確認した出典は `source` に URL で書く。

## 確認結果（最新の書き出し）

- 全体の長さ：37.0 秒（ロゴの画面は 2026-11-08 に外した）
- 読む速さ（句読点・括弧を除いた文字数 ÷ 画面の秒数）：画面 3 が 8.7 字/秒、画面 10 が 8.3 字/秒で目安の 8 字/秒を超える。画面 11 は米国の一文を含めて 31 字/5 秒。それ以外は 8 字/秒以内
- 小さい文字：44px（高さの 4.1%）。出典表記だけは 26px（2.4%）
- 1920×1080、30fps、H.264 + AAC

## 素材の出典とライセンス

| 素材 | 使った場所 | 出典 | ライセンス・注意 |
| --- | --- | --- | --- |
| ヒラギノ角ゴシック（W3 / W7） | すべての文字 | macOS に付属 | Apple の macOS ソフトウェア使用許諾契約による。フォントで描いた文字を動画にして公開・商用利用できるかは、契約本文での確認が済んでいない（推測では可能）。公開前に確認するか、Noto Sans JP（SIL OFL）に差し替える |
| Noteworthy | 画面 7 の手書き風の略語 | macOS に付属 | 同上 |
| 背景画像 6 枚 | 画面 1・2・3・4・6・7 | Codex CLI の image_generation（OpenAI）で生成。プロンプトとスレッド ID は `images/*.json` | OpenAI の利用規約では、生成物（Output）の権利は利用者に帰属する（https://openai.com/policies/terms-of-use）。既存の作品との類似について OpenAI の補償はない |
| BGM | 画面 3〜11 | Vertex AI Lyria 2（`lyria-002`）で生成。プロンプトは `bgm/hope-1.json` | Google Cloud Service Specific Terms 20(a)：生成物は Customer Data で、Google は新たな知的財産の所有権を主張しない（https://cloud.google.com/terms/service-terms）。電子透かし SynthID 入り。既存曲との類似について Google の補償対象かは未確認 |
| BGM（予備） | 使っていない | `bgm.ts` が正弦波から合成（自作） | 第三者の素材なし |
| 画面 6 の数字 | 年収 334万円 | 第25回医療経済実態調査報告 p.330-331 https://www.mhlw.go.jp/content/10808000/001599544.pdf | evidence-master 1-1 の採用値 |

写真・他者の音源は使っていない。画面 5・8・9・10・11 の背景は、`index.html` の中で図形として描いている。
