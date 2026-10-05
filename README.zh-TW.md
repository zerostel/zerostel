<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/zerostel-logo-dark.svg">
  <img src="docs/assets/brand/zerostel-logo-light.svg" alt="Zerostel" width="380">
</picture>

**任何 agent 出錯，都能回到零點。**

給 AI agent 的零信任：假設它一定會出錯，記下每一步，把它動過的檔案倒帶回去。
AI coding agent 的行車紀錄器加時光機，附上你自己定的防護規則，以及能驗證有沒有被竄改的紀錄。

[官網](https://zerostel.com) · [English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

[![npm](https://img.shields.io/npm/v/zerostel)](https://www.npmjs.com/package/zerostel)
[![CI](https://github.com/zerostel/zerostel/actions/workflows/ci.yml/badge.svg)](https://github.com/zerostel/zerostel/actions/workflows/ci.yml)
![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-green)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

</div>

```bash
npx zerostel install
```

想先看看效果？`npx zerostel demo` 會建立一個用完即丟的示範專案，模擬 agent 刪掉資料夾、把測試弄壞的一輪操作，讓你親手 undo。不需要 agent，也不會碰到你的任何專案。

裝好之後照常使用 agent。它把東西弄壞的時候：

```bash
zerostel log          # 一步一步看它做了什麼
zerostel undo         # 把檔案恢復到 agent 上一輪開始之前
zerostel rewind 0     # 或一路回到零點：這個 session 開始的時候
zerostel ui           # 同樣的事，在本機網頁上點選操作
```

<p align="center"><img src="docs/assets/demo.svg" alt="zerostel log 顯示 agent 用 rm -rf 刪掉 src/legacy；zerostel undo 把檔案救回來" width="780"></p>

## 為什麼需要

agent 會一次改幾十個檔案，也會跑 `rm`、`git checkout .`、資料庫遷移和建置腳本。出事的時候，你只想知道兩件事：它到底做了什麼？要怎麼回去？

有些 agent 自帶 checkpoint，但做法差很多。Claude Code 的 rewind 不包含透過 Bash 造成的變化；Copilot CLI 會追蹤 shell 指令；Cursor 和 Codex 又各有自己的機制。同時用好幾個 agent 的話，「改了什麼、救不救得回來」每個的答案都不一樣。

Zerostel 用同一種方式記錄每個支援的 agent：在每個可能改檔案的工具呼叫前後幫專案拍快照，留下提示、指令、檔案、時間和 token 的時間軸，還能匯出給別人看的報告。它完全不碰你的 `.git`。

| | agent 自帶的 checkpoint | commit／`git stash` | **Zerostel** |
|---|---|---|---|
| shell 指令造成的變化 | 看 agent | 只有你 commit 過的 | ✅ 專案內，加上你指定的檔案 |
| 回到指定的某一步 | 通常以提示為單位 | 以 commit 為單位 | ✅ 每次工具呼叫 |
| 指令、檔案、token、時間的時間軸 | 部分 | ❌ | ✅ |
| 事後能驗證紀錄有沒有被改過 | ❌ | ✅（commit 雜湊） | ✅ |
| 自訂規則：工具執行前擋下或先問你 | 各家不同 | ❌ | ✅ 所有 agent 用同一套規則 |
| 不同 agent 行為一致 | ❌ 各做各的 | ✅ | ✅ |
| 會寫入你的 `.git` | 有些會 | ✅ | ❌ 絕不 |
| 可分享的工作報告 | ❌ | ❌ | ✅ |

詳細比較與來源：[docs/comparison.md](docs/comparison.md)。

## 零信任，實際上做了什麼

這個名字背後的想法：不要因為 agent 平常都很乖就信任它。假設它會出錯，看見它做的每件事，並且保留一條回去的路。Zerostel 目前做到：

| 原則 | 在這裡的意思 |
|---|---|
| **假設一定會出事** | 每個可能改檔案的工具呼叫前後都拍快照。可以撤銷任何一輪、回到任何一步，或回到零點。 |
| **看見一切** | 每個提示、工具呼叫、指令、檔案變化、耗時和 token，每個 session 一條時間軸。 |
| **紀錄可驗證** | 每一行紀錄都用帶金鑰的雜湊和前一行串起來。`zerostel verify` 會指出哪一行被改過、刪掉或調換順序。 |
| **記錄器不歸 agent 管** | 入門規則禁止 agent 碰 `~/.zerostel`，agent 要移除 Zerostel 或修改 hook 設定時會先問你。規則可能被繞過，紀錄不會：session 中途 hook 被拿掉，下一次 hook 執行就會記下來。 |
| **最小權限，規則你定** | `~/.zerostel/policy.json` 裡的防護規則，會在工具執行前擋下，或讓 agent 先問你。 |
| **限制損害範圍** | 倒帶涵蓋專案、你指定的檔案（例如 `~/.zshrc`），以及 Windows 的使用者環境變數，而且每次倒帶本身都能再撤銷。倒帶收不回來的事，會先問你（見入門規則），或列出能撤銷它的指令。 |
| **不信任讀到的任何東西** | Zerostel 把每個專案都當作有惡意：不執行專案裡的程式、不跟著連結跑出專案、濾掉終端控制碼。 |

做不到的事：它不是沙盒。網路請求、部署、資料庫寫入都撤不回來；agent 用你的帳號執行，你能做的事它也能做。詳見[限制](#限制)。

## 安裝

```bash
npx zerostel install          # 直接執行，不做全域安裝
npm install -g zerostel       # 或是保留 zerostel 指令
```

請在你信任的資料夾（例如家目錄）執行 `npx`：在專案資料夾裡，npx 會優先使用專案自己提供的同名套件。需要 git；用 npm 安裝的話還需要 Node 20 以上。沒有 Node？每個版本也會附上內含 Node 的單一執行檔，支援 Windows、macOS、Linux 的 x64 和 arm64：從 [Releases](https://github.com/zerostel/zerostel/releases) 下載後執行 `zerostel install`，它會把自己複製到 `~/.zerostel/bin`。`gh attestation verify <檔案> --repo zerostel/zerostel` 可以確認下載的檔案是由這個 repo 的發布流程建置的。Homebrew 和 Scoop 的套件即將推出，範本在 [packaging/](packaging)。

`zerostel install` 會把自己複製到 `~/.zerostel/bin`，就算 npx 快取被清掉 hooks 也照樣能用，然後替找到的每個 agent 加上 hooks。修改前會顯示差異，並備份每個被改到的設定檔。

### 外掛、擴充和 Skill

各個 agent 自己的外掛系統也能安裝 Zerostel。它們都附上同一個 `zerostel` Skill，教 agent 怎麼讀自己的時間軸、先預覽倒帶再問你要不要套用，以及不要去動記錄器。

| Agent | 在 agent 裡執行 | 會加上什麼 |
|---|---|---|
| Claude Code | `/plugin marketplace add zerostel/zerostel`，再 `/plugin install zerostel@zerostel` | 錄製、防護規則和 Skill |
| Codex | `codex plugin marketplace add zerostel/zerostel`，再從外掛清單安裝 Zerostel | Skill；錄製靠 `zerostel install` |
| Antigravity | `agy plugin install https://github.com/zerostel/zerostel` | Skill；錄製靠 `zerostel install` |
| Gemini CLI | `gemini extensions install https://github.com/zerostel/zerostel` | Skill；錄製靠 `zerostel install` |
| 其他支援 Skill 的 agent | `npx skills add zerostel/zerostel` | Skill |
| MCP 用戶端 | [MCP Registry](https://registry.modelcontextprotocol.io) 裡的 `io.github.zerostel/zerostel` | MCP server（見下方） |

在 Claude Code 裡，外掛和 `zerostel install` 擇一使用即可；兩個都開也不會重複記錄。沒有任何外掛會自己啟動 MCP server：由你自己加，執行它的程式也由你決定（見下方）。

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

Zerostel 不在乎 agent 背後用的是哪個模型：Claude、GPT、Gemini、DeepSeek 或本機模型，記錄方式都一樣。

支援 Windows、macOS、Linux（含 WSL）。CI 會在三個系統、Node 20／22／24 上測試每一次提交。

## 指令

**記錄**

| 指令 | |
|---|---|
| `zerostel install` | 替這台電腦上找到的 agent 加上 hooks。`--agent gemini,copilot` 指定，`--agent all` 裝所有非實驗性的。 |
| `zerostel run -- <指令>` | 不用 hooks 也能記錄任何 agent 或腳本，檔案變動穩定後拍快照。 |

**查看**

| 指令 | |
|---|---|
| `zerostel log` | 這個專案最近一次 session 的時間軸。`-n 20` 看最後 20 步，`--changes` 只看有改檔案的步驟。 |
| `zerostel ui` | 在本機網頁看 session、時間軸和 diff，可以直接按還原和復原。 |
| `zerostel sessions` | 這個專案所有錄下來的 session。 |
| `zerostel show <n>`／`zerostel diff <n>` | 第 *n* 步的指令、輸出和檔案，或是完整的 diff。 |
| `zerostel find <路徑>` | 所有 session 裡動過這個檔案的每一步。 |

**回到過去**

| 指令 | |
|---|---|
| `zerostel undo` | 回到 agent 上一輪有改檔案的回合之前。馬上再執行一次就能撤銷這次 undo。 |
| `zerostel rewind <n>` | 回到第 *n* 步之前（`--after` 是之後，`0` 是零點）。不給 *n* 會列出步驟讓你選。`--only <路徑>` 只還原一部分，`--dry-run` 先預覽。 |
| `zerostel snapshot -m "說明"` | 手動存一個檢查點。 |

**分享與驗證**

| 指令 | |
|---|---|
| `zerostel report --open` | 把 session 匯出成一個獨立的 HTML 網頁。 |
| `zerostel report --share` | 給別人看的版本：檔案裡不含提示、指令、輸出和 diff。 |
| `zerostel verify` | 檢查這個 session 的紀錄在記錄之後有沒有被改過（`--all` 檢查全部）。 |

**防護規則**

| 指令 | |
|---|---|
| `zerostel policy init` | 建立入門規則：不准碰憑證；強制推送或修改 `.env` 前先問。 |
| `zerostel policy` | 顯示你的規則。 |
| `zerostel policy test "<指令或路徑>"` | 看看它會不會碰到哪條規則。 |

**整理**

| 指令 | |
|---|---|
| `zerostel status`／`zerostel doctor` | 安裝和記錄狀態；完整檢查，輸出可以直接貼到 issue。 |
| `zerostel prune` | 刪掉 30 天前的 session（`--older-than 7d`）和只有它們用到的快照。 |
| `zerostel projects` | 所有有紀錄的專案，搬過位置的也找得到；任何指令都能加 `--project <id>`。 |
| `zerostel config` | 顯示設定。 |
| `zerostel completion <shell>` | bash、zsh、fish、PowerShell 的 Tab 自動補全，例如 `eval "$(zerostel completion bash)"`。 |
| `zerostel uninstall` | 移除 hooks。紀錄會留在 `~/.zerostel`，直到你自己刪除。 |

`--session <id>` 選較舊的 session，`--json` 輸出機器可讀格式，`-y` 跳過確認。

## 防護規則

規則放在 `~/.zerostel/policy.json`。沒有這個檔案就沒有規則。`zerostel policy init` 會建立一份入門規則：除了下面這些，還會在以系統管理員身分執行（`sudo`）、全域安裝或移除軟體（`npm -g`、`pip --user`、`brew`、`winget`……）、修改系統或使用者設定（`setx`、`reg`、`crontab`……）、寫入系統資料夾、發布或部署（`npm publish`、`terraform apply`、`vercel --prod`……）、刪除資料表，以及關掉 Zerostel 本身（`zerostel uninstall`、`zerostel prune`、修改 agent 的 hook 設定）之前先問你。規則比對的是指令的寫法，能拖慢 agent 但擋不死；就算 hook 還是被拿掉，紀錄裡也會留下來。節錄：

```json
{
  "rules": [
    { "action": "deny", "paths": ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.kube/**", "~/.config/gcloud/**", "~/.zerostel/**"],
      "reason": "credentials, and Zerostel's own records, are off limits" },
    { "action": "ask", "paths": ["**/.env", "**/.env.*"], "access": "write", "reason": "changes a .env file" },
    { "action": "ask", "commands": ["git push --force*", "git push -f*", "git reset --hard*", "git clean -*f*", "* --no-verify*"],
      "reason": "rewrites or throws away git history" }
  ]
}
```

`zerostel policy init` 產生的檔案帶有 `$schema`，VS Code 等編輯器會一邊打一邊補全、檢查（schema 在 `https://zerostel.com/schema/policy.json`，`config.json` 也有）。

- **`paths`** 比對工具呼叫用到的檔案，包括 shell 指令裡出現的路徑。`~/` 是你的家目錄，其他相對路徑從專案根目錄算起。`**` 可以跨資料夾，`*` 不行。`"access": "write"` 讓規則只套用在會改檔案的工具。
- **`commands`** 比對 shell 指令的每一段（用 `&&`、`||`、`;`、`|` 切開）。`*` 代表任何字。
- **`tools`** 比對工具名稱，例如 `"WebFetch"` 或 `"mcp__github__delete_*"`。
- **`deny`** 在執行前擋下，並告訴 agent 原因。**`ask`** 會讓 Claude Code 先問你；沒辦法暫停詢問的 agent 會擋下，並請 agent 先跟你確認。

指令比對不分大小寫，並在 `&&`、`||`、`;`、`|`、`&`、`( )`、`$( )` 和反引號處切開；`$HOME/.ssh`、`%USERPROFILE%\.ssh`、Git Bash 的 `/c/Users/...` 這類寫法都認得出來。

被擋下和被詢問的呼叫會出現在時間軸、網頁介面和報告裡。`policy.json` 寫壞時，`zerostel status` 和 `doctor` 會指出來，不會自行猜測；Zerostel 自己出問題時，也絕不會擋住工具。防護規則是防止失誤的安全帶，不是沙盒：一個指令可以不寫出檔名就碰到那個檔案。

更多現成規則（機密、上傳、資料庫遷移、主分支、MCP 工具、相依套件、CI 專用的嚴格版），每條都有測試：[docs/guardrails.md](docs/guardrails.md)。

## 在 CI 裡使用

在 GitHub Actions 裡無人看管執行的 agent，也能有同樣的紀錄、防護規則和報告。時間軸會寫進 job summary，報告會附在這次執行上：

```yaml
- uses: zerostel/zerostel@v0
  with:
    agent: claude-code
    policy: .github/zerostel-policy.json
    run: claude -p "make npm test pass" --permission-mode acceptEdits
```

詳見 [docs/ci.md](docs/ci.md)。

## 讓 agent 自己使用（MCP）

`zerostel mcp` 是一個 [Model Context Protocol](https://modelcontextprotocol.io) server，agent 自己就能在做危險動作前存檢查點、看時間軸、用你的規則先檢查指令，也能在你要求時倒帶（「回到第 12 步」、「回到零點」）。倒帶在明確要求套用之前只會預覽，而且只作用在 agent 啟動時所在的專案。

全域安裝 `zerostel`（`npm install -g zerostel`）後，加到 Claude Code：

```bash
claude mcp add zerostel -- zerostel mcp
```

Windows 上改用 `claude mcp add zerostel -- cmd /c zerostel mcp`。Codex 從 `~/.codex/config.toml` 讀取：

```toml
[mcp_servers.zerostel]
command = "zerostel"
args = ["mcp"]
```

其他 agent 在它們的 MCP 設定裡填入同樣的指令和參數即可。

## 運作方式

```
 agent ──hook──▶ zerostel ──▶ policy.json      工具執行前擋下或先問
 （每次工具呼叫      │
  前後各一次）       └──────▶ ~/.zerostel/projects/<名稱>-<hash>/
                              ├─ snapshots.git      影子 repo，工作目錄就是你的專案
                              └─ sessions/*.jsonl   提示、指令、檔案、token、時間（雜湊串鏈）
```

- **Hooks。** agent 在每次工具呼叫前後、每一輪開始和結束時通知 Zerostel。唯讀工具只記錄；可能改檔案的工具前後各拍一次快照。
- **影子 git repo。** 快照存在獨立的 repository，它的工作目錄就是你的專案。你的 `.git`、分支、index、stash 都不會被動到，專案也不必是 git repo。檔案逐位元組保存，相同內容只存一份。
- **快照範圍。** `.gitignore` 沒排除的都會存，`node_modules` 這類依賴資料夾除外。`.env` 這種被忽略的小檔案仍然會備份，因為 agent 刪掉它的時候，正是你最需要它的時候。`watch` 裡列出的專案外檔案，存在另一個獨立的 repo。
- **安全的還原。** 還原前會先拍下目前狀態，所以每次還原都能撤銷。只刪除那份快照有備份的檔案，不會跟著 symlink 或 junction 跑出專案，還原後還會檢查結果。
- **可驗證的紀錄。** 每一行事件都帶有「前一行加上自己」的 HMAC，金鑰是 `~/.zerostel/audit.key`。
- **不擋路。** 除非規則觸發，hooks 不輸出任何東西、永遠以 0 結束、錯誤寫進自己的紀錄檔。Zerostel 出問題時，agent 照常工作。

詳見 [docs/architecture.md](docs/architecture.md)。

## 設定

`~/.zerostel/config.json`（每個欄位都可省略）：

```json
{
  "maxFileMB": 25,
  "snapshotTimeoutSec": 20,
  "retentionDays": 30,
  "exclude": ["data/**", "*.sqlite"],
  "watch": ["~/.zshrc", "~/.bashrc", "~/.gitconfig"]
}
```

- **`maxFileMB`**：超過這個大小的新檔案不拍快照，時間軸會註明。
- **`snapshotTimeoutSec`**：單次快照超過這個時間，這個專案暫停快照一小時，時間軸照常記錄。
- **`exclude`**：永遠不拍快照的 git pathspec glob。
- **`watch`**：家目錄下要跟著每個專案一起拍快照、一起倒帶的檔案（每個最大 1 MB）。這些檔案有變化時，會在時間軸上單獨顯示成一步。

## 隱私與安全

所有資料都留在你的電腦上，不會上傳。`~/.zerostel` 只有你自己能讀。

時間軸會保存提示、指令和指令輸出的最後一段。API key、token 和密碼會盡量遮蔽，但格式特殊的秘密不保證遮得到。檔案內容只存在快照 repo 裡。報告不會包含 `.env` 這類檔案，`--share` 則完全不含提示、指令、輸出和 diff，但檔案路徑和時間仍在。

Zerostel 把專案視為不可信任：檔名不會變成 git 選項或比對樣式、連結不會讓快照或還原跑出專案、專案資料夾裡的程式不會被當成 git 或 shell 執行、輸出裡的終端控制碼會被濾掉。`zerostel ui` 只聽 127.0.0.1，而且需要它印出的連結裡的隨機 token。[docs/security-model.md](docs/security-model.md)（英文）說明 Zerostel 保護什麼、不保護什麼；發現問題請看 [SECURITY.md](SECURITY.md)。

## 名字的由來

**Zero** trust（零信任）＋ **Stella**（星辰）。AI agent 像夜空裡的星星一樣越來越多；Zerostel 是它們最後都會回到的那一點：一份能驗證的紀錄，和一條回到零點的路。

## 常見問題

**會拖慢 agent 多少？** 用 `scripts/bench.mjs` 在 Windows 11（筆電 i9，開新程序最慢的平台）上量的：

| | 1,000 個檔案 | 10,000 個檔案 | 50,000 個檔案 |
|---|---|---|---|
| 只讀取的工具呼叫 | 0.16 秒 | 0.16 秒 | 0.16 秒 |
| 會改檔的工具呼叫（前後各拍一次快照） | 1.0 秒 | 1.2 秒 | 1.9 秒 |
| 專案的第一次快照（在背景進行） | 3 秒 | 35 秒 | 5 分鐘 |

第一次快照要把每個檔案讀一遍。它在 session 開始時就在背景進行，agent 不用等；完成之前的步驟照樣記錄，只是沒有快照。快照大約佔專案壓縮後的大小，再加上變動的部分。執行 `npm run build && node scripts/bench.mjs` 可以量你自己的電腦。

**git 不就夠了？** 如果你在對的時間點 commit 或 stash，git 是很好的復原工具。但 agent 在 commit 之間就會改東西，而且常透過 shell 指令，沒人會在每次工具呼叫前 commit。Zerostel 自動做這件事，而且存在自己的 repository，不弄亂你的歷史。長期保存還是交給 git 和正常備份。

**那 jj 呢？** Jujutsu 每次執行 `jj` 指令都會快照工作目錄，也有可以 undo 的操作紀錄。如果你的 agent 會在對的時間點跑 jj，它能涵蓋大部分需求。Zerostel 多了逐步時間軸、防護規則和報告，而且不需要任何人去執行什麼。

**這不是應該內建在 agent 裡嗎？** 不少 agent 有 checkpoint 和權限規則，夠用的話就用它。Zerostel 適合想要一份紀錄、一套規則、一種復原方式橫跨所有 agent 的人。兩者不衝突。

**跟 snap-back 或 Entire 有什麼不同？** snap-back 也用影子 git 拍快照並提供 undo；Entire 把 agent session 和你的 commit 連起來。Zerostel 把快照對應到 agent 的每一步，再加上時間軸、防護規則、可驗證的紀錄、網頁介面和可分享的報告。

**它是沙盒嗎？** 不是。防護規則擋下你規則裡寫到的工具呼叫，倒帶把檔案放回去。要跑不信任的程式碼，請另外把 agent 放進容器或獨立帳號。

**undo 會把 agent 做的事全部撤回嗎？** 不會。它只把有拍到的檔案放回去：專案，以及你在 `watch` 列出的檔案。指令全域安裝或移除的套件（npm、pip、Homebrew）會顯示成一步，並附上撤銷用的指令；倒帶時 Zerostel 會列出來，但絕不替你執行。Windows 上用 `setx` 等方式改的使用者環境變數會被還原。網路請求、部署、資料庫寫入、你真正的 `.git` 都不會被撤回，agent 的對話也不會倒轉，那部分請在 agent 裡另外 rewind，或開新 session。

**可以只撤銷一個 agent，讓另一個繼續工作嗎？** 不安全。undo 會還原整個專案（或 `--only` 指定的路徑），期間其他 agent 或你自己的修改也會一起被還原。先用 `--dry-run` 預覽；同時跑的 agent 請用不同的 worktree。

**會佔多少硬碟？** 相同內容只存一份並壓縮。`zerostel status` 會顯示總量，`zerostel prune` 可以清掉舊的 session。

**token 數字就是我的帳單嗎？** 不是。它從 agent 的對話紀錄讀取，格式不認得時會顯示 not captured，`zerostel run` 則完全看不到 token。請以服務商的後台為準。

## 限制

- 只能還原有拍到的狀態。刪除發生之後才開始記錄，就救不回那個檔案。
- 一個 shell 指令內部沒有中間狀態：同一個指令裡建立又刪掉的檔案不會被看到。`zerostel run` 在檔案穩定後才拍快照，短暫存在的檔案也可能漏掉。
- 專案外只有你在 `watch` 列出、而且位在家目錄下的檔案會拍快照。Windows 的使用者環境變數（`HKCU\Environment`）只在會改它的指令前後讀取，倒帶時還原；它們的值存在你電腦上的 session 紀錄裡，不會出現在報告中。全域套件只會列出，並附上撤銷指令。倒帶時，目標時間點還不存在的監看檔案會保持原樣。專案外的其他東西都不涵蓋，但時間軸仍會顯示動到它的指令。
- 以下不拍快照，存在時 `zerostel log` 會列出：被忽略的資料夾（`node_modules`、`dist/`、`.gitignore` 裡的東西）、巢狀 git repo 和 submodule、連結資料夾（symlink、junction）、超過 `maxFileMB` 的新檔案。
- 在家目錄或磁碟根目錄啟動的 agent 只有時間軸，沒有快照。
- 不分大小寫的檔案系統（Windows、macOS 預設）上，只改大小寫的重新命名（例如 `readme.md` → `README.md`）不會被當成變化。
- 在 WSL 裡，放在 Windows 磁碟（`/mnt/c/...`）的專案拍快照很慢，請放在 Linux 檔案系統裡。
- 雜湊串鏈能看出紀錄被「沒有你的 `audit.key` 的東西」改過。用你自己帳號的人可以讀到金鑰並整份重寫紀錄；請把 `~/.zerostel/**` 放在 deny 規則裡，讓 agent 碰不到。
- 防護規則比對的是工具呼叫寫出來的東西。不寫檔名就能碰到檔案的腳本或指令，會穿過去。

## 開發方向

- **已完成：** 七個 agent 的記錄與倒帶、零點、網頁介面、可分享的報告、可驗證的紀錄、防護規則、MCP server、監看專案外的檔案。
- **接下來：** 不需要你的金鑰也能驗證的簽章報告；透過 Zerostel 閘道記錄其他 MCP server 的呼叫；解析測試輸出，指出是哪個測試壞掉；實驗性 agent 的真機驗證。

## 疑難排解

執行 `zerostel doctor`。它會檢查 Node、git、每個 agent 的 hooks 和版本、設定檔、快照覆蓋範圍、最近一次 session 的稽核鏈、防護規則和最近的 hook 錯誤，輸出可以直接貼到 issue（家目錄路徑會縮寫成 `~`）。

## 參與開發

支援新的 agent 只要在 [src/agents/adapters.ts](src/agents/adapters.ts) 加一個 adapter。請看 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [docs/architecture.md](docs/architecture.md)。

```bash
npm install && npm test && npm run smoke
```

## 授權

[Apache-2.0](LICENSE)
