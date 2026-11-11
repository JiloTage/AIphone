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
- AIの返答はテキストを受信しながら短い文に区切って合成し、PCM音声を到着順に再生します。話しかけると再生・生成を中断します。
- マイク音声はブラウザーで発話区間を検出し、24kHzモノラルPCM16で文字起こしへ送ります。無音が560ms続くと発話を確定します。
- ログイン画面はありません。OpenAIキーとCloudflare→Modalの内部トークンはサーバー側だけで使用します。内部トークンは利用者のログイン認証ではありません。

## 現在の状態と検証範囲

公開先は [AIphone](https://deployment.example) です。2026-11-11にModal・OpenAI・Cloudflareの接続情報を設定し、GPUをT4へ変更しました。セットアップの実行記録は `evidence/setup-20261111.md`、T4への変更記録は `evidence/t4-20261111.md`、ローカル検証は `evidence/verification.json`、当初の要件と実装の対応は `evidence/implementation.md` を参照してください。

`evidence/` はローカルの検証記録です。端末のパス、画面、テスト時の会話内容が含まれるため、Gitには含めません。クローン直後には存在せず、`node scripts/verify.mjs` でローカル検証記録を生成できます。

実サービスで、Irodoriの日本語合成音声を文字起こしへ送り、Lunaの返答を再び音声にする往復を確認しました。`gpt-6-luna` / `reasoning.effort: "none"` を実応答で確認し、同じ音声・文字起こし接続を140秒間維持してからの合成も確認しています。これは合成音声を入力したAPI検証です。実マイク、スピーカーでの聴感、発話割り込み、数時間の通話は未確認です。測定中には音声受信が数十秒遅れる試行もあり、安定した低遅延を保証する結果ではありません。

## 初回セットアップ（PowerShell）

作業ディレクトリーはこのリポジトリーです。Node.js 22以降とuvが必要です。

```powershell
npm ci
uv sync --locked
$env:PYTHONIOENCODING = "utf-8"
```

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
| Secret名 | `voice-chat-example` |
| 環境変数名 | `MODAL_API_TOKEN` |
| 値 | 今作った内部トークン |

OpenAIのAPIキーはModalには登録しません。

### 2. 音声APIをModalへデプロイ

```powershell
uv run modal deploy backend/modal_app.py
```

初回はspeech.cppのCUDAビルドとモデルの取得があります。T4に対応するCUDAアーキテクチャ7.5でビルドし、CUDAバイナリーでモデルを取得する工程にもT4を使います。完了時に表示される `VoiceServer.web` の `https://…modal.run` URLを控えます。モデルはイメージに含まれ、通話のたびにダウンロードしません。

通常は0コンテナー、最大1コンテナー、CPU要求1コア・上限4コア、8GiB RAMです。GPUはT4に固定しています。2026-11-11時点の [Modalの料金](https://modal.com/pricing) では最安のGPUで、GPU単体は $0.000164/秒（$0.5904/時）です。CPU・RAM・OpenAIの費用は別途かかります。高いGPUへの自動切り替えはなく、T4の空きがなければ割り当てを待ちます。同じGPUで合成を一件ずつ処理し、WebSocket等の入力は最大16件です。複数の通話が重なると合成待ちが発生します。

### 3. Cloudflareに接続情報を登録

Cloudflareの認証が必要な環境では最初に `npx wrangler login` を実行します。この作業環境ではログイン済みでした。

[OpenAI Platform](https://platform.openai.com/api-keys)でAPIキーを用意し、次を順に実行します。値は各コマンドの非表示プロンプトへ入力します。

```powershell
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put MODAL_API_URL
npx wrangler secret put MODAL_API_TOKEN
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
| 声質・読み方の指示 | `prompts/voice.txt` | `uv run modal deploy backend/modal_app.py` |
| LLM、reasoning、文字起こし遅延 | `config/models.json` | `npm run deploy` |
| Irodoriモデル、声、速度、seed | `config/voice.json` | `uv run modal deploy backend/modal_app.py` |

Lunaは公式仕様で `none` に対応しているので、`none` を設定しています。別モデルへの自動切り替えはありません。`gpt-live-transcribe` の `minimal` はライブ音声の最小遅延設定です。他モデルとの実測比較による「最速」の保証はありません。

初期値は音声参照を必要としない `voice: "none"` です。この場合、同じ指示・seedでも文ごとに声質が変わることがあります。固定したい声がある場合は、利用できる参照音声からspeech.cppで声ファイルを作ります。

```text
speech voice irodori-tts-mf reference.wav backend/voices/reference.voice.gguf
```

`config/voice.json` の `voice` を `"reference"` に変えてModalを再デプロイすると、その声ファイルを読み込みます。声ファイルはGit管理から除外しています。

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

会話の保存先はブラウザーです。サーバーに履歴DBは置いていませんが、推論のために音声はOpenAIへ、会話内容はOpenAIへ、読み上げる文章はModalへ送ります。音声録音ファイルはアプリで保存しません。OpenAI Responsesには `store: false` を指定します。プロバイダー独自のログ・保持ポリシーとは別です。

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
