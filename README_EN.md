# open-claude-code

<p align="center">
  <strong>English</strong> · <a href="./README.md">中文</a>
</p>

`open-claude-code` is reconstructed from sourcemap information related to `@anthropic-ai/claude-code@2.1.88`. Based on that recovery work, this repository includes build fixes, structural restoration, and runtime adjustments. Current status: the project has been repaired and can be run locally for code reading and study.

**The recovery, build repair, and documentation work in this repository are driven by Codex.**

## Future Direction

This repository is not intended to replace the official release. It exists as a relatively complete local project for source reading, engineering analysis, build process research, and reference on terminal agent implementations.

## Project Overview

This repository mainly preserves the core engineering structure of the Claude Code terminal tool, including but not limited to:

- `src/`: restored source code
- `src/entrypoints/`: CLI entrypoints and related initialization logic
- `vendor/`: platform-specific binaries or runtime dependencies
- `stubs/`: local stub dependencies
- `images/`: demo screenshots

### Private MCP/NAPI compatibility and related status

The items below describe the current state of the private MCP and related native / NAPI compatibility layers in this recovered build. The table keeps only two signals: **whether the implementation is aligned with the official/original path**, and **the current recovery level (fully complete / mostly complete / graceful-degradation only)**.

| Component | Progress (official alignment) | Availability (recovery level) |
| --- | --- | --- |
| `@ant/claude-for-chrome-mcp` | Aligned with the official JS / bridge structure. | Mostly complete; still requires the external Chrome extension and socket bridge runtime. |
| `@ant/computer-use-mcp` | Aligned with the official MCP server / tool schema. | Mostly complete; real execution still depends on the native input / swift backends. |
| `@ant/computer-use-input` | Aligned with the official `.node` prebuild path. | Mostly complete; the restored path is currently centered on macOS. |
| `@ant/computer-use-swift` | Aligned with the official `computer_use.node` path. | Mostly complete; the restored native flow is currently centered on macOS. |
| `image-processor-napi` | Aligned with the official `.node` path, with an added JS fallback. | Mostly complete; native-first, with `sharp` as fallback. |
| `color-diff-napi` | Self-implemented TypeScript compatibility layer. | Mostly complete; the main path works, but it is not the official native implementation. |
| `audio-capture-napi` | Aligned with the official `.node` path. | Mostly complete; multi-platform native modules are restored, but real-device validation is still needed. |
| `url-handler-napi` | Aligned with the official `.node` path. | Mostly complete; the restored native listener is currently macOS-focused. |
| `modifiers-napi` | Aligned with the official Bun FFI approach. | Mostly complete; usable on macOS + Bun, with safe degradation elsewhere. |

> Overall: the native-path recoveries are primarily aligned with the official/original implementation, `color-diff-napi` remains a self-implemented compatibility layer, and `modifiers-napi` follows the official Bun FFI approach; the browser / computer-use chain still depends on external runtimes.

## Requirements

- Node.js 18 or later
- npm
- Bun

## Quick Start

Install dependencies:

```bash
bun install or npm install
```

Check the version:

```bash
bun run version or npm run version
```

Start directly:

```bash
bun run dev or npm run dev
```

Rebuild if needed:

```bash
bun run build or npm run build
```

## Helper Scripts

The repository also includes helper scripts for source restoration, platform binary download, native dependency extraction, and staging. Detailed usage is documented in [`scripts/README.md`](./scripts/README.md).

- `download-claude-binaries.cmd`: download Claude binaries for all supported platforms by version.
- `extract-native-deps-from-claude.mjs`: extract recognizable native dependencies and reports from Claude binaries.
- `stage-recovered-vendor-from-artifacts.mjs`: stage extracted results into a separate recovered vendor/stubs tree for manual merge or comparison.
- `restore-sourcemap-sources.mjs`: restore sources and compatibility-layer files from sourcemaps.

## Screenshots

### Startup

![Startup](./images/snapshot1.png)

### Interaction

![Interaction](./images/snapshot2.png)

![Interaction2](./images/snapshot3.png)

## Disclaimer

This repository is not an official Anthropic project and does not represent Anthropic in any way.

We do not own Claude Code, and we do not claim ownership over the original Claude Code source code, name, trademarks, branding, or any derivative rights related to it. The original source code and related rights associated with Claude Code belong to Anthropic, Inc. or the relevant rights holders.

This repository is provided for learning, research, discussion, and reference only. Do not use it for any commercial activity, including but not limited to:

- commercial distribution
- paid resale
- closed-source integration
- deployment as a paid service
- sublicensing
- any use that may infringe on the rights of the original owner

Users are solely responsible for evaluating and assuming all risks arising from the use of this repository, including but not limited to compliance risks, intellectual property risks, and any direct or indirect losses caused by such use.

Any use of this project to infringe upon Anthropic PBC's legitimate rights and interests or to circumvent product  policies is unrelated to this project and undertaken at your own risk.

If you are a relevant rights holder and believe any content in this repository should not be publicly displayed or distributed, please contact through the repository channel for handling.

## License Notice

This repository does not grant any additional license to Anthropic's original code, nor does it imply any relicensing of the upstream project. Except for rights otherwise granted by applicable law, this repository should not be treated as a substitute for an open-source license to the original Claude Code codebase.

## Acknowledgements

- Thanks to Anthropic for the original Claude Code project
- Thanks to Codex for contributing to the recovery, build repair, and documentation of this repository
