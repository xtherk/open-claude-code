import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const RECOVERED_VERSION = '0.0.0-recovered'
const SERVER_NAME = 'computer-use'
const UNAVAILABLE_MESSAGE =
  'Computer Use 私有原生包已替换为兼容层，当前恢复版不提供完整的本机控制能力。'

const passthroughSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
}

export const DEFAULT_GRANT_FLAGS = Object.freeze({
  clipboardRead: false,
  clipboardWrite: false,
  systemKeyCombos: false,
})

export const API_RESIZE_PARAMS = Object.freeze({})

export function targetImageSize(width, height) {
  return [
    Math.max(1, Math.round(Number(width) || 0)),
    Math.max(1, Math.round(Number(height) || 0)),
  ]
}

function buildTool(name, description, inputSchema = passthroughSchema) {
  return {
    name,
    description,
    inputSchema,
  }
}

function requestAccessSchema() {
  return {
    type: 'object',
    properties: {
      reason: { type: 'string' },
      apps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            requestedName: { type: 'string' },
            bundleId: { type: 'string' },
            displayName: { type: 'string' },
            path: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
      requestedFlags: {
        type: 'object',
        properties: {
          clipboardRead: { type: 'boolean' },
          clipboardWrite: { type: 'boolean' },
          systemKeyCombos: { type: 'boolean' },
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  }
}

function buildRequestAccessDescription(installedAppNames) {
  const names = Array.isArray(installedAppNames)
    ? installedAppNames.filter(name => typeof name === 'string' && name.length > 0)
    : []
  if (names.length === 0) {
    return '请求当前会话的 Computer Use 权限。'
  }
  const preview = names.slice(0, 12).join(', ')
  const suffix = names.length > 12 ? ' …' : ''
  return `请求当前会话的 Computer Use 权限。已检测应用：${preview}${suffix}`
}

export function buildComputerUseTools(
  capabilities = {},
  coordinateMode = 'pixels',
  installedAppNames = [],
) {
  void capabilities

  return [
    buildTool(
      'request_access',
      buildRequestAccessDescription(installedAppNames),
      requestAccessSchema(),
    ),
    buildTool(
      'list_granted_applications',
      '列出当前会话已经授权的应用和权限标记。',
    ),
    buildTool('screenshot', `截取屏幕截图，坐标模式：${coordinateMode}。`),
    buildTool('zoom', `截取屏幕局部区域，坐标模式：${coordinateMode}。`),
    buildTool('mouse_move', `移动鼠标，坐标模式：${coordinateMode}。`),
    buildTool('left_click', '执行左键单击。'),
    buildTool('right_click', '执行右键单击。'),
    buildTool('middle_click', '执行中键单击。'),
    buildTool('double_click', '执行双击。'),
    buildTool('triple_click', '执行三击。'),
    buildTool('left_mouse_down', '按下鼠标左键。'),
    buildTool('left_mouse_up', '释放鼠标左键。'),
    buildTool('left_click_drag', '执行拖拽操作。'),
    buildTool('scroll', '执行滚动操作。'),
    buildTool('cursor_position', '读取当前鼠标坐标。'),
    buildTool('type', '输入文本。'),
    buildTool('key', '发送按键或组合键。'),
    buildTool('hold_key', '按住按键一段时间。'),
    buildTool('wait', '等待指定秒数。'),
    buildTool('read_clipboard', '读取剪贴板文本。'),
    buildTool('write_clipboard', '写入剪贴板文本。'),
    buildTool('open_application', '按 bundle id 打开应用。'),
    buildTool('list_displays', '列出当前可用显示器。'),
    buildTool('current_display', '读取当前显示器选择状态。'),
    buildTool('switch_display', '切换到指定显示器，或切回 auto。'),
    buildTool('computer_batch', '批量执行一组 Computer Use 动作。'),
  ]
}

function textResult(text, isError = false, telemetry = undefined) {
  return {
    ...(isError ? { isError: true } : {}),
    ...(telemetry ? { telemetry } : {}),
    content: [
      {
        type: 'text',
        text,
      },
    ],
  }
}

function toJsonText(value) {
  return JSON.stringify(value, null, 2)
}

function unavailableResult(name) {
  return textResult(`${UNAVAILABLE_MESSAGE}\n工具：${name}`, true, {
    error_kind: 'compat_stub',
  })
}

function normalizeRequestedFlags(rawFlags) {
  return {
    clipboardRead: rawFlags?.clipboardRead === true,
    clipboardWrite: rawFlags?.clipboardWrite === true,
    systemKeyCombos: rawFlags?.systemKeyCombos === true,
  }
}

function normalizeRequestedApps(rawApps, grantedApps) {
  if (!Array.isArray(rawApps)) {
    return []
  }
  return rawApps.flatMap(item => {
    if (typeof item === 'string') {
      const alreadyGranted = grantedApps.some(app => app.bundleId === item)
      return [
        {
          requestedName: item,
          resolved: {
            bundleId: item,
            displayName: item,
          },
          alreadyGranted,
        },
      ]
    }
    if (!item || typeof item !== 'object') {
      return []
    }
    const requestedName =
      typeof item.requestedName === 'string'
        ? item.requestedName
        : typeof item.displayName === 'string'
          ? item.displayName
          : typeof item.bundleId === 'string'
            ? item.bundleId
            : 'Unknown App'
    const bundleId =
      typeof item.bundleId === 'string' && item.bundleId.length > 0
        ? item.bundleId
        : requestedName
    const displayName =
      typeof item.displayName === 'string' && item.displayName.length > 0
        ? item.displayName
        : requestedName
    const path = typeof item.path === 'string' ? item.path : undefined
    const alreadyGranted = grantedApps.some(app => app.bundleId === bundleId)
    return [
      {
        requestedName,
        resolved: {
          bundleId,
          displayName,
          ...(path ? { path } : {}),
        },
        alreadyGranted,
      },
    ]
  })
}

async function dispatchCompatTool(adapter, context, name, args) {
  const parsedArgs = args && typeof args === 'object' ? args : {}

  if (adapter?.isDisabled?.()) {
    return textResult(
      'Computer Use 当前被功能开关禁用，兼容层不会执行实际的本机控制操作。',
      true,
      { error_kind: 'disabled' },
    )
  }

  switch (name) {
    case 'list_granted_applications':
      return textResult(
        toJsonText({
          grantedApps: context?.getAllowedApps?.() ?? [],
          grantFlags: context?.getGrantFlags?.() ?? DEFAULT_GRANT_FLAGS,
        }),
      )
    case 'current_display':
      return textResult(
        toJsonText({
          selectedDisplayId: context?.getSelectedDisplayId?.() ?? null,
          pinnedByModel: context?.getDisplayPinnedByModel?.() ?? false,
          resolvedForApps: context?.getDisplayResolvedForApps?.() ?? null,
          lastScreenshotDims: context?.getLastScreenshotDims?.() ?? null,
        }),
      )
    case 'switch_display': {
      const mode =
        typeof parsedArgs.mode === 'string'
          ? parsedArgs.mode
          : typeof parsedArgs.display === 'string'
            ? parsedArgs.display
            : undefined
      const displayId =
        typeof parsedArgs.displayId === 'number' ? parsedArgs.displayId : undefined
      if (mode === 'auto') {
        context?.onDisplayPinned?.(undefined)
        return textResult('已切回自动显示器选择。')
      }
      if (displayId !== undefined) {
        context?.onDisplayPinned?.(displayId)
        return textResult(`已记录显示器选择：${displayId}`)
      }
      return textResult('switch_display 需要 displayId 或 mode=auto。', true, {
        error_kind: 'invalid_input',
      })
    }
    case 'list_displays':
      if (typeof adapter?.executor?.listDisplays === 'function') {
        try {
          return textResult(toJsonText(await adapter.executor.listDisplays()))
        } catch (error) {
          return textResult(String(error), true, { error_kind: 'executor_error' })
        }
      }
      return unavailableResult(name)
    case 'request_access': {
      const grantedApps = context?.getAllowedApps?.() ?? []
      const requestedFlags = normalizeRequestedFlags(parsedArgs.requestedFlags)
      const request = {
        apps: normalizeRequestedApps(parsedArgs.apps, grantedApps),
        requestedFlags,
        reason:
          typeof parsedArgs.reason === 'string' && parsedArgs.reason.length > 0
            ? parsedArgs.reason
            : UNAVAILABLE_MESSAGE,
        willHide: [],
      }

      if (typeof adapter?.ensureOsPermissions === 'function') {
        try {
          const permissions = await adapter.ensureOsPermissions()
          if (!permissions?.granted) {
            request.tccState = {
              accessibility: permissions?.accessibility === true,
              screenRecording: permissions?.screenRecording === true,
            }
          }
        } catch {
          // 兼容层只做 best effort。
        }
      }

      if (typeof context?.onPermissionRequest !== 'function') {
        return textResult(
          '当前调用上下文不支持权限对话框，无法继续 request_access。',
          true,
          { error_kind: 'no_permission_ui' },
        )
      }

      const response = await context.onPermissionRequest(request)
      context?.onAllowedAppsChanged?.(
        response?.granted ?? [],
        response?.flags ?? DEFAULT_GRANT_FLAGS,
      )

      return textResult(
        toJsonText({
          granted: response?.granted ?? [],
          denied: response?.denied ?? [],
          flags: response?.flags ?? DEFAULT_GRANT_FLAGS,
        }),
      )
    }
    default:
      return unavailableResult(name)
  }
}

export function createComputerUseMcpServer(adapter, coordinateMode = 'pixels') {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: RECOVERED_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildComputerUseTools(adapter?.executor?.capabilities, coordinateMode),
  }))

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) =>
    unavailableResult(params?.name ?? 'unknown'),
  )

  return server
}

export function bindSessionContext(adapter, coordinateMode, context) {
  void coordinateMode
  return async (name, args) => dispatchCompatTool(adapter, context, name, args)
}
