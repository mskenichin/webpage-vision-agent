# Webpage Vision Agent

Lexus公式サイトを左ペインの隔離ブラウザで表示し、右ペインのAIコンシェルジュとテキストまたは音声で対話するNext.jsデモです。要件と安全境界は [SPEC.md](SPEC.md) を参照してください。

## 実装済み

- Playwright Chromiumによるユーザー専用ブラウザセッション
- LexusサイトのJPEGライブ表示、クリック、スクロール、戻る、再読み込み
- テキストチャットとモデルページへのデモナビゲーション
- Foundry `gpt-realtime-2.1-mini` とWebRTCによる日本語の連続音声対話、semantic VAD、途中字幕、割り込み
- 複雑な比較・推薦を `gpt-5.6-sol` へ委譲し、8秒で `gpt-5.4` へフォールバックする高水準tool
- 通常モードと、複合要求を1サブタスクずつ計画・実行するタスクモードの切り替え
- Goal Planner、Next-Step Planner、独立Verifierによる `Plan → Act → Observe → Verify → Replan` ループ
- 包含・除外・件数・カテゴリ完全選択を扱う構造化制約と、要求外の任意追加項目を防ぐ最終検証
- 最大20ステップ・75秒の実行チャンク、状態を保持した自動継続、反復停止、許可ドメイン検証を備えたResponses API組み込み`computer`ツールによるブラウザ操作
- モデル安全確認とDOM検査を組み合わせた重要操作の承認・拒否、操作中断
- 承認後も同じサブタスクとVerifierへ復帰するタスク継続
- Plannerのゴール・サブタスク、構造化制約、Verifier根拠を展開できる処理ログ
- ブラウザ画像取得の10秒タイムアウトと、停止・クラッシュ時のブラウザ自動再生成
- 同一画面の画像・ページ本文を共有するタスク観測と、サブタスク・全ゴールを1回で判定する統合Verifier
- Planner、Verifier、Computer Useのモデル待ち時間・呼び出し回数・画面取得時間の処理ログ
- Microsoft Foundry Responses APIアダプターとDefaultAzureCredential認証
- 手動・AI操作共通の閲覧・リンククリック履歴
- 車種、ボディタイプ、パワートレインへの興味抽出と重複統合
- プロファイル編集、履歴収集停止、興味・履歴削除
- 許可ドメイン検証とページ内プロンプトを信頼しないモデル指示
- デスクトップ2ペインとモバイル用ペイン切り替え

データストアは現在インメモリで、単一ユーザーのデモ用途です。永続DB、認証、複数ユーザーのセッション分離、WebRTC画面配信は次の実装対象です。

### タスクモード

入力欄の実行モードを「タスク」に切り替えると、最初にユーザー要求からUI非依存のゴール制約だけを抽出します。現在画面と未達ゴールを観測して次の1目的だけを計画し、実行後にサブタスク制約と全ゴール制約を再検証します。未達時は最新画面から再計画し、全制約に画面上の証拠が揃うまで完了として扱いません。

特定カテゴリを「全部」選択する要求では、そのカテゴリ外の任意追加項目を0件とする制約も自動的に維持します。操作中に要求外項目を検出した場合は解除を優先し、最終画面に残っている場合はVerifierが完了を拒否します。

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
AZURE_COMPUTER_MODEL=gpt-5.4
AZURE_FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
AZURE_REALTIME_MODEL=gpt-realtime-2.1-mini
AZURE_REALTIME_VOICE=alloy
AZURE_EXPERT_MODEL=gpt-5.6-sol
AZURE_CHAT_MODEL=gpt-5.4
AZURE_TASK_PLANNER_MODEL=gpt-5.6-sol
AZURE_GOAL_PLANNER_MODEL=gpt-5.4
AZURE_GOAL_PLANNER_FALLBACK_MODEL=gpt-5.6-sol
AZURE_NEXT_STEP_PLANNER_MODEL=gpt-5.4
AZURE_NEXT_STEP_PLANNER_FALLBACK_MODEL=gpt-5.6-sol
AZURE_TASK_VERIFIER_MODEL=gpt-5.4
AZURE_TASK_VERIFIER_FALLBACK_MODEL=gpt-5.6-sol
AZURE_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
AZURE_SPEECH_MODEL=gpt-4o-mini-tts
AZURE_SPEECH_VOICE=alloy
```

APIキーは使用せず、`@azure/identity` の `DefaultAzureCredential` で `https://cognitiveservices.azure.com/.default` のトークンを取得します。ローカルではAzure CLI等でログインし、Azure上では最小権限のマネージドIDを割り当ててください。パスワード、トークン、APIキーは環境ファイルへ記載しないでください。

`AZURE_TASK_PLANNER_MODEL` と `AZURE_TASK_VERIFIER_MODEL` を省略した場合は `AZURE_EXPERT_MODEL` を使用します。Goal Plannerは `AZURE_GOAL_PLANNER_MODEL`（省略時は `AZURE_CHAT_MODEL`）を30秒で呼び出し、失敗時は `AZURE_GOAL_PLANNER_FALLBACK_MODEL`（省略時は `AZURE_TASK_PLANNER_MODEL`）を45秒で呼び出します。Next-Step Plannerは `AZURE_NEXT_STEP_PLANNER_MODEL`（省略時は `AZURE_CHAT_MODEL`）を30秒で呼び出し、失敗時は `AZURE_NEXT_STEP_PLANNER_FALLBACK_MODEL`（省略時は `AZURE_TASK_PLANNER_MODEL`）を45秒で呼び出します。Verifierも一次モデルを30秒で呼び出し、失敗時は `AZURE_TASK_VERIFIER_FALLBACK_MODEL`（省略時は `AZURE_CHAT_MODEL`）を45秒で呼び出します。タスク処理ログには各モデルの所要時間が表示されるため、同じシナリオで速度と成功率を比較してからモデルを変更してください。

音声モード開始時、`/api/realtime/session` がマネージドIDでセッション限定の短命client secretを発行します。ブラウザはその資格情報でFoundryへWebRTC接続し、音声、semantic VAD、字幕、応答、割り込みを同じ接続で処理します。単純な会話はRealtimeモデルが直接応答し、比較・推薦は高水準toolから `gpt-5.6-sol`、Web探索は検証済みのComputer Useループへ委譲します。Azureの長期資格情報と音声ファイルは保存・公開しません。

## コマンド

```bash
npm run dev    # 開発サーバー
npm run build  # 本番ビルド
npm run lint   # ESLint
npm test       # Vitest
npm run benchmark:task  # 起動済みアプリでタスクモードをライブ計測
```

### タスクモードのライブ計測

別のターミナルで`npm run dev`を起動してから、同じAzure設定を使って次を実行します。既定では1回のウォームアップ後に3回計測し、[scripts/task-scenarios.json](scripts/task-scenarios.json)のシナリオを順番に実行します。

```bash
npm run benchmark:task
```

短い動作確認や公開環境の計測では、環境変数で対象と回数を変更できます。

```bash
BENCHMARK_WARMUPS=0 BENCHMARK_RUNS=1 npm run benchmark:task
BENCHMARK_BASE_URL=https://<container-app-host> BENCHMARK_RUNS=5 npm run benchmark:task
```

結果は既定で`benchmark-results/task-live.json`へ保存します。総所要時間のP50/P95/平均、成功率、Planner・Verifier・Computer Useの時間、モデル呼び出し回数、画面取得時間、計測内訳外の時間、操作数、再計画数を記録します。長時間試行では各API応答のログをIDで逐次収集するため、画面表示用ログの200件上限に影響されません。Verifierは同じ`observationRevision`のサブタスク・全ゴールログを1回として集計し、Computer Useは承認途中の累積ログを除いて実行チャンクごとの最終値を集計します。各試行前に未完了タスク、会話、処理ログを破棄して開始URLへ戻します。承認が必要な操作は既定では自動承認せず、停止時点までの部分計測を含む失敗として記録します。

既知の非送信シナリオを無人実行する場合に限り、シナリオの`allowApprovals`と実行時の環境変数を両方指定します。問い合わせ送信、予約、購入など外部へ影響するシナリオには`allowApprovals`を設定しないでください。

```bash
BENCHMARK_APPROVE_ALLOWED_ACTIONS=1 BENCHMARK_WARMUPS=0 BENCHMARK_RUNS=1 npm run benchmark:task
```

主な設定値は`BENCHMARK_LIMIT`、`BENCHMARK_WARMUPS`、`BENCHMARK_RUNS`、`BENCHMARK_MAX_CONTINUATIONS`、`BENCHMARK_REQUEST_TIMEOUT_MS`、`BENCHMARK_BASE_URL`、`BENCHMARK_OUTPUT`、`BENCHMARK_APPROVE_ALLOWED_ACTIONS`です。同条件を保ったままタスク用モデルまたはContainer Apps revisionだけを変更し、速度と成功率を比較してください。

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
| Computer Use deployment | `gpt-5.4`の組み込み`computer`ツール | East US 2 |
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

### 現在のデプロイ

| 項目 | 値 |
| --- | --- |
| デプロイ日時 | 2026-08-13 23:57 UTC |
| ACR image | `webpage-vision-agent:model-retry-20260813235526-fb7b9a4` |
| Image digest | `sha256:687bf5ffb90dbb02d8251c06da41c77560b60e44eb4cf828bee20389be952e01` |
| Container App revision | `ca-webpage-vision-agent-dev--0000025` |
| Traffic | 100% |

デプロイ後にリビジョンが `Healthy` であること、公開トップページと `/api/session` がHTTP 200を返すこと、`agentMode` が `foundry` であることを確認済みです。

### Azure展開の依頼方法

コード修正後に現在のワークスペースをAzure開発環境へ展開する場合は、次のように指示します。

```text
現在のワークスペースの変更をAzure開発環境へ展開してください。

1. テスト、型検査、lint、production buildを実行する
2. 現在のコードから一意なタグでコンテナイメージをビルドする
3. ACR `crwebpagevisiondev6a372b32` へプッシュする
4. Container App `ca-webpage-vision-agent-dev` を新しいイメージへ更新する
5. 新リビジョンがHealthyかつトラフィック100%になることを確認する
6. 公開トップページと `/api/session` がHTTP 200を返すことを確認する
7. 使用したタグ、ダイジェスト、リビジョン、検証結果を報告する

リソースグループは `rg-webpage-vision-agent-dev` です。
未コミットの変更も含めて展開してください。
```

同じ環境への通常の展開では、次の短い指示も使用できます。

```text
現在の変更をACRへビルド・プッシュし、Azure Container Appへ展開して、公開環境の動作確認まで実行してください。未コミットの変更も含めてください。
```

コミット済みコードだけを展開する場合は、代わりに次の条件を指定します。

```text
未コミットの変更は含めず、現在のHEADだけを展開してください。
```

展開対象の取り違えを防ぐため、未コミット変更を含めるか、現在のHEADだけを使用するかを必ず明記します。
