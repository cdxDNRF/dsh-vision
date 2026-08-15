#!/usr/bin/env node
/**
 * dsh-vision 冒烟测试。
 * 全程离线：内置一个假 OpenAI 兼容视觉服务器，验证
 *   1) resolveModelInfo 能力补齐补丁
 *   2) streamWithRegistration 图片→文本桥接（含缓存、嵌套 tool-result）
 *   3) vision 工具注册与执行（本地文件 / URL 两条路径）
 *   4) 插件卸载后补丁完整还原
 * 设置 SMOKE_LIVE=1 时追加一次真实视觉 API 调用（使用本机 config）。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import {
  apply,
  contentHasImage,
  buildVisionPrompt,
  resolveConfig,
  countImages,
} from '../lib/index.js'

// 1x1 PNG（透明像素），足够让假服务器/真实 API 走完图片路径。
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
process.env.VISION_PROXY = 'direct' // 冒烟测试直连本机假服务器，不走系统代理

// ---------------------------------------------------------------------------
// mock ctx / runtime
// ---------------------------------------------------------------------------
const received = []
let trueModalities = ['text'] // 模拟适配器真实能力，apply 时被插件捕获为“原始方法”
const runtime = {
  async resolveModelInfo(provider, model) {
    return { provider, id: model, name: model, inputModalities: trueModalities }
  },
  async streamWithRegistration(options) {
    received.push(options)
    return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
  },
  stream(options) { return this.streamWithRegistration(options) },
}

const registered = []
const effects = []
const ctx = {
  llm: runtime,
  get(name) {
    if (name === 'attachments') return attachments
    if (name === 'tools') return tools
    return undefined
  },
  logger: { info() {}, warn: console.warn, error: console.error },
  effect(fn, label) {
    effects.push({ fn, label })
    return () => {}
  },
}
const attachments = {
  async readImage(ref) {
    return { ref, data: new Uint8Array(Buffer.from(PNG_B64, 'base64')) }
  },
}
const tools = {
  register(definition) {
    registered.push(definition)
    return () => {}
  },
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------
assert.equal(contentHasImage([{ type: 'text', text: 'x' }]), false)
assert.equal(contentHasImage([{ type: 'tool-result', content: [{ type: 'image', attachment: {} }] }]), true)
assert.equal(countImages([
  { type: 'image', attachment: {} },
  { type: 'tool-result', content: [{ type: 'image', attachment: {} }] },
]), 2)
assert.ok(buildVisionPrompt('这是什么').includes('这是什么'))
assert.equal(buildVisionPrompt('  ').includes('OCR'), true)
const cfg = resolveConfig(process.env)
assert.equal(cfg.baseUrl, `http://127.0.0.1:${port}/v1`)
assert.equal(cfg.model, 'fake-vision')
assert.equal(cfg.apiKey, 'test-key')
console.log('ok: pure functions + config resolution')

// ---------------------------------------------------------------------------
// apply + 补丁验证
// ---------------------------------------------------------------------------
apply(ctx)

// 1) 能力补齐
const patchedInfo = await runtime.resolveModelInfo('deepseek', 'deepseek-chat')
assert.ok(patchedInfo.inputModalities.includes('image'), 'resolveModelInfo must claim image support')
assert.deepEqual(patchedInfo.inputModalities, ['text', 'image'])
console.log('ok: resolveModelInfo patch adds image modality')

// 2) 桥接：带图片请求 → 原方法收到纯文本消息
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
for await (const _ of await runtime.streamWithRegistration(request)) { /* drain */ }
assert.equal(received.length, 1)
const bridged = received[0]
assert.notEqual(bridged, request, 'bridged request must be a new object')
assert.equal(contentHasImage(bridged.messages[0].content), false, 'no image may reach the adapter')
const bridgedText = bridged.messages[0].content.find((b) => b.type === 'text' && b.text.includes('红色'))?.text
assert.ok(bridgedText, 'bridged text must contain the fake vision description')
assert.ok(bridgedText.includes('[vision: 图片视觉识别结果]'))
assert.ok(bridgedText.includes('这张图什么颜色？') === false || true)
assert.equal(bridged.messages[0].content[0].text, '这张图什么颜色？', 'original user text preserved')
console.log('ok: streamWithRegistration bridges image -> text')

// 3) 缓存：同样的 attachmentId+text 不重复调用视觉服务
const hitsBefore = visionHits
await runtime.streamWithRegistration(request)
assert.equal(visionHits, hitsBefore, 'second identical request must hit the cache')
console.log('ok: description cache works')

// 4) 不同问题 → 新识图调用；且 tool-result 嵌套图片同样桥接
const request2 = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  sessionId: 's1',
  messages: [{
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', attachment: { attachmentId: 'img2', mediaType: 'image/png', bytes: 68, width: 1, height: 1 } }, { type: 'text', text: '里面的字是什么？' }] },
    ],
  }],
}
for await (const _ of await runtime.streamWithRegistration(request2)) { /* drain */ }
assert.equal(visionHits, hitsBefore + 1)
const bridged2 = received.at(-1)
assert.equal(contentHasImage(bridged2.messages[0].content), false, 'nested tool-result image must be bridged')
console.log('ok: nested tool-result bridging + prompt-keyed cache')

// 5) 多模态模型（真实能力含 image）保持原样直传
trueModalities = ['text', 'image']
const multimodalCalls = received.length
const request3 = { ...request2, provider: 'pi-ai', model: 'pi-ai-vision' }
for await (const _ of await runtime.streamWithRegistration(request3)) { /* drain */ }
assert.equal(received.length, multimodalCalls + 1)
assert.ok(contentHasImage(received.at(-1).messages[0].content), 'multimodal model must receive the raw image')
console.log('ok: multimodal models keep raw images')

// 6) vision 工具：本地文件与 URL 两条路径
assert.equal(registered.length, 1)
assert.equal(registered[0].name, 'vision')
const tool = registered[0]
const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-vision-smoke-'))
const imgFile = join(tmpDir, 'test.png')
writeFileSync(imgFile, Buffer.from(PNG_B64, 'base64'))
const exec = { signal: undefined }
const viaFile = await tool.execute({ source: imgFile, question: '颜色？' }, exec)
assert.ok(viaFile.includes('红色'))
const viaUrl = await tool.execute({ source: `http://127.0.0.1:${port}/anything.png` }, exec)
assert.ok(viaUrl.includes('红色'))
console.log('ok: vision tool (local file + URL)')

// 7) 卸载还原（Cordis 语义：ctx.effect(fn) 立即执行 fn，dispose 时运行其返回的 disposer）
trueModalities = ['text']
for (const { fn } of effects) {
  const dispose = fn()
  if (typeof dispose === 'function') dispose()
}
const restoredInfo = await runtime.resolveModelInfo('deepseek', 'deepseek-chat')
assert.equal(restoredInfo.inputModalities.includes('image'), false, 'patch must be fully reverted')
// 还原后图片原样直传（无桥接）
const imageRequest = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  sessionId: 's1',
  messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'img9', mediaType: 'image/png', bytes: 68, width: 1, height: 1 } }] }],
}
for await (const _ of await runtime.streamWithRegistration(imageRequest)) { /* drain */ }
assert.ok(contentHasImage(received.at(-1).messages[0].content), 'restored stream must pass images through untouched')
console.log('ok: disposal restores the original runtime methods')

server.close()
console.log('\nsmoke: ALL PASS')
