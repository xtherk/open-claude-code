#!/usr/bin/env node

import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'path'

const DEFAULT_REPORT = resolve(
  'artifacts',
  'claude-native-deps',
  'report.json',
)
const DEFAULT_OUT_DIR = resolve('artifacts', 'recovered-vendor-exact')
const REFERENCE_ROOTS = [
  'vendor/audio-capture',
  'vendor/image-processor',
  'vendor/url-handler',
  'stubs/ant-computer-use-input/prebuilds',
  'stubs/ant-computer-use-swift/prebuilds',
]
const ALLOWED_EXTENSIONS = new Set(['.node', '.dll', '.dylib', '.so'])

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = JSON.parse(await readFile(options.reportFile, 'utf8'))
  const references = await collectReferenceFiles(options.projectRoot)
  const candidates = await collectCandidates(report)

  await rm(options.outDir, { recursive: true, force: true })
  await mkdir(options.outDir, { recursive: true })

  const staged = []
  const missing = []

  for (const reference of references) {
    const bestMatch = findBestCandidate(reference, candidates)
    if (!bestMatch) {
      missing.push({
        targetPath: reference.relativePath,
        size: reference.size,
        sha256: reference.sha256,
      })
      continue
    }

    const outputPath = resolve(options.outDir, reference.relativePath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, bestMatch.outputBytes)

    staged.push({
      targetPath: reference.relativePath,
      outputPath,
      mode: bestMatch.mode,
      matchedScore: bestMatch.score,
      sourcePath: bestMatch.candidate.outputPath,
      sourceContainerPath: bestMatch.candidate.containerPath,
      sourceSize: bestMatch.candidate.size,
      stagedSize: bestMatch.outputBytes.length,
      referenceSize: reference.size,
      sha256: sha256(bestMatch.outputBytes),
      sourceSha256: bestMatch.candidate.sha256,
      referenceSha256: reference.sha256,
      architecture: bestMatch.candidate.architecture,
      platform: bestMatch.candidate.platform,
      assetHint: bestMatch.candidate.decoratedAssetHint,
      candidateExactLength: bestMatch.candidate.exactLength,
      candidateOverlayLength: bestMatch.candidate.overlayLength,
      referenceExactLength: reference.targetInfo.exactLength,
      referenceOverlayLength: reference.targetInfo.overlayLength,
      notes: buildStageNotes(bestMatch),
    })
  }

  const unmatchedCandidates = candidates
    .filter(candidate => !staged.some(item => item.sourcePath === candidate.outputPath))
    .map(candidate => ({
      outputPath: candidate.outputPath,
      containerPath: candidate.containerPath,
      size: candidate.size,
      sha256: candidate.sha256,
      architecture: candidate.architecture,
      platform: candidate.platform,
      assetHint: candidate.decoratedAssetHint,
      exactLength: candidate.exactLength,
      overlayLength: candidate.overlayLength,
      verifiedExact: candidate.verifiedExact,
    }))

  const manifest = {
    generatedAt: new Date().toISOString(),
    reportFile: options.reportFile,
    projectRoot: options.projectRoot,
    outputDir: options.outDir,
    staged,
    missing,
    unmatchedCandidates,
  }

  const manifestPath = join(options.outDir, 'MANIFEST.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  console.log(`已生成 staged vendor/stubs 目录: ${options.outDir}`)
  console.log(`MANIFEST: ${manifestPath}`)
  console.log(`已写入 ${staged.length} 个目标，缺失 ${missing.length} 个目标`)
}

function parseArgs(argv) {
  const options = {
    reportFile: DEFAULT_REPORT,
    outDir: DEFAULT_OUT_DIR,
    projectRoot: resolve('.'),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--report':
        options.reportFile = resolve(expectValue(argv, ++index, arg))
        break
      case '--out-dir':
        options.outDir = resolve(expectValue(argv, ++index, arg))
        break
      case '--project-root':
        options.projectRoot = resolve(expectValue(argv, ++index, arg))
        break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`未知参数: ${arg}`)
    }
  }

  return options
}

function printHelp() {
  console.log(`用法:
  node scripts/stage-recovered-vendor-from-artifacts.mjs [--report <report.json>] [--out-dir <dir>]

说明:
  - 读取 Claude 二进制 carve 报告
  - 按 asset 名称 + 架构/平台把提取产物映射到当前仓库的 vendor/stubs 目标槽位
  - 仅接受通过 PE / ELF / Mach-O 头部校验、长度精确一致的提取产物
  - 生成一个单独的 recovered vendor/stubs 目录，供手动覆盖
  - 不会直接改写当前 vendor/ 或 stubs/
`)
}

function expectValue(argv, index, flag) {
  if (index >= argv.length) {
    throw new Error(`${flag} 缺少参数值`)
  }
  return argv[index]
}

async function collectReferenceFiles(projectRoot) {
  const files = []
  for (const relativeRoot of REFERENCE_ROOTS) {
    const root = resolve(projectRoot, relativeRoot)
    if (!existsSync(root)) {
      continue
    }
    await collectFilesRecursive(root, files)
  }

  return Promise.all(
    files.map(async filePath => {
      const content = await readFile(filePath)
      const exactInfo = parseBinary(content)
      return {
        absolutePath: filePath,
        relativePath: normalizePath(relative(projectRoot, filePath)),
        size: content.length,
        sha256: sha256(content),
        bytes: content,
        targetInfo: {
          ...inferTargetInfoFromPath(filePath),
          exactLength: exactInfo?.spanLength ?? null,
          overlayLength:
            exactInfo && Number.isFinite(exactInfo.spanLength)
              ? Math.max(0, content.length - exactInfo.spanLength)
              : null,
        },
      }
    }),
  )
}

async function collectFilesRecursive(root, output) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(root, entry.name)
    if (entry.isDirectory()) {
      await collectFilesRecursive(fullPath, output)
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    if (!ALLOWED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue
    }
    output.push(fullPath)
  }
}

async function collectCandidates(report) {
  const candidates = []

  for (const file of report.files ?? []) {
    for (const embedded of file.embeddedBinaries ?? []) {
      if (!embedded.outputPath || !existsSync(embedded.outputPath)) {
        continue
      }
      const bytes = await readFile(embedded.outputPath)
      const exactInfo = parseBinary(bytes)
      candidates.push({
        outputPath: embedded.outputPath,
        containerPath: file.path,
        size: bytes.length,
        sha256: sha256(bytes),
        bytes,
        architecture: embedded.architecture ?? null,
        platform: embedded.platformGuess ?? null,
        assetHint: embedded.assetHint ?? null,
        decoratedAssetHint: embedded.decoratedAssetHint ?? null,
        exactLength: exactInfo?.spanLength ?? null,
        overlayLength:
          exactInfo && Number.isFinite(exactInfo.spanLength)
            ? Math.max(0, bytes.length - exactInfo.spanLength)
            : null,
        verifiedExact:
          exactInfo !== null && Number.isFinite(exactInfo.spanLength)
            ? exactInfo.spanLength === bytes.length
            : false,
      })
    }
  }

  return candidates
}

function findBestCandidate(reference, candidates) {
  let bestMatch = null
  for (const candidate of candidates) {
    const match = matchCandidateToReference(reference, candidate)
    if (!match) {
      continue
    }
    if (!bestMatch || match.score > bestMatch.score) {
      bestMatch = match
    }
  }
  return bestMatch
}

function matchCandidateToReference(reference, candidate) {
  if (!candidate.verifiedExact) {
    return null
  }

  const referenceAssetName = reference.targetInfo.assetName
  const candidateAssetNames = new Set([
    normalizeAssetName(candidate.assetHint),
    normalizeAssetName(candidate.decoratedAssetHint),
    normalizeAssetName(basename(candidate.outputPath)),
  ].filter(Boolean))
  if (!referenceAssetName || !candidateAssetNames.has(referenceAssetName)) {
    return null
  }

  let score = 1000
  if (reference.targetInfo.architecture && candidate.architecture) {
    if (reference.targetInfo.architecture === candidate.architecture) {
      score += 80
    } else {
      score -= 200
    }
  }
  if (reference.targetInfo.platform && candidate.platform) {
    if (reference.targetInfo.platform === candidate.platform) {
      score += 80
    } else {
      score -= 200
    }
  }

  if (reference.size === candidate.size) {
    score += 60
  }
  if (
    reference.targetInfo.exactLength !== null &&
    reference.targetInfo.exactLength === candidate.size
  ) {
    score += 40
  }
  if (
    !reference.targetInfo.architecture &&
    !reference.targetInfo.platform &&
    candidate.platform === 'darwin' &&
    candidate.architecture === 'arm64'
  ) {
    score += 10
  }
  if (normalizePath(candidate.containerPath).includes('-musl')) {
    score -= 20
  }
  if (reference.targetInfo.architecture && reference.targetInfo.platform) {
    const normalizedContainerPath = normalizePath(candidate.containerPath).toLowerCase()
    const expectedContainerSegment =
      `${reference.targetInfo.platform}-${reference.targetInfo.architecture}/claude`
    if (normalizedContainerPath.includes(expectedContainerSegment)) {
      score += 15
    }
  }

  if (
    reference.relativePath.includes(`${sep}x64-linux`) ||
    reference.relativePath.includes('/x64-linux')
  ) {
    if (!normalizePath(candidate.containerPath).includes('linux-x64/claude')) {
      score -= 10
    }
  }
  if (
    reference.relativePath.includes(`${sep}arm64-linux`) ||
    reference.relativePath.includes('/arm64-linux')
  ) {
    if (!normalizePath(candidate.containerPath).includes('linux-arm64/claude')) {
      score -= 10
    }
  }

  return {
    score,
    mode: 'exact_candidate',
    candidate,
    reference,
    outputBytes: candidate.bytes,
  }
}

function buildStageNotes(match) {
  const notes = ['直接使用经头部校验通过的提取产物，不再拼接或裁剪参考文件。']
  if ((match.candidate.overlayLength ?? 0) > 0) {
    notes.push(`提取产物自身仍有 ${match.candidate.overlayLength} 字节 overlay，需复核。`)
  }
  if ((match.reference.targetInfo.overlayLength ?? 0) > 0) {
    notes.push(
      `当前仓库参考文件含 ${match.reference.targetInfo.overlayLength} 字节 overlay，本次 staging 保留 header-exact 版本。`,
    )
  }
  return notes.join(' ')
}

function inferTargetInfoFromPath(filePath) {
  const normalized = normalizePath(filePath).toLowerCase()
  const platformMatch = normalized.match(/\/(arm64|x64|arm|x86)-(darwin|linux|win32)\//)
  return {
    architecture: platformMatch?.[1] ?? null,
    platform: platformMatch?.[2] ?? null,
    assetName: normalizeAssetName(basename(filePath)),
  }
}

function normalizeAssetName(value) {
  if (!value) {
    return null
  }
  const normalized = basename(String(value)).toLowerCase()
  switch (normalized) {
    case 'input.node':
    case 'libcomputer_use_input.dylib':
      return 'computer-use-input.node'
    case 'libcomputeruseswift.dylib':
    case 'computer-use-swift.node':
      return 'computer_use.node'
    default:
      return normalized
  }
}

function parseBinary(buffer) {
  return parsePe(buffer) ?? parseElf(buffer) ?? parseMachO(buffer)
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
  const certificateTableOffset = readUInt(buffer, dataDirectoryOffset + 8 * 4, 4, true)
  const certificateTableSize = readUInt(
    buffer,
    dataDirectoryOffset + 8 * 4 + 4,
    4,
    true,
  )
  const sectionsOffset = optionalOffset + sizeOfOptionalHeader
  let spanEnd = sectionsOffset + numberOfSections * 40

  for (let index = 0; index < numberOfSections; index += 1) {
    const entryOffset = sectionsOffset + index * 40
    if (entryOffset + 40 > buffer.length) {
      return null
    }
    const sizeOfRawData = readUInt(buffer, entryOffset + 16, 4, true) ?? 0
    const pointerToRawData = readUInt(buffer, entryOffset + 20, 4, true) ?? 0
    if (sizeOfRawData === 0) {
      continue
    }
    const sectionSpanEnd = validatedSpanEnd(buffer, pointerToRawData, sizeOfRawData)
    if (sectionSpanEnd === null) {
      return null
    }
    spanEnd = Math.max(spanEnd, sectionSpanEnd)
  }

  if (
    certificateTableOffset !== null &&
    certificateTableSize !== null &&
    certificateTableOffset > 0 &&
    certificateTableSize > 0
  ) {
    const certificateSpanEnd = validatedSpanEnd(
      buffer,
      certificateTableOffset,
      certificateTableSize,
    )
    if (certificateSpanEnd === null) {
      return null
    }
    spanEnd = Math.max(spanEnd, certificateSpanEnd)
  }

  return {
    format: 'pe',
    spanLength: spanEnd,
  }
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

  const is64Bit = buffer[4] === 2
  const littleEndian = buffer[5] === 1
  if ((buffer[4] !== 1 && buffer[4] !== 2) || (buffer[5] !== 1 && buffer[5] !== 2)) {
    return null
  }

  const programHeaderOffset = readUInt(
    buffer,
    is64Bit ? 32 : 28,
    is64Bit ? 8 : 4,
    littleEndian,
  )
  const programHeaderEntrySize = readUInt(buffer, is64Bit ? 54 : 42, 2, littleEndian)
  const programHeaderCount = readUInt(buffer, is64Bit ? 56 : 44, 2, littleEndian) ?? 0
  const sectionHeaderOffset = readUInt(
    buffer,
    is64Bit ? 40 : 32,
    is64Bit ? 8 : 4,
    littleEndian,
  )
  const sectionHeaderEntrySize = readUInt(buffer, is64Bit ? 58 : 46, 2, littleEndian)
  const sectionHeaderCount = readUInt(buffer, is64Bit ? 60 : 48, 2, littleEndian) ?? 0
  const expectedProgramHeaderEntrySize = is64Bit ? 56 : 32
  const expectedSectionHeaderEntrySize = is64Bit ? 64 : 40

  if (
    programHeaderOffset === null ||
    programHeaderEntrySize !== expectedProgramHeaderEntrySize ||
    programHeaderCount <= 0 ||
    programHeaderCount > 256 ||
    programHeaderOffset + programHeaderCount * programHeaderEntrySize > buffer.length
  ) {
    return null
  }

  let spanEnd = programHeaderOffset + programHeaderCount * programHeaderEntrySize
  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programHeaderOffset + index * programHeaderEntrySize
    const fileOffset = readUInt(
      buffer,
      offset + (is64Bit ? 8 : 4),
      is64Bit ? 8 : 4,
      littleEndian,
    ) ?? 0
    const fileSize = readUInt(
      buffer,
      offset + (is64Bit ? 32 : 16),
      is64Bit ? 8 : 4,
      littleEndian,
    ) ?? 0
    if (fileSize > 0) {
      const programSpanEnd = validatedSpanEnd(buffer, fileOffset, fileSize)
      if (programSpanEnd === null) {
        return null
      }
      spanEnd = Math.max(spanEnd, programSpanEnd)
    }
  }

  if (
    sectionHeaderOffset !== null &&
    sectionHeaderEntrySize === expectedSectionHeaderEntrySize &&
    sectionHeaderCount > 0 &&
    sectionHeaderCount <= 8192 &&
    sectionHeaderOffset + sectionHeaderCount * sectionHeaderEntrySize <= buffer.length
  ) {
    spanEnd = Math.max(
      spanEnd,
      sectionHeaderOffset + sectionHeaderCount * sectionHeaderEntrySize,
    )
    for (let index = 0; index < sectionHeaderCount; index += 1) {
      const offset = sectionHeaderOffset + index * sectionHeaderEntrySize
      const sectionType = readUInt(buffer, offset + 4, 4, littleEndian) ?? 0
      if (sectionType === 8) {
        continue
      }
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
      const sectionSpanEnd = validatedSpanEnd(buffer, sectionOffset, sectionSize)
      if (sectionSpanEnd === null) {
        return null
      }
      spanEnd = Math.max(spanEnd, sectionSpanEnd)
    }
  }

  return {
    format: 'elf',
    spanLength: spanEnd,
  }
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
  let validSegmentCount = 0

  for (let index = 0; index < ncmds; index += 1) {
    const command = readUInt(buffer, offset, 4, descriptor.littleEndian)
    const commandSize = readUInt(buffer, offset + 4, 4, descriptor.littleEndian)
    if (
      command === null ||
      commandSize === null ||
      commandSize < 8 ||
      offset + commandSize > buffer.length
    ) {
      return null
    }

    const normalizedCommand = command & 0x7fffffff
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
      const symSpanEnd = validatedSpanEnd(buffer, symoff, nsyms * symbolEntrySize)
      const strSpanEnd = validatedSpanEnd(buffer, stroff, strsize)
      if (symSpanEnd === null || strSpanEnd === null) {
        return null
      }
      spanEnd = Math.max(spanEnd, symSpanEnd, strSpanEnd)
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
    } else if (normalizedCommand === 0x22) {
      const dyldInfoSpanEnd = parseMachODyldInfoSpanEnd(
        buffer,
        offset,
        descriptor.littleEndian,
      )
      if (dyldInfoSpanEnd === null) {
        return null
      }
      spanEnd = Math.max(spanEnd, dyldInfoSpanEnd)
    } else if ([0x1d, 0x1e, 0x26, 0x29, 0x2b, 0x2e, 0x33, 0x34].includes(normalizedCommand)) {
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
    spanLength: spanEnd,
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
  let spanEnd = 8 + archCount * entrySize
  for (let index = 0; index < archCount; index += 1) {
    const entryOffset = 8 + index * entrySize
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
    if (sliceOffset === null || sliceSize === null || sliceSize <= 0) {
      return null
    }
    const sliceSpanEnd = validatedSpanEnd(buffer, sliceOffset, sliceSize)
    if (sliceSpanEnd === null) {
      return null
    }
    spanEnd = Math.max(spanEnd, sliceSpanEnd)
  }

  return {
    format: 'mach-o-fat',
    spanLength: spanEnd,
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
  let spanEnd = fileSize > 0 ? validatedSpanEnd(buffer, fileOffset, fileSize) : 0
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

    if (sectionFileSize > 0 && ![0x01, 0x0c, 0x12].includes(sectionType)) {
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

function parseMachODysymtabSpanEnd(buffer, commandOffset, descriptor) {
  const moduleEntrySize = descriptor.bits === 64 ? 56 : 52
  const tables = [
    { offsetField: 32, countField: 36, entrySize: 8 },
    { offsetField: 40, countField: 44, entrySize: moduleEntrySize },
    { offsetField: 48, countField: 52, entrySize: 4 },
    { offsetField: 56, countField: 60, entrySize: 4 },
    { offsetField: 64, countField: 68, entrySize: 8 },
    { offsetField: 72, countField: 76, entrySize: 8 },
  ]

  let spanEnd = 0
  for (const table of tables) {
    const tableOffset = readUInt(
      buffer,
      commandOffset + table.offsetField,
      4,
      descriptor.littleEndian,
    ) ?? 0
    const tableCount = readUInt(
      buffer,
      commandOffset + table.countField,
      4,
      descriptor.littleEndian,
    ) ?? 0
    const tableSpanEnd = validatedSpanEnd(buffer, tableOffset, tableCount * table.entrySize)
    if (tableSpanEnd === null) {
      return null
    }
    spanEnd = Math.max(spanEnd, tableSpanEnd)
  }
  return spanEnd
}

function parseMachODyldInfoSpanEnd(buffer, commandOffset, littleEndian) {
  let spanEnd = 0
  for (const fieldOffset of [8, 16, 24, 32, 40]) {
    const dataoff = readUInt(buffer, commandOffset + fieldOffset, 4, littleEndian) ?? 0
    const datasize = readUInt(buffer, commandOffset + fieldOffset + 4, 4, littleEndian) ?? 0
    const tableSpanEnd = validatedSpanEnd(buffer, dataoff, datasize)
    if (tableSpanEnd === null) {
      return null
    }
    spanEnd = Math.max(spanEnd, tableSpanEnd)
  }
  return spanEnd
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
    case 8:
      return Number(
        littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset),
      )
    default:
      return null
  }
}

function normalizePath(value) {
  return value.split(sep).join('/')
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exit(1)
})
