/**
 * dsh-vision — DeepSeek Harness 视觉桥接插件（宿主侧入口）。
 *
 * 按官方文档规范编写：
 *  - 导出 `Config`（Schemastery schema），`apply(ctx, config)` 接收校验后的配置；
 *    行 config 作为 settings 的 base 层，`installSettingsSection` 挂接设置服务，
 *    GUI（设置 → 插件 → 插件配置）中的修改写入用户层并即时生效。
 *  - 通过 `defineTool`（@deepseek-ai/dsh-tools）注册 `vision` 模型工具。
 *  - 适配器层包装（lib/vision.js）：文本模型能力补齐 + 图片自动桥接，
 *    全部副作用挂在 Fiber 上，停止/更新自动还原。
 *  - API Key 通过凭证服务（credentials，默认引用 VISION_API_KEY）按操作解析，
 *    不在配置与日志中泄漏明文。
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
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
/** 硬依赖：llm（适配器包装）、tools（vision 工具注册）。 */
export const inject = ['llm', 'tools']

/** settings 命名空间（GUI 插件配置卡片读写该段）。 */
export const SETTINGS_NAMESPACE = settingsNamespace('dsh-vision')

/** 默认凭证引用：环境变量名（凭证服务 + 环境 + config.json 三层兜底）。 */
export const DEFAULT_API_KEY_REF = 'VISION_API_KEY'

/**
 * 插件配置 schema（官方规范：默认值写在 schema 中；组合行 config 作为 base 层）。
 * `apiKey` 为 secret（红线加密，不进前端响应）；`apiKeyEnv` 为凭证引用
 * （GUI 卡片通过凭证服务写入该引用，不落明文到设置文档）。
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('https://api.sudocode.chat/v1'),
  model: z.string().default('gpt-5.6-luna'),
  apiKey: z.string().role('secret').default(''),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_REF),
  proxy: z.string().default(''),
  maxTokens: z.number().step(1).min(1).default(1024),
  timeoutMs: z.number().step(1).min(1000).default(120000),
  cacheMaxEntries: z.number().step(1).min(1).default(200),
})

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
        const resolved = await credentials.resolve(credentialRef(refName))
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
    attachments: ctx.get('attachments'),
    cache,
    logger,
  }

  // 能力 1+2：适配器层包装（文本模型能力补齐 + 图片自动桥接）。
  const unwrapAdapters = installAdapterWraps(ctx, ctx.llm, deps)
  ctx.effect(() => unwrapAdapters, 'dsh-vision: adapter wraps')

  // 能力 3：vision 模型工具 —— 主动识图（本地路径 / http(s) 链接）。
  const disposeTool = ctx.tools.register(defineTool({
    name: 'vision',
    description:
      'Analyze a local image file or an http(s) image URL with the configured vision model and return a text description. '
      + 'Use it whenever the user references an image path/URL, asks to describe, analyze, OCR, or answer questions about an image. '
      + 'Accepts png/jpeg/webp/gif/bmp files.',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'Local image file path (absolute or workspace-relative) or an http(s):// image URL.',
      },
      question: {
        type: 'string',
        description: 'Optional question about the image; omit to get a full description with OCR of all text.',
      },
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
  }))
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
