# dsh-vision

DeepSeek Harness 视觉桥接插件：**任何模型都能发图、看图**。

- 非多模态模型（如 deepseek-chat）正常情况下收到图片会直接报错拒收（`Model ... does not support image input`）。
- 本插件在宿主侧接入三个关键点，让图片在任何模型下都能正常发送；对不支持图片输入的模型，在请求进入适配器之前自动调用**视觉模型**把图片转成文字描述注入请求。
- 视觉识别能力（原 vision-helper skill 的 `vision.js`）**完整内置**：OpenAI 兼容接口、代理支持、配置、CLI 与 `vision` 模型工具，不依赖任何 skill，换台机器装好插件即可用。

## 功能

1. **图片随便发**：对显式声明纯文本的模型补齐 `image` 输入能力声明，打开宿主 `prompt` / `selectModel` 的图片准入门禁；同时 `read_image`（fs 工具）对任意模型可用。
2. **自动桥接**：请求携带图片且目标模型真实能力不支持图片时，把图片块替换为视觉模型的文字描述（含 OCR），再交给适配器。会话记录与界面里显示的一直是原图。
3. **`vision` 模型工具**：agent 可主动分析本地图片路径或 http(s) 图片链接（等价于 vision-helper 的 `vision.js`）。
4. **独立 CLI**：`node cli/vision.mjs <路径|--url 链接> [问题]`，与 vision-helper 用法一致。
5. **缓存**：同一张图 + 同一段问题只调用一次视觉服务；识别失败结果缓存 60 秒，避免每轮对话重复轰炸。
6. **可配置**：环境变量 > `$DSH_HOME/storages/dsh-vision/config.json` > 插件目录 `config.json` > 内置默认值；配置文件改动热生效，无需重启。

## 工作原理（三个接入点，全部可逆）

| 接入点 | 手法 | 效果 |
| --- | --- | --- |
| `LlmRuntime#resolveModelInfo` | 包装共享 `llm` 服务实例：对 `inputModalities` 显式不含 `image` 的模型补上 `image` | 图片准入门禁放行；`read_image` 可用 |
| `LlmRuntime#streamWithRegistration` | 包装共享实例：按**未补丁前的真实能力**判断，不支持图片时先把消息中的图片桥接为文本 | 发给模型的请求无图片，文本模型不再报错 |
| `tools` 注册表 | 注册 `vision` 工具 | agent 主动识图（路径 / URL） |

多模态模型（真实能力含 `image`）的请求保持原样直传，桥接零开销。所有副作用挂在 Fiber 上，插件停止/更新时自动还原。

## 安装

### 方式 A：本机开发（link）

1. `git clone git@github.com:cdxDNRF/dsh-vision.git`
2. 编辑 profile 目录（如 `~/.dsh/profiles/web/`）的 `package.json`：

   ```json
   {
     "dependencies": {
       "@cdxdnrf/dsh-vision": "link:D:/path/to/dsh-vision"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@cdxdnrf/dsh-vision"]
       }
     }
   }
   ```

3. 在 profile 目录执行 `pnpm install`
4. 重启 harness（`dsh web`）

插件包内自带的 `cordis.patch.yml`（`dsh.bundle.patch`）会在加载时自动把
`- insert: [{ id: dsh-vision, name: '@cdxdnrf/dsh-vision' }]` 合并进宿主组合，无需手动改 cordis.yml。

### 方式 B：其他机器（git 依赖）

```json
"dependencies": {
  "@cdxdnrf/dsh-vision": "github:cdxDNRF/dsh-vision"
}
```

其余步骤同方式 A（`pnpm install` → 重启）。也支持 npm 安装（如已发布）：
`"@cdxdnrf/dsh-vision": "^0.1.0"`。

### 手动行（等价写法）

不在 bundles 里加包时，可直接在 profile 的 `cordis.patch.yml` 中加：

```yaml
- insert:
    - id: dsh-vision
      name: '@cdxdnrf/dsh-vision'
```

## 配置视觉服务

**优先级：环境变量 > `$DSH_HOME/storages/dsh-vision/config.json` > 插件目录 `config.json` > 内置默认值。**

`config.json` 字段（参考 `config.example.json`）：

```json
{
  "enabled": true,
  "baseUrl": "https://api.sudocode.chat/v1",
  "model": "gpt-5.6-luna",
  "apiKey": "sk-...",
  "proxy": "",
  "maxTokens": 1024,
  "timeoutMs": 120000,
  "cacheMaxEntries": 200
}
```

环境变量（与 vision-helper 同名）：

| 变量 | 含义 |
| --- | --- |
| `VISION_BASE_URL` | OpenAI 兼容网关地址 |
| `VISION_MODEL` | 视觉模型 id |
| `VISION_API_KEY` | API Key |
| `VISION_PROXY` | 显式代理（`http://host:port`；`direct` 表示禁用代理） |
| `VISION_MAX_TOKENS` / `VISION_TIMEOUT_MS` | 输出上限 / 超时（毫秒） |
| `DSH_VISION_ENABLED` | `false` 时关闭桥接（图片按原行为报错） |

未配置 `proxy` 时自动使用 `HTTPS_PROXY`/`HTTP_PROXY`，再回退 Windows 注册表系统代理（与 vision.js 同款逻辑）。HTTPS 目标走 CONNECT 隧道，HTTP 目标走绝对 URI。

## 行为细节

- 图片块的替换文本形如：`[vision: 图片视觉识别结果]\n<描述>`；消息原有文字保留，视觉问题 = 原有文字（无文字时用默认识图指令，要求逐字 OCR）。
- `tool-result` 里嵌套的图片（如 `read_image` 的结果）同样递归桥接。
- 桥接/识图失败时**不会静默吞图**：视觉服务失败会把失败原因注入文本块；桥接整体异常时保持原请求、走正常报错路径。
- 缓存键 = `attachmentId + 问题文本`，上限 `cacheMaxEntries`（LRU）。
- 配置文件修改后随下一次 LLM 请求热重载。

## CLI

```bash
node cli/vision.mjs ./photo.png "图里的文字是什么？"
node cli/vision.mjs --url https://example.com/a.png
```

配置读取顺序与插件一致，可作为独立识图脚本使用（vision.js 的替代品）。

## 开发与测试

```bash
npm run check   # 语法检查（lib / cli / smoke）
npm run smoke   # 离线冒烟：内置假视觉服务器，覆盖补丁、桥接、缓存、工具、卸载还原
```

冒烟测试全部离线；真实链路验证用 CLI 即可。

## 限制

- 桥接基于**请求时刻**的图片：历史轮次里的旧图使用当时的描述缓存；后续追问旧图时模型看到的是缓存描述（与 vision-helper 逐图描述一次的行为一致）。当前轮新发的图会按本轮问题重新识图。
- 对 `inputModalities` 未声明（unknown）的模型不主动桥接，保持原生行为。
- 视觉模型本身不可用时，文本模型会收到带失败说明的文本（而非图片），对话不中断。

## 卸载

从 profile 的 `package.json` 移除依赖与 bundles 条目 → `pnpm install` → 重启。所有补丁随插件停止自动还原。

## License

MIT
