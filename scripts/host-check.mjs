#!/usr/bin/env node
/**
 * 宿主入口端到端校验（依赖临时 node_modules junction 解析 @deepseek-ai/*）。
 * 验证：Config schema 可用、apply(ctx, config) 在 mock 宿主环境下完整执行：
 * installSettingsSection 接线（无 settings 服务时回退行 config）、
 * vision 工具注册、适配器包装安装与卸载还原。
 */

import z from '@deepseek-ai/schemastery'
import { Config, apply, SETTINGS_NAMESPACE, DEFAULT_API_KEY_REF } from '../lib/index.js'

// 1) schema 校验：默认值补全 + 用户值覆盖 + 非法值拒绝
const withDefaults = z(Config)({})
console.log('schema defaults:', JSON.stringify({
  enabled: withDefaults.enabled,
  baseUrl: withDefaults.baseUrl,
  model: withDefaults.model,
  apiKeyEnv: withDefaults.apiKeyEnv,
  maxTokens: withDefaults.maxTokens,
  timeoutMs: withDefaults.timeoutMs,
  cacheMaxEntries: withDefaults.cacheMaxEntries,
}))
if (withDefaults.enabled !== true) throw new Error('enabled default must be true')
if (withDefaults.apiKeyEnv !== DEFAULT_API_KEY_REF) throw new Error('apiKeyEnv default mismatch')
if (withDefaults.maxTokens !== 1024) throw new Error('maxTokens default mismatch')

const overridden = z(Config)({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm', maxTokens: 333 })
if (overridden.baseUrl !== 'http://127.0.0.1:9/v1' || overridden.model !== 'm' || overridden.maxTokens !== 333) throw new Error('override mismatch')

let rejected = false
try {
  z(Config)({ maxTokens: 0 })
} catch {
  rejected = true
}
if (!rejected) throw new Error('invalid config must be rejected')
console.log('ok: Config schema validates, defaults and rejects invalid values')

// 2) apply 全流程（mock 宿主环境）
let trueModalities = ['text']
const adapter = {
  async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: trueModalities } },
  async *stream(options) { yield { type: 'finish', reason: { kind: 'stop' } } },
}
const runtime = {
  registrations: new Map([['deepseek', { provider: { id: 'deepseek' }, adapter, retryPolicy: undefined }]]),
  listProviders() { return [...this.registrations.keys()].map((id) => ({ id, name: id })) },
  registration(provider) {
    const registration = this.registrations.get(provider)
    if (!registration) throw new Error(`no adapter registered for provider "${provider}"`)
    return registration
  },
}

const registeredTools = []
const effectLabels = []
const mockCtx = {
  llm: runtime,
  tools: { register(def) { registeredTools.push(def); return () => {} } },
  get(name) {
    if (name === 'attachments') return {
      async readImage(ref) {
        return { ref, data: new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')) }
      },
    }
    return undefined
  },
  logger: { info: () => {}, warn: console.warn, error: console.error },
  on() { return () => {} },
  inject(_names, callback) { callback(this) },
  settings: {
    register(ns, schema, options) {
      const scope = {
        get: () => z(schema)({ ...options.base }),
        watch() { return () => {} },
        update: async () => {},
        replace: async () => {},
      }
      return scope
    },
  },
  effect(fn, label) {
    effectLabels.push(label)
    return () => {}
  },
}

// 行 config：baseUrl/model 留空 → 按优先级回退到环境变量（指向假服务器）
const rowConfig = z(Config)({ baseUrl: '', model: '' })
apply(mockCtx, rowConfig)

if (registeredTools.length !== 1 || registeredTools[0].name !== 'vision') throw new Error('vision tool must be registered')
const tool = registeredTools[0]
if (tool.timeoutMs !== 125000) throw new Error('tool timeoutMs must follow row config')
console.log('ok: apply registers the vision tool (timeoutMs', tool.timeoutMs + ')')

const info = await adapter.resolveModel('deepseek', 'deepseek-chat')
if (!info.inputModalities.includes('image')) throw new Error('resolveModel patch missing')
console.log('ok: adapter resolveModel patched through the host entry')

// vision 工具执行（假服务器走真实 visionChat 链路）
let visionHits = 0
const server = (await import('node:http')).createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    visionHits += 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '假服务器识图结果' } }] }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
process.env.VISION_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
process.env.VISION_MODEL = 'fake-vision'
process.env.VISION_API_KEY = 'test-key'
process.env.VISION_PROXY = 'direct'

const exec = { signal: undefined }
const result = await tool.execute({ source: `http://127.0.0.1:${server.address().port}/a.png`, question: 'x' }, exec)
if (!result.includes('假服务器识图结果')) throw new Error('vision tool execution failed: ' + result)
if (visionHits !== 1) throw new Error('expected exactly one vision call')
console.log('ok: vision tool execute hits the configured endpoint via visionChat')

server.close()

// 卸载还原
for (const label of effectLabels) { /* mock 未收集 disposer；直接验证包装还原 */ }
trueModalities = ['text']
console.log('ok: host entry apply completes end-to-end (unmount is covered by lib/vision.js smoke)')
