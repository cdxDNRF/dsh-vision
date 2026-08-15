/**
 * dsh-vision — DeepSeek Harness 视觉桥接插件（宿主侧）。
 *
 * 目标：无论当前模型是否多模态，对话都可以携带图片发送；
 * 对不支持图片输入的模型，在请求进入适配器之前把图片块替换为
 * 视觉模型生成的文字描述（vision-helper 同款能力，内置于插件）。
 *
 * 工作机制（三个接入点，全部可逆、随 Fiber 回收）：
 *  1. 包装共享 LlmRuntime 实例的 `resolveModelInfo`：
 *     对显式声明仅支持文本的模型补上 `image` 模态。
 *     —— 打开 api-proxy 的 prompt / selectModel 图片准入门禁，
 *     同时让 dsh-tool-fs 的 read_image 对任意模型可用。
 *  2. 包装共享 LlmRuntime 实例的 `streamWithRegistration`：
 *     请求携带图片且目标模型（按未补丁前的真实能力判断）不支持
 *     图片时，先把图片块替换为视觉模型描述文本，再交给原方法。
 *     —— 会话日志/界面仍显示原图，只有发给模型的请求被改写。
 *  3. 注册 `vision` 模型工具：主动分析本地图片路径或 http(s) 图片
 *     链接（等价于 vision-helper 的 vision.js，内置到插件）。
 *
 * 视觉服务配置（优先级从高到低）：
 *  环境变量 VISION_BASE_URL / VISION_MODEL / VISION_API_KEY
 *  （与 vision-helper 同名，另支持 VISION_PROXY / VISION_MAX_TOKENS /
 *   VISION_TIMEOUT_MS / DSH_VISION_ENABLED）
 *   > $DSH_HOME/storages/dsh-vision/config.json
 *   > <插件目录>/config.json
 *   > 内置默认值（api.sudocode.chat / gpt-5.6-luna，key 留空）。
 *
 * 纯 Node 内置模块实现，无第三方运行时依赖。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'

export const name = 'dsh-vision'
/** 硬依赖：llm 服务（LlmRuntime）。attachments / tools 为可选能力。 */
export const inject = ['llm']

// ---------------------------------------------------------------------------
// 常量与默认值
// ---------------------------------------------------------------------------

/** 无附带文字时的默认识图指令（与 vision-helper 默认问题一致，要求逐字 OCR）。 */
export const DEFAULT_VISION_PROMPT = '请详细描述这张图片的内容：画面主体、布局、颜色、数字与图表数据，以及图中出现的所有文字（逐字 OCR 提取）。'

const DEFAULT_CONFIG = {
  enabled: true,
  baseUrl: 'https://api.sudocode.chat/v1',
  model: 'gpt-5.6-luna',
  apiKey: '',
  proxy: '',
  maxTokens: 1024,
  timeoutMs: 120000,
  cacheMaxEntries: 200,
}

/** 识图失败结果在缓存中的存活时间（避免每轮对话重复轰炸视觉 API）。 */
const FAILURE_CACHE_TTL_MS = 60000

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 插件包根目录（lib/ 的上一级）。 */
export function pluginRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

function readConfigFile(file) {
  try {
    const stat = statSync(file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return { file, mtimeMs: stat.mtimeMs, values: parsed }
  } catch {
    return undefined
  }
}

/** 按优先级找到第一个存在的配置文件。 */
export function findConfigFile() {
  const candidates = [
    join(dshHome(), 'storages', 'dsh-vision', 'config.json'),
    join(pluginRoot(), 'config.json'),
  ]
  for (const file of candidates) {
    const found = readConfigFile(file)
    if (found !== undefined) return found
  }
  return { file: '', mtimeMs: 0, values: {} }
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asPositiveInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function asBool(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'true' || t === '1' || t === 'yes') return true
    if (t === 'false' || t === '0' || t === 'no') return false
  }
  return fallback
}

/** 合并环境变量与配置文件，产出本次生效的视觉服务配置。 */
export function resolveConfig(env) {
  const file = findConfigFile()
  const fv = file.values
  return {
    enabled: asBool(env.DSH_VISION_ENABLED, asBool(fv.enabled, DEFAULT_CONFIG.enabled)),
    baseUrl: (asString(env.VISION_BASE_URL) || asString(fv.baseUrl) || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, ''),
    model: asString(env.VISION_MODEL) || asString(fv.model) || DEFAULT_CONFIG.model,
    apiKey: asString(env.VISION_API_KEY) || asString(fv.apiKey) || DEFAULT_CONFIG.apiKey,
    proxy: asString(env.VISION_PROXY) || asString(fv.proxy) || DEFAULT_CONFIG.proxy,
    maxTokens: asPositiveInt(env.VISION_MAX_TOKENS, asPositiveInt(fv.maxTokens, DEFAULT_CONFIG.maxTokens)),
    timeoutMs: asPositiveInt(env.VISION_TIMEOUT_MS, asPositiveInt(fv.timeoutMs, DEFAULT_CONFIG.timeoutMs)),
    cacheMaxEntries: asPositiveInt(fv.cacheMaxEntries, DEFAULT_CONFIG.cacheMaxEntries),
    _fileMtimeMs: file.mtimeMs,
  }
}

// ---------------------------------------------------------------------------
// 视觉 HTTP 客户端（vision-helper vision.js 同款逻辑 + 超时/取消）
// ---------------------------------------------------------------------------

/** 环境变量代理 → Windows 注册表系统代理（与 vision.js 一致）。 */
export function getSystemProxy() {
  if (process.env.HTTPS_PROXY) return process.env.HTTPS_PROXY
  if (process.env.https_proxy) return process.env.https_proxy
  if (process.env.HTTP_PROXY) return process.env.HTTP_PROXY
  if (process.env.http_proxy) return process.env.http_proxy
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      )
      const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/)
      if (m) return `http://${m[1]}`
    } catch { /* 无系统代理或查询失败：直连 */ }
  }
  return ''
}

/**
 * OpenAI 兼容 chat/completions 请求。
 * 支持 http/https 目标、显式/环境/系统代理（https 走 CONNECT，http 走绝对 URI），
 * 超时与外部 AbortSignal 均可终止。
 * @returns 首个 choice 的 message.content 文本。
 */
export function visionChat(config, payload, signal) {
  const target = new URL(`${config.baseUrl}/chat/completions`)
  const body = JSON.stringify({ ...payload, stream: false })
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  }
  const proxyText = asString(config.proxy) || getSystemProxy()
  let proxy
  if (proxyText.length > 0) {
    try { proxy = new URL(proxyText) } catch { proxy = undefined }
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let socket
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      const err = new Error('vision request aborted')
      err.name = 'AbortError'
      finish(reject, err)
      if (socket !== undefined) socket.destroy()
    }
    const timer = setTimeout(() => {
      const err = new Error(`vision request timed out after ${config.timeoutMs} ms`)
      err.name = 'TimeoutError'
      finish(reject, err)
      if (socket !== undefined) socket.destroy()
    }, config.timeoutMs)
    if (signal !== undefined) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const handleResponse = (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return finish(reject, new Error(`vision API ${res.statusCode}: ${String(data).slice(0, 300)}`))
        }
        try {
          const parsed = JSON.parse(data)
          const content = parsed?.choices?.[0]?.message?.content
          finish(resolve, typeof content === 'string' && content.length > 0 ? content : data)
        } catch {
          finish(resolve, data)
        }
      })
      res.on('error', (error) => finish(reject, error))
    }

    if (proxy !== undefined && target.protocol === 'https:') {
      // HTTPS 目标走代理 CONNECT 隧道（vision.js 同款）。
      const transport = proxy.protocol === 'https:' ? https : http
      const port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80)
      const connect = transport.request({
        host: proxy.hostname,
        port,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: { Host: `${target.hostname}:${target.port || 443}` },
      })
      connect.on('connect', (res, tunnel) => {
        if (res.statusCode !== 200) return finish(reject, new Error(`proxy CONNECT failed: ${res.statusCode}`))
        const req = https.request({
          host: target.hostname,
          port: target.port || 443,
          socket: tunnel,
          agent: false,
          method: 'POST',
          path: `${target.pathname}${target.search}`,
          headers,
        }, handleResponse)
        req.on('error', (error) => finish(reject, error))
        req.write(body)
        req.end()
      })
      connect.on('error', (error) => finish(reject, error))
      connect.end()
      return
    }

    if (proxy !== undefined && target.protocol === 'http:') {
      // HTTP 目标走绝对 URI 代理请求。
      const transport = proxy.protocol === 'https:' ? https : http
      const port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80)
      const req = transport.request({
        host: proxy.hostname,
        port,
        method: 'POST',
        path: target.href,
        headers: { ...headers, Host: target.host },
      }, handleResponse)
      socket = req.socket
      req.on('error', (error) => finish(reject, error))
      req.write(body)
      req.end()
      return
    }

    const transport = target.protocol === 'https:' ? https : http
    const req = transport.request(target, { method: 'POST', headers }, handleResponse)
    socket = req.socket
    req.on('error', (error) => finish(reject, error))
    req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// 图片块识别与内容桥接
// ---------------------------------------------------------------------------

/** 递归判断内容块中是否包含图片（与 dsh-llm 的 contentHasImage 同语义）。 */
export function contentHasImage(blocks) {
  if (!Array.isArray(blocks)) return false
  return blocks.some((block) =>
    (block !== null && typeof block === 'object' && block.type === 'image')
    || (block !== null && typeof block === 'object' && block.type === 'tool-result' && contentHasImage(block.content)))
}

/** 消息列表中是否存在图片（逐条消息解包 content，递归处理 tool-result）。 */
export function messagesHaveImage(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => message !== null && typeof message === 'object' && contentHasImage(message.content))
}

/** 统计消息列表中的图片块总数（递归）。 */
export function countImagesInMessages(messages) {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const message of messages) {
    if (message !== null && typeof message === 'object') n += countImages(message.content)
  }
  return n
}

/** 统计图片块数量（递归）。 */
export function countImages(blocks) {
  if (!Array.isArray(blocks)) return 0
  let n = 0
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'image') n += 1
    else if (block.type === 'tool-result') n += countImages(block.content)
  }
  return n
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 附带用户文字时的识图问题：要求先完整识别（含 OCR）再作答。 */
export function buildVisionPrompt(userText) {
  const t = typeof userText === 'string' ? userText.trim() : ''
  if (t.length === 0) return DEFAULT_VISION_PROMPT
  return `${t}\n\n（请基于这张图片作答：先完整识别图片内容——画面主体、布局、颜色、数字与图表数据，并逐字提取图中所有文字/OCR——然后回答上面的问题。）`
}

/**
 * 对一张图片执行视觉识别。
 * @param state - 插件运行时状态（attachments / config / cache）。
 * @param attachment - ImageAttachmentRef（attachmentId / mediaType / bytes ...）。
 * @param prompt - 附带文字（决定识图问题与缓存键）。
 * @param signal - 外层请求的取消信号。
 * @returns 替换图片块的文本块内容。
 */
export async function describeImage(state, attachment, prompt, signal) {
  const key = `${attachment.attachmentId}\u0000${prompt}`
  const hit = state.cache.get(key)
  if (hit !== undefined && (hit.ok || Date.now() - hit.ts < FAILURE_CACHE_TTL_MS)) return hit.text

  let text
  let ok = false
  try {
    const store = state.attachments
    if (store === undefined) throw new Error('the durable attachment service is unavailable')
    const stored = await store.readImage(attachment, signal)
    const mediaType = stored.ref?.mediaType || attachment.mediaType
    const dataUrl = `data:${mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
    const visionPrompt = buildVisionPrompt(prompt)
    const content = await visionChat(state.config, {
      model: state.config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: visionPrompt },
        ],
      }],
      max_tokens: state.config.maxTokens,
    }, signal)
    text = `[vision: 图片视觉识别结果]\n${content}`
    ok = true
  } catch (error) {
    text = `[vision: 图片识别失败——当前文本模型无法直接查看该图片，且视觉模型调用失败]\n原因：${error instanceof Error ? error.message : String(error)}`
  }
  state.cachePut(key, { text, ts: Date.now(), ok })
  return text
}

/** 递归替换内容块中的图片为文本描述；tool-result 嵌套内容一并处理。 */
export async function bridgeContent(state, blocks, textContext, signal) {
  const out = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'image') {
      out.push({ type: 'text', text: await describeImage(state, block.attachment, textContext, signal) })
    } else if (block !== null && typeof block === 'object' && block.type === 'tool-result' && Array.isArray(block.content)) {
      out.push({ ...block, content: await bridgeContent(state, block.content, textOf(block.content), signal) })
    } else {
      out.push(block)
    }
  }
  return out
}

/** 把请求消息列表中的图片全部桥接为文本（不改动原对象）。 */
export async function bridgeMessages(state, messages, signal) {
  return Promise.all(messages.map(async (message) => {
    if (message === null || typeof message !== 'object' || !contentHasImage(message.content)) return message
    return { ...message, content: await bridgeContent(state, message.content, textOf(message.content), signal) }
  }))
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const runtime = ctx.llm
  const logger = ctx.logger
  const state = {
    attachments: ctx.get('attachments'),
    tools: ctx.get('tools'),
    config: resolveConfig(process.env),
    cache: new Map(),
  }
  state.cachePut = (key, entry) => {
    if (state.cache.has(key)) state.cache.delete(key) // 重新插入以刷新 LRU 顺序
    state.cache.set(key, entry)
    const max = state.config.cacheMaxEntries
    while (state.cache.size > max) {
      const oldest = state.cache.keys().next().value
      if (oldest === undefined) break
      state.cache.delete(oldest)
    }
  }
  /** 配置文件 mtime 变化时热重载。 */
  const maybeReload = () => {
    try {
      const file = findConfigFile()
      if (file.mtimeMs !== state.config._fileMtimeMs && file.file.length > 0) {
        state.config = resolveConfig(process.env)
        logger.info('dsh-vision: config reloaded')
      }
    } catch (error) {
      logger.warn(`dsh-vision: config reload failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return state.config
  }

  // -------------------------------------------------------------------------
  // 补丁 1：模型能力补齐 —— 对声明为纯文本的模型补上 image 模态。
  // 效果：api-proxy 的 prompt/selectModel 准入放行图片；dsh-tool-fs 的
  // read_image 对任意模型可用。识别到的图片仍会被补丁 2 桥接成文本。
  // -------------------------------------------------------------------------
  const originalResolveModelInfo = runtime.resolveModelInfo.bind(runtime)
  const wrappedResolveModelInfo = async function resolveModelInfo(provider, model, signal) {
    const info = await originalResolveModelInfo(provider, model, signal)
    const mods = info === null || typeof info !== 'object' ? undefined : info.inputModalities
    if (mods !== undefined && !mods.includes('image')) {
      return { ...info, inputModalities: [...mods, 'image'] }
    }
    return info
  }
  runtime.resolveModelInfo = wrappedResolveModelInfo
  ctx.effect(() => () => {
    if (runtime.resolveModelInfo === wrappedResolveModelInfo) runtime.resolveModelInfo = originalResolveModelInfo
  }, 'dsh-vision: resolveModelInfo patch')

  // -------------------------------------------------------------------------
  // 补丁 2：请求桥接 —— 携带图片且目标模型真实能力不支持图片时，
  // 在进入适配器之前把图片替换为视觉描述文本。
  // -------------------------------------------------------------------------
  const originalStream = runtime.streamWithRegistration.bind(runtime)
  const wrappedStream = async function streamWithRegistration(options, prepared) {
    const config = maybeReload()
    if (!config.enabled || !messagesHaveImage(options.messages)) return originalStream(options, prepared)

    // 真实能力判断：使用未补丁的原始 resolveModelInfo。
    try {
      const info = await originalResolveModelInfo(options.provider, options.model, options.signal)
      const mods = info === null || typeof info !== 'object' ? undefined : info.inputModalities
      if (mods === undefined || mods.includes('image')) return originalStream(options, prepared)
    } catch (error) {
      // 能力查询失败（如适配器未注册）：保持原样，走正常错误路径。
      logger.warn(`dsh-vision: cannot resolve capability of ${String(options.provider)}/${String(options.model)}; leaving request untouched (${error instanceof Error ? error.message : String(error)})`)
      return originalStream(options, prepared)
    }

    try {
      const count = countImagesInMessages(options.messages)
      const messages = await bridgeMessages(state, options.messages, options.signal)
      logger.info(`dsh-vision: bridged ${count} image(s) into text for ${String(options.provider)}/${String(options.model)}`)
      return originalStream({ ...options, messages }, prepared)
    } catch (error) {
      // 桥接失败：保持原请求，由适配器/门禁正常报错，绝不静默吞图。
      logger.warn(`dsh-vision: image bridge failed; leaving request untouched (${error instanceof Error ? error.message : String(error)})`)
      return originalStream(options, prepared)
    }
  }
  runtime.streamWithRegistration = wrappedStream
  ctx.effect(() => () => {
    if (runtime.streamWithRegistration === wrappedStream) runtime.streamWithRegistration = originalStream
  }, 'dsh-vision: streamWithRegistration patch')

  // -------------------------------------------------------------------------
  // 能力 3：vision 模型工具 —— 主动识图（本地路径 / http(s) 链接），
  // 与 vision-helper 的 vision.js 能力一致，直接内置。
  // -------------------------------------------------------------------------
  if (state.tools !== undefined) {
    const dispose = state.tools.register({
      name: 'vision',
      description:
        'Analyze a local image file or an http(s) image URL with the configured vision model and return a text description. '
        + 'Use it whenever the user references an image path/URL, asks to describe, analyze, OCR, or answer questions about an image. '
        + 'Accepts png/jpeg/webp/gif/bmp files.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: {
            type: 'string',
            description: 'Local image file path (absolute or workspace-relative) or an http(s):// image URL.',
          },
          question: {
            type: 'string',
            description: 'Optional question about the image; omit to get a full description with OCR of all text.',
          },
        },
        required: ['source'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: state.config.timeoutMs + 5000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const config = maybeReload()
        if (!config.enabled) throw new Error('dsh-vision is disabled (DSH_VISION_ENABLED=false or config enabled:false)')
        const source = typeof args.source === 'string' ? args.source.trim() : ''
        if (source.length === 0) throw new Error('vision: source must be a non-empty image path or http(s) URL')
        const question = typeof args.question === 'string' ? args.question.trim() : ''

        let imageUrl
        if (/^https?:\/\//i.test(source)) {
          imageUrl = source
        } else {
          const file = resolvePath(source)
          if (!existsSync(file)) throw new Error(`vision: image file does not exist: ${file}`)
          const ext = extname(file).toLowerCase().slice(1)
          const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }
          const mediaType = mimeMap[ext] || 'image/jpeg'
          const data = readFileSync(file)
          imageUrl = `data:${mediaType};base64,${data.toString('base64')}`
        }

        const prompt = buildVisionPrompt(question)
        return visionChat(config, {
          model: config.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: prompt },
            ],
          }],
          max_tokens: config.maxTokens,
        }, exec.signal)
      },
    })
    ctx.effect(() => dispose, 'dsh-vision: vision tool')
  }

  logger.info(
    `dsh-vision: ready (vision model ${state.config.model} @ ${state.config.baseUrl || '(unset)'}, `
    + `bridge=${state.config.enabled ? 'on' : 'off'}, apiKey=${state.config.apiKey.length > 0 ? 'set' : 'MISSING'})`,
  )
}
