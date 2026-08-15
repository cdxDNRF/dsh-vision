#!/usr/bin/env node
/**
 * dsh-vision 独立识图脚本 —— 与 vision-helper 的 vision.js 用法一致，
 * 配置读取顺序：环境变量 VISION_* > $DSH_HOME/storages/dsh-vision/config.json
 * > <插件目录>/config.json > 内置默认值。
 *
 * 用法:
 *   node cli/vision.mjs <图片路径> [问题]
 *   node cli/vision.mjs --url <图片链接> [问题]
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve as resolvePath, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, visionChat, buildVisionPrompt } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  let imageSource = ''
  let prompt = ''
  let isUrl = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) {
      isUrl = true
      imageSource = argv[++i]
    } else if (!imageSource && !argv[i].startsWith('--')) {
      imageSource = argv[i]
    } else if (imageSource && !argv[i].startsWith('--')) {
      prompt = prompt ? `${prompt} ${argv[i]}` : argv[i]
    }
  }
  return { imageSource, prompt, isUrl }
}

function resolveImageUrl(source, isUrl) {
  if (isUrl) return source
  const file = resolvePath(source)
  if (!existsSync(file)) throw new Error(`文件不存在: ${file}`)
  const ext = extname(file).toLowerCase().slice(1)
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }
  const data = readFileSync(file)
  return `data:${mimeMap[ext] || 'image/jpeg'};base64,${data.toString('base64')}`
}

async function main() {
  const { imageSource, prompt, isUrl } = parseArgs(process.argv.slice(2))
  if (!imageSource) {
    console.error('用法: node cli/vision.mjs <图片路径> [问题]')
    console.error('      node cli/vision.mjs --url <图片链接> [问题]')
    process.exit(1)
  }
  const config = resolveConfig(process.env)
  if (!config.enabled) {
    console.error('dsh-vision 已禁用（DSH_VISION_ENABLED=false）。')
    process.exit(1)
  }
  if (!config.apiKey) {
    console.error('缺少 API Key：请设置 VISION_API_KEY 环境变量，或在 config.json 中填写 apiKey。')
    process.exit(1)
  }
  try {
    const imageUrl = resolveImageUrl(imageSource, isUrl)
    const result = await visionChat(config, {
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: buildVisionPrompt(prompt) },
        ],
      }],
      max_tokens: config.maxTokens,
    })
    console.log(result)
  } catch (err) {
    console.error('识图失败:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
