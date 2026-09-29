#!/usr/bin/env node
/**
 * Static client contract check.
 *
 * Two UI generations are covered because both registrations ship in one bundle:
 *  - dsh 0.2.0+ : `plugins.bundle.config` (keyed by the bundle package name),
 *    rendered on the plugin-manager detail page, values via ctx.configForms;
 *  - dsh ≤0.1.5 : `settings.plugin.item` (keyed by the settings namespace).
 *
 * The client bundle is intentionally self-contained and cannot be imported in Node.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---- dsh 0.2.0+：插件管理器配置页 ----
assert.match(
  source,
  /slots\.inject\(['"]plugins\.bundle\.config['"]/,
  'plugin-manager config page must wait for the plugins.bundle.config declaration',
)
assert.match(
  source,
  /name:\s*['"]plugins\.bundle\.config['"][\s\S]{0,200}?key:\s*PKG_NAME/,
  'plugins.bundle.config must be keyed by the bundle package name',
)
assert.match(source, /PKG_NAME\s*=\s*['"]@cdxdnrf\/dsh-vision['"]/, 'the bundle key must be this package name')
assert.match(source, /ctx\.configForms\.get|configForms\.get/, 'the page must read values through ctx.configForms')
assert.match(source, /credentials\.describe|credentials\.set/, 'the page must handle the API key through credentials')

// ---- dsh ≤0.1.5：设置页卡片（向后兼容）----
assert.match(source, /name:\s*['"]settings\.plugin\.item['"]/, 'legacy settings card slot must remain')
assert.match(source, /key:\s*SETTINGS_NS/, 'legacy keyed settings slot must use the served settings namespace')
assert.doesNotMatch(source, /id:\s*['"]dsh-vision['"]/, 'keyed slots must not use the removed list-slot id')

// ---- 服务读取必须可选：0.1.x 的 settingsScope 在 0.2.0 已移除 ----
assert.match(source, /const inject = \['slots', 'locale'\]/, 'inject must stay on version-stable services only')
assert.match(source, /ctx\.get\(['"]configForms['"]\)/, 'configForms must be read optionally through ctx.get')
assert.match(source, /ctx\.get\(['"]settingsScope['"]\)/, 'settingsScope must be read optionally through ctx.get')

console.log('client-contract: ALL PASS')