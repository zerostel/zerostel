<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/zerostel-logo-dark.svg">
  <img src="docs/assets/brand/zerostel-logo-light.svg" alt="Zerostel" width="380">
</picture>

**任何 agent 出錯，都能回到零點。**

給 AI agent 的零信任：假設它一定會出錯，記下每一步，把它動過的檔案倒帶回去。
AI coding agent 的行車紀錄器加時光機：每一步都有紀錄，測試結果連到它跑的那一版程式，有你自己定的防護規則，還能交接給下一個 agent 或人並讓對方核對。

[官網](https://zerostel.com) · [English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

[![npm](https://img.shields.io/npm/v/zerostel)](https://www.npmjs.com/package/zerostel)
[![CI](https://github.com/zerostel/zerostel/actions/workflows/ci.yml/badge.svg)](https://github.com/zerostel/zerostel/actions/workflows/ci.yml)
![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-green)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

</div>

<p align="center"><img src="docs/assets/demo.gif" alt="npx zerostel demo：agent 用 rm -rf 刪掉 src/legacy、測試失敗；npx zerostel checks 顯示測試先前通過、之後一直失敗；npx zerostel undo 把檔案救回來" width="800"></p>

## 快速開始

```bash
npx zerostel install
```

想先看看效果？`npx zerostel demo` 會建立一個用完即丟的示範專案，模擬 agent 刪掉資料夾、把測試弄壞的一輪操作，讓你親手 undo。不需要 agent，也不會碰到你的任何專案。

裝好之後照常使用 agent。它把東西弄壞的時候：

```bash
zerostel log          # 一步一步看它做了什麼
zerostel checks       # 測試是在現在這版程式上通過的嗎？
zerostel undo         # 把檔案恢復到 agent 上一輪開始之前
zerostel rewind 0     # 或一路回到零點：這個 session 開始的時候
zerostel handoff      # 交給下一個 agent 或人接手需要知道的事
zerostel ui           # 同樣的事，在本機網頁上點選操作
```

## 它做什麼

- **記錄。** 每個提示、工具呼叫、指令、檔案變更、耗時和 token 數，每個 session 一條時間軸：在終端機用 `zerostel log` 看，或用 `zerostel ui` 在本機網頁看。
- **倒帶。** 每次可能改檔案的工具呼叫前後各拍一次快照，shell 指令也包含在內。可以撤銷一個回合、回到任何一步，或一路回到零點；每次倒帶本身也能再撤銷。
- **防護。** 你自己定的規則，能在工具執行前擋下，或要 agent 先問你。所有 agent 共用同一套規則。
- **核對與交接。** agent 跑的每個測試、型別檢查和建置，都會連到它當時跑的那一版程式；`zerostel checks` 分得出「現在這版通過」和「舊版通過、之後又改過」。`zerostel handoff` 把你的要求、目前狀態和試過的做法交給下一個 agent 或人。
- **驗證與分享。** 用雜湊鏈串起來的紀錄，被改過看得出來；一頁式報告，附分享用的隱私模式。
- **只在本機。** 什麼都不上傳，`~/.zerostel` 只有你能讀，也從不動你的 `.git`。

這就是給 AI agent 的零信任：假設它會出錯、看見它做的每件事、永遠留一條退路（[實際怎麼做](docs/zero-trust.md)，英文）。它不是沙盒：網路請求、部署、資料庫寫入都收不回來，請看[限制](#限制)。

## 為什麼需要

agent 會一次改幾十個檔案，也會跑 `rm`、`git checkout .`、資料庫遷移和建置腳本。出事的時候，你只想知道兩件事：它到底做了什麼？要怎麼回去？

有些 agent 自帶 checkpoint，但做法差很多。Claude Code 的 rewind 不包含透過 Bash 造成的變化；Copilot CLI 會追蹤 shell 指令；Cursor 和 Codex 又各有自己的機制。同時用好幾個 agent 的話，「改了什麼、救不救得回來」每個的答案都不一樣。

Zerostel 用同一種方式記錄每個支援的 agent：在每個可能改檔案的工具呼叫前後幫專案拍快照，留下提示、指令、檔案、時間和 token 的時間軸，還能匯出給別人看的報告。它完全不碰你的 `.git`。

| | agent 自帶的 checkpoint | commit／`git stash` | **Zerostel** |
|---|---|---|---|
| shell 指令造成的變化 | 看 agent | 只有你 commit 或 stash 過的 | ✅ 專案內，加上你指定的檔案 |
| 回到指定的某一步 | 通常以提示為單位 | 以 commit 或 stash 為單位 | ✅ 每次工具呼叫 |
| 指令、檔案、token、時間的時間軸 | 部分 | ❌ | ✅ |
| 事後能驗證紀錄有沒有被改過 | ❌ | ✅（commit 雜湊） | ✅ |
| 自訂規則：工具執行前擋下或先問你 | 各家不同 | ❌ | ✅ 所有 agent 用同一套規則 |
| 不同 agent 行為一致 | ❌ 各做各的 | ✅ | ✅ |
| 會寫入你的 `.git` | 有些會 | ✅ | ❌ 絕不 |
| 可分享的工作報告 | ❌ | ❌ | ✅ |

詳細比較與來源：[docs/comparison.md](docs/comparison.md)。背後的真實事故：[What your coding agent's checkpoints can't bring back](https://zerostel.com/blog/agent-checkpoints/)（英文）。

## 和其他工具比較

各家 agent 一直在加自己的 checkpoint，也有不錯的外掛工具：[Turnback](https://github.com/MFaizR77/turnback)、[Turnal](https://github.com/AadiJo/turnal)、[bashback](https://github.com/trouties/bashback)、[logbook](https://github.com/sheeki03/logbook)、[codex-rewind](https://github.com/extracurricular-ai/codex-rewind)。Zerostel 多做的是：

- **倒帶不會弄丟東西。** 沒有完整備份的檔案絕不刪除或覆寫，每個檔案在改動前一刻會再看一次，`--keep-others` 會保留其他 agent 或你之後改過的檔案，而且每次倒帶（就算中途被打斷）都能再撤銷。
- **不只專案資料夾。** 你指定監看的檔案（例如 `~/.zshrc`）、Windows 使用者環境變數，以及全域安裝（會列出，並附上撤銷用的指令）。
- **證據連到程式版本。** 測試和建置都記錄它們跑的是哪一版程式，舊版通過、之後又改過的會標成過期；交接內容也能拿來和資料夾核對。
- **所有 agent 共用一套規則。** 防護規則在工具執行前擋下或先問你，紀錄被改過也看得出來。
- **agent 照原樣用。** 直接掛在官方 agent 上，不用改版、不用包一層；零執行期依賴，什麼都不上傳。

有些情況別的工具更適合：agent 自己的 `/rewind` 和 codex-rewind 會連同對話一起倒回；Turnal 能用二分法找出是哪一輪讓測試壞掉。[各工具逐一比較與出處](docs/alternatives.md)。

## 支援的 agent 與系統

| Agent | 方式 | 狀態 |
|---|---|---|
| Claude Code | hooks | ✅ 已在真實 session 測過 |
| Codex | hooks（第一次要用 `/hooks` 核准） | ✅ 已在真實 session 測過 |
| Cursor | hooks | ✅ CLI 已在真實 session 測過；CLI 不送提示事件，所以在 CLI 裡 undo 一次退一步。Windows 上請從 PowerShell 啟動，從 Git Bash 啟動時它的 hook 不會執行 |
| Gemini CLI | hooks（只在信任的資料夾生效） | ✅ 已完整實測¹；適用 Code Assist Standard／Enterprise 和付費 API 金鑰，個人帳號已在 2026 年 6 月移到 Antigravity |
| Antigravity（CLI、桌面版、IDE） | hooks | ✅ 已完整實測¹；它不提供提示文字，回合會顯示為「New turn」 |
| Copilot CLI | hooks（`~/.copilot/hooks`） | ✅ 已在真實 session 測過 |
| opencode | 外掛 | ✅ 已在真實 session 測過 |
| DeepSeek Harness | 外掛 | 🧪 實驗性（dsh 本身還是開發者預覽版）；已完整實測¹ |
| 其他任何 agent（Aider、腳本……） | `zerostel run -- <指令>` 監看檔案變化 | ✅ 較粗略：沒有工具呼叫、token 和防護規則 |

¹ 在 Windows 上執行真正的 agent，只把模型換成照劇本回應的假模型：一個提示、寫檔、執行指令、一個被規則擋下的呼叫、回合結束，再 undo。

實驗性的 agent 要指名才會安裝，例如 `zerostel install --agent deepseek`。歡迎回報真實使用的狀況。

各個 agent 透過 hook 回報的內容不完全一樣（prompt、失敗的指令、token）；詳見[各 agent 會告訴 Zerostel 什麼](docs/install.md#what-each-agent-tells-zerostel)。

Zerostel 不在乎 agent 背後用的是哪個模型：Claude、GPT、Gemini、DeepSeek 或本機模型，記錄方式都一樣。

支援 Windows、macOS、Linux（含 WSL）。CI 會在三個系統、Node 20／22／24／26 上測試每一次提交。

## 安裝

```bash
npx zerostel install          # 直接執行，不做全域安裝
npm install -g zerostel       # 或是保留 zerostel 指令
```

需要 git 和 Node 20 以上。沒有 Node？每個版本都附有內含 Node 的單一執行檔，支援 Windows、macOS、Linux：從 [Releases](https://github.com/zerostel/zerostel/releases) 下載後執行 `zerostel install`。Claude Code、Codex、Antigravity、Gemini CLI 的外掛、agent skill，以及怎麼驗證下載的檔案：[docs/install.md](docs/install.md)（英文）。

## 文件

| | |
|---|---|
| [指令](docs/commands.md) | 所有指令和選項 |
| [防護規則](docs/guardrails.md) | 規則怎麼運作，以及測試過的範例 |
| [設定](docs/configuration.md) | `~/.zerostel/config.json` |
| [CI](docs/ci.md) | GitHub Action |
| [MCP server](docs/mcp.md) | 讓 agent 讀自己的時間軸，在你要求時倒帶 |
| [運作方式](docs/architecture.md) | hooks、影子 repo、安全的倒帶、稽核鏈 |
| [零信任](docs/zero-trust.md) | 每條原則，以及 Zerostel 怎麼做到 |
| [安全模型](docs/security-model.md) | 它保護什麼、不保護什麼 |
| [各 agent 的 checkpoint](docs/comparison.md) | 每個 agent 的 undo 能救回什麼，附來源 |
| [其他工具](docs/alternatives.md) | Turnback、Turnal、bashback 等工具逐一比較 |
| [常見問題](docs/faq.md) | 速度、硬碟用量、git、jj、沙盒、token |

以上文件為英文。出問題時先執行 `zerostel doctor`：它會檢查 Node、git、每個 agent 的 hooks、你的設定和防護規則，輸出可以直接貼到 issue。

## 限制

- 只能還原有拍到的狀態。刪除發生之後才開始記錄，就救不回那個檔案。
- 一個 shell 指令內部沒有中間狀態：同一個指令裡建立又刪掉的檔案不會被看到。`zerostel run` 在檔案穩定後才拍快照，短暫存在的檔案也可能漏掉。
- 專案外只有你在 `watch` 列出、而且位在家目錄下的檔案會拍快照。Windows 的使用者環境變數（`HKCU\Environment`）只在會改它的指令前後讀取，倒帶時還原；它們的值存在你電腦上的 session 紀錄裡，不會出現在報告中。全域套件只會列出，並附上撤銷指令。倒帶時，目標時間點還不存在的監看檔案會保持原樣。專案外的其他東西都不涵蓋，但時間軸仍會顯示動到它的指令。
- 以下不拍快照，存在時 `zerostel log` 會列出：被忽略的資料夾（`node_modules`、`dist/`、`.gitignore` 裡的東西）、巢狀 git repo 和 submodule、連結資料夾（symlink、junction）、超過 `maxFileMB` 的新檔案。
- 在家目錄、磁碟根目錄或家目錄的上層資料夾啟動的 agent 只有時間軸，沒有快照。
- 倒帶是以整個檔案為單位：加上 `--keep-others` 會保留別人改過的檔案，但兩個 agent 改了同一個檔案時不會幫你合併。
- agent 跑的測試或建置，只有在 agent 回報結果時才算通過；`zerostel check -- <指令>` 則一定知道結果。
- 不分大小寫的檔案系統（Windows、macOS 預設）上，只改大小寫的重新命名（例如 `readme.md` → `README.md`）不會被當成變化。
- 在 WSL 裡，放在 Windows 磁碟（`/mnt/c/...`）的專案拍快照很慢，請放在 Linux 檔案系統裡。
- 雜湊串鏈能看出紀錄被「沒有你的 `audit.key` 的東西」改過。用你自己帳號的人可以讀到金鑰並整份重寫紀錄；請把 `~/.zerostel/**` 放在 deny 規則裡，讓 agent 碰不到。
- 防護規則比對的是工具呼叫寫出來的東西。不寫檔名就能碰到檔案的腳本或指令，會穿過去。

## 開發方向

- **已完成：** 七個 agent 的記錄與倒帶、零點、網頁介面、可分享的報告、可驗證的紀錄、防護規則、MCP server、監看專案外的檔案、連到程式版本的檢查結果、交接、保留其他 session 修改的倒帶。
- **接下來：** 不需要你的金鑰也能驗證的簽章報告；透過 Zerostel 閘道記錄其他 MCP server 的呼叫；找出是哪一步讓檢查失敗、是哪個測試壞掉；實驗性 agent 的真機驗證。
- **歡迎幫忙：** [macOS 和 Linux 的實測回報](https://github.com/zerostel/zerostel/issues/4)，以及標了 [help wanted](https://github.com/zerostel/zerostel/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) 的 issue。

## 參與開發

問題和想法歡迎到 [Discussions](https://github.com/zerostel/zerostel/discussions) 討論。支援新的 agent 只要在 [src/agents/adapters.ts](src/agents/adapters.ts) 加一個 adapter。請看 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [docs/architecture.md](docs/architecture.md)。

```bash
npm ci && npm test && npm run smoke
```

## 授權

[Apache-2.0](LICENSE)
