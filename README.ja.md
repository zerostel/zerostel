<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/zerostel-logo-dark.svg">
  <img src="docs/assets/brand/zerostel-logo-light.svg" alt="Zerostel" width="380">
</picture>

**どんな AI エージェントも、ゼロ地点まで巻き戻す。**

AI エージェントのためのゼロトラスト：壊すものと想定し、すべてのステップを記録し、触ったファイルを巻き戻せるようにする。
コーディングエージェントのためのフライトレコーダー兼タイムマシン。自分で決めるガードレールと、改ざんを検証できるログ付き。

[公式サイト](https://zerostel.com) · [English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

[![npm](https://img.shields.io/npm/v/zerostel)](https://www.npmjs.com/package/zerostel)
[![CI](https://github.com/zerostel/zerostel/actions/workflows/ci.yml/badge.svg)](https://github.com/zerostel/zerostel/actions/workflows/ci.yml)
![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-green)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

</div>

<p align="center"><img src="docs/assets/demo.gif" alt="npx zerostel demo：エージェントが rm -rf で src/legacy を削除してテストが失敗し、npx zerostel undo で元に戻す" width="800"></p>

## クイックスタート

```bash
npx zerostel install
```

まず試してみたいなら：`npx zerostel demo` は使い捨てのサンプルプロジェクトを作り、エージェントがフォルダを削除してテストを壊すターンを再現し、それを undo で戻せます。エージェントは不要で、あなたのプロジェクトには触れません。

あとはいつも通りエージェントを使うだけです。何かを壊されたら：

```bash
zerostel log          # 何が起きたかをステップごとに確認
zerostel undo         # ファイルをエージェントの直前のターンより前に戻す
zerostel rewind 0     # セッション開始時点（ゼロ地点）まで一気に戻す
zerostel ui           # 同じことをローカルの Web ページで
```

## できること

- **記録。** すべてのプロンプト、ツール呼び出し、コマンド、ファイル変更、所要時間、トークン数を、セッションごとに 1 本のタイムラインに。ターミナルでは `zerostel log`、ローカルの Web ページでは `zerostel ui` で見られます。
- **巻き戻し。** ファイルを変更しうるツール呼び出しの前後でスナップショットを取ります。シェルコマンドも対象です。1 ターンの取り消し、任意のステップへの巻き戻し、ゼロ地点までの巻き戻しができ、巻き戻し自体もまた取り消せます。
- **ガード。** 自分で決めたルールで、ツールの実行前にブロックしたり、先に確認させたりできます。すべてのエージェントで同じルールです。
- **検証と共有。** ハッシュチェーンでつながったログで、書き換えられれば分かります。共有用のプライバシーモードを備えた 1 ページのレポートも作れます。
- **ローカルだけ。** 何もアップロードせず、`~/.zerostel` は本人だけが読めて、あなたの `.git` には一切触れません。

これが AI エージェントのためのゼロトラストです。エージェントは間違えるものと考え、すべての動きを見て、常に戻る道を残します（[具体的には](docs/zero-trust.md)、英語）。サンドボックスではありません。ネットワークリクエスト、デプロイ、データベースへの書き込みは取り消せません。[制限](#制限)をご覧ください。

## なぜ必要か

エージェントは一度に何十ものファイルを編集し、`rm`、`git checkout .`、マイグレーション、ビルドスクリプトも実行します。問題が起きたとき知りたいのは、「何をしたのか」と「どう戻すのか」です。

チェックポイントを持つエージェントもありますが、仕組みはまちまちです。Claude Code の rewind は Bash 経由の変更を含みません。Copilot CLI はシェルコマンドも追跡します。Cursor や Codex にもそれぞれ独自の仕組みがあります。複数のエージェントを使うと、「何が変わって、戻せるのか」の答えがエージェントごとに違ってしまいます。

Zerostel は対応するすべてのエージェントを同じ方法で記録します。ファイルを変更しうるツール呼び出しの前後でプロジェクトのスナップショットを取り、プロンプト・コマンド・ファイル・時間・トークンのタイムラインを残し、他の人に渡せるレポートを出力します。あなたの `.git` には一切触れません。

| | エージェント組み込みのチェックポイント | コミット／`git stash` | **Zerostel** |
|---|---|---|---|
| シェルコマンドによる変更 | エージェント次第 | コミットした分だけ | ✅ プロジェクト内と、指定したファイル |
| 特定のステップに戻る | 多くはプロンプト単位 | コミット単位 | ✅ ツール呼び出し単位 |
| コマンド・ファイル・トークン・時間のタイムライン | 一部 | ❌ | ✅ |
| 後からログの改ざんを検証できる | ❌ | ✅（コミットハッシュ） | ✅ |
| 独自ルールで実行前にブロック・確認 | エージェントごと | ❌ | ✅ すべてのエージェントで同じルール |
| エージェント間で同じ動作 | ❌ それぞれ別 | ✅ | ✅ |
| あなたの `.git` に書き込む | 一部あり | ✅ | ❌ 決してしない |
| 共有できるセッションレポート | ❌ | ❌ | ✅ |

詳細と出典：[docs/comparison.md](docs/comparison.md)。背景にある実際のトラブル：[What your coding agent's checkpoints can't bring back](https://zerostel.com/blog/agent-checkpoints/)（英語）

## 対応エージェントとシステム

| エージェント | 方式 | 状態 |
|---|---|---|
| Claude Code | フック | ✅ 実セッションで確認済み |
| Codex | フック（初回のみ `/hooks` で承認） | ✅ 実セッションで確認済み |
| Cursor | フック | ✅ CLI を実セッションで確認済み。CLI はプロンプトのイベントを送らないため、CLI では undo が 1 変更ずつ戻ります。Windows では PowerShell から起動してください（Git Bash から起動するとフックが動きません） |
| Gemini CLI | フック（信頼済みフォルダのみ） | ✅ エンドツーエンドで確認済み¹。Code Assist Standard／Enterprise と有料 API キー向け（個人アカウントは 2026 年 6 月に Antigravity へ移行） |
| Antigravity（CLI、デスクトップ、IDE） | フック | ✅ エンドツーエンドで確認済み¹。プロンプト本文は渡されないため、ターンは「New turn」と表示 |
| Copilot CLI | フック（`~/.copilot/hooks`） | ✅ 実セッションで確認済み |
| opencode | プラグイン | ✅ 実セッションで確認済み |
| DeepSeek Harness | プラグイン | 🧪 実験的（dsh 自体が開発者プレビュー）。エンドツーエンドで確認済み¹ |
| その他（Aider、スクリプトなど） | `zerostel run -- <コマンド>` でファイルを監視 | ✅ 粗め：ツール呼び出し・トークン・ガードレールなし |

¹ Windows で本物のエージェントを動かし、モデルだけを台本どおりに応答する偽モデルに置き換えて確認：プロンプト、ファイル書き込み、コマンド実行、ルールで止められた呼び出し、ターンの終了、undo。

実験的なエージェントは名前を指定したときだけインストールされます（例：`zerostel install --agent deepseek`）。実際の利用状況の報告を歓迎します。

エージェントの裏にあるモデルは問いません。Claude、GPT、Gemini、DeepSeek、ローカルモデルのいずれも同じように記録します。

Windows、macOS、Linux（WSL を含む）に対応。CI はすべてのコミットを 3 つの OS と Node 20／22／24 でテストしています。

## インストール

```bash
npx zerostel install          # その場で実行、グローバルには入れない
npm install -g zerostel       # zerostel コマンドを常に使えるようにする
```

git と Node 20 以上が必要です。Node がない場合は、各リリースに Node を内蔵した単一の実行ファイル（Windows・macOS・Linux）があります。[Releases](https://github.com/zerostel/zerostel/releases) からダウンロードして `zerostel install` を実行してください。Claude Code、Codex、Antigravity、Gemini CLI のプラグイン、エージェントスキル、ダウンロードの検証方法は [docs/install.md](docs/install.md)（英語）にあります。

## ドキュメント

| | |
|---|---|
| [コマンド](docs/commands.md) | すべてのコマンドとオプション |
| [ガードレール](docs/guardrails.md) | ルールの仕組みと、テスト済みのレシピ |
| [設定](docs/configuration.md) | `~/.zerostel/config.json` |
| [CI](docs/ci.md) | GitHub Action |
| [MCP サーバー](docs/mcp.md) | エージェントが自分のタイムラインを読み、頼まれたら巻き戻す |
| [仕組み](docs/architecture.md) | フック、シャドウリポジトリ、安全な巻き戻し、監査チェーン |
| [ゼロトラスト](docs/zero-trust.md) | 各原則と、Zerostel がどう実現しているか |
| [セキュリティモデル](docs/security-model.md) | 守るもの、守らないもの |
| [各エージェントのチェックポイント](docs/comparison.md) | 各エージェントの undo で何が戻るか（出典付き） |
| [よくある質問](docs/faq.md) | 速度、ディスク使用量、git、jj、サンドボックス、トークン |

ドキュメントは英語です。うまく動かないときは、まず `zerostel doctor` を実行してください。Node、git、各エージェントのフック、設定とガードレールを確認し、その出力はそのまま issue に貼れます。

## 制限

- 復元できるのは取得済みの状態だけです。削除の後に記録を始めても、そのファイルは戻せません。
- 1 つのシェルコマンドの途中の状態はありません。同じコマンド内で作成・削除されたファイルは見えません。`zerostel run` はファイルが落ち着いてからスナップショットを取るため、短時間しか存在しないファイルを取りこぼすことがあります。
- プロジェクトの外では、`watch` に挙げたホームフォルダ内のファイルだけがスナップショットされます。Windows のユーザー環境変数（`HKCU\Environment`）は、それを変更するコマンドの前後でだけ読み取り、巻き戻しで元に戻します。値はあなたのマシン上のセッションログに保存され、レポートには含めません。グローバルパッケージは、元に戻すコマンドと一緒に一覧にするだけです。巻き戻し先の時点で存在しなかった監視ファイルはそのまま残します。それ以外のプロジェクト外のものは対象外ですが、触れたコマンドはタイムラインに残ります。
- 次のものはスナップショットされず、存在する場合は `zerostel log` に表示されます：無視されたフォルダ（`node_modules`、`dist/`、`.gitignore` の対象）、入れ子の git リポジトリとサブモジュール、リンクされたフォルダ（シンボリックリンク、ジャンクション）、`maxFileMB` を超える新規ファイル。
- ホームディレクトリやドライブのルートで起動したエージェントは、タイムラインのみでスナップショットはありません。
- 大文字小文字を区別しないファイルシステム（Windows、macOS の既定）では、大文字小文字だけを変える名前変更（例：`readme.md` → `README.md`）は変更として扱われません。
- WSL では、Windows ドライブ上（`/mnt/c/...`）のプロジェクトはスナップショットが遅くなります。Linux 側のファイルシステムに置いてください。
- ハッシュチェーンは、`audit.key` を持たないものによるログの編集を見抜きます。あなた自身のアカウントを使う人は鍵を読んでログを丸ごと書き換えられます。`~/.zerostel/**` を deny ルールに入れて、エージェントが触れないようにしてください。
- ガードレールはツール呼び出しに書かれた内容に一致します。ファイル名を書かずにファイルへ届くスクリプトやコマンドはすり抜けます。

## ロードマップ

- **完了：** 7 つのエージェントの記録と巻き戻し、ゼロ地点、Web 表示、共有できるレポート、検証できるログ、ガードレール、MCP サーバー、プロジェクト外のファイルの監視。
- **次：** 鍵がなくても誰でも検証できる署名付きレポート、Zerostel ゲートウェイを通した他の MCP サーバー呼び出しの記録、テスト出力を解析してどのテストが壊れたかを示す機能、実験的なエージェントの実機検証。
- **募集中：** [macOS と Linux での動作報告](https://github.com/zerostel/zerostel/issues/4)、および [help wanted](https://github.com/zerostel/zerostel/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) ラベルの issue。

## コントリビュート

質問やアイデアは [Discussions](https://github.com/zerostel/zerostel/discussions) へどうぞ。新しいエージェントへの対応は、[src/agents/adapters.ts](src/agents/adapters.ts) にアダプターを 1 つ追加するだけです。[CONTRIBUTING.md](CONTRIBUTING.md) と [docs/architecture.md](docs/architecture.md) をご覧ください。

```bash
npm ci && npm test && npm run smoke
```

## ライセンス

[Apache-2.0](LICENSE)
