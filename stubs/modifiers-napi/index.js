import { existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const currentDir = dirname(fileURLToPath(import.meta.url))
const knownModifiers = ['shift', 'command', 'control', 'option']
const modifierAliases = new Map([
  ['shift', 'shift'],
  ['command', 'command'],
  ['cmd', 'command'],
  ['control', 'control'],
  ['ctrl', 'control'],
  ['option', 'option'],
  ['opt', 'option'],
  ['alt', 'option'],
])
const ffiModifierMasks = {
  shift: 0x20000,
  control: 0x40000,
  option: 0x80000,
  command: 0x100000,
}
const ffiLibraryPaths = [
  '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices',
  '/System/Library/Frameworks/Carbon.framework/Carbon',
]
const kCGEventSourceStateCombinedSessionState = 0

let cachedModule = null
let loadAttempted = false
let cachedBunFfiModule = null
let bunFfiLoadAttempted = false

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

function normalizeModifierName(modifier) {
  const normalized = String(modifier ?? '')
    .trim()
    .toLowerCase()
  return modifierAliases.get(normalized) ?? normalized
}

function normalizeModifierList(values) {
  if (!Array.isArray(values)) {
    return []
  }
  const result = []
  const seen = new Set()
  for (const value of values) {
    const normalized = normalizeModifierName(value)
    if (!knownModifiers.includes(normalized) || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function loadBunFfiFallbackModule() {
  if (bunFfiLoadAttempted) {
    return cachedBunFfiModule
  }
  bunFfiLoadAttempted = true

  if (process.platform !== 'darwin') {
    return null
  }

  let ffi = null
  try {
    ffi = require('bun:ffi')
  } catch {
    return null
  }

  for (const libraryPath of ffiLibraryPaths) {
    try {
      const lib = ffi.dlopen(libraryPath, {
        CGEventSourceFlagsState: {
          args: [ffi.FFIType.i32],
          returns: ffi.FFIType.u64,
        },
      })
      const getFlags = () =>
        Number(
          lib.symbols.CGEventSourceFlagsState(
            kCGEventSourceStateCombinedSessionState,
          ),
        )
      cachedBunFfiModule = {
        prewarm() {
          getFlags()
        },
        getModifiers() {
          const flags = getFlags()
          return knownModifiers.filter(
            modifier => (flags & ffiModifierMasks[modifier]) !== 0,
          )
        },
        isModifierPressed(modifier) {
          const normalized = normalizeModifierName(modifier)
          const flag = ffiModifierMasks[normalized]
          if (flag === undefined) {
            return false
          }
          return (getFlags() & flag) !== 0
        },
      }
      return cachedBunFfiModule
    } catch {
      // 继续尝试下一条 framework 路径。
    }
  }

  return null
}

function loadModule() {
  if (loadAttempted) {
    return cachedModule
  }
  loadAttempted = true

  if (process.platform !== 'darwin') {
    return null
  }

  const envPath = process.env.MODIFIERS_NODE_PATH
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
    `build/Release/modifiers.node`,
    `build/Debug/modifiers.node`,
    `../build/Release/modifiers.node`,
    `../build/Debug/modifiers.node`,
    `vendor/modifiers-napi/${platformDir}/modifiers.node`,
    `../vendor/modifiers-napi/${platformDir}/modifiers.node`,
    `../../vendor/modifiers-napi/${platformDir}/modifiers.node`,
    `../../../vendor/modifiers-napi/${platformDir}/modifiers.node`,
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

  cachedModule = loadBunFfiFallbackModule()
  return cachedModule
}

export const isSupported = process.platform === 'darwin'
export function getNativeModule() {
  return loadModule()
}

export function getModifiers() {
  const mod = getNativeModule()
  if (!mod) {
    return []
  }
  if (typeof mod.getModifiers === 'function') {
    try {
      return normalizeModifierList(mod.getModifiers())
    } catch {
      return []
    }
  }
  if (typeof mod.isModifierPressed === 'function') {
    return knownModifiers.filter(modifier => {
      try {
        return mod.isModifierPressed(modifier)
      } catch {
        return false
      }
    })
  }
  return []
}

export function prewarm() {
  const mod = getNativeModule()
  if (!mod || typeof mod.prewarm !== 'function') {
    return
  }
  try {
    mod.prewarm()
  } catch {
    // 预热失败不影响主流程。
  }
}

export function isModifierPressed(modifier) {
  const mod = getNativeModule()
  if (!mod || typeof mod.isModifierPressed !== 'function') {
    return false
  }
  try {
    return mod.isModifierPressed(normalizeModifierName(modifier))
  } catch {
    return false
  }
}

export default {
  isSupported,
  getNativeModule,
  getModifiers,
  prewarm,
  isModifierPressed,
}
