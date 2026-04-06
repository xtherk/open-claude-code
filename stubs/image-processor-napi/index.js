import { existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, resolve } from 'path'
import sharpImport from 'sharp'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const currentDir = dirname(fileURLToPath(import.meta.url))
const fallbackSharp =
  typeof sharpImport === 'function' ? sharpImport : sharpImport.default

let cachedModule = null
let loadAttempted = false

function buildCandidates(relativePaths) {
  const seen = new Set()
  const candidates = []
  const bases = [currentDir, process.cwd()]

  for (const base of bases) {
    for (const relativePath of relativePaths) {
      const candidate = resolve(base, relativePath)
      if (!seen.has(candidate)) {
        seen.add(candidate)
        candidates.push(candidate)
      }
    }
  }

  return candidates
}

export function getNativeModule() {
  if (loadAttempted) {
    return cachedModule
  }
  loadAttempted = true

  const envPath = process.env.IMAGE_PROCESSOR_NODE_PATH
  if (envPath) {
    try {
      cachedModule = require(envPath)
      return cachedModule
    } catch {
      // 继续走下面的回退路径。
    }
  }

  const platformDir = `${process.arch}-${process.platform}`
  const candidates = buildCandidates([
    `vendor/image-processor/${platformDir}/image-processor.node`,
    `../vendor/image-processor/${platformDir}/image-processor.node`,
    `../../vendor/image-processor/${platformDir}/image-processor.node`,
    `../../../vendor/image-processor/${platformDir}/image-processor.node`,
  ])

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }
    try {
      cachedModule = require(candidate)
      return cachedModule
    } catch {
      // 尝试下一条路径。
    }
  }

  cachedModule = null
  return cachedModule
}

function createFallbackInstance(input, operations) {
  let instance = fallbackSharp(input)
  for (const operation of operations) {
    instance = operation.applyToSharp(instance)
  }
  return instance
}

export function sharp(input) {
  const operations = []

  const api = {
    async metadata() {
      const nativeModule = getNativeModule()
      if (nativeModule && Buffer.isBuffer(input)) {
        try {
          const processor = await nativeModule.processImage(input)
          for (const operation of operations) {
            operation.applyToNative(processor)
          }
          return processor.metadata()
        } catch {
          // 原生链路失败时退回 sharp。
        }
      }
      return createFallbackInstance(input, operations).metadata()
    },
    resize(width, height, options) {
      operations.push({
        applyToNative(processor) {
          processor.resize(width, height, options)
        },
        applyToSharp(instance) {
          return instance.resize(width, height, options)
        },
      })
      return api
    },
    jpeg(options) {
      operations.push({
        applyToNative(processor) {
          processor.jpeg(options?.quality)
        },
        applyToSharp(instance) {
          return instance.jpeg(options)
        },
      })
      return api
    },
    png(options) {
      operations.push({
        applyToNative(processor) {
          processor.png(options)
        },
        applyToSharp(instance) {
          return instance.png(options)
        },
      })
      return api
    },
    webp(options) {
      operations.push({
        applyToNative(processor) {
          processor.webp(options?.quality)
        },
        applyToSharp(instance) {
          return instance.webp(options)
        },
      })
      return api
    },
    async toBuffer() {
      const nativeModule = getNativeModule()
      if (nativeModule && Buffer.isBuffer(input)) {
        try {
          const processor = await nativeModule.processImage(input)
          for (const operation of operations) {
            operation.applyToNative(processor)
          }
          return processor.toBuffer()
        } catch {
          // 原生链路失败时退回 sharp。
        }
      }
      return createFallbackInstance(input, operations).toBuffer()
    },
  }

  return api
}

export default sharp
