const fs = require("fs");
const path = require("path");

if (process.platform !== "darwin") {
  throw new Error("@ant/computer-use-swift is only available on macOS");
}

function collectCandidates(fileName) {
  const platformDir = `${process.arch}-darwin`;
  const candidates = [];
  const seen = new Set();
  const bases = [__dirname, process.cwd()];
  const relatives = [
    `../prebuilds/${platformDir}/${fileName}`,
    `../prebuilds/${fileName}`,
    `../stubs/ant-computer-use-swift/prebuilds/${platformDir}/${fileName}`,
    `../stubs/ant-computer-use-swift/prebuilds/${fileName}`,
    `../../stubs/ant-computer-use-swift/prebuilds/${platformDir}/${fileName}`,
    `../../stubs/ant-computer-use-swift/prebuilds/${fileName}`,
    `../node_modules/@ant/computer-use-swift/prebuilds/${platformDir}/${fileName}`,
    `../node_modules/@ant/computer-use-swift/prebuilds/${fileName}`,
    `../../node_modules/@ant/computer-use-swift/prebuilds/${platformDir}/${fileName}`,
    `../../node_modules/@ant/computer-use-swift/prebuilds/${fileName}`,
  ];

  for (const base of bases) {
    for (const relativePath of relatives) {
      const candidate = path.resolve(base, relativePath);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function loadNative() {
  const envPath = process.env.COMPUTER_USE_SWIFT_NODE_PATH;
  let lastError = null;

  if (envPath) {
    try {
      return require(envPath);
    } catch (error) {
      lastError = error;
    }
  }

  const candidates = collectCandidates("computer_use.node");
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      return require(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const details = candidates.map(candidate => `- ${candidate}`).join("\n");
  const suffix =
    lastError instanceof Error && lastError.message
      ? `\n最后一次错误：${lastError.message}`
      : "";

  throw new Error(
    `@ant/computer-use-swift 原生模块加载失败。${suffix}\n已尝试路径：\n${details}`,
  );
}

const native = loadNative();
module.exports = native.computerUse;
