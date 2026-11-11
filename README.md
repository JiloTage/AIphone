# AIphone

日本語でAIと音声・テキストの会話ができるWebアプリです。Cloudflare Workersで画面とAPIを配信し、Modal上のIrodori-TTS + speech.cppで音声を生成します。

## 使い方

- サイドバーの「新しい会話」で会話を作成します。
- 「通話をはじめる」を押し、マイクの使用を許可します。呼び出し中に音声モデルを準備し、接続後に会話を始められます。
- テキスト入力でも会話できます。
- 「声の設定」で話し方を調整し、参照音声を登録できます。

会話履歴はブラウザーごとに保存されます。声の設定と参照音声はアプリ全体で共有されます。

## 構成

| 用途 | サービス・モデル |
| --- | --- |
| 画面・API | Cloudflare Workers |
| 会話生成 | OpenAI `gpt-6-luna`（`reasoning.effort: none`） |
| 音声認識 | OpenAI `gpt-live-transcribe`（`delay: minimal`） |
| 音声合成 | Modal / T4、speech.cpp v0.10.1、Irodori-TTS v4.1 Small MF |

AIの返答が完成したら全文をspeech.cppへ渡し、生成された音声をストリーム再生します。通話中はModalへのWebSocket接続を維持します。

## セットアップ

Node.js 22以降、uv、OpenAI・Modal・Cloudflareのアカウントが必要です。以下はリポジトリのルートで実行するPowerShellの例です。

```powershell
npm ci
uv sync --locked
$env:PYTHONIOENCODING = "utf-8"
Copy-Item wrangler.jsonc wrangler.local.jsonc
Copy-Item .env.deploy.example .env.deploy
```

`wrangler.local.jsonc` の `name` にCloudflare Worker名を指定します。`.env.deploy` にはModalのアプリ名・Secret名・Volume名を設定します。既存の設定ファイルがある場合はコピーを省略してください。

### 1. Modalの設定

```powershell
uv run modal setup
uv run python -c "import secrets; print(secrets.token_urlsafe(32))"
```

ブラウザーでModalにログインします。生成したトークンを使い、[Modalの管理画面](https://modal.com/)でSecretを作成します。

| 項目 | 値 |
| --- | --- |
| Secret名 | `.env.deploy` の `MODAL_SECRET_NAME` |
| 環境変数名 | `MODAL_API_TOKEN` |
| 値 | 生成したトークン |

このトークンはCloudflareからModalへの接続に使います。手順3でも同じ値を登録してください。

### 2. 音声APIのデプロイ

```powershell
npm run deploy:voice
```

初回はspeech.cppのビルドとモデルの取得に時間がかかります。完了時に表示される `VoiceServer.web` のURLを、次の手順で使用します。

### 3. Cloudflareの設定とデプロイ

[OpenAI Platform](https://platform.openai.com/api-keys)でAPIキーを用意します。使用するプロジェクトで、`gpt-6-luna` と `gpt-live-transcribe` が利用できる必要があります。

```powershell
npx wrangler login
npx wrangler secret put OPENAI_API_KEY --config wrangler.local.jsonc
npx wrangler secret put MODAL_API_URL --config wrangler.local.jsonc
npx wrangler secret put MODAL_API_TOKEN --config wrangler.local.jsonc
npm run deploy
```

各コマンドの入力欄に、APIキー、手順2のURL、手順1のトークンをそれぞれ入力します。デプロイ完了後、表示されたURLをブラウザーで開いてください。

## 声の設定

サイドバーの「声の設定」から速度、生成ステップ数、シード、声の指示、言語、音声の長さ、末尾の無音判定を変更できます。「声を試聴する」で確認し、「設定を保存」で反映します。保存した設定は次の通話から使われます。

参照音声は名前を付けて登録し、使用する声として選択できます。登録できる音声は1ファイル25 MB以下、0.5〜120秒、最大32件です。アップロード時に24 kHz・モノラルPCM16 WAVへ変換します。

設定と参照音声はModal Volumeに保存され、別のブラウザーや端末でも利用できます。「初期値に戻す」を押して保存すると、設定ファイルの初期値に戻ります。

## プロンプト・モデルの変更

| 変更する内容 | ファイル | 反映するコマンド |
| --- | --- | --- |
| 会話の性格・口調・返答の長さ | `prompts/system.txt` | `npm run deploy` |
| 文字起こしの文脈や固有名詞 | `prompts/transcription.txt` | `npm run deploy` |
| 声質・読み方の初期指示 | `prompts/voice.txt` | `npm run deploy:voice` |
| 会話・文字起こしモデル | `config/models.json` | `npm run deploy` |
| 音声モデル・速度・シードの初期値 | `config/voice.json` | `npm run deploy:voice` |

画面で保存した声の設定は、ファイルの初期値より優先されます。

## ローカル開発

セットアップで作成した設定に加え、`.dev.vars.example` を `.dev.vars` にコピーし、OpenAIのAPIキー、ModalのURL、内部トークンを設定します。

```powershell
npm run dev
```

`http://127.0.0.1:8787` で開けます。

テストとビルド確認：

```powershell
node scripts/verify.mjs
```

JavaScript・Pythonのテスト、Modalモジュールの読み込み、Cloudflareのdry-runビルドを実行します。

固定の応答を返すテキスト会話用の開発サーバー：

```powershell
node tests/browser-server.mjs
```

`http://127.0.0.1:8788` で、セッションの作成・切り替え・再読み込みを確認できます。

## 運用時の注意

- 認証はありません。アクセスできる人は有料APIを利用でき、共通の声の設定や参照音声を変更・再生・削除できます。
- 通話音声と会話内容はOpenAIへ、読み上げる文章はModalへ送信されます。
- ModalはT4を最大1コンテナー使用し、同時に届いた音声合成を順番に処理します。複数人で利用すると待ち時間が発生します。
- 通話中と終了後の停止待機時間（120秒）はModalのリソース費用がかかります。OpenAIのAPI利用料も別途発生します。
- ページを閉じたり会話を切り替えたりすると通話を終了します。端末の画面ロックやネットワーク切断でも通話が中断する場合があります。

## 関連ドキュメント

- [speech.cpp / Irodori-TTS](https://github.com/nyosegawa/speech.cpp/blob/v0.10.1/docs/models/irodori-tts.md)
- [speech.cpp HTTPサーバー](https://github.com/nyosegawa/speech.cpp/blob/v0.10.1/docs/server.md)
- [Modal](https://modal.com/docs)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
