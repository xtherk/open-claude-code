import { existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const currentDir = dirname(fileURLToPath(import.meta.url))

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

function loadModule() {
  if (loadAttempted) {
    return cachedModule
  }
  loadAttempted = true

  if (process.platform !== 'darwin') {
    return null
  }

  const envPath = process.env.URL_HANDLER_NODE_PATH
  if (envPath) {
    try {
      cachedModule = require(envPath)
      return cachedModule
    } catch {
      // 继续走下面的回退路径。
    }
  }

  const platformDir = `${process.arch}-darwin`
  const candidates = buildCandidates([
    `vendor/url-handler/${platformDir}/url-handler.node`,
    `../vendor/url-handler/${platformDir}/url-handler.node`,
    `../../vendor/url-handler/${platformDir}/url-handler.node`,
    `../../../vendor/url-handler/${platformDir}/url-handler.node`,
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

  return null
}

export function waitForUrlEvent(timeoutMs) {
  const mod = loadModule()
  if (!mod) {
    return null
  }
  return mod.waitForUrlEvent(timeoutMs)
}
