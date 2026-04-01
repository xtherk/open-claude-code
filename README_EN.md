# open-claude-code

[中文](README.md)/[English](README_EN.md)

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

## Requirements

- Node.js 18 or later
- npm
- Bun

## Quick Start

Install dependencies:

```bash
npm install
```

Check the restored version:

```bash
npm run smoke
```

Start directly:

```bash
node ./dist/cli.js
```

Rebuild if needed:

```bash
npm run build
```

## Screenshots

### Startup

![Startup](./images/snapshot1.png)

### Interaction

![Interaction](./images/snapshot2.png)

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
