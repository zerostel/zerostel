<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/zerostel-logo-dark.svg">
  <img src="docs/assets/brand/zerostel-logo-light.svg" alt="Zerostel" width="380">
</picture>

**任何 agent 出错，都能回到零点。**

给 AI agent 的零信任：假设它一定会出错，记下每一步，把它动过的文件回退回去。
AI 编程 agent 的行车记录仪加时光机：每一步都有记录，测试结果关联到它运行的那一版代码，有你自己定的防护规则，还能交接给下一个 agent 或人并让对方核对。

[官网](https://zerostel.com) · [English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

[![npm](https://img.shields.io/npm/v/zerostel)](https://www.npmjs.com/package/zerostel)
[![CI](https://github.com/zerostel/zerostel/actions/workflows/ci.yml/badge.svg)](https://github.com/zerostel/zerostel/actions/workflows/ci.yml)
![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-green)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

</div>

<p align="center"><img src="docs/assets/demo.gif" alt="npx zerostel demo：agent 用 rm -rf 删掉 src/legacy、测试失败，接着 npx zerostel undo 把文件找回来" width="800"></p>

## 快速开始

```bash
npx zerostel install
```

想先看看效果？`npx zerostel demo` 会创建一个用完即丢的示范项目，模拟 agent 删掉文件夹、把测试搞坏的一轮操作，让你亲手 undo。不需要 agent，也不会碰到你的任何项目。

装好之后照常使用 agent。它把东西搞坏的时候：

```bash
zerostel log          # 一步一步看它做了什么
zerostel checks       # 测试是在现在这版代码上通过的吗？
zerostel undo         # 把文件恢复到 agent 上一轮开始之前
zerostel rewind 0     # 或者一路回到零点：这个 session 开始的时候
zerostel handoff      # 交给下一个 agent 或人接手需要知道的事
zerostel ui           # 同样的事，在本地网页上点着操作
```

## 它做什么

- **记录。** 每个提示、工具调用、命令、文件变更、耗时和 token 数，每个 session 一条时间线：在终端用 `zerostel log` 看，或用 `zerostel ui` 在本地网页看。
- **回退。** 每次可能改文件的工具调用前后各拍一次快照，shell 命令也包括在内。可以撤销一个回合、回到任意一步，或一路回到零点；每次回退本身也能再撤销。
- **防护。** 你自己定的规则，能在工具运行前拦下，或让 agent 先问你。所有 agent 共用同一套规则。
- **核对与交接。** agent 跑的每个测试、类型检查和构建，都会关联到它当时运行的那一版代码；`zerostel checks` 分得清「现在这版通过」和「旧版通过、之后又改过」。`zerostel handoff` 把你的要求、当前状态和试过的做法交给下一个 agent 或人。
- **验证与分享。** 用哈希链串起来的记录，被改过看得出来；单页报告，带分享用的隐私模式。
- **只在本地。** 什么都不上传，`~/.zerostel` 只有你能读，也从不碰你的 `.git`。

这就是给 AI agent 的零信任：假设它会出错、看见它做的每件事、永远留一条退路（[具体怎么做](docs/zero-trust.md)，英文）。它不是沙箱：网络请求、部署、数据库写入都收不回来，请看[限制](#限制)。

## 为什么需要

agent 会一次改几十个文件，也会运行 `rm`、`git checkout .`、数据库迁移和构建脚本。出问题的时候，你只想知道两件事：它到底做了什么？怎么回去？

有些 agent 自带 checkpoint，但做法差别很大。Claude Code 的 rewind 不包含通过 Bash 造成的改动；Copilot CLI 会跟踪 shell 命令；Cursor 和 Codex 又各有自己的机制。同时用好几个 agent 的话，“改了什么、能不能恢复”每个的答案都不一样。

Zerostel 用同一种方式记录每个支持的 agent：在每个可能改文件的工具调用前后给项目拍快照，留下提示、命令、文件、时间和 token 的时间线，还能导出给别人看的报告。它完全不碰你的 `.git`。

| | agent 自带的 checkpoint | commit／`git stash` | **Zerostel** |
|---|---|---|---|
| shell 命令造成的改动 | 看 agent | 只有你 commit 或 stash 过的 | ✅ 项目内，加上你指定的文件 |
| 回到指定的某一步 | 通常以提示为单位 | 以 commit 或 stash 为单位 | ✅ 每次工具调用 |
| 命令、文件、token、时间的时间线 | 部分 | ❌ | ✅ |
| 事后能验证记录是否被改过 | ❌ | ✅（commit 哈希） | ✅ |
| 自定义规则：工具运行前拦下或先问你 | 各家不同 | ❌ | ✅ 所有 agent 用同一套规则 |
| 不同 agent 行为一致 | ❌ 各做各的 | ✅ | ✅ |
| 会写入你的 `.git` | 有些会 | ✅ | ❌ 绝不 |
| 可分享的工作报告 | ❌ | ❌ | ✅ |

详细对比和来源：[docs/comparison.md](docs/comparison.md)。背后的真实事故：[What your coding agent's checkpoints can't bring back](https://zerostel.com/blog/agent-checkpoints/)（英文）。

## 和其他工具比较

各家 agent 一直在加自己的 checkpoint，也有不错的插件工具：[Turnback](https://github.com/MFaizR77/turnback)、[Turnal](https://github.com/AadiJo/turnal)、[bashback](https://github.com/trouties/bashback)、[logbook](https://github.com/sheeki03/logbook)、[codex-rewind](https://github.com/extracurricular-ai/codex-rewind)。Zerostel 多做的是：

- **回退不会弄丢东西。** 没有完整备份的文件绝不删除或覆盖，每个文件在改动前一刻会再看一次，`--keep-others` 会保留其他 agent 或你之后改过的文件，而且每次回退（就算中途被打断）都能再撤销。
- **不只项目文件夹。** 你指定监视的文件（例如 `~/.zshrc`）、Windows 用户环境变量，以及全局安装（会列出，并附上撤销用的命令）。
- **证据关联到代码版本。** 测试和构建都记录它们运行的是哪一版代码，旧版通过、之后又改过的会标成过期；交接内容也能拿来和文件夹核对。
- **所有 agent 共用一套规则。** 防护规则在工具运行前拦下或先问你，记录被改过也看得出来。
- **agent 照原样用。** 直接挂在官方 agent 上，不用改版、不用包一层；零运行时依赖，什么都不上传。

有些情况别的工具更合适：agent 自己的 `/rewind` 和 codex-rewind 会连同对话一起回退；Turnal 能用二分法找出是哪一轮让测试坏掉。[各工具逐一比较与出处](docs/alternatives.md)。

## 支持的 agent 和系统

| Agent | 方式 | 状态 |
|---|---|---|
| Claude Code | hooks | ✅ 已在真实 session 中测试 |
| Codex | hooks（第一次需要用 `/hooks` 批准） | ✅ 已在真实 session 中测试 |
| Cursor | hooks | ✅ CLI 已在真实 session 中测试；CLI 不发提示事件，所以在 CLI 里 undo 一次退一步。Windows 上请从 PowerShell 启动，从 Git Bash 启动时它的 hook 不会运行 |
| Gemini CLI | hooks（只在受信任的文件夹生效） | ✅ 已完整实测¹；适用 Code Assist Standard／Enterprise 和付费 API 密钥，个人账号已在 2026 年 6 月迁到 Antigravity |
| Antigravity（CLI、桌面版、IDE） | hooks | ✅ 已完整实测¹；它不提供提示文字，回合会显示为「New turn」 |
| Copilot CLI | hooks（`~/.copilot/hooks`） | ✅ 已在真实 session 中测试 |
| opencode | 插件 | ✅ 已在真实 session 中测试 |
| DeepSeek Harness | 插件 | 🧪 实验性（dsh 本身还是开发者预览版）；已完整实测¹ |
| 其他任何 agent（Aider、脚本……） | `zerostel run -- <命令>` 监视文件变化 | ✅ 较粗略：没有工具调用、token 和防护规则 |

¹ 在 Windows 上运行真正的 agent，只把模型换成按剧本回应的假模型：一个提示、写文件、运行命令、一个被规则挡下的调用、回合结束，再 undo。

实验性的 agent 要指名才会安装，例如 `zerostel install --agent deepseek`。欢迎反馈真实使用的情况。

各个 agent 通过 hook 上报的内容不完全一样（prompt、失败的命令、token）；详见[各 agent 会告诉 Zerostel 什么](docs/install.md#what-each-agent-tells-zerostel)。

Zerostel 不在乎 agent 背后用的是哪个模型：Claude、GPT、Gemini、DeepSeek 或本地模型，记录方式都一样。

支持 Windows、macOS、Linux（含 WSL）。CI 会在三个系统、Node 20／22／24 上测试每一次提交。

## 安装

```bash
npx zerostel install          # 直接运行，不做全局安装
npm install -g zerostel       # 或者保留 zerostel 命令
```

需要 git 和 Node 20 以上。没有 Node？每个版本都附带内置 Node 的单一可执行文件，支持 Windows、macOS、Linux：从 [Releases](https://github.com/zerostel/zerostel/releases) 下载后运行 `zerostel install`。Claude Code、Codex、Antigravity、Gemini CLI 的插件、agent skill，以及如何验证下载的文件：[docs/install.md](docs/install.md)（英文）。

## 文档

| | |
|---|---|
| [命令](docs/commands.md) | 所有命令和选项 |
| [防护规则](docs/guardrails.md) | 规则如何工作，以及测试过的示例 |
| [配置](docs/configuration.md) | `~/.zerostel/config.json` |
| [CI](docs/ci.md) | GitHub Action |
| [MCP server](docs/mcp.md) | 让 agent 读自己的时间线，在你要求时回退 |
| [工作原理](docs/architecture.md) | hooks、影子仓库、安全的回退、审计链 |
| [零信任](docs/zero-trust.md) | 每条原则，以及 Zerostel 如何做到 |
| [安全模型](docs/security-model.md) | 它保护什么、不保护什么 |
| [各 agent 的 checkpoint](docs/comparison.md) | 每个 agent 的 undo 能找回什么，附来源 |
| [其他工具](docs/alternatives.md) | Turnback、Turnal、bashback 等工具逐一比较 |
| [常见问题](docs/faq.md) | 速度、磁盘占用、git、jj、沙箱、token |

以上文档为英文。出问题时先运行 `zerostel doctor`：它会检查 Node、git、每个 agent 的 hooks、你的配置和防护规则，输出可以直接贴到 issue 里。

## 限制

- 只能恢复拍到过的状态。删除发生之后才开始记录，就找不回那个文件。
- 一个 shell 命令内部没有中间状态：同一条命令里创建又删除的文件不会被看到。`zerostel run` 在文件稳定后才拍快照，短暂存在的文件也可能漏掉。
- 项目外只有你在 `watch` 列出、而且位于主目录下的文件会拍快照。Windows 的用户环境变量（`HKCU\Environment`）只在会改它的命令前后读取，回退时恢复；它们的值存在你电脑上的 session 记录里，不会出现在报告中。全局包只会列出，并附上撤销命令。回退时，目标时间点还不存在的监视文件会保持原样。项目外的其他内容都不覆盖，但时间线仍会显示动过它的命令。
- 以下内容不拍快照，存在时 `zerostel log` 会列出：被忽略的文件夹（`node_modules`、`dist/`、`.gitignore` 里的内容）、嵌套的 git 仓库和 submodule、链接文件夹（symlink、junction）、超过 `maxFileMB` 的新文件。
- 在用户主目录、磁盘根目录或主目录的上层文件夹启动的 agent 只有时间线，没有快照。
- 回退以整个文件为单位：加上 `--keep-others` 会保留别人改过的文件，但两个 agent 改了同一个文件时不会帮你合并。
- agent 运行的测试或构建，只有在 agent 上报结果时才算通过；`zerostel check -- <命令>` 则一定知道结果。
- 不区分大小写的文件系统（Windows、macOS 默认）上，只改大小写的重命名（例如 `readme.md` → `README.md`）不会被当作改动。
- 在 WSL 里，放在 Windows 磁盘（`/mnt/c/...`）上的项目拍快照很慢，请放在 Linux 文件系统里。
- 哈希串链能看出记录被“没有你的 `audit.key` 的东西”改过。用你自己账号的人可以读到密钥并整份重写记录；请把 `~/.zerostel/**` 放在 deny 规则里，让 agent 碰不到。
- 防护规则匹配的是工具调用写出来的内容。不写文件名就能碰到文件的脚本或命令，会穿过去。

## 开发方向

- **已完成：** 七个 agent 的记录与回退、零点、网页界面、可分享的报告、可验证的记录、防护规则、MCP server、监视项目外的文件、关联到代码版本的检查结果、交接、保留其他 session 修改的回退。
- **接下来：** 不需要你的密钥也能验证的签名报告；通过 Zerostel 网关记录其他 MCP server 的调用；找出是哪一步让检查失败、是哪个测试坏了；实验性 agent 的真机验证。
- **欢迎帮忙：** [macOS 和 Linux 的实测反馈](https://github.com/zerostel/zerostel/issues/4)，以及标了 [help wanted](https://github.com/zerostel/zerostel/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) 的 issue。

## 参与开发

问题和想法欢迎到 [Discussions](https://github.com/zerostel/zerostel/discussions) 讨论。支持新的 agent 只需要在 [src/agents/adapters.ts](src/agents/adapters.ts) 加一个 adapter。请看 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [docs/architecture.md](docs/architecture.md)。

```bash
npm ci && npm test && npm run smoke
```

## 许可证

[Apache-2.0](LICENSE)
