/**
 * dsh-vision 客户端半边 —— 设置 → 插件 → 插件配置 中的配置卡片。
 *
 * 官方 Slot 规范（@deepseek-ai/dsh-client-ui-settings-plugins 的扩展点）：
 *  - 注册进 `settings.plugin.item` 列表 Slot；
 *  - 卡片表单基于客户端 settingsScope（绑定宿主命名空间 `dsh-vision`），
 *    暂存编辑 → 保存时经 settings.mutate RPC 写入用户层（宿主侧即时生效）；
 *  - API Key 走凭证域（api.credentials.describe/set），引用段内 `apiKeyEnv`
 *    （默认 VISION_API_KEY），明文永不进入前端响应。
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
        this.listeners.add(() => { store.set(project()) })
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

    const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-vision: card dictionaries')
      const { api } = ctx.get('connection')
      const card = new VisionCardController(ctx.settingsScope.bind({ namespace: SETTINGS_NS }), api)
      ctx.effect(() => ctx.remote.$on('credentials/updated', (ref) => {
        card.refreshCredential(ref)
      }), 'dsh-vision: credential invalidations')
      ctx.slots.register({
        name: 'settings.plugin.item',
        id: 'dsh-vision',
        order: 30,
        locale: NS,
        inject: () => ({ hooks: { dshVisionCard: card.store }, ...card.form.actions() }),
      }, VisionCard)
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
