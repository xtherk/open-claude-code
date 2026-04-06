#!/usr/bin/env node

import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, resolve } from 'path'

const DEFAULT_OUTPUT_DIR = resolve('artifacts', 'claude-native-deps')
const DEFAULT_MIN_STRING_LENGTH = 6
const DEFAULT_MAX_STRING_MATCHES = 80
const DEFAULT_MAX_STRING_LENGTH = 240
const DEFAULT_MAX_EMBEDDED = 24
const MIN_EMBEDDED_BINARY_SIZE = 4096

const EXACT_KEYWORDS = [
  'modifiers-napi',
  'audio-capture-napi',
  'image-processor-napi',
  'url-handler-napi',
  '@ant/computer-use-input',
  '@ant/computer-use-swift',
  '@ant/computer-use-mcp',
  '@ant/claude-for-chrome-mcp',
  'computer-use',
  'claude-for-chrome-mcp',
  'input.node',
  'better_sqlite3.node',
]

const KNOWN_EMBEDDED_ASSET_NAMES = [
  'audio-capture.node',
  'image-processor.node',
  'url-handler.node',
  'computer-use-input.node',
  'input.node',
  'computer-use-swift.node',
  'computer_use.node',
  'libComputerUseSwift.dylib',
  'libcomputer_use_input.dylib',
  'modifiers.node',
  'better_sqlite3.node',
  'sharp.node',
]

const LIBRARY_TOKEN_REGEX =
  /(?:[@A-Za-z0-9_./\\%+-]+?\.(?:node|dll|dylib|so(?:\.\d+)*))(?![A-Za-z0-9_])/g

const MACHO_LOAD_COMMANDS = new Set([0x0c, 0x18, 0x1f, 0x23])
const MACHO_LINKEDIT_DATA_COMMANDS = new Set([
  0x1d, // LC_CODE_SIGNATURE
  0x1e, // LC_SEGMENT_SPLIT_INFO
  0x26, // LC_FUNCTION_STARTS
  0x29, // LC_DATA_IN_CODE
  0x2b, // LC_DYLIB_CODE_SIGN_DRS
  0x2e, // LC_LINKER_OPTIMIZATION_HINT
  0x33, // LC_DYLD_EXPORTS_TRIE
  0x34, // LC_DYLD_CHAINED_FIXUPS
])
const MACHO_DYLD_INFO_COMMANDS = new Set([0x22]) // LC_DYLD_INFO / LC_DYLD_INFO_ONLY
const MACHO_ZERO_FILL_SECTION_TYPES = new Set([0x01, 0x0c, 0x12])
const EMBEDDED_SIGNATURES = [
  { kind: 'pe', signature: Buffer.from('4d5a', 'hex') },
  { kind: 'elf', signature: Buffer.from('7f454c46', 'hex') },
  { kind: 'macho', signature: Buffer.from('feedface', 'hex') },
  { kind: 'macho', signature: Buffer.from('cefaedfe', 'hex') },
  { kind: 'macho', signature: Buffer.from('feedfacf', 'hex') },
  { kind: 'macho', signature: Buffer.from('cffaedfe', 'hex') },
  { kind: 'macho-fat', signature: Buffer.from('cafebabe', 'hex') },
  { kind: 'macho-fat', signature: Buffer.from('cafebabf', 'hex') },
  { kind: 'macho-fat', signature: Buffer.from('bebafeca', 'hex') },
  { kind: 'macho-fat', signature: Buffer.from('bfbafeca', 'hex') },
]
const BUNDLE_ASSET_PATH_REGEX =
  /(?:[A-Za-z]:\/~BUN\/root\/|\/\$?bunfs\/root\/|\/prebuilds\/)[A-Za-z0-9._/@+-]+?\.(?:node|dll|dylib|so(?:\.\d+)*)/gi

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  if (options.inputs.length === 0) {
    printHelp()
    throw new Error('至少需要指定一个 Claude 二进制文件或目录。')
  }

  await mkdir(options.outDir, { recursive: true })

  const inputFiles = await collectInputFiles(options.inputs, options.recursive)
  if (inputFiles.length === 0) {
    throw new Error('没有找到可分析的输入文件。')
  }

  const results = []
  let binaryCount = 0

  for (const inputFile of inputFiles) {
    const analysis = await analyzeFile(inputFile, options)
    if (!analysis) {
      continue
    }
    binaryCount += 1
    results.push(analysis)

    const dependencyCount = analysis.parsedDependencies.length
    const libraryCount = analysis.libraryCandidates.length
    const keywordCount = analysis.keywordHits.length
    const carvedCount = analysis.embeddedBinaries.length
    console.log(
      `[ok] ${analysis.path} -> ${analysis.format} ${analysis.architecture ?? 'unknown'} ` +
        `imports=${dependencyCount} keywords=${keywordCount} libs=${libraryCount} carved=${carvedCount}`,
    )
  }

  const report = {
    generatedAt: new Date().toISOString(),
    options: {
      inputs: options.inputs,
      outDir: options.outDir,
      recursive: options.recursive,
      carveEmbedded: options.carveEmbedded,
      minStringLength: options.minStringLength,
      maxStringMatches: options.maxStringMatches,
      maxStringLength: options.maxStringLength,
      maxEmbedded: options.maxEmbedded,
    },
    summary: buildSummary(results, inputFiles.length, binaryCount),
    files: results,
  }

  await writeFile(options.reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`\n报告已写入: ${options.reportFile}`)
  console.log(`输出目录: ${options.outDir}`)

  if (binaryCount === 0) {
    process.exitCode = 1
  }
}

function parseArgs(argv) {
  const options = {
    inputs: [],
    outDir: DEFAULT_OUTPUT_DIR,
    reportFile: '',
    recursive: true,
    carveEmbedded: true,
    minStringLength: DEFAULT_MIN_STRING_LENGTH,
    maxStringMatches: DEFAULT_MAX_STRING_MATCHES,
    maxStringLength: DEFAULT_MAX_STRING_LENGTH,
    maxEmbedded: DEFAULT_MAX_EMBEDDED,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '-i':
      case '--input':
        options.inputs.push(expectValue(argv, ++index, arg))
        break
      case '-o':
      case '--out-dir':
        options.outDir = resolve(expectValue(argv, ++index, arg))
        break
      case '--report':
        options.reportFile = resolve(expectValue(argv, ++index, arg))
        break
      case '--min-string-length':
        options.minStringLength = parsePositiveInt(
          expectValue(argv, ++index, arg),
          arg,
        )
        break
      case '--max-string-matches':
        options.maxStringMatches = parsePositiveInt(
          expectValue(argv, ++index, arg),
          arg,
        )
        break
      case '--max-string-length':
        options.maxStringLength = parsePositiveInt(
          expectValue(argv, ++index, arg),
          arg,
        )
        break
      case '--max-embedded':
        options.maxEmbedded = parsePositiveInt(expectValue(argv, ++index, arg), arg)
        break
      case '--no-recursive':
        options.recursive = false
        break
      case '--no-carve':
        options.carveEmbedded = false
        break
      default:
        if (arg.startsWith('-')) {
          throw new Error(`未知参数: ${arg}`)
        }
        options.inputs.push(arg)
        break
    }
  }

  if (!options.reportFile) {
    options.reportFile = join(options.outDir, 'report.json')
  }

  return options
}

function printHelp() {
  console.log(`用法:
  node scripts/extract-native-deps-from-claude.mjs <file-or-dir> [...more]

说明:
  - 支持对 Claude 各平台二进制（PE / ELF / Mach-O / Fat Mach-O）做 best-effort 分析
  - 提取导入依赖、扫描 .node/.dll/.dylib/.so 相关字符串
  - 可选 carve 内嵌二进制片段并产出 JSON 报告

常用参数:
  -i, --input <path>          指定输入文件或目录，可重复
  -o, --out-dir <dir>        输出目录，默认: ${DEFAULT_OUTPUT_DIR}
      --report <file>        自定义报告 JSON 路径
      --min-string-length N  最短字符串长度，默认: ${DEFAULT_MIN_STRING_LENGTH}
      --max-string-matches N 每个文件最多记录多少条命中字符串，默认: ${DEFAULT_MAX_STRING_MATCHES}
      --max-string-length N  记录字符串的最大长度，默认: ${DEFAULT_MAX_STRING_LENGTH}
      --max-embedded N       每个文件最多 carve 多少个内嵌二进制，默认: ${DEFAULT_MAX_EMBEDDED}
      --no-recursive         目录模式下不递归
      --no-carve             只做解析和字符串扫描，不 carve 内嵌二进制
  -h, --help                 显示帮助

示例:
  node scripts/extract-native-deps-from-claude.mjs C:/downloads/claude/2.1.89
  node scripts/extract-native-deps-from-claude.mjs ./claude.exe --no-carve
  node scripts/extract-native-deps-from-claude.mjs ./vendor/audio-capture/x64-win32/audio-capture.node --report ./tmp/audio-report.json
`)
}

function expectValue(argv, index, flag) {
  if (index >= argv.length) {
    throw new Error(`${flag} 缺少参数值`)
  }
  return argv[index]
}

function parsePositiveInt(rawValue, flag) {
  const value = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} 需要正整数，收到: ${rawValue}`)
  }
  return value
}

async function collectInputFiles(inputs, recursive) {
  const files = []
  const seen = new Set()

  for (const input of inputs) {
    const resolved = resolve(input)
    await collectPath(resolved, recursive, files, seen)
  }

  return files
}

async function collectPath(targetPath, recursive, files, seen) {
  const fileStat = await stat(targetPath)
  if (fileStat.isDirectory()) {
    const children = await readdir(targetPath, { withFileTypes: true })
    for (const child of children) {
      const childPath = join(targetPath, child.name)
      if (child.isDirectory()) {
        if (recursive) {
          await collectPath(childPath, recursive, files, seen)
        }
        continue
      }
      if (child.isFile()) {
        if (!seen.has(childPath)) {
          seen.add(childPath)
          files.push(childPath)
        }
      }
    }
    return
  }

  if (!seen.has(targetPath)) {
    seen.add(targetPath)
    files.push(targetPath)
  }
}

async function analyzeFile(filePath, options) {
  const buffer = await readFile(filePath)
  const parsed = parseBinary(buffer)
  if (!parsed) {
    return null
  }

  const keywordHits = scanExactKeywordHits(buffer)
  const stringMatches = collectInterestingStrings(
    buffer,
    options.minStringLength,
    options.maxStringMatches,
    options.maxStringLength,
  )
  const libraryCandidates = dedupeStrings([
    ...parsed.dependencies,
    ...extractDependencyNamesFromStrings(stringMatches),
  ]).sort((left, right) => left.localeCompare(right))
  const packageHints = inferPackageHints([
    filePath,
    ...keywordHits,
    ...libraryCandidates,
    ...stringMatches,
  ])
  const outputBaseDir = join(
    options.outDir,
    buildOutputBaseName(filePath),
  )
  let embeddedBinaries = []
  if (options.carveEmbedded) {
    await mkdir(outputBaseDir, { recursive: true })
    embeddedBinaries = await carveEmbeddedBinaries(
      buffer,
      parsed.spanLength,
      outputBaseDir,
      options.maxEmbedded,
      {
        containerArchitecture: parsed.architecture,
        containerPlatform: parsed.platformGuess,
      },
    )
  }
  const embeddedArchitectures = dedupeStrings(
    embeddedBinaries.map(item => item.architecture).filter(Boolean),
  ).sort((left, right) => left.localeCompare(right))

  return {
    path: filePath,
    size: buffer.length,
    format: parsed.format,
    platformGuess: parsed.platformGuess,
    architecture: parsed.architecture,
    metadata: parsed.metadata,
    parsedDependencies: parsed.dependencies,
    libraryCandidates,
    keywordHits,
    stringMatches,
    packageHints,
    embeddedBinaries,
    embeddedArchitectures,
    embeddedHasMixedArchitectures: embeddedArchitectures.length > 1,
  }
}

function parseBinary(buffer) {
  const pe = parsePe(buffer)
  if (pe) {
    return pe
  }

  const elf = parseElf(buffer)
  if (elf) {
    return elf
  }

  const macho = parseMachO(buffer)
  if (macho) {
    return macho
  }

  return null
}

function parsePe(buffer) {
  if (buffer.length < 0x40 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    return null
  }

  const peOffset = readUInt(buffer, 0x3c, 4, true)
  if (
    peOffset === null ||
    peOffset + 24 > buffer.length ||
    buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
  ) {
    return null
  }

  const coffOffset = peOffset + 4
  const machine = readUInt(buffer, coffOffset, 2, true)
  const numberOfSections = readUInt(buffer, coffOffset + 2, 2, true) ?? 0
  const sizeOfOptionalHeader = readUInt(buffer, coffOffset + 16, 2, true) ?? 0
  const optionalOffset = coffOffset + 20
  const optionalMagic = readUInt(buffer, optionalOffset, 2, true)
  const is64Bit = optionalMagic === 0x20b
  if (
    (optionalMagic !== 0x10b && optionalMagic !== 0x20b) ||
    numberOfSections <= 0 ||
    numberOfSections > 96 ||
    sizeOfOptionalHeader <= 0 ||
    optionalOffset + sizeOfOptionalHeader > buffer.length
  ) {
    return null
  }

  const dataDirectoryOffset = optionalOffset + (is64Bit ? 112 : 96)
  const importRva = readUInt(buffer, dataDirectoryOffset + 8, 4, true)
  const delayImportRva = readUInt(buffer, dataDirectoryOffset + 8 * 13, 4, true)
  const certificateTableOffset = readUInt(buffer, dataDirectoryOffset + 8 * 4, 4, true)
  const certificateTableSize = readUInt(
    buffer,
    dataDirectoryOffset + 8 * 4 + 4,
    4,
    true,
  )
  const sectionsOffset = optionalOffset + sizeOfOptionalHeader
  const sections = []
  let validSectionCount = 0
  let spanEnd = sectionsOffset + numberOfSections * 40

  for (let index = 0; index < numberOfSections; index += 1) {
    const entryOffset = sectionsOffset + index * 40
    if (entryOffset + 40 > buffer.length) {
      return null
    }

    const name = buffer
      .toString('ascii', entryOffset, entryOffset + 8)
      .replace(/\0+$/g, '')
    const virtualSize = readUInt(buffer, entryOffset + 8, 4, true) ?? 0
    const virtualAddress = readUInt(buffer, entryOffset + 12, 4, true) ?? 0
    const sizeOfRawData = readUInt(buffer, entryOffset + 16, 4, true) ?? 0
    const pointerToRawData = readUInt(buffer, entryOffset + 20, 4, true) ?? 0
    sections.push({
      name,
      virtualSize,
      virtualAddress,
      sizeOfRawData,
      pointerToRawData,
    })
    if (sizeOfRawData === 0) {
      validSectionCount += 1
      continue
    }
    if (
      pointerToRawData <= 0 ||
      pointerToRawData > buffer.length ||
      pointerToRawData + sizeOfRawData > buffer.length
    ) {
      return null
    }
    validSectionCount += 1
    spanEnd = Math.max(spanEnd, pointerToRawData + sizeOfRawData)
  }

  if (sections.length !== numberOfSections || validSectionCount === 0) {
    return null
  }

  if (
    certificateTableOffset !== null &&
    certificateTableSize !== null &&
    certificateTableOffset > 0 &&
    certificateTableSize > 0 &&
    certificateTableOffset + certificateTableSize <= buffer.length
  ) {
    spanEnd = Math.max(spanEnd, certificateTableOffset + certificateTableSize)
  }

  const imports = []
  collectPeImportNames(buffer, importRva, sections, imports)
  collectPeDelayImportNames(buffer, delayImportRva, sections, imports)

  return {
    format: 'pe',
    platformGuess: 'win32',
    architecture: peMachineToArch(machine),
    dependencies: dedupeStrings(imports.map(normalizeDependencyName).filter(Boolean)),
    spanLength: clampSpan(spanEnd, buffer.length),
    metadata: {
      machine,
      sectionCount: sections.length,
      bits: is64Bit ? 64 : 32,
      exactLength: clampSpan(spanEnd, buffer.length),
      overlayLength: Math.max(0, buffer.length - clampSpan(spanEnd, buffer.length)),
    },
  }
}

function collectPeImportNames(buffer, importRva, sections, imports) {
  if (!importRva) {
    return
  }

  const descriptorOffset = rvaToOffset(importRva, sections)
  if (descriptorOffset === null) {
    return
  }

  const descriptorSize = 20
  for (let index = 0; index < 1024; index += 1) {
    const entryOffset = descriptorOffset + index * descriptorSize
    if (entryOffset + descriptorSize > buffer.length) {
      break
    }

    const originalFirstThunk = readUInt(buffer, entryOffset, 4, true) ?? 0
    const timeDateStamp = readUInt(buffer, entryOffset + 4, 4, true) ?? 0
    const forwarderChain = readUInt(buffer, entryOffset + 8, 4, true) ?? 0
    const nameRva = readUInt(buffer, entryOffset + 12, 4, true) ?? 0
    const firstThunk = readUInt(buffer, entryOffset + 16, 4, true) ?? 0

    if (
      originalFirstThunk === 0 &&
      timeDateStamp === 0 &&
      forwarderChain === 0 &&
      nameRva === 0 &&
      firstThunk === 0
    ) {
      break
    }

    const nameOffset = rvaToOffset(nameRva, sections)
    if (nameOffset === null) {
      continue
    }

    const value = readCString(buffer, nameOffset, buffer.length)
    if (value) {
      imports.push(value)
    }
  }
}

function collectPeDelayImportNames(buffer, delayImportRva, sections, imports) {
  if (!delayImportRva) {
    return
  }

  const descriptorOffset = rvaToOffset(delayImportRva, sections)
  if (descriptorOffset === null) {
    return
  }

  const descriptorSize = 32
  for (let index = 0; index < 256; index += 1) {
    const entryOffset = descriptorOffset + index * descriptorSize
    if (entryOffset + descriptorSize > buffer.length) {
      break
    }

    const nameRva = readUInt(buffer, entryOffset + 4, 4, true) ?? 0
    if (nameRva === 0) {
      const descriptorBytes = buffer.subarray(entryOffset, entryOffset + descriptorSize)
      if (descriptorBytes.every(byte => byte === 0)) {
        break
      }
      continue
    }

    const nameOffset = rvaToOffset(nameRva, sections)
    if (nameOffset === null) {
      continue
    }

    const value = readCString(buffer, nameOffset, buffer.length)
    if (value) {
      imports.push(value)
    }
  }
}

function rvaToOffset(rva, sections) {
  for (const section of sections) {
    const start = section.virtualAddress
    const size = Math.max(section.virtualSize, section.sizeOfRawData)
    const end = start + size
    if (rva >= start && rva < end) {
      return section.pointerToRawData + (rva - start)
    }
  }

  if (rva >= 0) {
    return rva
  }

  return null
}

function parseElf(buffer) {
  if (
    buffer.length < 0x34 ||
    buffer[0] !== 0x7f ||
    buffer[1] !== 0x45 ||
    buffer[2] !== 0x4c ||
    buffer[3] !== 0x46
  ) {
    return null
  }

  const elfClass = buffer[4]
  const dataEncoding = buffer[5]
  const is64Bit = elfClass === 2
  const littleEndian = dataEncoding === 1
  if ((elfClass !== 1 && elfClass !== 2) || (dataEncoding !== 1 && dataEncoding !== 2)) {
    return null
  }

  const machine = readUInt(buffer, 18, 2, littleEndian)
  const programHeaderOffset = readUInt(
    buffer,
    is64Bit ? 32 : 28,
    is64Bit ? 8 : 4,
    littleEndian,
  )
  const programHeaderEntrySize = readUInt(buffer, is64Bit ? 54 : 42, 2, littleEndian)
  const programHeaderCount = readUInt(buffer, is64Bit ? 56 : 44, 2, littleEndian) ?? 0
  const expectedProgramHeaderEntrySize = is64Bit ? 56 : 32
  const sectionHeaderOffset = readUInt(
    buffer,
    is64Bit ? 40 : 32,
    is64Bit ? 8 : 4,
    littleEndian,
  )
  const sectionHeaderEntrySize = readUInt(buffer, is64Bit ? 58 : 46, 2, littleEndian)
  const sectionHeaderCount = readUInt(buffer, is64Bit ? 60 : 48, 2, littleEndian) ?? 0
  const expectedSectionHeaderEntrySize = is64Bit ? 64 : 40

  if (
    programHeaderOffset === null ||
    programHeaderEntrySize === null ||
    machine === null ||
    machine === 0 ||
    programHeaderEntrySize !== expectedProgramHeaderEntrySize ||
    programHeaderCount <= 0 ||
    programHeaderCount > 256 ||
    programHeaderOffset >= buffer.length ||
    programHeaderOffset + programHeaderCount * programHeaderEntrySize > buffer.length
  ) {
    return null
  }

  const programHeaders = []
  let validLoadableHeaderCount = 0
  let spanEnd = programHeaderOffset + programHeaderCount * programHeaderEntrySize
  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programHeaderOffset + index * programHeaderEntrySize
    if (offset + programHeaderEntrySize > buffer.length) {
      return null
    }

    let type
    let fileOffset
    let virtualAddress
    let fileSize
    let memorySize

    if (is64Bit) {
      type = readUInt(buffer, offset, 4, littleEndian) ?? 0
      fileOffset = readUInt(buffer, offset + 8, 8, littleEndian) ?? 0
      virtualAddress = readUInt(buffer, offset + 16, 8, littleEndian) ?? 0
      fileSize = readUInt(buffer, offset + 32, 8, littleEndian) ?? 0
      memorySize = readUInt(buffer, offset + 40, 8, littleEndian) ?? 0
    } else {
      type = readUInt(buffer, offset, 4, littleEndian) ?? 0
      fileOffset = readUInt(buffer, offset + 4, 4, littleEndian) ?? 0
      virtualAddress = readUInt(buffer, offset + 8, 4, littleEndian) ?? 0
      fileSize = readUInt(buffer, offset + 16, 4, littleEndian) ?? 0
      memorySize = readUInt(buffer, offset + 20, 4, littleEndian) ?? 0
    }

    programHeaders.push({
      type,
      offset: fileOffset,
      virtualAddress,
      fileSize,
      memorySize,
    })
    if (
      fileOffset < 0 ||
      fileSize < 0 ||
      fileOffset > buffer.length ||
      fileOffset + fileSize > buffer.length
    ) {
      return null
    }
    if (type === 1 && fileSize > 0) {
      validLoadableHeaderCount += 1
    }
    if (fileSize > 0) {
      spanEnd = Math.max(spanEnd, fileOffset + fileSize)
    }
  }

  if (programHeaders.length !== programHeaderCount || validLoadableHeaderCount === 0) {
    return null
  }

  if (
    sectionHeaderOffset !== null &&
    sectionHeaderEntrySize !== null &&
    sectionHeaderCount > 0 &&
    sectionHeaderCount <= 8192
  ) {
    const hasValidSectionTable =
      sectionHeaderEntrySize === expectedSectionHeaderEntrySize &&
      sectionHeaderOffset < buffer.length &&
      sectionHeaderOffset + sectionHeaderCount * sectionHeaderEntrySize <= buffer.length
    if (hasValidSectionTable) {
      spanEnd = Math.max(
        spanEnd,
        sectionHeaderOffset + sectionHeaderCount * sectionHeaderEntrySize,
      )
      for (let index = 0; index < sectionHeaderCount; index += 1) {
        const offset = sectionHeaderOffset + index * sectionHeaderEntrySize
        const sectionType = readUInt(buffer, offset + 4, 4, littleEndian) ?? 0
        const sectionOffset = readUInt(
          buffer,
          offset + (is64Bit ? 24 : 16),
          is64Bit ? 8 : 4,
          littleEndian,
        ) ?? 0
        const sectionSize = readUInt(
          buffer,
          offset + (is64Bit ? 32 : 20),
          is64Bit ? 8 : 4,
          littleEndian,
        ) ?? 0
        if (sectionSize === 0) {
          continue
        }
        if (sectionType === 8) {
          continue
        }
        if (
          sectionOffset < 0 ||
          sectionOffset > buffer.length ||
          sectionOffset + sectionSize > buffer.length
        ) {
          return null
        }
        spanEnd = Math.max(spanEnd, sectionOffset + sectionSize)
      }
    }
  }

  const dependencies = []
  const dynamicHeader = programHeaders.find(header => header.type === 2)
  if (dynamicHeader) {
    const entrySize = is64Bit ? 16 : 8
    const dynamicEntries = []
    let stringTableVirtualAddress = null
    let stringTableSize = null

    for (
      let offset = dynamicHeader.offset;
      offset + entrySize <= dynamicHeader.offset + dynamicHeader.fileSize;
      offset += entrySize
    ) {
      const tag = readUInt(buffer, offset, is64Bit ? 8 : 4, littleEndian) ?? 0
      const value = readUInt(
        buffer,
        offset + (is64Bit ? 8 : 4),
        is64Bit ? 8 : 4,
        littleEndian,
      ) ?? 0

      if (tag === 0) {
        break
      }

      dynamicEntries.push({ tag, value })
      if (tag === 5) {
        stringTableVirtualAddress = value
      } else if (tag === 10) {
        stringTableSize = value
      }
    }

    if (stringTableVirtualAddress !== null) {
      const stringTableOffset = virtualAddressToOffset(
        stringTableVirtualAddress,
        programHeaders,
      )
      if (stringTableOffset !== null) {
        for (const entry of dynamicEntries) {
          if (entry.tag !== 1) {
            continue
          }
          const start = stringTableOffset + entry.value
          if (start >= buffer.length) {
            continue
          }
          const limit = stringTableSize
            ? Math.min(stringTableOffset + stringTableSize, buffer.length)
            : buffer.length
          const value = readCString(buffer, start, limit)
          if (value) {
            dependencies.push(value)
          }
        }
      }
    }
  }

  return {
    format: 'elf',
    platformGuess: 'linux',
    architecture: elfMachineToArch(machine),
    dependencies: dedupeStrings(
      dependencies.map(normalizeDependencyName).filter(Boolean),
    ),
    spanLength: clampSpan(spanEnd, buffer.length),
    metadata: {
      machine,
      programHeaderCount: programHeaders.length,
      bits: is64Bit ? 64 : 32,
      littleEndian,
      exactLength: clampSpan(spanEnd, buffer.length),
      overlayLength: Math.max(0, buffer.length - clampSpan(spanEnd, buffer.length)),
    },
  }
}

function virtualAddressToOffset(virtualAddress, programHeaders) {
  for (const header of programHeaders) {
    if (header.type !== 1) {
      continue
    }

    const start = header.virtualAddress
    const end = start + Math.max(header.memorySize, header.fileSize)
    if (virtualAddress >= start && virtualAddress < end) {
      return header.offset + (virtualAddress - start)
    }
  }

  return null
}

function parseMachO(buffer) {
  const magicHex = buffer.toString('hex', 0, 4)
  switch (magicHex) {
    case 'feedface':
      return parseThinMachO(buffer, { littleEndian: false, bits: 32 })
    case 'cefaedfe':
      return parseThinMachO(buffer, { littleEndian: true, bits: 32 })
    case 'feedfacf':
      return parseThinMachO(buffer, { littleEndian: false, bits: 64 })
    case 'cffaedfe':
      return parseThinMachO(buffer, { littleEndian: true, bits: 64 })
    case 'cafebabe':
      return parseFatMachO(buffer, { littleEndian: false, arch64: false })
    case 'cafebabf':
      return parseFatMachO(buffer, { littleEndian: false, arch64: true })
    case 'bebafeca':
      return parseFatMachO(buffer, { littleEndian: true, arch64: false })
    case 'bfbafeca':
      return parseFatMachO(buffer, { littleEndian: true, arch64: true })
    default:
      return null
  }
}

function parseThinMachO(buffer, descriptor) {
  const headerSize = descriptor.bits === 64 ? 32 : 28
  if (buffer.length < headerSize) {
    return null
  }

  const cpuType = readUInt(buffer, 4, 4, descriptor.littleEndian)
  const ncmds = readUInt(buffer, 16, 4, descriptor.littleEndian) ?? 0
  const sizeofcmds = readUInt(buffer, 20, 4, descriptor.littleEndian) ?? 0
  if (
    ncmds <= 0 ||
    ncmds > 1024 ||
    sizeofcmds <= 0 ||
    headerSize + sizeofcmds > buffer.length
  ) {
    return null
  }
  let offset = headerSize
  let spanEnd = headerSize + sizeofcmds
  const dependencies = []
  let validSegmentCount = 0

  for (let index = 0; index < ncmds; index += 1) {
    if (offset + 8 > buffer.length) {
      break
    }

    const command = readUInt(buffer, offset, 4, descriptor.littleEndian)
    const commandSize = readUInt(buffer, offset + 4, 4, descriptor.littleEndian)
    if (
      command === null ||
      commandSize === null ||
      commandSize < 8 ||
      offset + commandSize > buffer.length
    ) {
      break
    }

    const normalizedCommand = command & 0x7fffffff
    if (MACHO_LOAD_COMMANDS.has(normalizedCommand)) {
      const nameOffset = readUInt(buffer, offset + 8, 4, descriptor.littleEndian)
      if (nameOffset !== null && nameOffset < commandSize) {
        const value = readCString(buffer, offset + nameOffset, offset + commandSize)
        if (value) {
          dependencies.push(value)
        }
      }
    }

    if (
      (normalizedCommand === 0x01 && descriptor.bits === 32) ||
      (normalizedCommand === 0x19 && descriptor.bits === 64)
    ) {
      const segmentSpanEnd = parseMachOSegmentCommand(
        buffer,
        offset,
        commandSize,
        descriptor,
      )
      if (segmentSpanEnd === null) {
        return null
      }
      validSegmentCount += 1
      spanEnd = Math.max(spanEnd, segmentSpanEnd)
    } else if (normalizedCommand === 0x02) {
      const symoff = readUInt(buffer, offset + 8, 4, descriptor.littleEndian) ?? 0
      const nsyms = readUInt(buffer, offset + 12, 4, descriptor.littleEndian) ?? 0
      const stroff = readUInt(buffer, offset + 16, 4, descriptor.littleEndian) ?? 0
      const strsize = readUInt(buffer, offset + 20, 4, descriptor.littleEndian) ?? 0
      const symbolEntrySize = descriptor.bits === 64 ? 16 : 12
      const validatedSymEnd = validatedSpanEnd(
        buffer,
        symoff,
        nsyms * symbolEntrySize,
      )
      const validatedStrEnd = validatedSpanEnd(buffer, stroff, strsize)
      if (validatedSymEnd === null || validatedStrEnd === null) {
        return null
      }
      spanEnd = Math.max(spanEnd, validatedSymEnd, validatedStrEnd)
    } else if (normalizedCommand === 0x0b) {
      const dysymtabSpanEnd = parseMachODysymtabSpanEnd(
        buffer,
        offset,
        descriptor,
      )
      if (dysymtabSpanEnd === null) {
        return null
      }
      spanEnd = Math.max(spanEnd, dysymtabSpanEnd)
    } else if (MACHO_DYLD_INFO_COMMANDS.has(normalizedCommand)) {
      const dyldInfoSpanEnd = parseMachODyldInfoSpanEnd(
        buffer,
        offset,
        descriptor.littleEndian,
      )
      if (dyldInfoSpanEnd === null) {
        return null
      }
      spanEnd = Math.max(spanEnd, dyldInfoSpanEnd)
    } else if (MACHO_LINKEDIT_DATA_COMMANDS.has(normalizedCommand)) {
      const dataoff = readUInt(buffer, offset + 8, 4, descriptor.littleEndian) ?? 0
      const datasize = readUInt(buffer, offset + 12, 4, descriptor.littleEndian) ?? 0
      const linkeditSpanEnd = validatedSpanEnd(buffer, dataoff, datasize)
      if (linkeditSpanEnd === null) {
        return null
      }
      spanEnd = Math.max(spanEnd, linkeditSpanEnd)
    }

    offset += commandSize
  }

  if (validSegmentCount === 0) {
    return null
  }

  return {
    format: 'mach-o',
    platformGuess: 'darwin',
    architecture: machoCpuTypeToArch(cpuType),
    dependencies: dedupeStrings(
      dependencies.map(normalizeDependencyName).filter(Boolean),
    ),
    spanLength: clampSpan(spanEnd, buffer.length),
    metadata: {
      bits: descriptor.bits,
      littleEndian: descriptor.littleEndian,
      commandCount: ncmds,
      cpuType,
      exactLength: clampSpan(spanEnd, buffer.length),
      overlayLength: Math.max(0, buffer.length - clampSpan(spanEnd, buffer.length)),
    },
  }
}

function parseFatMachO(buffer, descriptor) {
  if (buffer.length < 8) {
    return null
  }

  const archCount = readUInt(buffer, 4, 4, descriptor.littleEndian) ?? 0
  if (archCount <= 0 || archCount > 32) {
    return null
  }
  const entrySize = descriptor.arch64 ? 32 : 20
  const slices = []
  let spanEnd = 8 + archCount * entrySize
  const dependencies = []
  let architecture = null

  for (let index = 0; index < archCount; index += 1) {
    const entryOffset = 8 + index * entrySize
    if (entryOffset + entrySize > buffer.length) {
      break
    }

    const cpuType = readUInt(buffer, entryOffset, 4, descriptor.littleEndian)
    const sliceOffset = readUInt(
      buffer,
      entryOffset + 8,
      descriptor.arch64 ? 8 : 4,
      descriptor.littleEndian,
    )
    const sliceSize = readUInt(
      buffer,
      entryOffset + (descriptor.arch64 ? 16 : 12),
      descriptor.arch64 ? 8 : 4,
      descriptor.littleEndian,
    )

    if (
      sliceOffset === null ||
      sliceSize === null ||
      sliceSize <= 0 ||
      sliceOffset < 8 + archCount * entrySize ||
      sliceOffset + sliceSize > buffer.length
    ) {
      continue
    }

    const slice = parseMachO(buffer.subarray(sliceOffset, sliceOffset + sliceSize))
    const sliceArchitecture = machoCpuTypeToArch(cpuType)
    slices.push({
      architecture: sliceArchitecture,
      offset: sliceOffset,
      size: sliceSize,
      dependencies: slice?.dependencies ?? [],
    })

    if (!architecture) {
      architecture = sliceArchitecture
    } else if (sliceArchitecture && architecture !== sliceArchitecture) {
      architecture = 'universal'
    }

    dependencies.push(...(slice?.dependencies ?? []))
    spanEnd = Math.max(spanEnd, sliceOffset + sliceSize)
  }

  return {
    format: 'mach-o-fat',
    platformGuess: 'darwin',
    architecture,
    dependencies: dedupeStrings(
      dependencies.map(normalizeDependencyName).filter(Boolean),
    ),
    spanLength: clampSpan(spanEnd, buffer.length),
    metadata: {
      archCount: slices.length,
      slices,
      fat64: descriptor.arch64,
      littleEndian: descriptor.littleEndian,
      exactLength: clampSpan(spanEnd, buffer.length),
      overlayLength: Math.max(0, buffer.length - clampSpan(spanEnd, buffer.length)),
    },
  }
}

function parseMachOSegmentCommand(buffer, commandOffset, commandSize, descriptor) {
  const is64Bit = descriptor.bits === 64
  const segmentHeaderSize = is64Bit ? 72 : 56
  const sectionEntrySize = is64Bit ? 80 : 68
  if (commandSize < segmentHeaderSize) {
    return null
  }

  const fileOffset = readUInt(
    buffer,
    commandOffset + (is64Bit ? 40 : 32),
    is64Bit ? 8 : 4,
    descriptor.littleEndian,
  ) ?? 0
  const fileSize = readUInt(
    buffer,
    commandOffset + (is64Bit ? 48 : 36),
    is64Bit ? 8 : 4,
    descriptor.littleEndian,
  ) ?? 0
  const sectionCount = readUInt(
    buffer,
    commandOffset + (is64Bit ? 64 : 48),
    4,
    descriptor.littleEndian,
  ) ?? 0

  let spanEnd = headerOnlySpanEnd(buffer, fileOffset, fileSize)
  if (spanEnd === null) {
    return null
  }

  const sectionTableOffset = commandOffset + segmentHeaderSize
  if (
    sectionCount < 0 ||
    sectionCount > 4096 ||
    sectionTableOffset + sectionCount * sectionEntrySize > commandOffset + commandSize
  ) {
    return null
  }

  for (let index = 0; index < sectionCount; index += 1) {
    const sectionOffset = sectionTableOffset + index * sectionEntrySize
    const sectionType = (readUInt(
      buffer,
      sectionOffset + (is64Bit ? 64 : 56),
      4,
      descriptor.littleEndian,
    ) ?? 0) & 0xff
    const sectionFileOffset = readUInt(
      buffer,
      sectionOffset + (is64Bit ? 48 : 40),
      4,
      descriptor.littleEndian,
    ) ?? 0
    const sectionFileSize = readUInt(
      buffer,
      sectionOffset + (is64Bit ? 40 : 36),
      is64Bit ? 8 : 4,
      descriptor.littleEndian,
    ) ?? 0
    const relocationOffset = readUInt(
      buffer,
      sectionOffset + (is64Bit ? 56 : 48),
      4,
      descriptor.littleEndian,
    ) ?? 0
    const relocationCount = readUInt(
      buffer,
      sectionOffset + (is64Bit ? 60 : 52),
      4,
      descriptor.littleEndian,
    ) ?? 0

    if (sectionFileSize > 0 && machOSectionHasFileData(sectionType)) {
      const sectionSpanEnd = validatedSpanEnd(buffer, sectionFileOffset, sectionFileSize)
      if (sectionSpanEnd === null) {
        return null
      }
      spanEnd = Math.max(spanEnd, sectionSpanEnd)
    }

    if (relocationCount > 0) {
      const relocationSpanEnd = validatedSpanEnd(
        buffer,
        relocationOffset,
        relocationCount * 8,
      )
      if (relocationSpanEnd === null) {
        return null
      }
      spanEnd = Math.max(spanEnd, relocationSpanEnd)
    }
  }

  return spanEnd
}

function parseMachODyldInfoSpanEnd(buffer, commandOffset, littleEndian) {
  let spanEnd = 0
  const fields = [8, 16, 24, 32, 40]
  for (const fieldOffset of fields) {
    const dataoff = readUInt(buffer, commandOffset + fieldOffset, 4, littleEndian) ?? 0
    const datasize = readUInt(buffer, commandOffset + fieldOffset + 4, 4, littleEndian) ?? 0
    const candidateSpanEnd = validatedSpanEnd(buffer, dataoff, datasize)
    if (candidateSpanEnd === null) {
      return null
    }
    spanEnd = Math.max(spanEnd, candidateSpanEnd)
  }
  return spanEnd
}

function parseMachODysymtabSpanEnd(buffer, commandOffset, descriptor) {
  const littleEndian = descriptor.littleEndian
  const moduleEntrySize = descriptor.bits === 64 ? 56 : 52
  const tables = [
    { offsetField: 32, countField: 36, entrySize: 8 }, // TOC
    { offsetField: 40, countField: 44, entrySize: moduleEntrySize }, // module table
    { offsetField: 48, countField: 52, entrySize: 4 }, // ext refs
    { offsetField: 56, countField: 60, entrySize: 4 }, // indirect symbol table
    { offsetField: 64, countField: 68, entrySize: 8 }, // external relocations
    { offsetField: 72, countField: 76, entrySize: 8 }, // local relocations
  ]

  let spanEnd = 0
  for (const table of tables) {
    const offsetValue = readUInt(
      buffer,
      commandOffset + table.offsetField,
      4,
      littleEndian,
    ) ?? 0
    const countValue = readUInt(
      buffer,
      commandOffset + table.countField,
      4,
      littleEndian,
    ) ?? 0
    const candidateSpanEnd = validatedSpanEnd(
      buffer,
      offsetValue,
      countValue * table.entrySize,
    )
    if (candidateSpanEnd === null) {
      return null
    }
    spanEnd = Math.max(spanEnd, candidateSpanEnd)
  }

  return spanEnd
}

function machOSectionHasFileData(sectionType) {
  return !MACHO_ZERO_FILL_SECTION_TYPES.has(sectionType)
}

function headerOnlySpanEnd(buffer, offset, size) {
  if (size <= 0) {
    return 0
  }
  return validatedSpanEnd(buffer, offset, size)
}

function collectInterestingStrings(buffer, minLength, maxMatches, maxStringLength) {
  const matches = []
  const seen = new Set()
  let start = -1

  for (let index = 0; index <= buffer.length; index += 1) {
    const byte = index < buffer.length ? buffer[index] : 0
    const printable =
      byte >= 0x20 && byte <= 0x7e && byte !== 0x7f && byte !== 0xff && byte !== 0xfe

    if (printable) {
      if (start === -1) {
        start = index
      }
      continue
    }

    if (start !== -1 && index - start >= minLength) {
      const value = buffer.toString('utf8', start, index).trim()
      const libraryTokens = extractLibraryTokens(value)
      if (
        value &&
        value.length <= maxStringLength &&
        libraryTokens.length > 0 &&
        !seen.has(value)
      ) {
        seen.add(value)
        matches.push(value.slice(0, 400))
        if (matches.length >= maxMatches) {
          break
        }
      }
    }

    start = -1
  }

  return matches
}

function extractDependencyNamesFromStrings(strings) {
  const matches = []
  for (const value of strings) {
    for (const token of extractLibraryTokens(value)) {
      const normalized = normalizeDependencyName(token)
      if (normalized) {
        matches.push(normalized)
      }
    }
  }
  return matches
}

async function carveEmbeddedBinaries(
  buffer,
  rootSpanLength,
  outputDir,
  maxEmbedded,
  containerInfo = {},
) {
  const allCandidates = collectAllEmbeddedCandidates(buffer)
  const rootOccupiedSpanLength = deriveRootOccupiedSpanLength(
    rootSpanLength,
    buffer.length,
    allCandidates,
  )
  const selectedCandidates = selectEmbeddedCandidates(
    allCandidates,
    rootOccupiedSpanLength,
    maxEmbedded,
  )
  const preparedCandidates = prepareEmbeddedCandidates(
    buffer,
    selectedCandidates.map(candidate => refineEmbeddedCandidate(buffer, candidate)),
  )
  const darwinArchitectureSet = new Set(
    preparedCandidates
      .filter(candidate => candidate.platformGuess === 'darwin')
      .map(candidate => candidate.architecture)
      .filter(Boolean),
  )
  const shouldAppendDarwinArchitecture = darwinArchitectureSet.size > 1

  const outputs = []
  for (let index = 0; index < preparedCandidates.length; index += 1) {
    const candidate = preparedCandidates[index]
    const decoratedHint = buildDecoratedAssetHint(
      candidate.assetHint,
      candidate.architecture,
      candidate.platformGuess,
      shouldAppendDarwinArchitecture,
    )
    const fileName = decoratedHint
      ? `${String(index + 1).padStart(2, '0')}-${sanitizeFileName(decoratedHint)}`
      : `${String(index + 1).padStart(2, '0')}-offset-0x${candidate.offset.toString(16)}${formatToExtension(candidate.format)}`
    const outputPath = join(outputDir, fileName)
    await writeFile(outputPath, buffer.subarray(candidate.offset, candidate.offset + candidate.length))
    outputs.push({
      ...candidate,
      assetHint: candidate.assetHint,
      decoratedAssetHint: decoratedHint,
      outputPath,
      containerArchitecture: containerInfo.containerArchitecture ?? null,
      containerPlatform: containerInfo.containerPlatform ?? null,
      matchesContainerArchitecture:
        containerInfo.containerArchitecture && candidate.architecture
          ? containerInfo.containerArchitecture === candidate.architecture
          : null,
    })
  }

  return outputs
}

function deriveRootOccupiedSpanLength(rootSpanLength, bufferLength, allCandidates) {
  if (
    rootSpanLength >= bufferLength * 0.9 &&
    Array.isArray(allCandidates) &&
    allCandidates.length > 0 &&
    allCandidates[0].offset > 0
  ) {
    return allCandidates[0].offset
  }
  return rootSpanLength
}

function collectAllEmbeddedCandidates(buffer) {
  const candidatesByOffset = new Map()

  for (const descriptor of EMBEDDED_SIGNATURES) {
    let offset = 0
    while (offset < buffer.length) {
      const foundOffset = buffer.indexOf(descriptor.signature, offset)
      if (foundOffset === -1) {
        break
      }

      offset = foundOffset + 1
      if (foundOffset === 0) {
        continue
      }

      const parsed = parseBinary(buffer.subarray(foundOffset))
      if (!parsed) {
        continue
      }

      const spanLength = clampSpan(parsed.spanLength, buffer.length - foundOffset)
      if (spanLength < MIN_EMBEDDED_BINARY_SIZE) {
        continue
      }

      const candidate = {
        offset: foundOffset,
        length: spanLength,
        format: parsed.format,
        platformGuess: parsed.platformGuess,
        architecture: parsed.architecture,
        metadata: {
          ...(parsed.metadata ?? {}),
          exactLength: spanLength,
          overlayLength: Math.max(0, buffer.length - foundOffset - spanLength),
        },
      }
      const existing = candidatesByOffset.get(foundOffset)
      if (!existing || shouldPreferEmbeddedCandidate(candidate, existing)) {
        candidatesByOffset.set(foundOffset, candidate)
      }
    }
  }

  return [...candidatesByOffset.values()].sort((left, right) => {
    if (left.offset !== right.offset) {
      return left.offset - right.offset
    }
    return right.length - left.length
  })
}

function shouldPreferEmbeddedCandidate(candidate, existing) {
  if (candidate.length !== existing.length) {
    return candidate.length > existing.length
  }
  return embeddedFormatPriority(candidate.format) > embeddedFormatPriority(existing.format)
}

function embeddedFormatPriority(format) {
  switch (format) {
    case 'mach-o-fat':
      return 4
    case 'mach-o':
      return 3
    case 'pe':
      return 2
    case 'elf':
      return 1
    default:
      return 0
  }
}

function selectEmbeddedCandidates(allCandidates, rootSpanLength, maxEmbedded) {
  const selected = []
  const occupiedRanges = [{ start: 0, end: clampSpan(rootSpanLength, Number.MAX_SAFE_INTEGER) }]

  for (const candidate of allCandidates) {
    if (selected.length >= maxEmbedded) {
      break
    }
    if (isInsideRanges(candidate.offset, occupiedRanges)) {
      continue
    }
    const range = {
      start: candidate.offset,
      end: candidate.offset + candidate.length,
    }
    if (rangesOverlap(range, occupiedRanges)) {
      continue
    }
    occupiedRanges.push(range)
    selected.push(candidate)
  }

  return selected
}

function refineEmbeddedCandidate(buffer, candidate) {
  return {
    ...candidate,
    length: clampSpan(candidate.length, buffer.length - candidate.offset),
  }
}

function prepareEmbeddedCandidates(buffer, candidates) {
  const prepared = []

  for (const candidate of candidates) {
    const baseHint = inferEmbeddedBinaryHint(
      buffer,
      candidate.offset,
      candidate.offset + candidate.length,
    )

    if (candidate.format === 'mach-o-fat') {
      const slices = expandFatMachOCandidate(buffer, candidate, baseHint)
      if (slices.length > 0) {
        prepared.push(...slices)
        continue
      }
    }

    prepared.push({
      ...candidate,
      assetHint: baseHint,
    })
  }

  prepared.sort((left, right) => left.offset - right.offset)
  return prepared
}

function expandFatMachOCandidate(buffer, candidate, fallbackHint) {
  const slices = candidate.metadata?.slices
  if (!Array.isArray(slices) || slices.length === 0) {
    return []
  }

  const expanded = []
  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index]
    const sliceOffset = candidate.offset + slice.offset
    const sliceLength = slice.size
    if (
      slice.offset < 0 ||
      sliceLength < MIN_EMBEDDED_BINARY_SIZE ||
      sliceOffset < candidate.offset ||
      sliceOffset + sliceLength > candidate.offset + candidate.length
    ) {
      continue
    }

    const sliceHint =
      fallbackHint ??
      inferEmbeddedBinaryHint(buffer, sliceOffset, sliceOffset + sliceLength)

    expanded.push({
      offset: sliceOffset,
      length: sliceLength,
      format: 'mach-o',
      sourceFormat: candidate.format,
      platformGuess: 'darwin',
      architecture: slice.architecture ?? null,
      metadata: {
        sliceIndex: index,
        parentOffset: candidate.offset,
        parentLength: candidate.length,
      },
      assetHint: sliceHint,
    })
  }

  return expanded
}

function buildDecoratedAssetHint(
  assetHint,
  architecture,
  platformGuess,
  shouldAppendDarwinArchitecture,
) {
  if (!assetHint) {
    return null
  }
  if (
    platformGuess === 'darwin' &&
    shouldAppendDarwinArchitecture &&
    architecture
  ) {
    return appendArchitectureToAssetName(assetHint, architecture)
  }
  return assetHint
}

function appendArchitectureToAssetName(assetHint, architecture) {
  const extension = extname(assetHint)
  const normalizedArchitecture = sanitizeFileName(architecture)
  if (!extension) {
    return `${assetHint}.${normalizedArchitecture}`
  }
  return `${assetHint.slice(0, -extension.length)}.${normalizedArchitecture}${extension}`
}

function isInsideRanges(offset, ranges) {
  return ranges.some(range => offset >= range.start && offset < range.end)
}

function rangesOverlap(target, ranges) {
  return ranges.some(
    range => !(target.end <= range.start || target.start >= range.end),
  )
}

function formatToExtension(format) {
  switch (format) {
    case 'pe':
      return '.pe.bin'
    case 'elf':
      return '.elf.bin'
    case 'mach-o':
      return '.macho.bin'
    case 'mach-o-fat':
      return '.fat-macho.bin'
    default:
      return '.bin'
  }
}

function inferEmbeddedBinaryHint(buffer, start, end) {
  const bundleAssetPath = findNearestBundleAssetPath(buffer, start, end)
  if (bundleAssetPath) {
    return normalizeEmbeddedBinaryAssetHint(bundleAssetPath)
  }

  const slice = buffer.toString('latin1', start, end)
  for (const assetName of KNOWN_EMBEDDED_ASSET_NAMES) {
    if (slice.includes(assetName)) {
      return normalizeEmbeddedBinaryAssetHint(assetName)
    }
  }

  const sliceHeuristicHint = inferEmbeddedBinaryHintFromText(slice)
  if (sliceHeuristicHint) {
    return normalizeEmbeddedBinaryAssetHint(sliceHeuristicHint)
  }

  const contextStart = Math.max(0, start - 0x20000)
  const contextEnd = Math.min(buffer.length, end + 0x20000)
  const context = buffer.toString('latin1', contextStart, contextEnd)

  for (const assetName of KNOWN_EMBEDDED_ASSET_NAMES) {
    if (context.includes(assetName)) {
      return normalizeEmbeddedBinaryAssetHint(assetName)
    }
  }

  const contextHeuristicHint = inferEmbeddedBinaryHintFromText(context)
  if (contextHeuristicHint) {
    return normalizeEmbeddedBinaryAssetHint(contextHeuristicHint)
  }

  return null
}

function findNearestBundleAssetPath(buffer, start, end) {
  const contextStart = Math.max(0, start - 0x40000)
  const contextEnd = Math.min(buffer.length, end + 0x40000)
  const context = buffer.toString('latin1', contextStart, contextEnd)
  const matches = [...context.matchAll(BUNDLE_ASSET_PATH_REGEX)]
  if (matches.length === 0) {
    return null
  }

  let bestMatch = null
  for (const match of matches) {
    if (match.index === undefined) {
      continue
    }

    const rawPath = match[0]
    const globalStart = contextStart + match.index
    const globalEnd = globalStart + rawPath.length
    const isBefore = globalEnd <= start
    const distance = isBefore
      ? start - globalEnd
      : globalStart >= end
        ? 0x1000000 + (globalStart - end)
        : 0x2000000

    if (
      !bestMatch ||
      distance < bestMatch.distance ||
      (distance === bestMatch.distance && globalEnd > bestMatch.globalEnd)
    ) {
      bestMatch = {
        distance,
        globalEnd,
        rawPath,
      }
    }
  }

  if (!bestMatch) {
    return null
  }

  const normalizedPath = bestMatch.rawPath.replace(/\\/g, '/')
  const assetName = normalizedPath.split('/').pop() ?? normalizedPath
  return assetName || null
}

function normalizeEmbeddedBinaryAssetHint(assetHint) {
  switch (assetHint) {
    case 'input.node':
    case 'libcomputer_use_input.dylib':
      return 'computer-use-input.node'
    case 'libComputerUseSwift.dylib':
    case 'computer-use-swift.node':
      return 'computer_use.node'
    default:
      return assetHint
  }
}

function buildOutputBaseName(filePath) {
  const fileName = basename(filePath, extname(filePath)) || 'binary'
  const parentName = basename(dirname(filePath)) || 'root'
  if (parentName === fileName) {
    return sanitizeFileName(fileName)
  }
  return sanitizeFileName(`${parentName}-${fileName}`)
}

function inferEmbeddedBinaryHintFromText(text) {
  const normalized = text.toLowerCase()
  const scores = new Map()

  scoreAssetHint(scores, 'image-processor.node', normalized, [
    ['imageprocessor', 6],
    ['processimage', 6],
    ['image_processor.dll', 8],
    ['read_clipboard_image', 8],
    ['has_clipboard_image', 8],
    ['failed to decode image', 6],
    ['failed to encode png', 6],
    ['failed to encode jpeg', 6],
    ['cargo\\image-', 4],
    ['cargo\\png-', 4],
    ['cargo\\jpeg', 4],
    ['cargo\\image-webp', 4],
    ['png', 1],
    ['jpeg', 1],
    ['webp', 1],
    ['gif', 1],
    ['bmp', 1],
    ['avif', 1],
  ])

  scoreAssetHint(scores, 'audio-capture.node', normalized, [
    ['audio capture error', 8],
    ['audio playback error', 7],
    ['audio_capture_napi.dll', 8],
    ['audiounit.framework', 8],
    ['coreaudio.framework', 8],
    ['microphoneauthorizationstatus', 8],
    ['microphone', 4],
    ['libasound.so.2', 8],
    ['alsa_', 7],
    ['failed to build capture client', 7],
    ['failed to build audio clock', 7],
    ['cpal', 4],
    ['wasapi', 4],
    ['snd_', 4],
    ['audio', 1],
    ['capture', 1],
  ])

  scoreAssetHint(scores, 'computer-use-input.node', normalized, [
    ['computer_use_input', 8],
    ['libcomputer_use_input.dylib', 10],
    ['movemouse', 8],
    ['mousescroll', 8],
    ['mouselocation', 8],
    ['cgeventcreatemouseevent', 8],
    ['cgwarp', 4],
    ['mouse button', 4],
    ['keyboard', 3],
    ['input.node', 2],
  ])

  scoreAssetHint(scores, 'computer_use.node', normalized, [
    ['libcomputeruseswift.dylib', 10],
    ['computer-use-swift', 6],
    ['computeruseswift', 6],
    ['screencapturekit', 10],
    ['capturescreenregion', 10],
    ['capturescreenwithexclusion', 10],
    ['screen capture', 6],
    ['display stream', 6],
    ['scstream', 6],
  ])

  scoreAssetHint(scores, 'url-handler.node', normalized, [
    ['url-handler.node', 10],
    ['url_handler', 6],
    ['openurl', 4],
  ])

  scoreAssetHint(scores, 'modifiers.node', normalized, [
    ['modifiers-napi', 8],
    ['ismodifierpressed', 8],
    ['getmodifiers', 8],
  ])

  let bestAsset = null
  let bestScore = 0
  for (const [asset, score] of scores.entries()) {
    if (score > bestScore) {
      bestAsset = asset
      bestScore = score
    }
  }

  if (bestScore < 4) {
    return null
  }
  return bestAsset
}

function scoreAssetHint(scores, assetName, text, patterns) {
  let score = 0
  for (const [pattern, weight] of patterns) {
    if (text.includes(pattern)) {
      score += weight
    }
  }
  if (score > 0) {
    scores.set(assetName, (scores.get(assetName) ?? 0) + score)
  }
}

function scanExactKeywordHits(buffer) {
  const hits = []
  for (const keyword of EXACT_KEYWORDS) {
    if (buffer.indexOf(Buffer.from(keyword, 'utf8')) !== -1) {
      hits.push(keyword)
    }
  }
  return hits.sort((left, right) => left.localeCompare(right))
}

function extractLibraryTokens(value) {
  const matches = value.match(LIBRARY_TOKEN_REGEX)
  if (!matches) {
    return []
  }
  return dedupeStrings(
    matches
      .map(match => normalizeDependencyName(match))
      .filter(token => token && isLikelyLibraryToken(token)),
  )
}

function inferPackageHints(values) {
  const hints = new Set()
  for (const value of values) {
    const normalized = value.toLowerCase()
    if (normalized.includes('modifiers-napi') || normalized.includes('modifiers.node')) {
      hints.add('modifiers-napi')
    }
    if (normalized.includes('audio-capture-napi') || normalized.includes('audio-capture.node')) {
      hints.add('audio-capture-napi')
    }
    if (
      normalized.includes('image-processor-napi') ||
      normalized.includes('image-processor.node')
    ) {
      hints.add('image-processor-napi')
    }
    if (normalized.includes('url-handler-napi') || normalized.includes('url-handler.node')) {
      hints.add('url-handler-napi')
    }
    if (
      normalized.includes('@ant/computer-use-input') ||
      normalized.includes('input.node')
    ) {
      hints.add('@ant/computer-use-input')
    }
    if (
      normalized.includes('@ant/computer-use-swift') ||
      normalized.includes('computer_use.node')
    ) {
      hints.add('@ant/computer-use-swift')
    }
    if (normalized.includes('@ant/computer-use-mcp')) {
      hints.add('@ant/computer-use-mcp')
    }
    if (normalized.includes('@ant/claude-for-chrome-mcp')) {
      hints.add('@ant/claude-for-chrome-mcp')
    }
  }
  return [...hints].sort((left, right) => left.localeCompare(right))
}

function buildSummary(results, totalInputFiles, binaryCount) {
  const parsedDependencySet = new Set()
  const libraryCandidateSet = new Set()
  const keywordHitSet = new Set()
  const packageHintSet = new Set()
  const embeddedArchitectureSet = new Set()
  let embeddedCount = 0

  for (const result of results) {
    for (const dependency of result.parsedDependencies) {
      parsedDependencySet.add(dependency)
    }
    for (const candidate of result.libraryCandidates) {
      libraryCandidateSet.add(candidate)
    }
    for (const keywordHit of result.keywordHits) {
      keywordHitSet.add(keywordHit)
    }
    for (const packageHint of result.packageHints) {
      packageHintSet.add(packageHint)
    }
    for (const architecture of result.embeddedArchitectures ?? []) {
      embeddedArchitectureSet.add(architecture)
    }
    embeddedCount += result.embeddedBinaries.length
  }

  return {
    totalInputFiles,
    binaryCount,
    parsedDependencyCount: parsedDependencySet.size,
    libraryCandidateCount: libraryCandidateSet.size,
    keywordHitCount: keywordHitSet.size,
    embeddedBinaryCount: embeddedCount,
    parsedDependencies: [...parsedDependencySet].sort((left, right) => left.localeCompare(right)),
    libraryCandidates: [...libraryCandidateSet].sort((left, right) => left.localeCompare(right)),
    keywordHits: [...keywordHitSet].sort((left, right) => left.localeCompare(right)),
    packageHints: [...packageHintSet].sort((left, right) => left.localeCompare(right)),
    embeddedArchitectures: [...embeddedArchitectureSet].sort((left, right) =>
      left.localeCompare(right),
    ),
  }
}

function sanitizeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

function dedupeStrings(values) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    result.push(value)
  }
  return result
}

function normalizeDependencyName(value) {
  return value
    .trim()
    .replace(/^[^a-zA-Z0-9@/]+/, '')
    .replace(/[^a-zA-Z0-9._/@+-]+$/g, '')
}

function isLikelyLibraryToken(token) {
  const normalized = token.toLowerCase()
  if (/[%*?{}|]/.test(normalized) || /\\[dDsSwW.]/.test(normalized)) {
    return false
  }

  if (normalized.includes('/') || normalized.includes('\\')) {
    return true
  }

  const baseName = normalized.split(/[\\/]/).pop() ?? normalized
  if (EXACT_KEYWORDS.includes(baseName)) {
    return true
  }

  if (baseName.endsWith('.node')) {
    return baseName.includes('-') || baseName.includes('_')
  }

  if (baseName.endsWith('.so')) {
    return false
  }

  if (baseName.startsWith('lib')) {
    return true
  }

  if (/[0-9]/.test(baseName)) {
    return true
  }

  if (baseName.includes('-') || baseName.includes('_')) {
    return true
  }

  return false
}

function readCString(buffer, start, limit = buffer.length) {
  if (start < 0 || start >= buffer.length) {
    return ''
  }

  let end = start
  while (end < limit && end < buffer.length && buffer[end] !== 0) {
    end += 1
  }
  if (end <= start) {
    return ''
  }

  return buffer.toString('utf8', start, end)
}

function clampSpan(spanLength, maxLength) {
  if (!Number.isFinite(spanLength) || spanLength <= 0) {
    return 0
  }
  return Math.min(spanLength, maxLength)
}

function validatedSpanEnd(buffer, offset, size) {
  if (!Number.isFinite(offset) || !Number.isFinite(size) || offset < 0 || size < 0) {
    return null
  }
  if (size === 0) {
    return 0
  }
  if (offset > buffer.length || offset + size > buffer.length) {
    return null
  }
  return offset + size
}

function readUInt(buffer, offset, width, littleEndian) {
  if (offset < 0 || offset + width > buffer.length) {
    return null
  }

  switch (width) {
    case 2:
      return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
    case 4:
      return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
    case 8: {
      const value = littleEndian
        ? buffer.readBigUInt64LE(offset)
        : buffer.readBigUInt64BE(offset)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number.MAX_SAFE_INTEGER
      }
      return Number(value)
    }
    default:
      return null
  }
}

function peMachineToArch(machine) {
  switch (machine) {
    case 0x014c:
      return 'x86'
    case 0x8664:
      return 'x64'
    case 0xaa64:
      return 'arm64'
    case 0x01c4:
      return 'arm'
    default:
      return machine ? `machine-0x${machine.toString(16)}` : null
  }
}

function elfMachineToArch(machine) {
  switch (machine) {
    case 0x03:
      return 'x86'
    case 0x3e:
      return 'x64'
    case 0x28:
      return 'arm'
    case 0xb7:
      return 'arm64'
    default:
      return machine ? `machine-0x${machine.toString(16)}` : null
  }
}

function machoCpuTypeToArch(cpuType) {
  switch (cpuType >>> 0) {
    case 7:
      return 'x86'
    case 0x01000007:
      return 'x64'
    case 12:
      return 'arm'
    case 0x0100000c:
      return 'arm64'
    default:
      return cpuType ? `cpu-0x${(cpuType >>> 0).toString(16)}` : null
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
