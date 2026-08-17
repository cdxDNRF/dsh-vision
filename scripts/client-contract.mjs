#!/usr/bin/env node
/**
 * Static client contract check for dsh 0.1.0-rc.7+.
 * The client bundle is intentionally self-contained and cannot be imported in Node.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(source, /name:\s*['"]settings\.plugin\.item['"]/, 'settings card must target the settings plugin slot')
assert.match(source, /key:\s*SETTINGS_NS/, 'rc.7 keyed settings slot must use the served settings namespace')
assert.doesNotMatch(source, /id:\s*['"]dsh-vision['"]/, 'rc.7 keyed slot must not use the old list-slot id')
assert.match(source, /slots\.inject\(['"]settings\.plugin\.item['"]/, 'slot registration must wait for the declaration')
console.log('client-contract: ALL PASS')
