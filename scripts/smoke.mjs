#!/usr/bin/env node
/**
 * dsh-vision 冒烟测试（离线，内置假视觉服务器）。
 * 覆盖 lib/vision.js 核心：
 *   1) effectiveVisionConfig 解析与 config.json 兜底
 *   2) 适配器层包装：resolveModel 能力补齐、stream 图片桥接（含缓存、嵌套 tool-result）
 *   3) 多模态模型（真实能力含 image）原样直传
 *   4) llm/adapters-updated 增量包装
 *   5) 卸载完整还原
 * 宿主入口 lib/index.js（Config/defineTool/installSettingsSection）由 npm run check 做语法校验，
 * 并在真实 harness 中验证。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import {
  contentHasImage,
  buildVisionPrompt,
  effectiveVisionConfig,
  installAdapterWraps,
} from '../lib/vision.js'

// 1x1 PNG（透明像素），足够让假服务器走完图片路径。
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

// ---------------------------------------------------------------------------
// 假视觉服务器
// ---------------------------------------------------------------------------
let visionHits = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    visionHits += 1
    const parsed = JSON.parse(body)
    const text = parsed.messages?.[0]?.content?.some?.((b) => b?.type === 'image_url')
      ? '图中是一个红色方块（fake-vision-server 生成）。'
      : '无图片'
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

process.env.VISION_BASE_URL = `http://127.0.0.1:${port}/v1`
process.env.VISION_MODEL = 'fake-vision'
process.env.VISION_API_KEY = 'test-key'
process.env.VISION_PROXY = 'direct'

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------
assert.equal(contentHasImage([{ type: 'text', text: 'x' }]), false)
assert.equal(contentHasImage([{ type: 'tool-result', content: [{ type: 'image', attachment: {} }] }]), true)
assert.ok(buildVisionPrompt('这是什么').includes('这是什么'))
assert.equal(buildVisionPrompt('  ').includes('OCR'), true)
const section = { enabled: true, baseUrl: '', model: '', proxy: '', maxTokens: 2048, timeoutMs: 90000, cacheMaxEntries: 50 }
const cfg = effectiveVisionConfig(section, process.env)
assert.equal(cfg.baseUrl, `http://127.0.0.1:${port}/v1`)
assert.equal(cfg.model, 'fake-vision')
assert.equal(cfg.maxTokens, 2048)
assert.equal(cfg.timeoutMs, 90000)
assert.equal(cfg.enabled, true)
console.log('ok: pure functions + effectiveVisionConfig')

// ---------------------------------------------------------------------------
// mock LlmRuntime + 适配器
// ---------------------------------------------------------------------------
let trueModalities = ['text']
const received = []
let listeners = []

const adapter = {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: trueModalities }
  },
  async *stream(options) {
    received.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const runtime = {
  registrations: new Map([['deepseek', { provider: { id: 'deepseek' }, adapter, retryPolicy: undefined }]]),
  listProviders() {
    return [...this.registrations.keys()].map((id) => ({ id, name: id }))
  },
  registration(provider) {
    const registration = this.registrations.get(provider)
    if (!registration) throw new Error(`no adapter registered for provider "${provider}"`)
    return registration
  },
}

let events = []
const ctx = {
  llm: runtime,
  on(name, listener) {
    events.push({ name, listener })
    return () => { events = events.filter((e) => e.listener !== listener) }
  },
  get(name) {
    if (name === 'attachments') return {
      async readImage(ref) {
        return { ref, data: new Uint8Array(Buffer.from(PNG_B64, 'base64')) }
      },
    }
    return undefined
  },
  logger: { info() {}, warn: console.warn, error: console.error },
  effect(fn) { return () => {} },
}

const effects = []
const disposeFns = []
const deps = {
  enabled: () => section.enabled !== false,
  section: () => section,
  resolveApiKey: async () => 'test-key',
  attachments: ctx.get('attachments'),
  cache: new Map(),
  logger: ctx.logger,
}

// ---------------------------------------------------------------------------
// 包装与桥接
// ---------------------------------------------------------------------------
const unwrap = installAdapterWraps(ctx, runtime, deps)

// 1) 能力补齐：resolveModel 补上 image
const patchedInfo = await adapter.resolveModel('deepseek', 'deepseek-chat')
assert.deepEqual(patchedInfo.inputModalities, ['text', 'image'], 'resolveModel must claim image support')
console.log('ok: adapter resolveModel patch adds image modality')

// 2) 桥接：带图片请求 → 原适配器收到纯文本消息
const request = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  sessionId: 's1',
  messages: [{
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: '这张图什么颜色？' },
      { type: 'image', attachment: { attachmentId: 'img1', mediaType: 'image/png', bytes: 68, width: 1, height: 1 } },
    ],
  }],
}
for await (const _ of adapter.stream(request)) { /* drain */ }
assert.equal(received.length, 1)
const bridged = received[0]
assert.notEqual(bridged, request, 'bridged request must be a new object')
assert.equal(contentHasImage(bridged.messages[0].content), false, 'no image may reach the adapter')
assert.ok(bridged.messages[0].content.some((b) => b.type === 'text' && b.text.includes('红色')), 'bridged text must carry the vision description')
assert.equal(bridged.messages[0].content[0].text, '这张图什么颜色？', 'original user text preserved')
console.log('ok: adapter stream bridges image -> text')

// 3) 缓存：同样的 attachmentId+text 不重复调用视觉服务
const hitsBefore = visionHits
for await (const _ of adapter.stream(request)) { /* drain */ }
assert.equal(visionHits, hitsBefore, 'second identical request must hit the cache')
console.log('ok: description cache works')

// 4) 嵌套 tool-result 桥接 + 不同问题触发新识图
const request2 = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  sessionId: 's1',
  messages: [{
    role: 'user',
    source: { kind: 'user' },
    content: [{
      type: 'tool-result',
      toolCallId: 'c1',
      content: [
        { type: 'image', attachment: { attachmentId: 'img2', mediaType: 'image/png', bytes: 68, width: 1, height: 1 } },
        { type: 'text', text: '里面的字是什么？' },
      ],
    }],
  }],
}
for await (const _ of adapter.stream(request2)) { /* drain */ }
assert.equal(visionHits, hitsBefore + 1)
assert.equal(contentHasImage(received.at(-1).messages[0].content), false, 'nested tool-result image must be bridged')
console.log('ok: nested tool-result bridging + prompt-keyed cache')

// 5) 多模态模型原样直传
trueModalities = ['text', 'image']
const before = received.length
const request3 = { ...request2, provider: 'pi-ai', model: 'pi-ai-vision' }
for await (const _ of adapter.stream(request3)) { /* drain */ }
assert.equal(received.length, before + 1)
assert.ok(contentHasImage(received.at(-1).messages[0].content), 'multimodal model must receive the raw image')
console.log('ok: multimodal models keep raw images')

// 6) llm/adapters-updated 增量包装：新注册的文本适配器同样被桥接
const adapter2 = {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text'] }
  },
  async *stream(options) {
    received.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
runtime.registrations.set('custom', { provider: { id: 'custom' }, adapter: adapter2, retryPolicy: undefined })
for (const { listener } of events) listener()
const request4 = { ...request, provider: 'custom', model: 'custom-chat' }
for await (const _ of adapter2.stream(request4)) { /* drain */ }
assert.equal(contentHasImage(received.at(-1).messages[0].content), false, 'newly registered adapter must be wrapped')
assert.deepEqual((await adapter2.resolveModel('custom', 'custom-chat')).inputModalities, ['text', 'image'])
console.log('ok: llm/adapters-updated rewraps new adapters')

// 7) 卸载还原
unwrap()
trueModalities = ['text']
const restoredInfo = await adapter.resolveModel('deepseek', 'deepseek-chat')
assert.equal(restoredInfo.inputModalities.includes('image'), false, 'resolveModel patch must be fully reverted')
const imageRequest = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  sessionId: 's1',
  messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'img9', mediaType: 'image/png', bytes: 68, width: 1, height: 1 } }] }],
}
for await (const _ of adapter.stream(imageRequest)) { /* drain */ }
assert.ok(contentHasImage(received.at(-1).messages[0].content), 'restored stream must pass images through untouched')
assert.equal(events.length, 0, 'adapters-updated listener must be removed')
console.log('ok: disposal restores adapters and removes the listener')

server.close()
console.log('\nsmoke: ALL PASS')
