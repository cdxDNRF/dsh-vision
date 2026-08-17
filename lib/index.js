/**
 * dsh-vision — DeepSeek Harness 视觉桥接插件（宿主侧入口）。
 *
 * 架构原则（针对 2026-08-16 故障报告的根因）：**零 in-box 导入**。
 * 本模块不 import 任何 @deepseek-ai/* 包——Cordis loader 只要求 Config
 * 实现 Standard Schema 接口（`Config['~standard'].validate`），settings
 * 服务只要求 schema 可调用且带 `toJSON()`（节点结构兼容 redactSecrets
 * 与客户端 `new Schema(envelope)` 重水化），工具注册表接受普通
 * ToolDefinition，凭证服务接受普通字符串引用。全部按接口手写，因此：
 *  - 无论 pnpm / dsh plugin add 把什么物理副本装进 profile，插件自身的
 *    模块图都不会与 harness 产生第二个实例（Symbol 分裂类故障不可能发生）；
 *  - 包零依赖、零 peerDependencies，安装不会引入任何 in-box 副本。
 *
 * 功能：
 *  1. 适配器层包装（lib/vision.js）：文本模型能力补齐 + 图片自动桥接。
 *  2. `vision` 模型工具：主动识图（本地路径 / http(s) 链接）。
 *  3. 设置命名空间 `dsh-vision`（行 config 为 base，GUI「插件配置」卡片写入
 *     用户层即时生效）；通过 `llm.registerConfigurableProviders` 把命名空间
 *     暴露给 0.1.0-rc.6 的 Web 设置客户端（apiproxy 只暴露白名单 + 可配置
 *     provider 目录）。
 *  4. API Key 经凭证服务（默认引用 VISION_API_KEY）每操作解析，明文不落
 *     前端响应与日志。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve as resolvePath, extname } from 'node:path'
import {
  buildVisionPrompt,
  effectiveVisionConfig,
  installAdapterWraps,
  readConfigFileValue,
  visionChat,
} from './vision.js'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-vision'
/**
 * 硬依赖：llm（适配器包装 + 目录注册）、tools（vision 工具注册）、
 * attachments（桥接时读取图片字节——必须声明注入：不声明时本行可能
 * 与附件服务同波激活，apply 时刻 `ctx.get('attachments')` 会拿到
 * undefined 并被永久捕获进闭包，导致所有识图失败）。
 */
export const inject = ['llm', 'tools', 'attachments']

/** settings 命名空间（GUI 插件配置卡片读写该段；字符串即品牌运行时表现）。 */
export const SETTINGS_NAMESPACE = 'dsh-vision'

/** 默认凭证引用：环境变量名（凭证服务 + 环境 + config.json 三层兜底）。 */
export const DEFAULT_API_KEY_REF = 'VISION_API_KEY'

// ---------------------------------------------------------------------------
// Config schema（手写 Standard Schema + schemastery 兼容节点/toJSON 信封）
// ---------------------------------------------------------------------------

const FIELDS = [
  { key: 'enabled', type: 'boolean', default: true },
  { key: 'baseUrl', type: 'string', default: 'https://api.sudocode.chat/v1' },
  { key: 'model', type: 'string', default: 'gpt-5.6-luna' },
  { key: 'apiKey', type: 'string', role: 'secret', default: '' },
  { key: 'apiKeyEnv', type: 'string', role: 'credential-ref', default: DEFAULT_API_KEY_REF },
  { key: 'proxy', type: 'string', default: '' },
  { key: 'maxTokens', type: 'number', step: 1, min: 1, default: 1024 },
  { key: 'timeoutMs', type: 'number', step: 1, min: 1000, default: 120000 },
  { key: 'cacheMaxEntries', type: 'number', step: 1, min: 1, default: 200 },
]

const FIELDS_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]))

function checkField(field, value) {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, message: `${field.key} must be a boolean` }
    case 'string':
      return typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, message: `${field.key} must be a string` }
    case 'number': {
      const n = typeof value === 'number' ? value : NaN
      if (!Number.isFinite(n)) return { ok: false, message: `${field.key} must be a number` }
      if (field.step === 1 && !Number.isInteger(n)) return { ok: false, message: `${field.key} must be an integer` }
      if (field.min !== undefined && n < field.min) return { ok: false, message: `${field.key} must be >= ${field.min}` }
      return { ok: true, value: n }
    }
    default:
      return { ok: false, message: `${field.key}: unsupported type ${field.type}` }
  }
}

/**
 * 校验并补全默认值。未知字段响亮拒绝（文档原则「配置错误要响亮」）；
 * 返回 Standard Schema 结果 `{ value }` 或 `{ issues }`。
 */
export function validateSection(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'config must be an object' }] }
  }
  const out = {}
  const issues = []
  for (const [key, value] of Object.entries(raw)) {
    const field = FIELDS_BY_KEY.get(key)
    if (field === undefined) {
      issues.push({ message: `unknown field "${key}"`, path: [key] })
      continue
    }
    if (value === undefined) continue
    const checked = checkField(field, value)
    if (checked.ok) out[key] = checked.value
    else issues.push({ message: checked.message, path: [key] })
  }
  for (const field of FIELDS) {
    if (out[field.key] === undefined) out[field.key] = field.default
  }
  if (issues.length > 0) return { issues }
  return { value: out }
}

/** schemastery `toJSON()` 兼容信封（客户端 `new Schema(envelope)` 可重水化）。 */
function buildEnvelope() {
  const refs = {}
  let uid = 0
  const rootUid = ++uid
  const dictRefs = {}
  for (const field of FIELDS) {
    const fieldUid = ++uid
    const node = { type: field.type, meta: { default: field.default } }
    if (field.role !== undefined) node.meta.role = field.role
    if (field.type === 'number') {
      if (field.min !== undefined) node.meta.min = field.min
      if (field.step !== undefined) node.meta.step = field.step
    }
    refs[fieldUid] = node
    dictRefs[field.key] = fieldUid
  }
  refs[rootUid] = { type: 'object', meta: { default: {} }, dict: dictRefs }
  return { uid: rootUid, refs }
}

/** 手写 schema 节点：可调用（settings 服务 `schema(merged)`）+ 节点结构 + 信封。 */
export const Config = Object.assign(function configSchema(value) {
  const result = validateSection(value)
  if (result.issues) {
    const error = new Error(`invalid dsh-vision config: ${result.issues.map((issue) => issue.message).join('; ')}`)
    error.issues = result.issues
    throw error
  }
  return result.value
}, {
  type: 'object',
  meta: { default: {} },
  dict: Object.fromEntries(FIELDS.map((field) => {
    const meta = { default: field.default }
    if (field.role !== undefined) meta.role = field.role
    if (field.type === 'number') {
      if (field.min !== undefined) meta.min = field.min
      if (field.step !== undefined) meta.step = field.step
    }
    return [field.key, { type: field.type, meta }]
  })),
  '~standard': {
    version: 1,
    vendor: 'cdxdnrf',
    validate: (value) => validateSection(value),
  },
  toJSON: () => buildEnvelope(),
})

// ---------------------------------------------------------------------------
// 设置段接线（installSettingsSection 的零依赖内联等价物，逻辑同源）
// ---------------------------------------------------------------------------

/** Fiber 状态常量（与 dsh-settings 同值：4=disposed，5=unloading）。 */
function isUnloading(ctx) {
  const state = ctx.fiber?.state
  return state === 4 || state === 5
}

function installSettingsSection(ctx, ns, schema, entry, hooks) {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, { base: entry })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  // 设置段接线：settings 服务存在时注册命名空间（base = 组合行 config），
  // 服务不可用时回退到行 config。GUI 修改即时生效。
  let current = () => config
  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })

  // 0.1.0-rc.7 的 Web 设置客户端按「已服务命名空间」派发 keyed Slot。
  // 视觉网关不是 agent 的 LLM 路由，仍只声明 configurable provider，
  // 让 settings.describe() 返回 dsh-vision 并驱动客户端 settings 卡片。
  const disposeProviderEntry = ctx.llm.registerConfigurableProviders([{
    provider: 'dsh-vision',
    displayName: 'dsh-vision (vision bridge)',
    settingsNs: SETTINGS_NAMESPACE,
    settingsPath: [],
  }])
  ctx.effect(() => disposeProviderEntry, 'dsh-vision: configurable provider exposure')

  const logger = ctx.logger
  const cache = new Map()

  /** 每操作解析一次 API Key：段内字面量 > 凭证服务 > 进程环境 > config.json 兜底。 */
  const resolveApiKey = async () => {
    const section = current()
    const literal = typeof section.apiKey === 'string' ? section.apiKey.trim() : ''
    if (literal.length > 0) return literal
    const refName = (typeof section.apiKeyEnv === 'string' && section.apiKeyEnv.trim().length > 0)
      ? section.apiKeyEnv.trim()
      : DEFAULT_API_KEY_REF
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(refName)
        if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) return resolved.value
      } catch (error) {
        logger.warn(`dsh-vision: credential resolution for "${refName}" failed (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    const ambient = process.env[refName]
    if (typeof ambient === 'string' && ambient.trim().length > 0) return ambient.trim()
    return asString(readConfigFileValue('apiKey'))
  }

  const deps = {
    enabled: () => current().enabled !== false,
    section: () => current(),
    resolveApiKey,
    attachments: ctx.attachments,
    cache,
    logger,
  }

  // 能力 1+2：适配器层包装（文本模型能力补齐 + 图片自动桥接）。
  const unwrapAdapters = installAdapterWraps(ctx, ctx.llm, deps)
  ctx.effect(() => unwrapAdapters, 'dsh-vision: adapter wraps')

  // 能力 3：vision 模型工具 —— 主动识图（本地路径 / http(s) 链接）。
  // 手写 ToolDefinition（等价于 defineTool 的 JSON Schema 输出，零依赖）。
  const disposeTool = ctx.tools.register({
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
    timeoutMs: asPositiveInt(config.timeoutMs, 120000) + 5000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const section = current()
      if (section.enabled === false) throw new Error('dsh-vision is disabled (set enabled: true in its plugin configuration)')
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

      const visionConfig = {
        ...effectiveVisionConfig(section, process.env),
        apiKey: await resolveApiKey(),
      }
      return visionChat(visionConfig, {
        model: visionConfig.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: buildVisionPrompt(question) },
          ],
        }],
        max_tokens: visionConfig.maxTokens,
      }, exec.signal)
    },
  })
  ctx.effect(() => disposeTool, 'dsh-vision: vision tool')

  const section = current()
  logger.info(
    `dsh-vision: ready (vision model ${section.model || '(unset)'} @ ${section.baseUrl || '(unset)'}, `
    + `bridge=${section.enabled === false ? 'off' : 'on'}, keyRef=${section.apiKeyEnv || DEFAULT_API_KEY_REF})`,
  )
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asPositiveInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}
