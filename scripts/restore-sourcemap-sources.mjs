#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const sourceMapPath = path.join(projectRoot, 'dist', 'cli.js.map');
const recoveryDir = path.join(projectRoot, '.recovery');
const sourceRuntimeDir = path.join(projectRoot, 'src', 'recovery');
const reportPath = path.join(recoveryDir, 'recovery-report.json');
const tsconfigPath = path.join(projectRoot, 'tsconfig.recovered.json');

const args = new Set(process.argv.slice(2));
const overwrite = args.has('--overwrite');
const skipNodeModules = args.has('--skip-node-modules');
const buildAfterRestore = args.has('--build');

/**
 * 将 Windows 路径统一转换为 POSIX 形式，便于 sourcemap 路径处理。
 */
function toPosixPath(value) {
  return value.replaceAll('\\', '/');
}

/**
 * 确保相对 import 以 ./ 或 ../ 开头。
 */
function ensureImportPath(value) {
  if (value.startsWith('.')) {
    return value;
  }

  return `./${value}`;
}

/**
 * 递归创建目录并写文件。
 */
async function writeTextFile(filePath, content, { force = false } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  if (!force) {
    try {
      await fs.access(filePath);
      return false;
    } catch {
      // 文件不存在时继续写入
    }
  }

  await fs.writeFile(filePath, content, 'utf8');
  return true;
}

/**
 * 从 bare import 推导包名：
 * - react/jsx-runtime -> react
 * - @scope/pkg/subpath -> @scope/pkg
 */
function normalizePackageName(specifier) {
  const normalized = specifier.trim();

  if (!normalized || normalized.startsWith('.') || normalized.startsWith('/') || normalized.startsWith('node:') || normalized.startsWith('bun:') || normalized.startsWith('#')) {
    return null;
  }

  const parts = normalized.split('/');
  if (normalized.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : normalized;
  }

  return parts[0];
}

/**
 * 将 node_modules 内路径切分为包名与包内相对路径。
 */
function splitNodeModulePath(relativePath) {
  const normalized = toPosixPath(relativePath);
  const parts = normalized.split('/');

  if (parts[0]?.startsWith('@')) {
    const packageName = `${parts[0]}/${parts[1]}`;
    const packageRelativePath = parts.slice(2).join('/');
    return { packageName, packageRelativePath };
  }

  return {
    packageName: parts[0],
    packageRelativePath: parts.slice(1).join('/'),
  };
}

/**
 * 检测源码更偏向 ESM 还是 CommonJS，用于生成最小 package.json。
 */
function detectPackageModuleKind(content) {
  const text = content ?? '';
  const hasEsmSyntax = /\bimport\s+[^'"]|\bexport\s+(?:\{|\*|default|const|class|function|type|interface)/m.test(text);
  const hasCjsSyntax = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\brequire\s*\(/m.test(text);

  if (hasEsmSyntax && !hasCjsSyntax) {
    return 'module';
  }

  if (!hasEsmSyntax && hasCjsSyntax) {
    return 'commonjs';
  }

  return 'mixed';
}

/**
 * 为 bare import 包生成一个尽量稳妥的 main 入口。
 */
function detectPackageEntry(files) {
  const candidates = [
    'index.js',
    'index.mjs',
    'index.cjs',
    'dist/index.js',
    'dist/index.mjs',
    'dist/index.cjs',
    'lib/index.js',
    'lib/index.mjs',
    'lib/index.cjs',
    'source/index.js',
    'source/index.mjs',
    'source/index.cjs',
    'build/index.js',
    'build/index.mjs',
    'build/index.cjs',
    'esm/index.js',
    'esm/index.mjs',
    'cjs/index.js',
    'cjs/index.cjs',
    'src/index.js',
    'src/index.mjs',
    'main.js',
    'main.mjs',
    'main.cjs',
  ];

  for (const candidate of candidates) {
    if (files.has(candidate)) {
      return candidate;
    }
  }

  const rootLevelEntries = [...files].filter((item) => /^[^/]+\.(?:js|mjs|cjs)$/.test(item));
  if (rootLevelEntries.length === 1) {
    return rootLevelEntries[0];
  }

  return null;
}

/**
 * 提取 import / export / dynamic import / require 的依赖 specifier。
 * 这里只做恢复用途，不追求完整 AST 级精度。
 */
function collectModuleSpecifiers(content) {
  const results = new Set();
  const text = content ?? '';
  const regexes = [
    /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const regex of regexes) {
    let match = regex.exec(text);
    while (match) {
      if (match[1]) {
        results.add(match[1]);
      }
      match = regex.exec(text);
    }
  }

  return [...results];
}

/**
 * 记录恢复报告里关心的宏与 feature 标记。
 */
function collectCompileMarkers(content, macros, features) {
  const text = content ?? '';

  const macroRegex = /\bMACRO\.([A-Z0-9_]+)/g;
  let macroMatch = macroRegex.exec(text);
  while (macroMatch) {
    macros.add(macroMatch[1]);
    macroMatch = macroRegex.exec(text);
  }

  const featureRegex = /\bfeature\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g;
  let featureMatch = featureRegex.exec(text);
  while (featureMatch) {
    features.add(featureMatch[1]);
    featureMatch = featureRegex.exec(text);
  }
}

/**
 * 让恢复后的源码不再依赖未定义的 MACRO.*，并把 src/* 别名改回相对路径。
 */
function transformInternalSource(relativePath, originalContent) {
  let content = originalContent ?? '';
  const injections = [];
  const currentFilePath = path.join(projectRoot, relativePath);

  content = content.replace(/(['"])src\/([^'"]+)\1/g, (_, quote, specifierTail) => {
    const importPath = ensureImportPath(
      toPosixPath(path.relative(path.dirname(currentFilePath), path.join(projectRoot, 'src', specifierTail))),
    );
    return `${quote}${importPath}${quote}`;
  });

  if (/\bMACRO\.[A-Z0-9_]+/.test(content)) {
    const macroShimPath = ensureImportPath(toPosixPath(path.relative(path.dirname(currentFilePath), path.join(sourceRuntimeDir, 'macroShim.js'))));
    content = content.replace(/\bMACRO\./g, 'RECOVERY_MACRO.');
    injections.push(`import { RECOVERY_MACRO } from '${macroShimPath}';`);
  }

  if (injections.length > 0) {
    content = `${injections.join('\n')}\n${content}`;
  }

  return content;
}

/**
 * 生成恢复编译所需的兼容层。
 */
async function writeRecoveryRuntime(version, macros) {
  const macroValues = {
    BUILD_TIME: new Date().toISOString(),
    FEEDBACK_CHANNEL: 'github',
    ISSUES_EXPLAINER: 'https://github.com/anthropics/claude-code/issues',
    NATIVE_PACKAGE_URL: '',
    PACKAGE_URL: 'https://github.com/anthropics/claude-code',
    VERSION: version,
    VERSION_CHANGELOG: 'https://github.com/anthropics/claude-code/releases',
  };

  for (const macro of macros) {
    if (!(macro in macroValues)) {
      macroValues[macro] = '';
    }
  }

  const macroShim = `/**
 * 恢复源码兼容层：
 * 原始构建流程会在打包时注入 MACRO.* 常量，这里改为静态对象，先保证源码可以继续编译。
 */
export const RECOVERY_MACRO = ${JSON.stringify(macroValues, null, 2)};
`;

  await writeTextFile(path.join(sourceRuntimeDir, 'macroShim.js'), macroShim, { force: true });
}

/**
 * 生成恢复编译使用的 tsconfig。
 */
async function writeRecoveredTsconfig() {
  const tsconfig = {
    $schema: 'https://json.schemastore.org/tsconfig',
    compilerOptions: {
      target: 'ES2022',
      module: 'Preserve',
      moduleResolution: 'Bundler',
      jsx: 'react-jsx',
      allowJs: true,
      checkJs: false,
      resolveJsonModule: true,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      skipLibCheck: true,
      strict: false,
      noEmit: true,
      lib: ['ES2022'],
      types: ['node'],
      baseUrl: '.',
    },
    include: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.js', 'sdk-tools.d.ts'],
  };

  await writeTextFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`, { force: true });
}

/**
 * 为从 sourcemap 提取出来的 node_modules 源码补最小 package.json。
 */
async function writeSyntheticPackageManifests(packageInfos, bareImportedPackages) {
  const unresolvedBareImports = [];

  for (const [packageName, info] of [...packageInfos.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const manifestPath = path.join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json');
    const moduleKind = info.moduleKinds.module > info.moduleKinds.commonjs ? 'module' : undefined;
    const mainEntry = detectPackageEntry(info.files);

    if (bareImportedPackages.has(packageName) && !mainEntry) {
      unresolvedBareImports.push(packageName);
    }

    const manifest = {
      name: packageName,
      private: true,
      ...(moduleKind ? { type: moduleKind } : {}),
      ...(mainEntry ? { main: `./${mainEntry}` } : {}),
      ...(moduleKind && mainEntry ? { module: `./${mainEntry}` } : {}),
    };

    await writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { force: true });
  }

  return unresolvedBareImports;
}

/**
 * 构建恢复后的 cli，验证源码是否至少能继续被 Bun bundler 接受。
 */
function runRecoveredBuild() {
  const buildArgs = [
    'build',
    'src/entrypoints/cli.tsx',
    '--outdir',
    'dist',
    '--target',
    'node',
    '--sourcemap',
  ];

  const result = spawnSync('bun', buildArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (typeof result.status === 'number') {
    return result.status;
  }

  return 1;
}

const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const sourceMap = JSON.parse(await fs.readFile(sourceMapPath, 'utf8'));

if (!Array.isArray(sourceMap.sources) || !Array.isArray(sourceMap.sourcesContent) || sourceMap.sources.length !== sourceMap.sourcesContent.length) {
  throw new Error('dist/cli.js.map 结构异常：sources 与 sourcesContent 不匹配。');
}

const macros = new Set();
const featureFlags = new Set();
const bareImportedPackages = new Set();
const packageInfos = new Map();

let restoredSourceFiles = 0;
let restoredNodeModuleFiles = 0;

for (let index = 0; index < sourceMap.sources.length; index += 1) {
  const rawSource = sourceMap.sources[index];
  const originalContent = sourceMap.sourcesContent[index] ?? '';
  const normalizedSource = toPosixPath(rawSource);

  if (normalizedSource.startsWith('../src/')) {
    const relativePath = normalizedSource.slice(3);
    const transformedContent = transformInternalSource(relativePath, originalContent);

    await writeTextFile(path.join(projectRoot, relativePath), transformedContent, { force: overwrite });
    restoredSourceFiles += 1;

    collectCompileMarkers(originalContent, macros, featureFlags);
    for (const specifier of collectModuleSpecifiers(originalContent)) {
      const packageName = normalizePackageName(specifier);
      if (packageName) {
        bareImportedPackages.add(packageName);
      }
    }
  } else if (!skipNodeModules && normalizedSource.startsWith('../node_modules/')) {
    const relativePath = normalizedSource.slice(3);
    const nodeModuleContent = originalContent;

    await writeTextFile(path.join(projectRoot, relativePath), nodeModuleContent, { force: overwrite });
    restoredNodeModuleFiles += 1;

    const { packageName, packageRelativePath } = splitNodeModulePath(relativePath.slice('node_modules/'.length));
    if (!packageInfos.has(packageName)) {
      packageInfos.set(packageName, {
        files: new Set(),
        moduleKinds: {
          module: 0,
          commonjs: 0,
          mixed: 0,
        },
      });
    }

    const packageInfo = packageInfos.get(packageName);
    packageInfo.files.add(packageRelativePath);
    const moduleKind = detectPackageModuleKind(nodeModuleContent);
    packageInfo.moduleKinds[moduleKind] += 1;
  }
}

await fs.mkdir(recoveryDir, { recursive: true });
await writeRecoveryRuntime(packageJson.version, macros);
await writeRecoveredTsconfig();

const unresolvedBareImports = skipNodeModules ? [] : await writeSyntheticPackageManifests(packageInfos, bareImportedPackages);

const report = {
  packageName: packageJson.name,
  version: packageJson.version,
  sourceMap: path.basename(sourceMapPath),
  restoredSourceFiles,
  restoredNodeModuleFiles,
  skippedNodeModules: skipNodeModules,
  entrypoint: 'src/entrypoints/cli.tsx',
  macroNames: [...macros].sort(),
  featureFlags: [...featureFlags].sort(),
  bareImportedPackages: [...bareImportedPackages].sort(),
  unresolvedBareImports,
  generatedFiles: [
    'src/recovery/macroShim.js',
    'tsconfig.recovered.json',
  ],
  buildCommand: 'bun build src/entrypoints/cli.tsx --outdir dist --target node --sourcemap',
};

await writeTextFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { force: true });

console.log(`已恢复源码文件: ${restoredSourceFiles}`);
console.log(`已恢复依赖源码文件: ${restoredNodeModuleFiles}`);
console.log(`恢复报告: ${toPosixPath(path.relative(projectRoot, reportPath))}`);

if (unresolvedBareImports.length > 0) {
  console.log(`仍缺少可自动推断入口的 bare import 包: ${unresolvedBareImports.join(', ')}`);
}

if (buildAfterRestore) {
  const status = runRecoveredBuild();
  if (status !== 0) {
    process.exit(status);
  }
}
