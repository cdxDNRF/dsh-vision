/**
 * dsh-vision 核心（零第三方运行时依赖，仅 Node 内置模块）。
 *
 * 职责：
 *  - 图片块识别 / 桥接（图片 → 视觉模型文字描述）
 *  - OpenAI 兼容视觉 HTTP 客户端（代理：显式 > 环境变量 > Windows 系统代理）
 *  - 配置解析（settings 段 > 环境变量 > config.json 兜底 > 内置默认）
 *  - 适配器层包装：对文本模型补齐 image 能力声明 + 请求桥接
 *
 * 与 Harness 的接缝（全部可逆、随 Fiber 回收）：
 *  1. adapter.resolveModel —— 对显式纯文本模型补上 `image` 输入模态。
 *     打开 api-proxy 的 prompt / selectModel 图片准入门禁，并让
 *     dsh-tool-fs 的 read_image 对任意模型可用。
 *  2. adapter.stream —— 请求带图且目标模型（按未包装前的真实能力判断）
 *     不支持图片时，把图片块替换为视觉模型描述文本，再交给原适配器。
 *     `llm/adapters-updated` 事件驱动对新注册适配器的增量包装。
 *
 * 会话日志与界面始终显示原图；只有进入适配器的请求被改写。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'

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
  maxTokens: 4096,
  timeoutMs: 120000,
  cacheMaxEntries: 200,
}

/** 识图失败结果在缓存中的存活时间（避免每轮对话重复轰炸视觉 API）。 */
const FAILURE_CACHE_TTL_MS = 60000

// ---------------------------------------------------------------------------
// 兜底配置（config.json，legacy 机制；GUI/设置优先）
// ---------------------------------------------------------------------------

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function pluginRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

function readConfigFile(file) {
  try {
    const stat = statSync(file)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return { file, values: parsed }
  } catch {
    return undefined
  }
}

export function findConfigFile() {
  const candidates = [
    join(dshHome(), 'storages', 'dsh-vision', 'config.json'),
    join(pluginRoot(), 'config.json'),
  ]
  for (const file of candidates) {
    const found = readConfigFile(file)
    if (found !== undefined) return found.values
  }
  return {}
}

/** 读取 config.json 兜底值（GUI 未配置时的最后手段）。 */
export function readConfigFileValue(key) {
  const values = findConfigFile()
  return values?.[key]
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asPositiveInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * 解析本次操作生效的视觉服务配置。
 * 优先级：settings 段（base=组合行 config → schema 默认）> 环境变量 > config.json > 内置默认。
 * apiKey 由调用方单独解析（凭证服务每操作解析一次）。
 * @param section - 当前 settings 段（已由框架校验并补全默认值）。
 * @param env - process.env 快照。
 */
export function effectiveVisionConfig(section, env) {
  const file = findConfigFile()
  return {
    enabled: section.enabled !== false,
    baseUrl: (asString(section.baseUrl) || asString(env.VISION_BASE_URL) || asString(file.baseUrl) || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, ''),
    model: asString(section.model) || asString(env.VISION_MODEL) || asString(file.model) || DEFAULT_CONFIG.model,
    proxy: asString(section.proxy) || asString(env.VISION_PROXY) || asString(file.proxy) || DEFAULT_CONFIG.proxy,
    maxTokens: asPositiveInt(section.maxTokens, asPositiveInt(env.VISION_MAX_TOKENS, asPositiveInt(file.maxTokens, DEFAULT_CONFIG.maxTokens))),
    timeoutMs: asPositiveInt(section.timeoutMs, asPositiveInt(env.VISION_TIMEOUT_MS, asPositiveInt(file.timeoutMs, DEFAULT_CONFIG.timeoutMs))),
    cacheMaxEntries: asPositiveInt(section.cacheMaxEntries, asPositiveInt(file.cacheMaxEntries, DEFAULT_CONFIG.cacheMaxEntries)),
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
 * 支持 http/https 目标、显式/环境/系统代理（https 走 CONNECT，http 走绝对 URI）；
 * `direct` / `none` 显式禁用代理。超时与外部 AbortSignal 均可终止。
 * @returns 首个 choice 的 message.content 文本。
 */
export function visionChat(config, payload, signal) {
  const baseUrl = asString(config.baseUrl) || DEFAULT_CONFIG.baseUrl
  const target = new URL(`${baseUrl.replace(/\/+$/, '')}/chat/completions`)
  const body = JSON.stringify({ ...payload, stream: false })
  const headers = {
    Authorization: `Bearer ${asString(config.apiKey)}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  }
  const proxyText = asString(config.proxy) || getSystemProxy()
  let proxy
  if (proxyText.length > 0 && proxyText !== 'direct' && proxyText !== 'none') {
    try { proxy = new URL(proxyText) } catch { proxy = undefined }
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let socket
    let timer
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
    timer = setTimeout(() => {
      const err = new Error(`vision request timed out after ${config.timeoutMs} ms`)
      err.name = 'TimeoutError'
      finish(reject, err)
      if (socket !== undefined) socket.destroy()
    }, asPositiveInt(config.timeoutMs, DEFAULT_CONFIG.timeoutMs))
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
          const finishReason = parsed?.choices?.[0]?.finish_reason
          if (finishReason === 'length') {
            const err = new Error(
              `vision model output was truncated by max_tokens (${config.maxTokens}); `
              + 'increase the "maxTokens" setting or ask a more focused question',
            )
            err.name = 'VisionTruncatedError'
            return finish(reject, err)
          }
          finish(resolve, typeof content === 'string' && content.length > 0 ? content : data)
        } catch (error) {
          if (error?.name === 'VisionTruncatedError') return finish(reject, error)
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
  return `${t}\n\n（请直接回答上面的问题，不要先做整体描述。回答要具体、简洁，可引用图中文字。）`
}

function boundedCachePut(state, key, entry) {
  const cache = state.cache
  if (cache.has(key)) cache.delete(key) // 重新插入以刷新 LRU 顺序
  cache.set(key, entry)
  const max = asPositiveInt(state.section().cacheMaxEntries, DEFAULT_CONFIG.cacheMaxEntries)
  while (cache.size > max) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/**
 * 对一张图片执行视觉识别。
 * @param state - 桥接状态（section / resolveApiKey / attachments / cache / logger）。
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
    const section = state.section()
    const config = {
      ...effectiveVisionConfig(section, process.env),
      apiKey: await state.resolveApiKey(),
    }
    const content = await visionChat(config, {
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: visionPrompt },
        ],
      }],
      max_tokens: config.maxTokens,
    }, signal)
    text = `[vision: 图片视觉识别结果]\n${content}`
    ok = true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      state.logger?.warn(`dsh-vision: vision recognition failed for ${String(attachment?.attachmentId).slice(0, 24)}…: ${message}`)
    } catch { /* 日志失败不得影响桥接 */ }
    text = `[vision: 图片识别失败——当前文本模型无法直接查看该图片，且视觉模型调用失败]\n原因：${message}`
  }
  boundedCachePut(state, key, { text, ts: Date.now(), ok })
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
// 适配器层包装
// ---------------------------------------------------------------------------

/** 包装一个适配器实例的 resolveModel / stream；重复调用跳过。 */
function wrapAdapter(runtime, providerId, deps, wrapped) {
  let registration
  try {
    registration = runtime.registration(providerId)
  } catch {
    return
  }
  const adapter = registration?.adapter
  if (adapter === undefined || adapter === null || wrapped.has(adapter)) return

  const state = {
    section: deps.section,
    resolveApiKey: deps.resolveApiKey,
    attachments: deps.attachments,
    cache: deps.cache,
    logger: deps.logger,
  }

  const origResolveModel = adapter.resolveModel.bind(adapter)
  const wrappedResolveModel = async function resolveModel(provider, model, signal) {
    const info = await origResolveModel(provider, model, signal)
    if (!deps.enabled()) return info
    const mods = info === null || typeof info !== 'object' ? undefined : info.inputModalities
    if (mods !== undefined && !mods.includes('image')) {
      return { ...info, inputModalities: [...mods, 'image'] }
    }
    return info
  }

  const origStream = adapter.stream.bind(adapter)
  const wrappedStream = async function* stream(options) {
    if (deps.enabled() && messagesHaveImage(options.messages)) {
      try {
        const info = await origResolveModel(options.provider, options.model, options.signal)
        const mods = info === null || typeof info !== 'object' ? undefined : info.inputModalities
        if (mods !== undefined && !mods.includes('image')) {
          const count = countImagesInMessages(options.messages)
          const messages = await bridgeMessages(state, options.messages, options.signal)
          deps.logger.info(`dsh-vision: bridged ${count} image(s) into text for ${String(options.provider)}/${String(options.model)}`)
          yield* origStream({ ...options, messages })
          return
        }
      } catch (error) {
        deps.logger.warn(`dsh-vision: image bridge failed; leaving request untouched (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    yield* origStream(options)
  }

  adapter.resolveModel = wrappedResolveModel
  adapter.stream = wrappedStream
  wrapped.set(adapter, { origResolveModel, origStream })
}

function unwrapAll(wrapped) {
  for (const [adapter, originals] of wrapped) {
    try {
      adapter.resolveModel = originals.origResolveModel
      adapter.stream = originals.origStream
    } catch { /* 适配器可能已被替换/冻结 */ }
  }
  wrapped.clear()
}

function wrapAll(runtime, deps, wrapped) {
  let providers = []
  try {
    providers = runtime.listProviders()
  } catch (error) {
    deps.logger.warn(`dsh-vision: cannot enumerate providers (${error instanceof Error ? error.message : String(error)})`)
    return
  }
  for (const provider of providers) {
    try {
      wrapAdapter(runtime, provider.id, deps, wrapped)
    } catch (error) {
      deps.logger.warn(`dsh-vision: cannot wrap adapter "${String(provider.id)}" (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

/**
 * 安装适配器层包装（能力补齐 + 图片桥接），并跟随 `llm/adapters-updated`
 * 事件增量包装后续注册的适配器。返回卸载函数（还原全部包装并移除监听）。
 * @param ctx - 宿主插件上下文。
 * @param runtime - LlmRuntime 实例（ctx.llm）。
 * @param deps - { enabled, section, state, resolveApiKey, attachments, cache, logger }。
 */
export function installAdapterWraps(ctx, runtime, deps) {
  const wrapped = new Map()
  wrapAll(runtime, deps, wrapped)
  const disposeListener = ctx.on('llm/adapters-updated', () => {
    wrapAll(runtime, deps, wrapped)
  })
  return () => {
    disposeListener()
    unwrapAll(wrapped)
  }
}
