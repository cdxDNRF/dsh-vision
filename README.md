# dsh-vision

DeepSeek Harness 视觉桥接插件：**任何模型都能发图、看图**。

- 非多模态模型（如 deepseek-chat）收到图片会直接报错拒收（`Model ... does not support image input`）。本插件接入宿主三个关键点，让图片在任何模型下都能正常发送；对不支持图片输入的模型，在请求进入适配器之前自动调用**视觉模型**把图片转成文字描述（含逐字 OCR）注入请求。
- 视觉识别能力（原 vision-helper 的 `vision.js`）**完整内置**：OpenAI 兼容接口、代理支持、独立 CLI 与 `vision` 模型工具，不依赖任何 skill。
- 按 [官方插件文档](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) 规范编写：`apply(ctx, config)`、`Config` schema（Standard Schema 接口）、`dsh.bundle` 组合包 manifest，并在**设置 → 插件 → 插件配置**里提供图形化配置卡片（自定义 API 地址 / 模型 / Key，即改即生效）。

### 零 in-box 导入（模块身份分裂免疫）

v0.3 起本插件**不 import 任何 `@deepseek-ai/*` 包**，且**零依赖、零 peerDependencies**：

- Cordis loader 只要求 `Config['~standard'].validate`（Standard Schema 接口）→ 手写；
- settings 服务只要求 schema 可调用且带 `toJSON()`（信封兼容客户端 `new Schema(envelope)` 重水化、节点结构兼容 `redactSecrets`）→ 手写（已用部署正本 schemastery + dsh-settings 实测兼容）；
- 工具注册表接受普通 `ToolDefinition`（JSON Schema 参数）→ 手写；
- 凭证服务接受普通字符串引用 → 直接传字符串。

因此无论 `dsh plugin add` / pnpm 如何安装依赖，插件自身的模块图都不会与 harness 产生第二个实例——此前导致 `reading 'prepare'` 崩溃的 `TOOL_RUNTIME_SCHEDULER` Symbol 分裂类故障**从结构上不可能发生**；安装也不会向 profile 引入任何 in-box 物理副本。

## 功能

1. **图片随便发**：对显式声明纯文本的模型补齐 `image` 输入能力声明（包装 `adapter.resolveModel`），打开宿主 `prompt` / `selectModel` 的图片准入门禁；`read_image`（fs 工具）对任意模型可用。
2. **自动桥接**：包装 `adapter.stream`——请求带图且目标模型**真实能力**（未补丁前）不支持图片时，把图片块递归替换为视觉模型文字描述再交给适配器。会话记录与界面始终显示原图；框架的请求冻结、不变量校验、prepared-call 路径全部不受影响（改写只发生在适配器边界）。
3. **`vision` 模型工具**：agent 可主动分析本地图片路径或 http(s) 图片链接。
4. **配置 GUI**：设置 → 插件 → 插件配置 → 「视觉桥接（dsh-vision）」卡片：接口地址、模型、API Key、代理、最大输出、超时。命名空间通过 `llm.registerConfigurableProviders` 按官方契约暴露给 Web 设置客户端（仅声明目录、不注册 adapter，视觉服务不会成为 agent 的 LLM 路由）。
5. **独立 CLI**：`node cli/vision.mjs <路径|--url 链接> [问题]`，与 vision-helper 用法一致。
6. **缓存**：同一张图 + 同一段问题只调用一次视觉服务；失败结果缓存 60 秒。
7. **可逆**：全部副作用挂在 Fiber 上；`llm/adapters-updated` 事件驱动对新注册适配器的增量包装；插件停止/更新自动还原。

## 配置体系（官方插件配置规范）

优先级从高到低：

| 层 | 来源 |
| --- | --- |
| 1 | **设置用户层**（GUI「插件配置」卡片保存的内容，写入 `$DSH_HOME/settings.yaml`，即时生效） |
| 2 | **组合行 config**（`cordis.patch.yml` 中本插件行的 `config`，作为设置的 `base` 层） |
| 3 | **schema 默认值**（`Config` schema 中声明） |
| 4 | 环境变量 `VISION_BASE_URL` / `VISION_MODEL` / `VISION_PROXY` / `VISION_MAX_TOKENS` / `VISION_TIMEOUT_MS` |
| 5 | `config.json` 兜底（`$DSH_HOME/storages/dsh-vision/config.json` 或插件目录；未配置 GUI 的机器用） |

字段（`Config` schema）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后桥接与能力补齐全部停用（图片按原生行为报错） |
| `baseUrl` | `https://api.sudocode.chat/v1` | OpenAI 兼容视觉网关 |
| `model` | `gpt-5.6-luna` | 视觉模型 id |
| `apiKey` | `""` | 字面量密钥（secret，GUI 不读写；供行 config 高级用户） |
| `apiKeyEnv` | `VISION_API_KEY` | 凭证引用（GUI 的 API Key 输入框写入该引用） |
| `proxy` | `""` | 空=自动（环境变量→Windows 系统代理）；`direct`=禁用；`http://host:port`=显式 |
| `maxTokens` | `1024` | 单次识图输出上限 |
| `timeoutMs` | `120000` | 单次识图超时 |
| `cacheMaxEntries` | `200` | 描述缓存上限（LRU） |

**API Key 解析**（每次操作实时解析）：段内 `apiKey` → 凭证服务 `resolve(apiKeyEnv)` → 进程环境变量 → `config.json`。明文永不进入前端响应与日志。

## 安装

### 组合包（推荐）

```bash
# 从 GitHub 安装（注意：pnpm 会要求为 git 依赖的 prepare 脚本授权，按提示操作）
dsh plugin --profile <name> add github:cdxDNRF/dsh-vision

# 本地 checkout（开发）
dsh plugin --profile <name> add ./dsh-vision

# npm（如已发布）
dsh plugin --profile <name> add @cdxdnrf/dsh-vision
```

`dsh plugin add` 会把包加入 profile 的依赖并追加进 `dsh.profile.bundles`；包内 `cordis.patch.yml`（`dsh.bundle.patch`）自动把插件行合并进宿主组合。重启 harness 生效。

也可以手动等价配置：

```jsonc
// profile/package.json
{
  "dependencies": { "@cdxdnrf/dsh-vision": "link:/path/to/dsh-vision" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@cdxdnrf/dsh-vision"] } }
}
```

```bash
dsh plugin --profile <name> install   # pnpm install
```

### 卸载

```bash
dsh plugin --profile <name> remove @cdxdnrf/dsh-vision
```

所有补丁随插件停止自动还原。

## 行为细节

- 图片块替换为 `[vision: 图片视觉识别结果]\n<描述>`；消息原有文字保留，视觉问题 = 原有文字（无文字时用默认识图指令，要求逐字 OCR）。
- `tool-result` 嵌套图片（如 `read_image` 结果）同样递归桥接；多模态模型（真实能力含 `image`）原样直传，零开销。
- 视觉服务失败时把失败原因注入文本块，**不静默吞图**；桥接整体异常时保持原请求、走正常报错路径。
- 缓存键 = `attachmentId + 问题文本`。
- 配置文件/设置修改后下一次 LLM 请求即热生效，无需重启。

## 开发与测试

```bash
npm run check      # 语法检查（host 入口 / 核心 / client bundle / CLI / 测试），零依赖可直接运行
npm run smoke      # 离线冒烟：假视觉服务器，覆盖能力补齐、桥接、缓存、多模态直传、增量包装、卸载还原
npm run host-check # 宿主入口端到端：Standard Schema 契约、settings 接线、目录暴露、vision 工具注册与执行链路
```

## 与官方文档的对应关系

| 文档页 | 本插件的实现 |
| --- | --- |
| 第一个插件 | 导出 `name` / `inject` / `apply(ctx, config)`；副作用全部 `ctx.effect` |
| 开发一个 Tool | 注册 `vision` 工具（手写 `ToolDefinition`，与 `defineTool` 的 JSON Schema 输出等价） |
| 插件配置 | 导出 `Config`（手写 Standard Schema，`~standard.validate` + callable + `toJSON()` 信封，与 schemastery 兼容）；行 config 作为 base；内联 `installSettingsSection` 等价接线（GUI 即改即生效） |
| 打包与安装 | `dsh.bundle.patch` 组合包 manifest；`dsh plugin add` 安装；`dsh.client` 声明客户端半边 |

## 限制

- 桥接基于**请求时刻**的图片：历史轮次旧图使用当时的描述缓存；当前轮新发的图按本轮问题重新识图（与 vision-helper 逐图描述一次的行为一致）。
- 对 `inputModalities` 未声明（unknown）的模型不主动桥接，保持原生行为。
- 视觉模型不可用时，文本模型会收到带失败说明的文本（而非图片），对话不中断。

## License

MIT
