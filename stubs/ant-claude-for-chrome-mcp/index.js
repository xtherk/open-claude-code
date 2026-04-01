import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const RECOVERED_VERSION = '0.0.0-recovered'
const UNAVAILABLE_MESSAGE =
  'Claude in Chrome 私有桥接包已替换为兼容层，当前恢复版不提供浏览器桥接执行能力。'

const passthroughSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
}

function buildTool(name, description) {
  return {
    name,
    description,
    inputSchema: passthroughSchema,
  }
}

export const BROWSER_TOOLS = [
  buildTool('javascript_tool', '在当前网页上下文中执行 JavaScript。'),
  buildTool('read_page', '读取当前页面内容。'),
  buildTool('find', '在页面内查找文本。'),
  buildTool('form_input', '向页面表单输入内容。'),
  buildTool('computer', '执行浏览器内的通用交互动作。'),
  buildTool('navigate', '导航到指定 URL。'),
  buildTool('resize_window', '调整浏览器窗口大小。'),
  buildTool('gif_creator', '管理浏览器录屏 GIF。'),
  buildTool('upload_image', '向页面上传图片。'),
  buildTool('get_page_text', '提取页面纯文本。'),
  buildTool('tabs_context_mcp', '读取当前浏览器标签页上下文。'),
  buildTool('tabs_create_mcp', '新建浏览器标签页。'),
  buildTool('update_plan', '更新浏览器任务计划。'),
  buildTool('read_console_messages', '读取浏览器控制台消息。'),
  buildTool('read_network_requests', '读取浏览器网络请求。'),
  buildTool('shortcuts_list', '列出浏览器快捷指令。'),
  buildTool('shortcuts_execute', '执行浏览器快捷指令。'),
]

function textResult(text, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [
      {
        type: 'text',
        text,
      },
    ],
  }
}

function emptyReadPayload(toolName) {
  switch (toolName) {
    case 'tabs_context_mcp':
      return {
        tabs: [],
        activeTabId: null,
        note: UNAVAILABLE_MESSAGE,
      }
    case 'shortcuts_list':
      return {
        shortcuts: [],
        note: UNAVAILABLE_MESSAGE,
      }
    case 'read_console_messages':
      return {
        messages: [],
        note: UNAVAILABLE_MESSAGE,
      }
    case 'read_network_requests':
      return {
        requests: [],
        note: UNAVAILABLE_MESSAGE,
      }
    case 'find':
      return {
        matches: [],
        note: UNAVAILABLE_MESSAGE,
      }
    case 'read_page':
      return {
        content: '',
        note: UNAVAILABLE_MESSAGE,
      }
    case 'get_page_text':
      return {
        text: '',
        note: UNAVAILABLE_MESSAGE,
      }
    default:
      return null
  }
}

export function createClaudeForChromeMcpServer(context = {}) {
  const server = new Server(
    {
      name: 'claude-in-chrome',
      version: RECOVERED_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BROWSER_TOOLS,
  }))

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const toolName = params?.name ?? 'unknown'
    context?.logger?.warn?.(
      '[Claude in Chrome Compat] tool %s is unavailable in recovered build',
      toolName,
    )

    const readPayload = emptyReadPayload(toolName)
    if (readPayload !== null) {
      return textResult(JSON.stringify(readPayload, null, 2))
    }

    return textResult(`${UNAVAILABLE_MESSAGE}\n工具：${toolName}`, true)
  })

  return server
}
