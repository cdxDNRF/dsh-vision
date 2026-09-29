/**
 * dsh-vision 客户端半边 —— 两个 UI 世代共存，各自等自己的 Slot 声明：
 *
 * 1) dsh 0.2.0+（当前）：侧边栏「插件」面板（插件管理器）详情页的配置页
 *    - Slot `plugins.bundle.config`（keyed；`key` = 本 bundle 包名
 *      `@cdxdnrf/dsh-vision`）。注册后该 bundle 在插件页出现配置区，
 *      **点击插件进去即可配置 VLM 模型**（默认沿用组合层 gpt-5.6-luna）。
 *    - 值/写入走 `ctx.configForms.get('dsh-vision')`（`getSnapshot` /
 *      `subscribe` / `set` / `unset`），取代 0.1.x 的 `settingsScope`。
 *    - 0.2.0 已移除 `settings.plugin.item`，且插件 bundle 可能被新版插件管理器
 *      标记为未启用（`installed: true, enabled: false`）而不再加载。
 *
 * 2) dsh ≤0.1.5（向后兼容）：设置 → 插件 → 插件配置 卡片
 *    - Slot `settings.plugin.item`（keyed；`key` = 设置命名空间 `dsh-vision`）。
 *
 * 两代都用 `slots.inject` 等待声明，因此在不支持的那一代上静默不注册，
 * 不会因未知 Slot 抛错而拖垮客户端 bundle。
 * API Key 两代都走凭证域（`credentials.describe` / `credentials.set`），
 * 引用段内 `apiKeyEnv`（默认 VISION_API_KEY），明文永不进入前端状态与响应。
 *
 * 客户端 bundle 格式：自包含的 window.__ModuleLoader__.load({id, factory})，
 * 通过 require('react') 共享模块加载器的 React 实例。
 */
window.__ModuleLoader__.load({
  id: '@cdxdnrf/dsh-vision',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')

    const NS = 'dsh-vision-settings'
    const SETTINGS_NS = 'dsh-vision'
    const DEFAULT_API_KEY_REF = 'VISION_API_KEY'
    const API_KEY_FIELD = 'apiKey'

    // -------------------------------------------------------------------------
    // 样式（官方 CSS 注入模式：data-plugin-css 防重复）
    // -------------------------------------------------------------------------
    const css = [
      '.dsv-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
      '.dsv-card.open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.dsv-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      '.dsv-head-text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      '.dsv-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      '.dsv-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      '.dsv-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
      '.dsv-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;font-size:12px}',
      '.dsv-chevron.open{transform:rotate(180deg)}',
      '.dsv-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.dsv-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      '.dsv-field+.dsv-field{border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dsv-field-head{align-items:center;gap:8px;display:flex}',
      '.dsv-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
      '.dsv-badges{align-items:center;gap:8px;display:inline-flex}',
      '.dsv-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
      '.dsv-badge-muted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}',
      '.dsv-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}',
      '.dsv-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.dsv-reset:disabled{cursor:default}',
      '.dsv-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
      '.dsv-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.dsv-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dsv-input.invalid{border-color:var(--dsw-alias-label-error)}',
      '.dsv-error{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}',
      '.dsv-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
      '.dsv-note{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}',
      '.dsv-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
      '.dsv-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}',
      '.dsv-btn-discard,.dsv-btn-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
      '.dsv-btn-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
      '.dsv-btn-save{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-button-primary-fill-invert,var(--dsw-alias-label-primary))}',
      '.dsv-btn-save:disabled,.dsv-btn-discard:disabled{opacity:.45;cursor:default}',
    ].join('')
    const tagId = '@cdxdnrf/dsh-vision/settings-card.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@cdxdnrf/dsh-vision'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------------------
    // 字段控件（官方 settings-plugins 同款交互：暂存 → 保存统一写入）
    // -------------------------------------------------------------------------
    function ValueField(props) {
      return React.createElement('div', { className: 'dsv-field' },
        React.createElement('div', { className: 'dsv-field-head' },
          React.createElement('label', { className: 'dsv-label', htmlFor: props.id }, props.label),
          props.overridden ? React.createElement('span', { className: 'dsv-badges' },
            React.createElement('span', { className: 'dsv-badge' }, props.overriddenLabel),
            React.createElement('button', { type: 'button', className: 'dsv-reset', disabled: props.disabled, onClick: props.onReset }, props.resetLabel)) : null),
        React.createElement('input', {
          id: props.id,
          className: 'dsv-input' + (props.invalid ? ' invalid' : ''),
          type: 'text',
          ...props.numeric === true ? { inputMode: 'numeric' } : {},
          value: props.text,
          placeholder: props.placeholder ?? '',
          disabled: props.disabled,
          onChange: (event) => props.onEdit(event.target.value),
        }),
        React.createElement('p', { className: props.invalid ? 'dsv-error' : 'dsv-hint' }, props.invalid ? props.invalidLabel : props.hint))
    }

    function SecretField(props) {
      return React.createElement('div', { className: 'dsv-field' },
        React.createElement('div', { className: 'dsv-field-head' },
          React.createElement('label', { className: 'dsv-label', htmlFor: props.id }, props.label),
          React.createElement('span', { className: 'dsv-badges' },
            React.createElement('span', { className: props.configured ? 'dsv-badge' : 'dsv-badge-muted' }, props.stateLabel))),
        React.createElement('input', {
          id: props.id,
          className: 'dsv-input',
          type: 'password',
          autoComplete: 'off',
          value: props.text,
          disabled: props.disabled,
          onChange: (event) => props.onEdit(event.target.value),
        }),
        React.createElement('p', { className: 'dsv-hint' }, props.hint))
    }

    // -------------------------------------------------------------------------
    // 表单模型（与官方 settings-plugins 的 CardForm 同一契约）
    // -------------------------------------------------------------------------
    function numberField(field) {
      return {
        field,
        format: (value) => typeof value === 'number' ? String(value) : '',
        parse: (text) => {
          const trimmed = text.trim()
          if (trimmed === '') return { kind: 'clear' }
          const parsed = Number(trimmed)
          return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
        },
      }
    }

    function textField(field) {
      return {
        field,
        format: (value) => typeof value === 'string' ? value : '',
        parse: (text) => {
          const trimmed = text.trim()
          return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
        },
      }
    }

    class CardForm {
      constructor(scope, specs, secrets = []) {
        this.scope = scope
        this.specs = new Map(specs.map((spec) => [spec.field, spec]))
        this.secretSpecs = new Map(secrets.map((spec) => [spec.field, spec]))
        this.staged = new Map()
        this.listeners = new Set()
        this.saving = false
        this.failed = false
        scope.subscribe(() => { this.publish() })
      }

      bind(project) {
        const listeners = this.listeners
        let snapshot = project()
        const store = {
          getSnapshot: () => snapshot,
          subscribe: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          set: (value) => {
            snapshot = value
            for (const listener of listeners) listener()
          },
        }
        // 只刷新快照，不得再次通知监听器：
        // 该监听器排在 React 订阅者之前，publish()/store.set() 时先更新快照，
        // 后面的订阅者读到的就是最新值；若此处再调用 store.set() 会自我递归爆栈。
        this.listeners.add(() => { snapshot = project() })
        return store
      }

      shell() {
        const snapshot = this.scope.getSnapshot()
        const plan = this.plan()
        return {
          available: snapshot.status === 'ready',
          writable: snapshot.writable,
          dirty: plan.length > 0,
          invalid: plan.some((item) => item.run === undefined),
          saving: this.saving,
          failed: this.failed,
        }
      }

      field(field) {
        const staged = this.staged.get(field)
        if (this.secretSpecs.has(field)) {
          return { text: staged?.text ?? '', overridden: false, invalid: false }
        }
        const spec = this.spec(field)
        if (staged === undefined) {
          return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false }
        }
        const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text)
        return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
      }

      actions() {
        return {
          edit: (field, text) => {
            this.stage(field, { text, clear: false })
          },
          resetField: (field) => {
            this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
          },
          save: () => { this.save() },
          discard: () => {
            if (this.staged.size === 0 && !this.failed) return
            this.staged.clear()
            this.failed = false
            this.publish()
          },
        }
      }

      async save() {
        const plan = this.plan()
        const writes = plan.flatMap((item) => item.run === undefined ? [] : [item.run])
        if (plan.length === 0 || this.saving || writes.length !== plan.length) return
        this.saving = true
        this.failed = false
        this.publish()
        let landed = true
        for (const write of writes) landed = await write() && landed
        if (landed) this.staged.clear()
        this.saving = false
        this.failed = !landed
        this.publish()
      }

      plan() {
        const plan = []
        for (const [field, staged] of this.staged) {
          const secret = this.secretSpecs.get(field)
          if (secret !== undefined) {
            const value = staged.text.trim()
            if (value !== '') plan.push({ field, run: () => secret.write(value) })
            continue
          }
          const spec = this.spec(field)
          if (staged.clear) {
            if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
            continue
          }
          if (staged.text === spec.format(this.sectionValue(field))) continue
          const write = spec.parse(staged.text)
          if (write === undefined) plan.push({ field, run: undefined })
          else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
          else plan.push({ field, run: () => this.store(field, write.value) })
        }
        return plan
      }

      async clear(field) {
        await this.scope.unset(field)
        return !this.stored(field)
      }

      async store(field, value) {
        await this.scope.set(field, value)
        return this.userLayer()?.[field] === value
      }

      stage(field, edit) {
        this.staged.set(field, edit)
        this.failed = false
        this.publish()
      }

      spec(field) {
        const spec = this.specs.get(field)
        if (spec === undefined) throw new Error(`plugin card has no field ${field}`)
        return spec
      }

      snapshotOf() { return this.scope.getSnapshot() }
      sectionValue(field) { return this.snapshotOf().value?.[field] }
      baseValue(field) { return this.snapshotOf().base?.[field] }
      userLayer() { return this.snapshotOf().user }
      stored(field) {
        const user = this.userLayer()
        return user !== undefined && Object.hasOwn(user, field)
      }
      publish() { for (const listener of this.listeners) listener() }
    }

    // -------------------------------------------------------------------------
    // 卡片控制器：settings 段 + 凭证域
    // -------------------------------------------------------------------------
    class VisionCardController {
      constructor(scope, api) {
        this.scope = scope
        this.api = api
        this.form = new CardForm(scope, [
          textField('baseUrl'),
          textField('model'),
          textField('proxy'),
          numberField('maxTokens'),
          numberField('timeoutMs'),
        ], [{
          field: API_KEY_FIELD,
          write: (text) => this.writeKey(text),
        }])
        this.credential = { ref: '', configured: false, writable: true }
        this.store = this.form.bind(() => this.projection())
        scope.subscribe(() => { this.readCredential() })
        this.readCredential()
      }

      projection() {
        return {
          ...this.form.shell(),
          baseUrl: this.form.field('baseUrl'),
          model: this.form.field('model'),
          proxy: this.form.field('proxy'),
          maxTokens: this.form.field('maxTokens'),
          timeoutMs: this.form.field('timeoutMs'),
          apiKey: this.form.field(API_KEY_FIELD),
          apiKeyConfigured: this.credential.configured,
          apiKeyWritable: this.credential.writable,
        }
      }

      async readCredential() {
        const ref = this.refOf()
        if (ref !== this.credential.ref) {
          this.credential = { ref, configured: false, writable: true }
          this.store.set(this.projection())
        }
        let response
        try {
          response = await this.api.credentials.describe({ refs: [ref] })
        } catch (_credentialReadFailure) {
          return
        }
        if (!response.result.ok || ref !== this.refOf()) return
        const view = response.result.value.credentials[ref]
        const next = {
          ref,
          configured: view?.configured ?? false,
          writable: view?.writable ?? true,
        }
        if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
        this.credential = next
        this.store.set(this.projection())
      }

      refreshCredential(ref) {
        if (ref !== this.credential.ref) return
        this.readCredential()
      }

      inject() {
        return {
          hooks: { dshVisionCard: this.store },
          ...this.form.actions(),
        }
      }

      async writeKey(value) {
        try {
          await this.api.credentials.set({ ref: this.refOf(), value })
        } catch (_credentialWriteFailure) { /* 保存失败时保留草稿，卡片显示失败状态 */ }
        await this.readCredential()
        return this.credential.configured
      }

      refOf() {
        const declared = this.scope.getSnapshot().value?.apiKeyEnv
        return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
      }
    }

    // -------------------------------------------------------------------------
    // 卡片组件
    // -------------------------------------------------------------------------
    function VisionCard(props) {
      const { t } = props
      const [open, setOpen] = React.useState(false)
      const state = props.useDshVisionCard((snapshot) => snapshot)
      if (!state.available) return null
      const disabled = !state.writable
      const blocked = !state.dirty || state.invalid || state.saving
      return React.createElement('li', { className: 'dsv-card' + (open ? ' open' : '') },
        React.createElement('button', {
          type: 'button',
          className: 'dsv-head',
          'aria-expanded': open,
          'aria-label': `${t(open ? 'collapse' : 'expand')}: ${t('title')}`,
          onClick: () => setOpen(!open),
        },
        React.createElement('span', { className: 'dsv-head-text' },
          React.createElement('span', { className: 'dsv-name' }, t('title')),
          React.createElement('span', { className: 'dsv-desc' }, t('description'))),
        state.dirty ? React.createElement('span', { className: 'dsv-pending' }, t('unsaved')) : null,
        React.createElement('span', { className: 'dsv-chevron' + (open ? ' open' : '') }, '▾')),
        open ? React.createElement('div', { className: 'dsv-body' },
          !state.writable ? React.createElement('p', { className: 'dsv-note' }, t('readOnly')) : null,
          React.createElement(ValueField, {
            id: 'dsv-base-url',
            label: t('baseUrl'),
            hint: t('baseUrlHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidText'),
            disabled,
            ...state.baseUrl,
            onEdit: (text) => props.edit('baseUrl', text),
            onReset: () => props.resetField('baseUrl'),
          }),
          React.createElement(ValueField, {
            id: 'dsv-model',
            label: t('model'),
            hint: t('modelHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidText'),
            disabled,
            ...state.model,
            onEdit: (text) => props.edit('model', text),
            onReset: () => props.resetField('model'),
          }),
          React.createElement(SecretField, {
            id: 'dsv-api-key',
            label: t('apiKey'),
            hint: t('apiKeyHint'),
            stateLabel: state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset'),
            configured: state.apiKeyConfigured,
            disabled: disabled || !state.apiKeyWritable,
            ...state.apiKey,
            onEdit: (text) => props.edit(API_KEY_FIELD, text),
          }),
          React.createElement(ValueField, {
            id: 'dsv-proxy',
            label: t('proxy'),
            hint: t('proxyHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidText'),
            disabled,
            placeholder: t('proxyPlaceholder'),
            ...state.proxy,
            onEdit: (text) => props.edit('proxy', text),
            onReset: () => props.resetField('proxy'),
          }),
          React.createElement(ValueField, {
            id: 'dsv-max-tokens',
            label: t('maxTokens'),
            hint: t('maxTokensHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            numeric: true,
            disabled,
            ...state.maxTokens,
            onEdit: (text) => props.edit('maxTokens', text),
            onReset: () => props.resetField('maxTokens'),
          }),
          React.createElement(ValueField, {
            id: 'dsv-timeout',
            label: t('timeoutMs'),
            hint: t('timeoutMsHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            numeric: true,
            disabled,
            ...state.timeoutMs,
            onEdit: (text) => props.edit('timeoutMs', text),
            onReset: () => props.resetField('timeoutMs'),
          }),
          React.createElement('div', { className: 'dsv-footer' },
            state.failed ? React.createElement('p', { className: 'dsv-failed', role: 'status' }, t('saveFailed')) : null,
            React.createElement('button', { type: 'button', className: 'dsv-btn-discard', disabled: !state.dirty || state.saving, onClick: props.discard }, t('discard')),
            React.createElement('button', { type: 'button', className: 'dsv-btn-save', disabled: blocked, onClick: props.save }, t(state.saving ? 'saving' : 'save')))) : null)
    }

    // -------------------------------------------------------------------------
    // 文案与插件入口
    // -------------------------------------------------------------------------
    const zh = {
      title: '视觉桥接（dsh-vision）',
      description: '给任意模型发图片；文本模型由视觉服务自动转述（含 OCR），并提供 vision 识图工具。',
      baseUrl: '视觉服务接口地址',
      baseUrlHint: 'OpenAI 兼容网关地址，如 https://api.sudocode.chat/v1。',
      model: '视觉模型',
      modelHint: '视觉服务使用的模型 id，如 gpt-5.6-luna。',
      apiKey: 'API Key',
      apiKeyHint: '留空则保持现有密钥；保存后写入凭证服务（默认引用 VISION_API_KEY）。',
      apiKeySet: '已配置',
      apiKeyUnset: '未配置',
      proxy: '代理地址',
      proxyHint: '可选，如 http://127.0.0.1:10808；填 direct 禁用代理，留空自动使用系统代理。',
      proxyPlaceholder: '(自动)',
      maxTokens: '最大输出 tokens',
      maxTokensHint: '单次识图的最大输出长度。',
      timeoutMs: '超时（毫秒）',
      timeoutMsHint: '单次识图请求的超时时间。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃',
      unsaved: '未保存',
      saveFailed: '保存失败，请重试。',
      overridden: '已覆盖',
      reset: '重置',
      invalidText: '内容不能为空或格式无效。',
      invalidNumber: '必须是有效数字。',
      readOnly: '当前部署的设置为只读。',
      expand: '展开',
      collapse: '收起',
    }
    const en = {
      title: 'Vision bridge (dsh-vision)',
      description: 'Send images to any model; text-only models get vision-generated descriptions (with OCR), plus a vision tool for the agent.',
      baseUrl: 'Vision API base URL',
      baseUrlHint: 'OpenAI-compatible gateway, e.g. https://api.sudocode.chat/v1.',
      model: 'Vision model',
      modelHint: 'Model id used by the vision service, e.g. gpt-5.6-luna.',
      apiKey: 'API Key',
      apiKeyHint: 'Leave blank to keep the stored key; saving writes it through the credentials service (default ref VISION_API_KEY).',
      apiKeySet: 'Configured',
      apiKeyUnset: 'Not configured',
      proxy: 'Proxy',
      proxyHint: 'Optional, e.g. http://127.0.0.1:10808; use "direct" to disable, leave blank for the system proxy.',
      proxyPlaceholder: '(auto)',
      maxTokens: 'Max output tokens',
      maxTokensHint: 'Maximum output length per vision call.',
      timeoutMs: 'Timeout (ms)',
      timeoutMsHint: 'Per-call timeout for the vision request.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      unsaved: 'Unsaved',
      saveFailed: 'Save failed, please retry.',
      overridden: 'Overridden',
      reset: 'Reset',
      invalidText: 'Text is empty or invalid.',
      invalidNumber: 'Must be a valid number.',
      readOnly: 'Settings are read-only in this deployment.',
      expand: 'Expand',
      collapse: 'Collapse',
    }

    // -------------------------------------------------------------------------
    // dsh 0.2.0+：侧边栏「插件」面板（插件管理器）详情页里的配置页
    //   slot: plugins.bundle.config（keyed；key = 本 bundle 包名，注册后该 bundle
    //         在插件页出现配置区，点击插件进去即可改 VLM 模型等）
    //   读值/写入：ctx.configForms.get(命名空间) → getSnapshot/subscribe/set/unset
    //   API Key：ctx.remote.credentials.describe/set（明文不保留在前端状态里）
    // -------------------------------------------------------------------------
    const PKG_NAME = '@cdxdnrf/dsh-vision'

    /** 配置页字段（model 为 VLM 模型，默认沿用组合层 gpt-5.6-luna）。 */
    const PAGE_FIELDS = [
      { key: 'model', label: 'model', hint: 'modelHint', numeric: false, placeholder: 'gpt-5.6-luna' },
      { key: 'baseUrl', label: 'baseUrl', hint: 'baseUrlHint', numeric: false, placeholder: 'https://api.sudocode.chat/v1' },
      { key: 'proxy', label: 'proxy', hint: 'proxyHint', numeric: false, placeholder: '(auto)' },
      { key: 'maxTokens', label: 'maxTokens', hint: 'maxTokensHint', numeric: true, placeholder: '65536' },
      { key: 'timeoutMs', label: 'timeoutMs', hint: 'timeoutMsHint', numeric: true, placeholder: '120000' },
    ]

    /** 订阅 configForms 表单快照：status/value/base/user/revision/writable/mode。 */
    function useFormSnapshot(form) {
      const [snap, setSnap] = React.useState(() => (form === undefined ? undefined : form.getSnapshot()))
      React.useEffect(() => {
        if (form === undefined) return undefined
        setSnap(form.getSnapshot())
        return form.subscribe(() => setSnap(form.getSnapshot()))
      }, [form])
      return snap
    }

    /** 字段是否被用户层覆盖：按 PRESENCE 判定（与官方配置页一致）。 */
    function isOverridden(user, key) {
      return user !== null && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, key)
    }

    function asText(value) {
      return value === undefined || value === null ? '' : String(value)
    }

    /**
     * 插件管理器详情页的 VLM 配置页。
     * props: { view: 'summary' | 'page', t, configForms, remote }
     */
    function VisionConfigPage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const configForms = props.configForms
      // 凭据域名用 ctx.get 取出后传入，绝不写 `remote.credentials`：那是 Cordis
      // 守卫属性，未在 inject 中声明时会抛 "cannot get property ... without
      // inject"，使整个 slot 条目 abdicated → 配置区空白。
      const credentials = props.credentials
      const form = React.useMemo(
        () => (configForms === undefined || typeof configForms.get !== 'function' ? undefined : configForms.get(SETTINGS_NS)),
        [configForms],
      )
      const snap = useFormSnapshot(form)
      const value = snap !== undefined && snap.value !== null && typeof snap.value === 'object' ? snap.value : {}
      const user = snap === undefined ? undefined : snap.user
      const writable = form !== undefined && snap !== undefined && snap.writable !== false

      const [draft, setDraft] = React.useState({})
      const [keyDraft, setKeyDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState('')
      const [credential, setCredential] = React.useState(undefined)

      const keyRef = asText(value.apiKeyEnv).length > 0 ? asText(value.apiKeyEnv) : DEFAULT_API_KEY_REF

      const refreshCredential = React.useCallback(() => {
        if (credentials === undefined || typeof credentials.describe !== 'function') return
        try {
          credentials.describe([keyRef])
            .then((response) => {
              // Remote 调用返回结果信封 { ok, value }（与官方页面同款解包）
              const info = response !== null && typeof response === 'object' && response.ok === true
                && response.value !== null && typeof response.value === 'object'
                ? response.value[keyRef]
                : undefined
              setCredential(info)
            })
            .catch(() => setCredential(undefined))
        } catch {
          setCredential(undefined)
        }
      }, [credentials, keyRef])
      React.useEffect(() => { refreshCredential() }, [refreshCredential])

      const dirtyFields = Object.keys(draft)
      const dirty = dirtyFields.length > 0 || keyDraft.length > 0

      if (props.view === 'summary') {
        return React.createElement('span', { className: 'dsv-note' }, `${t('model')}: ${asText(value.model)}`)
      }

      const edit = (key, text) => setDraft((prev) => Object.assign({}, prev, { [key]: text }))
      const discard = () => { setDraft({}); setKeyDraft(''); setFailed('') }

      const resetField = async (key) => {
        setDraft((prev) => { const next = Object.assign({}, prev); delete next[key]; return next })
        if (form !== undefined) { try { await form.unset(key) } catch { /* 快照会自愈 */ } }
      }

      const save = async () => {
        setBusy(true); setFailed('')
        try {
          if (form !== undefined) {
            for (const key of dirtyFields) {
              const spec = PAGE_FIELDS.find((field) => field.key === key)
              const raw = draft[key]
              const next = spec !== undefined && spec.numeric === true ? Number(raw) : raw
              if (spec !== undefined && spec.numeric === true && !Number.isFinite(next)) {
                throw new Error(`${t(spec.label)}: ${t('invalidNumber')}`)
              }
              const accepted = await form.set(key, next)
              if (accepted !== true) throw new Error(t('saveFailed'))
            }
          }
          if (keyDraft.length > 0 && credentials !== undefined && typeof credentials.set === 'function') {
            const response = await credentials.set(keyRef, keyDraft)
            if (response !== null && typeof response === 'object' && response.ok === false) {
              throw new Error(response.error?.message ?? t('saveFailed'))
            }
            setKeyDraft('')
            refreshCredential()
          }
          setDraft({})
        } catch (error) {
          setFailed(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const fields = PAGE_FIELDS.map((spec) => {
        const overridden = isOverridden(user, spec.key)
        const text = Object.prototype.hasOwnProperty.call(draft, spec.key) ? draft[spec.key] : asText(value[spec.key])
        return React.createElement('div', { className: 'dsv-field', key: spec.key },
          React.createElement('div', { className: 'dsv-field-head' },
            React.createElement('label', { className: 'dsv-label', htmlFor: `dsv-mgr-${spec.key}` }, t(spec.label)),
            overridden ? React.createElement('span', { className: 'dsv-badges' },
              React.createElement('span', { className: 'dsv-badge' }, t('overridden')),
              React.createElement('button', {
                type: 'button',
                className: 'dsv-reset',
                disabled: busy || !writable,
                onClick: () => { void resetField(spec.key) },
              }, t('reset'))) : null),
          React.createElement('input', {
            id: `dsv-mgr-${spec.key}`,
            className: 'dsv-input',
            type: 'text',
            ...(spec.numeric ? { inputMode: 'numeric' } : {}),
            value: text,
            placeholder: spec.placeholder,
            disabled: busy || !writable,
            onChange: (event) => edit(spec.key, event.target.value),
          }),
          React.createElement('p', { className: 'dsv-hint' }, t(spec.hint)))
      })

      const credentialField = React.createElement('div', { className: 'dsv-field' },
        React.createElement('div', { className: 'dsv-field-head' },
          React.createElement('label', { className: 'dsv-label', htmlFor: 'dsv-mgr-api-key' }, t('apiKey')),
          React.createElement('span', { className: 'dsv-badges' },
            React.createElement('span', { className: 'dsv-badge' },
              credential !== undefined && credential.configured === true ? t('apiKeySet') : t('apiKeyUnset')),
            React.createElement('span', { className: 'dsv-badge-muted' }, keyRef))),
        React.createElement('input', {
          id: 'dsv-mgr-api-key',
          className: 'dsv-input',
          type: 'password',
          value: keyDraft,
          placeholder: credential !== undefined && credential.configured === true ? '••••••••' : '',
          disabled: busy || !writable || (credential !== undefined && credential.writable === false),
          onChange: (event) => setKeyDraft(event.target.value),
        }),
        React.createElement('p', { className: 'dsv-hint' }, t('apiKeyHint')))

      return React.createElement('div', { className: 'dsv-manager-form' },
        ...fields,
        credentialField,
        snap !== undefined && snap.status === 'unavailable'
          ? React.createElement('p', { className: 'dsv-note' }, t('readOnly')) : null,
        React.createElement('div', { className: 'dsv-footer' },
          dirty ? React.createElement('span', { className: 'dsv-badge' }, t('unsaved')) : null,
          failed.length > 0 ? React.createElement('p', { className: 'dsv-failed' }, failed) : null,
          React.createElement('button', {
            type: 'button', className: 'dsv-btn-discard', disabled: busy || !dirty, onClick: discard,
          }, t('discard')),
          React.createElement('button', {
            type: 'button',
            className: 'dsv-btn-save',
            disabled: busy || !dirty || !writable,
            onClick: () => { void save() },
          }, busy ? t('saving') : t('save'))))
    }

    /**
     * 硬依赖只保留跨版本稳定的 slots/locale；其余服务一律 ctx.get 读取
     * （0.1.x 的 settingsScope 在 0.2.0 已由 configForms 取代——硬注入它会让
     * 客户端半边在新版上永不激活）。
     */
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-vision: card dictionaries')

      const remote = ctx.get('remote')
      const configForms = ctx.get('configForms')
      const settingsScope = ctx.get('settingsScope')
      const connection = ctx.get('connection')

      // ---- dsh 0.2.0+：插件管理器详情页的配置页 ----
      // `remote.credentials` 是 mixin：只能通过注入拿到（ctx.get 取不到，直接读
      // `remote.credentials` 属性则会被守卫拒绝并让整个 slot 条目崩溃）。用运行时
      // ctx.inject 等它就绪，老版本没有该 mixin 时只是不注册新版页面，不影响旧卡片。
      if (configForms !== undefined) {
        ctx.inject(['remote', 'remote.credentials'], (credsCtx) => {
          const credentials = credsCtx.remote.credentials
          ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config',
            key: PKG_NAME,
            inject: () => ({ t: ctx.locale.bind(NS), configForms, credentials }),
          }, VisionConfigPage))
        })
      }

      // ---- dsh ≤0.1.5：设置 → 插件 → 插件配置 卡片（旧契约，保留兼容）----
      if (settingsScope !== undefined && connection !== undefined) {
        const card = new VisionCardController(settingsScope.bind({ namespace: SETTINGS_NS }), connection.api)
        if (remote !== undefined && typeof remote.$on === 'function') {
          ctx.effect(() => remote.$on('credentials/updated', (ref) => {
            card.refreshCredential(ref)
          }), 'dsh-vision: credential invalidations')
        }
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
          name: 'settings.plugin.item',
          key: SETTINGS_NS,
          locale: NS,
          inject: () => ({ hooks: { dshVisionCard: card.store }, ...card.form.actions() }),
        }, VisionCard))
      }
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
