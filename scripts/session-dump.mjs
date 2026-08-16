#!/usr/bin/env node
// Dump the tail events of a dsh session log (zstd frames) for diagnosis.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const tailCount = Number(process.argv[3] || 40)
const MAGIC = 0xfd2fb528
const buf = readFileSync(file)

// 定位所有帧边界（magic 起始）
const frames = []
for (let i = 0; i < buf.length - 3; i++) {
  if (buf.readUInt32LE(i) === MAGIC) frames.push(i)
}
frames.push(buf.length)
const events = []
for (let f = 0; f < frames.length - 1; f++) {
  const raw = buf.subarray(frames[f], frames[f + 1])
  try {
    const text = zstdDecompressSync(raw).toString('utf8').trim()
    if (!text) continue
    for (const line of text.split('\n')) {
      try { events.push(JSON.parse(line)) } catch { /* torn */ }
    }
  } catch (e) {
    // 尝试前缀解码（尾部帧可能被截断）
    try {
      const text = zstdDecompressSync(raw, { finishFlush: 2 }).toString('utf8').trim()
      if (text) for (const line of text.split('\n')) { try { events.push(JSON.parse(line)) } catch { /* torn */ } }
    } catch { /* skip */ }
  }
}
console.log(`total events: ${events.length}`)
const tail = events.slice(-tailCount)
for (const ev of tail) {
  const d = ev.data ?? {}
  let extra = ''
  if (ev.type === 'user/message' || ev.type === 'assistant/message' || ev.type === 'tool/result') {
    const msg = d.message ?? d
    const content = Array.isArray(msg.content)
      ? msg.content.map((b) => {
          if (b.type === 'text') return `[text:${String(b.text).slice(0, 120).replace(/\n/g, '⏎')}]`
          if (b.type === 'image') return `[image:${b.attachment?.attachmentId?.slice(0, 20)}…]`
          if (b.type === 'tool-call') return `[tool-call:${b.name}]`
          if (b.type === 'tool-result') return `[tool-result]`
          return `[${b.type}]`
        }).join(' ') : '?'
    extra = ` :: ${content.slice(0, 500)}`
  } else if (ev.type === 'turn/end') {
    extra = ` :: ${JSON.stringify(d.reason).slice(0, 300)}`
  } else if (ev.type === 'step/start') {
    extra = ` :: turn=${d.turn} step=${d.step}`
  } else if (ev.type === 'assistant/chunk' && d.chunk?.type === 'finish') {
    extra = ` :: ${JSON.stringify(d.chunk.reason).slice(0, 200)}`
  } else if (d && typeof d === 'object' && Object.keys(d).length > 0) {
    extra = ` :: ${JSON.stringify(d).slice(0, 220)}`
  }
  console.log(`seq=${ev.seq ?? '?'} ${ev.type}${extra}`)
}
