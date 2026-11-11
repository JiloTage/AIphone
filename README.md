# AIphone

日本語でAIと話す、認証なしのWebアプリです。Cloudflare Workersが画面とAPIを配信し、Modal上のIrodori-TTS + speech.cppが音声を生成します。

## 構成

```text
ブラウザー ── テキスト / SSE ── Cloudflare Worker ── OpenAI Responses
     │                              │                 gpt-6-luna / effort=none
     ├── PCM 24kHz / WebSocket ──────┼── OpenAI Realtime transcription
     │                              │   gpt-live-transcribe / delay=minimal
     └── 音声 / WebSocket ───────────┴── Modal (T4 GPU)
                                         speech.cpp v0.10.1
                                         Irodori-TTS v4.1 Small MF
```

- 左のサイドバーで会話を分けます。会話履歴はこのブラウザーのlocalStorageに保存します。端末間同期はありません。
- 通話ボタンを押すと呼び出し音が鳴ります。Modalのモデル読み込みと短い試し合成、文字起こし接続、マイクの準備が終わってから通話可能な表示になります。
- 通話中は音声生成と同じModalコンテナーへのWebSocketを保持し、20秒間隔のpingを送ります。無言でも通話の呼び出しは実行中のままです。切断時には会話履歴を保ち、自動再接続します。
- AIの文章は受信しながら表示し、返答が完成したら全文を一度だけspeech.cppへ渡します。文や長文の分割はspeech.cppに任せ、出力の生PCMストリームを到着次第中継・再生します。話しかけると再生・生成を中断します。
- マイク音声はブラウザーで発話区間を検出し、24kHzモノラルPCM16で文字起こしへ送ります。無音が560ms続くと発話を確定します。
- ログイン画面はありません。OpenAIキーとCloudflare→Modalの内部トークンはサーバー側だけで使用します。内部トークンは利用者のログイン認証ではありません。

## 現在の状態と検証範囲

実際の公開URL、アカウント情報、本番固有のリソース名はGitに保存しません。ローカル検証は `evidence/verification.json` を参照してください。

`evidence/` はローカルの検証記録です。端末のパス、画面、テスト時の会話内容が含まれるため、Gitには含めません。クローン直後には存在せず、`node scripts/verify.mjs` でローカル検証記録を生成できます。

実サービスで、Irodoriの日本語合成音声を文字起こしへ送り、Lunaの返答を再び音声にする往復を確認しました。`gpt-6-luna` / `reasoning.effort: "none"` を実応答で確認し、同じ音声・文字起こし接続を140秒間維持してからの合成も確認しています。これは合成音声を入力したAPI検証です。実マイク、スピーカーでの聴感、発話割り込み、数時間の通話は未確認です。測定中には音声受信が数十秒遅れる試行もあり、安定した低遅延を保証する結果ではありません。

## 初回セットアップ（PowerShell）

作業ディレクトリーはこのリポジトリーです。Node.js 22以降とuvが必要です。

```powershell
npm ci
uv sync --locked
$env:PYTHONIOENCODING = "utf-8"
Copy-Item wrangler.jsonc wrangler.local.jsonc
Copy-Item .env.deploy.example .env.deploy
```

`wrangler.local.jsonc` の `name` と、`.env.deploy` のModalアプリ・Secret・Volume名を、自分の環境に合わせて設定します。この2ファイルはGit対象外です。既存環境では作成済みのファイルを上書きせず、そのまま使ってください。リポジトリー内の名前は設定例で、本番の識別情報ではありません。

### 1. Modalにログインし、内部トークンを登録

```powershell
uv run modal setup
```

ブラウザーでModalアカウントにログインします。次のコマンドでランダムな内部トークンを一つ作り、パスワードマネージャーなどへ控えてください。チャットやGitへ貼り付ける必要はありません。

```powershell
uv run python -c "import secrets; print(secrets.token_urlsafe(32))"
```

[Modalの管理画面](https://modal.com/)のSecretsで、次のSecretを作成します。

| 項目 | 値 |
| --- | --- |
| Secret名 | `.env.deploy` の `MODAL_SECRET_NAME` と同じ名前 |
| 環境変数名 | `MODAL_API_TOKEN` |
| 値 | 今作った内部トークン |

OpenAIのAPIキーはModalには登録しません。

### 2. 音声APIをModalへデプロイ

```powershell
npm run deploy:voice
```

初回はspeech.cppのCUDAビルドとモデルの取得があります。T4に対応するCUDAアーキテクチャ7.5でビルドし、CUDAバイナリーでモデルを取得する工程にもT4を使います。完了時に表示される `VoiceServer.web` の `https://…modal.run` URLを控えます。モデルはイメージに含まれ、通話のたびにダウンロードしません。

通常は0コンテナー、最大1コンテナー、CPU要求1コア・上限4コア、8GiB RAMです。GPUはT4に固定しています。2026-11-11時点の [Modalの料金](https://modal.com/pricing) では最安のGPUで、GPU単体は $0.000164/秒（$0.5904/時）です。CPU・RAM・OpenAIの費用は別途かかります。高いGPUへの自動切り替えはなく、T4の空きがなければ割り当てを待ちます。同じGPUで合成を一件ずつ処理し、WebSocket等の入力は最大16件です。複数の通話が重なると合成待ちが発生します。

### 3. Cloudflareに接続情報を登録

Cloudflareの認証が必要な環境では最初に `npx wrangler login` を実行します。この作業環境ではログイン済みでした。

[OpenAI Platform](https://platform.openai.com/api-keys)でAPIキーを用意し、次を順に実行します。値は各コマンドの非表示プロンプトへ入力します。

```powershell
npx wrangler secret put OPENAI_API_KEY --config wrangler.local.jsonc
npx wrangler secret put MODAL_API_URL --config wrangler.local.jsonc
npx wrangler secret put MODAL_API_TOKEN --config wrangler.local.jsonc
npm run deploy
```

`MODAL_API_URL` は手順2のURL、`MODAL_API_TOKEN` は手順1と同じ値です。OpenAI側で `gpt-6-luna` と `gpt-live-transcribe` が利用可能である必要があります。

### 4. 実際に通話を確認

公開URLをChromeまたはSafariで開き、通話ボタンを押してマイクの使用を許可してください。

1. コールド状態から呼び出し表示になり、音声の準備後に「お話しください」になること。
2. 日本語で話して、文字起こし・AIの文章・合成音声が順番に届くこと。
3. AIの発話中に話しかけると、前の音声が止まること。エコーが入る環境ではヘッドホンも試してください。
4. 数分黙ってから再び話しても、通話のための再コールドスタートが起きないこと。
5. ネットワークを一時的に切断したあと、会話履歴を保って再接続すること。
6. 終話後にマイク表示が消え、別セッションの会話と混ざらないこと。

上記は利用する端末で必要な実機確認です。APIの往復・140秒間の接続維持は確認済みですが、この手順全体をブラウザーと実マイクで通過したとは扱っていません。

## プロンプトと設定の編集

| 編集対象 | ファイル | 反映するコマンド |
| --- | --- | --- |
| 会話の性格・口調・返答の長さ | `prompts/system.txt` | `npm run deploy` |
| 文字起こしの文脈や固有名詞 | `prompts/transcription.txt` | `npm run deploy` |
| 声質・読み方の指示 | `prompts/voice.txt` | `npm run deploy:voice` |
| LLM、reasoning、文字起こし遅延 | `config/models.json` | `npm run deploy` |
| Irodoriモデル、声、速度、seed | `config/voice.json` | `npm run deploy:voice` |

Lunaは公式仕様で `none` に対応しているので、`none` を設定しています。別モデルへの自動切り替えはありません。`gpt-live-transcribe` の `minimal` はライブ音声の最小遅延設定です。他モデルとの実測比較による「最速」の保証はありません。

サイドバーの「声の設定」で、速度、生成ステップ数、シード、声の指示、言語、秒数指定、長さの倍率、末尾の無音判定を変更できます。「設定を保存」でアプリ全体に保存され、次の通話から反映されます。保存前の設定は「声を試聴する」で確認できます。MFモデルが対応しないCFGやtemperature等は表示しません。運用上の上限はstepsが64、duration_scaleが0.1〜4です。

参照音声は設定画面から名前を付けて登録・選択・再生・削除できます。ブラウザーが読み込めるWAV/MP3等を24 kHz・モノラルPCM16 WAVに変換してアップロードします。元ファイル25 MB以下、0.5〜120秒、登録32件までです。登録後に声を選んで設定を保存してください。参照なしでは、同じ指示・seedでも文ごとに声質が変わることがあります。

設定と登録した参照音声は、`.env.deploy` の `MODAL_VOLUME_NAME` で指定したModal Volumeの `/data` に永続保存します。別のブラウザー・端末でも共通で、再デプロイやコールドスタート後も保持します。変更はリビジョンを照合し、別の画面の更新を古い設定で上書きしません。現構成は `max_containers=1` で単一の書き込み元を想定します。複数コンテナーへ増やす場合は、保存処理の排他制御を変更してください。

音声APIには `response_format: "pcm"`, `stream_format: "audio"` を指定しています。アプリ側で70文字に分割する処理はありません。speech.cpp v0.10.1のIrodori処理は全文を内部で分割し、文間には標準で0.9秒の間を入れます。音声の出力はストリームですが、読み上げの開始はLunaの返答が完成してからです。APIの入力上限は一回4000文字です。

```text
speech voice irodori-tts-mf reference.wav backend/voices/reference.voice.gguf
```

上のCLI方式も利用できます。`config/voice.json` の `voice` を `"reference"` に変えてModalを再デプロイすると、その声ファイルを読み込みます。声ファイルはGit管理から除外しています。画面で保存済みのパラメーターは、コード内の初期値より優先されます。「初期値に戻す」後に保存すれば初期値へ戻せます。

## ローカル開発と検証

ローカルでも実サービスを使う場合だけ、`.dev.vars.example` を `.dev.vars` にコピーして3つの値を設定します。`.dev.vars` はGit対象外です。

```powershell
npm run dev
```

ローカルURLは `http://127.0.0.1:8787` です。設定がなくても画面と「設定待ち」の動作を確認できます。

```powershell
node scripts/verify.mjs
```

このコマンドはJavaScript/Pythonの検証、Modalアプリの読み込み、Cloudflareのdry-runビルドを実行し、コードのSHA-256と実行ログを `evidence/` に保存します。外部AIは呼びません。

テキスト会話の画面だけを検証する専用fixtureは次で起動します。決まった検証用文章を返すだけで、AIを呼びません。公開用フォルダーの外に置いています。

```powershell
node tests/browser-server.mjs
```

`http://127.0.0.1:8788` を開いてセッションの作成・切替・再読込を確認できます。入出力は `evidence/browser-fixture.jsonl` に記録されます。

## 保存と運用上の範囲

会話の保存先はブラウザーです。サーバーに履歴DBは置いていませんが、推論のために通話音声と会話内容はOpenAIへ、読み上げる文章はModalへ送ります。通話の録音ファイルはアプリで保存しません。設定画面で登録した参照音声は、声の設定とともにアプリのModal Volumeへ保存します。OpenAI Responsesには `store: false` を指定します。プロバイダー独自のログ・保持ポリシーとは別です。

認証がないため、サイトにアクセスできる人は共通の設定を変更し、登録した参照音声を再生・利用・削除できます。参照音声を非公開にしたい場合は認証が必要です。参照音声の原本は削除時にVolumeから取り除きます。進行中の通話は開始時の設定と参照音声をメモリーに保持し、通話終了まで同じ声で話せます。speech.cppには声を個別にアンロードするAPIがないため、読み込み済みの声の特徴はコンテナー終了までメモリーに残ります。コンテナー内の読み込みは64種類までに制限しています。登録・削除を繰り返して上限に達した場合は通話を終了し、120秒の停止待機後に接続してください。

長い会話では直近80件・合計4万文字以内をモデルへ送ります。履歴自体はブラウザーに残ります。ページを閉じたりセッションを切り替えると通話を終了します。スマートフォンの画面ロック、OSによるタブ停止、ネットワーク障害中の無停止動作は保証できません。再接続の間に届かなかった音声は録音・再送しません。

ログインなしのURLから有料APIを利用できるため、URLを知る第三者も利用でき、費用が発生します。同一オリジン検査はログイン認証の代わりにはなりません。会話中と終話後のscale-down待機中はModalのリソース費用がかかります。

speech.cppはv0.10.1のコミットに固定しています。本構成ではModal上でCUDAビルドとT4での日本語PCM生成を確認しました。生成音声から実際に日本語を文字起こしできましたが、声質や発音の聴感評価は未実施です。

## 参照した一次資料

- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [GPT-Live-Transcribe](https://developers.openai.com/api/docs/models/gpt-live-transcribe)
- [speech.cppのIrodori-TTS](https://github.com/nyosegawa/speech.cpp/blob/v0.10.1/docs/models/irodori-tts.md)
- [speech.cpp HTTPサーバー](https://github.com/nyosegawa/speech.cpp/blob/v0.10.1/docs/server.md)
- [speech.cppビルド](https://github.com/nyosegawa/speech.cpp/blob/v0.10.1/docs/install.md)
- [Modal Web Functions / WebSockets](https://modal.com/docs/guide/webhooks)
- [Modal cold starts](https://modal.com/docs/guide/cold-start)
- [Cloudflare WebSockets](https://developers.cloudflare.com/workers/examples/websockets/)
