#!/usr/bin/env node
/**
 * 宿主入口端到端校验（零依赖，任何机器可直接运行）。
 * 验证：Config 的 Standard Schema 契约（loader 调用路径）、callable/toJSON（settings 服务契约）、
 * apply(ctx, config) 完整执行：设置段接线（无 settings 服务时回退行 config）、
 * configurable-provider 目录暴露、vision 工具注册与执行链路、适配器包装。
 */

import { strict as assert } from 'node:assert'
import http from 'node:http'
import { Config, validateSection, apply, SETTINGS_NAMESPACE, DEFAULT_API_KEY_REF } from '../lib/index.js'

// ---------------------------------------------------------------------------
// 1) Config schema：loader 契约（~standard.validate）+ settings 契约（callable/toJSON）
// ---------------------------------------------------------------------------
// loader 调用方式：runtime.Config['~standard'].validate(config)
const stdResult = Config['~standard'].validate({ baseUrl: 'http://127.0.0.1:9/v1', maxTokens: 333 })
assert.ok(stdResult.issues === undefined, 'standard validate must accept partial config')
assert.equal(stdResult.value.baseUrl, 'http://127.0.0.1:9/v1')
assert.equal(stdResult.value.enabled, true, 'defaults must be filled')
assert.equal(stdResult.value.apiKeyEnv, DEFAULT_API_KEY_REF)
assert.equal(stdResult.value.maxTokens, 333)
assert.equal(stdResult.value.timeoutMs, 120000)

// 非法值响亮拒绝
const bad = Config['~standard'].validate({ maxTokens: 0, nope: 1 })
assert.ok(Array.isArray(bad.issues) && bad.issues.length === 2, 'invalid fields must produce issues')

// settings 契约：schema(merged) 可调用
const resolved = Config({ enabled: false, proxy: 'direct' })
assert.equal(resolved.enabled, false)
assert.equal(resolved.proxy, 'direct')
assert.equal(resolved.baseUrl, 'https://api.sudocode.chat/v1')

// settings 契约：toJSON() 信封（uid/refs 结构）
const envelope = Config.toJSON()
assert.equal(typeof envelope.uid, 'number')
assert.equal(typeof envelope.refs, 'object')
const root = envelope.refs[envelope.uid]
assert.equal(root.type, 'object')
assert.ok(root.dict.apiKey !== undefined && root.dict.baseUrl !== undefined && root.dict.model !== undefined)
assert.equal(envelope.refs[root.dict.apiKey].meta.role, 'secret', 'apiKey must be a secret role')
assert.equal(envelope.refs[root.dict.apiKeyEnv].meta.role, 'credential-ref', 'apiKeyEnv must be a credential-ref role')
console.log('ok: Config standard-schema / callable / toJSON envelope contracts')

// redactSecrets 节点结构兼容：meta.role / type / dict 可遍历
const secrets = []
for (const [key, node] of Object.entries(Config.dict)) {
  if (node.meta?.role === 'secret') secrets.push(key)
}
assert.deepEqual(secrets, ['apiKey'])
console.log('ok: redactSecrets node-structure compatibility')

// ---------------------------------------------------------------------------
// 2) apply 全流程（mock 宿主环境）
// ---------------------------------------------------------------------------
let trueModalities = ['text']
const adapter = {
  async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: trueModalities } },
  async *stream(options) { yield { type: 'finish', reason: { kind: 'stop' } } },
}
const registeredProviders = []
const runtime = {
  registrations: new Map([['deepseek', { provider: { id: 'deepseek' }, adapter, retryPolicy: undefined }]]),
  listProviders() { return [...this.registrations.keys()].map((id) => ({ id, name: id })) },
  registration(provider) {
    const registration = this.registrations.get(provider)
    if (!registration) throw new Error(`no adapter registered for provider "${provider}"`)
    return registration
  },
  registerConfigurableProviders(entries) {
    registeredProviders.push(entries)
    return () => {}
  },
}

const registeredTools = []
const registeredNamespaces = []
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
      registeredNamespaces.push({ ns, base: options.base })
      const scope = {
        get: () => schema({ ...options.base }),
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

const rowConfig = Config({ baseUrl: '', model: '' }) // 空 baseUrl/model → 环境变量回退
apply(mockCtx, rowConfig)

// 设置命名空间注册（base = 行 config）
assert.equal(registeredNamespaces.length, 1)
assert.equal(registeredNamespaces[0].ns, SETTINGS_NAMESPACE)
assert.equal(registeredNamespaces[0].base.baseUrl, '')
console.log('ok: settings namespace registered with row config as base')

// configurable-provider 目录暴露（GUI 卡片可见性）
assert.equal(registeredProviders.length, 1)
assert.deepEqual(registeredProviders[0][0], {
  provider: 'dsh-vision',
  displayName: 'dsh-vision (vision bridge)',
  settingsNs: SETTINGS_NAMESPACE,
  settingsPath: [],
})
console.log('ok: configurable-provider directory exposure')

// vision 工具注册（手写 ToolDefinition 的 JSON Schema 参数）
assert.equal(registeredTools.length, 1)
assert.equal(registeredTools[0].name, 'vision')
assert.equal(registeredTools[0].parameters.type, 'object')
assert.deepEqual(registeredTools[0].parameters.required, ['source'])
assert.equal(registeredTools[0].timeoutMs, 125000)
console.log('ok: vision tool registered (hand-built JSON Schema definition)')

// 适配器包装（经宿主入口）
const info = await adapter.resolveModel('deepseek', 'deepseek-chat')
assert.ok(info.inputModalities.includes('image'), 'resolveModel patch missing')
console.log('ok: adapter resolveModel patched through the host entry')

// vision 工具执行（假服务器走真实 visionChat 链路）
let visionHits = 0
const server = http.createServer((req, res) => {
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
const result = await registeredTools[0].execute({ source: `http://127.0.0.1:${server.address().port}/a.png`, question: 'x' }, exec)
assert.ok(result.includes('假服务器识图结果'), 'vision tool execution failed: ' + result)
assert.equal(visionHits, 1, 'expected exactly one vision call')
console.log('ok: vision tool execute hits the configured endpoint via visionChat')

server.close()
console.log('\nhost-check: ALL PASS')
