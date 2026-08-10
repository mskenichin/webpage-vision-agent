# Webpage Vision Agent

Lexus公式サイトを左ペインの隔離ブラウザで表示し、右ペインのAIコンシェルジュとテキストまたは音声で対話するNext.jsデモです。要件と安全境界は [SPEC.md](SPEC.md) を参照してください。

## 実装済み

- Playwright Chromiumによるユーザー専用ブラウザセッション
- LexusサイトのJPEGライブ表示、クリック、スクロール、戻る、再読み込み
- テキストチャットとモデルページへのデモナビゲーション
- MediaRecorderとFoundry `gpt-4o-mini-transcribe` による日本語音声入力・文字起こし
- 約1.4秒の無音による発話確定、`gpt-5.4` 応答、次の発話待機を繰り返す音声会話モード
- ブラウザの音声合成による日本語読み上げ
- Microsoft Foundry Responses APIアダプターとDefaultAzureCredential認証
- 手動・AI操作共通の閲覧・リンククリック履歴
- 車種、ボディタイプ、パワートレインへの興味抽出と重複統合
- プロファイル編集、履歴収集停止、興味・履歴削除
- 許可ドメイン検証とページ内プロンプトを信頼しないモデル指示
- デスクトップ2ペインとモバイル用ペイン切り替え

データストアは現在インメモリで、単一ユーザーのデモ用途です。永続DB、認証、重要操作承認、WebRTC画面配信、Foundryの複数ステップcomputer-useループは次の実装対象です。

## 必要環境

- Node.js 20.9以上
- npm
- Chromiumの実行に必要なLinuxライブラリ
- Foundry連携時は対象Azure環境へアクセスできるマネージドID、Azure CLIログイン、またはDefaultAzureCredential対応資格情報

## セットアップ

```bash
npm install
npx playwright install chromium
cp .env.example .env.local
npm run dev
```

ブラウザで `http://localhost:3000` を開きます。Foundry設定が空の場合は、既知のLexusモデルページを開くデモモードで動作します。

## Microsoft Foundry

`.env.local` に、Phase 0で確定した値を設定します。

```dotenv
AZURE_FOUNDRY_ENDPOINT=https://<foundry-resource-endpoint>
AZURE_FOUNDRY_MODEL=<computer-use-deployment-name>
AZURE_FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
AZURE_CHAT_MODEL=gpt-5.4
AZURE_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
```

APIキーは使用せず、`@azure/identity` の `DefaultAzureCredential` で `https://cognitiveservices.azure.com/.default` のトークンを取得します。ローカルではAzure CLI等でログインし、Azure上では最小権限のマネージドIDを割り当ててください。パスワード、トークン、APIキーは環境ファイルへ記載しないでください。

音声入力ではブラウザが録音したWebMまたはMP4音声を約1.8秒間隔で `/api/transcribe` へ送信します。サーバーは最大25 MBと音声形式を検証し、マネージドIDでFoundryの文字起こしdeploymentを呼び出します。録音中は文字起こし結果が入力欄へ逐次反映されます。発話開始後に約1.4秒の無音を検知すると文字列を確定し、`gpt-5.4` へ送信して応答を表示・読み上げます。応答後は自動的に次の発話待ちへ戻り、マイクボタンをもう一度押すまで音声会話モードを継続します。音声ファイルは保存しません。

## コマンド

```bash
npm run dev    # 開発サーバー
npm run build  # 本番ビルド
npm run lint   # ESLint
npm test       # Vitest
```

## Azure開発環境

| 項目 | 値 |
| --- | --- |
| Tenant | `7b6b7a10-a2d2-4306-9687-a6b1d51976d7` |
| Subscription | `6a372b32-f8e9-460f-8f2a-2329a10fa8ef` |
| Resource group | `rg-webpage-vision-agent-dev` |

初期セットアップアカウントは `kenichin@MngEnvMCAP903977.onmicrosoft.com` です。アプリケーションの実行IDには使用しません。

### デプロイ済みリソース

| リソース | 名前 | リージョン |
| --- | --- | --- |
| Azure AI Services | `aif-webpage-vision-agent-dev-6a372b32` | East US 2 |
| Foundry Project | `aif-webpage-vision-agent-project` | East US 2 |
| Chat deployment | `gpt-5.4` (`2026-03-05`) | East US 2 |
| Transcription deployment | `gpt-4o-mini-transcribe` (`2025-12-15`, GlobalStandard 60) | East US 2 |
| User Assigned Managed Identity | `id-webpage-vision-agent-dev` | Japan East |
| Azure Container Registry | `crwebpagevisiondev6a372b32` | Japan East |
| Container Apps Environment | `cae-webpage-vision-agent-dev` | Japan East |
| Container App | `ca-webpage-vision-agent-dev` | Japan East |
| Log Analytics Workspace | `log-webpage-vision-agent-dev` | Japan East |

公開URL: <https://ca-webpage-vision-agent-dev.yellowdune-90c60b2f.japaneast.azurecontainerapps.io/>

Container Appはユーザー割り当てマネージドIDを使用し、AI Servicesには `Cognitive Services OpenAI User`、ACRには `AcrPull` のみを付与しています。2026年8月10日時点では、このサブスクリプションのモデルカタログにcomputer-useモデルが公開されていないため、`AZURE_FOUNDRY_MODEL` は未設定でデモモード動作です。モデル利用承認後にデプロイ名を設定してください。
