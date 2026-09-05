#!/usr/bin/env node
/**
 * 截断检测回归测试：finish_reason=length 时必须报错而非静默返回半截内容。
 */
import { strict as assert } from 'node:assert'
import http from 'node:http'
import { visionChat } from '../lib/vision.js'

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{
        message: { role: 'assistant', content: '回答被截断的半截内容，包含' },
        finish_reason: 'length',
      }],
    }))
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

// 1. finish_reason=length 必须抛错
await assert.rejects(
  visionChat({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', maxTokens: 100, timeoutMs: 5000, proxy: 'direct' }, { model: 'm', messages: [] }),
  (err) => {
    assert.equal(err.name, 'VisionTruncatedError')
    assert.ok(err.message.includes('max_tokens'))
    return true
  },
)
console.log('ok: finish_reason=length raises VisionTruncatedError instead of returning truncated content')

// 2. 正常响应不受影响
const server2 = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '完整回答' }, finish_reason: 'stop' }],
  }))
})
await new Promise((r) => server2.listen(0, '127.0.0.1', r))
const port2 = server2.address().port
const ok = await visionChat({ baseUrl: `http://127.0.0.1:${port2}/v1`, apiKey: 'k', maxTokens: 100, timeoutMs: 5000, proxy: 'direct' }, { model: 'm', messages: [] })
assert.equal(ok, '完整回答')
console.log('ok: finish_reason=stop returns content normally')

server.close()
server2.close()
console.log('\ntruncation-check: ALL PASS')
