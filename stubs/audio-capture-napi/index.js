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

  const platform = process.platform
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return null
  }

  const envPath = process.env.AUDIO_CAPTURE_NODE_PATH
  if (envPath) {
    try {
      cachedModule = require(envPath)
      return cachedModule
    } catch {
      // 继续走下面的回退路径。
    }
  }

  const platformDir = `${process.arch}-${platform}`
  const candidates = buildCandidates([
    `vendor/audio-capture/${platformDir}/audio-capture.node`,
    `../vendor/audio-capture/${platformDir}/audio-capture.node`,
    `../../vendor/audio-capture/${platformDir}/audio-capture.node`,
    `../../../vendor/audio-capture/${platformDir}/audio-capture.node`,
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

export function isNativeAudioAvailable() {
  return loadModule() !== null
}

export function startNativeRecording(onData, onEnd) {
  const mod = loadModule()
  if (!mod) {
    return false
  }
  return mod.startRecording(onData, onEnd)
}

export function stopNativeRecording() {
  const mod = loadModule()
  if (!mod) {
    return
  }
  mod.stopRecording()
}

export function isNativeRecordingActive() {
  const mod = loadModule()
  if (!mod) {
    return false
  }
  return mod.isRecording()
}

export function startNativePlayback(sampleRate, channels) {
  const mod = loadModule()
  if (!mod) {
    return false
  }
  return mod.startPlayback(sampleRate, channels)
}

export function writeNativePlaybackData(data) {
  const mod = loadModule()
  if (!mod) {
    return
  }
  mod.writePlaybackData(data)
}

export function stopNativePlayback() {
  const mod = loadModule()
  if (!mod) {
    return
  }
  mod.stopPlayback()
}

export function isNativePlaying() {
  const mod = loadModule()
  if (!mod) {
    return false
  }
  return mod.isPlaying()
}

export function microphoneAuthorizationStatus() {
  const mod = loadModule()
  if (!mod || typeof mod.microphoneAuthorizationStatus !== 'function') {
    return 0
  }
  return mod.microphoneAuthorizationStatus()
}

export default {
  isNativeAudioAvailable,
  startNativeRecording,
  stopNativeRecording,
  isNativeRecordingActive,
  startNativePlayback,
  writeNativePlaybackData,
  stopNativePlayback,
  isNativePlaying,
  microphoneAuthorizationStatus,
}
