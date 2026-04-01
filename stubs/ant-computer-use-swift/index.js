function unsupported(methodName) {
  return new Error(
    `@ant/computer-use-swift 兼容层未实现 ${methodName}，当前恢复版不提供原生 macOS Computer Use 能力。`,
  )
}

function defaultDisplay(displayId = 0) {
  return {
    id: displayId ?? 0,
    displayId: displayId ?? 0,
    width: 1440,
    height: 900,
    scaleFactor: 1,
    originX: 0,
    originY: 0,
  }
}

export const tcc = {
  checkAccessibility() {
    return false
  },
  checkScreenRecording() {
    return false
  },
}

export const apps = {
  async prepareDisplay() {
    return {
      hidden: [],
      activated: null,
    }
  },
  async previewHideSet() {
    return []
  },
  async findWindowDisplays() {
    return []
  },
  async appUnderPoint() {
    return null
  },
  async listInstalled() {
    return []
  },
  iconDataUrl() {
    return null
  },
  async listRunning() {
    return []
  },
  async open() {
    throw unsupported('apps.open')
  },
  async unhide() {},
}

export const display = {
  getSize(displayId) {
    return defaultDisplay(displayId)
  },
  listAll() {
    return []
  },
}

export async function resolvePrepareCapture() {
  throw unsupported('resolvePrepareCapture')
}

export const screenshot = {
  async captureExcluding() {
    throw unsupported('screenshot.captureExcluding')
  },
  async captureRegion() {
    throw unsupported('screenshot.captureRegion')
  },
}

export function _drainMainRunLoop() {}

export default {
  tcc,
  apps,
  display,
  resolvePrepareCapture,
  screenshot,
  _drainMainRunLoop,
}
