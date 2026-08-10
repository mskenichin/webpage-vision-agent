# Webpage Vision Agent

Lexus公式サイトを左ペインの隔離ブラウザで表示し、右ペインのAIコンシェルジュとテキストまたは音声で対話するNext.jsデモです。要件と安全境界は [SPEC.md](SPEC.md) を参照してください。

## 実装済み

- Playwright Chromiumによるユーザー専用ブラウザセッション
- LexusサイトのJPEGライブ表示、クリック、スクロール、戻る、再読み込み
- テキストチャットとモデルページへのデモナビゲーション
- Foundry `gpt-realtime-2.1-mini` とWebRTCによる日本語の連続音声対話、semantic VAD、途中字幕、割り込み
- 複雑な比較・推薦を `gpt-5.6-sol` へ委譲し、8秒で `gpt-5.4` へフォールバックする高水準tool
- 最大20ステップ・120秒、反復停止、許可ドメイン検証を備えた `computer-use-preview` ブラウザ操作
- モデル安全確認とDOM検査を組み合わせた重要操作の承認・拒否、操作中断
- Microsoft Foundry Responses APIアダプターとDefaultAzureCredential認証
- 手動・AI操作共通の閲覧・リンククリック履歴
- 車種、ボディタイプ、パワートレインへの興味抽出と重複統合
- プロファイル編集、履歴収集停止、興味・履歴削除
- 許可ドメイン検証とページ内プロンプトを信頼しないモデル指示
- デスクトップ2ペインとモバイル用ペイン切り替え

データストアは現在インメモリで、単一ユーザーのデモ用途です。永続DB、認証、重要操作承認、WebRTC画面配信は次の実装対象です。

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
AZURE_FOUNDRY_MODEL=computer-use-preview
AZURE_FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
AZURE_REALTIME_MODEL=gpt-realtime-2.1-mini
AZURE_REALTIME_VOICE=alloy
AZURE_EXPERT_MODEL=gpt-5.6-sol
AZURE_CHAT_MODEL=gpt-5.4
AZURE_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
AZURE_SPEECH_MODEL=gpt-4o-mini-tts
AZURE_SPEECH_VOICE=alloy
```

APIキーは使用せず、`@azure/identity` の `DefaultAzureCredential` で `https://cognitiveservices.azure.com/.default` のトークンを取得します。ローカルではAzure CLI等でログインし、Azure上では最小権限のマネージドIDを割り当ててください。パスワード、トークン、APIキーは環境ファイルへ記載しないでください。

音声モード開始時、`/api/realtime/session` がマネージドIDでセッション限定の短命client secretを発行します。ブラウザはその資格情報でFoundryへWebRTC接続し、音声、semantic VAD、字幕、応答、割り込みを同じ接続で処理します。単純な会話はRealtimeモデルが直接応答し、比較・推薦は高水準toolから `gpt-5.6-sol`、Web探索は検証済みのComputer Useループへ委譲します。Azureの長期資格情報と音声ファイルは保存・公開しません。

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
| Realtime deployment | `gpt-realtime-2.1-mini` | East US 2 |
| Expert deployment | `gpt-5.6-sol` | East US 2 |
| Computer Use deployment | `computer-use-preview` | East US 2 |
| Chat deployment | `gpt-5.4` (`2026-03-05`) | East US 2 |
| Transcription deployment | `gpt-4o-mini-transcribe` (`2025-12-15`, GlobalStandard 60) | East US 2 |
| Speech deployment | `gpt-4o-mini-tts` (`2025-12-15`, GlobalStandard 300) | East US 2 |
| User Assigned Managed Identity | `id-webpage-vision-agent-dev` | Japan East |
| Azure Container Registry | `crwebpagevisiondev6a372b32` | Japan East |
| Container Apps Environment | `cae-webpage-vision-agent-dev` | Japan East |
| Container App | `ca-webpage-vision-agent-dev` | Japan East |
| Log Analytics Workspace | `log-webpage-vision-agent-dev` | Japan East |

公開URL: <https://ca-webpage-vision-agent-dev.yellowdune-90c60b2f.japaneast.azurecontainerapps.io/>

Container Appはユーザー割り当てマネージドIDを使用し、AI Servicesには `Cognitive Services OpenAI User`、ACRには `AcrPull` のみを付与しています。
