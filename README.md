# open-claude-code

<p align="center">
  <strong>中文</strong> · <a href="./README_EN.md">English</a>
</p>
`open-claude-code` 是项目基于 `@anthropic-ai/claude-code@2.1.88` 版本相关 sourcemap 信息整理而来，在此基础上完成了编译修复、结构补全和可运行性调整。当前状态：已完成编译修复，可进行本地运行和代码阅读。

**当前仓库的恢复、修复与文档整理工作由 Codex 驱动完成。**

## 后续发展

本仓库的目标不是替代官方版本，而是为源码阅读、工程分析、构建流程研究和终端Agent实现参考提供一个相对完整的本地工程。

## 项目说明

这个仓库主要保留了 Claude Code 终端工具的核心工程结构，包括但不限于以下内容：

- `src/`：恢复后的主要源码
- `src/entrypoints/`：CLI 入口与相关初始化逻辑
- `vendor/`：平台相关二进制或运行时依赖
- `stubs/`：本地占位依赖
- `images/`：演示截图

### 私有 MCP/NAPI 兼容层进度等

下面这些是当前恢复版里和 Claude 私有 MCP、native / NAPI 替代实现相关的兼容层状态。这里只保留两个维度：**是否对标官方原版实现**，以及 **当前恢复程度（完成全部 / 完成大部分 / 纯降级防崩溃）**。

| 组件 | 当前进度（对标情况） | 可用情况（恢复程度） |
| --- | --- | --- |
| `@ant/claude-for-chrome-mcp` | 对标官方原版 JS / Bridge 结构。 | 完成大部分；仍需 Chrome 扩展与 socket bridge 外部运行时。 |
| `@ant/computer-use-mcp` | 对标官方原版 MCP server / tool schema。 | 完成大部分；真实执行仍依赖 input / swift 原生后端。 |
| `@ant/computer-use-input` | 对标官方原版 `.node` prebuild。 | 完成大部分；当前主要恢复 macOS 路径。 |
| `@ant/computer-use-swift` | 对标官方原版 `computer_use.node`。 | 完成大部分；当前主要恢复 macOS 原生链路。 |
| `image-processor-napi` | 对标官方原版 `.node`，并补充 JS fallback。 | 完成大部分；native-first，失败时回退 `sharp`。 |
| `color-diff-napi` | 自实现 TypeScript 兼容层。 | 完成大部分；主链路可用，但非官方 native 实现。 |
| `audio-capture-napi` | 对标官方原版 `.node` 路径。 | 完成大部分；已恢复多平台 native 模块，仍需实机验证。 |
| `url-handler-napi` | 对标官方原版 `.node` 路径。 | 完成大部分；当前主要恢复 macOS 原生监听。 |
| `modifiers-napi` | 对标官方原版 Bun FFI 方案。 | 完成大部分；macOS + Bun 可用，其他环境安全降级。 |

> 总体上：native 路径恢复以对标官方原版为主，`color-diff-napi` 为自实现兼容层，`modifiers-napi` 对标官方 Bun FFI 方案；browser / computer-use 整体链路仍需外部运行时配套。

## 环境要求

- Node.js 18或更高版本
- npm
- Bun

## 快速开始

安装依赖：

```bash
bun install 或 npm install
```

检查当前版本：

```bash
bun run version 或 npm run version
```

直接启动：

```bash
bun run dev 或 npm run dev
```

如需重新构建：

```bash
bun run build 或 npm run build
```

## 辅助脚本

仓库内还提供了一组围绕源码恢复、平台二进制下载、native 依赖提取与 staging 的辅助脚本，详细用法见 [`scripts/README.md`](./scripts/README.md)。

- `download-claude-binaries.cmd`：按版本批量下载各平台 Claude 二进制。
- `extract-native-deps-from-claude.mjs`：从各平台 Claude 二进制中提取可识别的 native 依赖与报告。
- `stage-recovered-vendor-from-artifacts.mjs`：把提取结果整理为独立的 recovered vendor/stubs 目录，便于手动覆盖或比对。
- `restore-sourcemap-sources.mjs`：从 sourcemap 恢复源码与编译所需兼容层文件。

## 演示截图

### 启动界面

![启动界面](./images/snapshot1.png)

### 交互界面

![交互界面](./images/snapshot2.png)

![交互界面2](./images/snapshot3.png)

## 免责声明

本仓库不是 Anthropic 官方项目，也不代表 Anthropic 的任何立场。

我方不拥有 Claude Code 的所有权，也不对 Claude Code 原始源码、名称、商标、相关品牌标识或其衍生权利主张任何所有权。与 Claude Code 相关的原始源码及其相关权利归 Anthropic 公司或其权利主体所有。

本仓库仅供学习、研究、交流和参考使用，请勿将其用于任何商业活动，包括但不限于：

- 商业分发
- 付费售卖
- 闭源集成
- 代部署服务
- 二次授权
- 任何可能侵犯原始权利人权益的用途

使用者应自行评估并承担由使用本仓库带来的风险与责任，包括但不限于合规风险、知识产权风险以及由此产生的直接或间接损失。

任何将本项目用于侵犯 Anthropic PBC 合法权益或规避产品政策的行为，均与本项目无关，风险自负。

如果你是相关权利人，并认为本仓库内容存在不适合公开展示或传播的部分，请通过仓库渠道联系处理。

## 许可说明

本仓库不对 Anthropic 原始代码授予任何额外许可证，也不意味着对上游项目进行了重新授权。除使用者依法享有的权利外，请不要将本仓库视为对 Claude Code 原始代码的开源授权替代品。

## 致谢

- 感谢 Anthropic提供Claude Code原始项目
- 感谢 Codex参与本仓库的恢复整理、编译修复与文档编写
- 感谢 [LinuxDo](https://linux.do/)论坛里可爱的佬友们提供的帮助
