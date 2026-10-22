# dsh-web-search-searxng

> English: A [SearXNG](https://docs.searxng.org/)-backed search provider for
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
> It registers into the `ctx.web` seam, so the model's existing `web_search`
> uses your self-hosted SearXNG instead of a paid search API. The endpoint can
> be changed from chat with `/searxng <url>` — no YAML editing required.

把自建 [SearXNG](https://docs.searxng.org/) 注册成 DSH `web_search` 的搜索后端。
它不新造工具，而是实现 DSH web capability seam（`ctx.web`）里的
**Search Provider**：

```
Agent → web_search → ctx.web → dsh-web-search-searxng → GET /search?format=json → SearXNG
```

模型看到的工具名、参数、引用格式都不变；换掉的只是搜索后端。`web_fetch`
不在本插件范围内，仍使用部署原有的 fetch provider。

## 特性

- **零额外运行时依赖**：复用 DSH 宿主的 `@deepseek-ai/dsh-web` 与
  `@deepseek-ai/schemastery`。
- **子路径友好**：`https://host/searxng`、末尾斜杠、根路径都能正确构造
  `/search`，不靠字符串拼接。
- **字段映射**：`url/title/content/publishedDate` → DSH 的
  `url/title/snippet/publishedAt`；只保留 HTTP(S) 来源，去重、丢弃空白字段。
- **分页**：首页不足 `maxResults` 时才请求下一页，遇到空页/无新增结果即停止。
- **缓存**：可选的进程内缓存；只缓存非空结果，避免缓存上游故障。
- **可操作错误**：403 提示检查 `search.formats`，429 提示限流，200 但返回
  HTML 也会提示启用 JSON；调用方取消返回 `WEB_ABORTED`。
- **聊天内改配置**：`/searxng <url>` 通过 DSH 的 `ctx.configEditor` 写入
  profile patch，保留 YAML 注释，下一次搜索立即生效。

## 文件结构

```text
dsh-searx-plugin/
├── bin/cli.js            # npx 安装器：setup / status / check
├── lib/
│   ├── index.js          # Config schema + apply() + /searxng 命令
│   ├── provider.js       # JSON 映射、分页、缓存、错误分类
│   └── url.js            # 纯 URL 构造（provider 与 CLI 共用）
├── test/
│   ├── provider.test.js
│   ├── seam.test.js
│   ├── command.test.js
│   ├── loader.mjs
│   └── run-all.mjs
├── cordis.patch.yml
├── install.ps1
├── package.json
├── README.md
└── LICENSE
```

## 工作方式

```
Agent
  ↓ web_search
DSH web seam (ctx.web)
  ↓ WebSearchProvider id = searxng
dsh-web-search-searxng
  ↓ GET /search?q=...&format=json
SearXNG
  ↓ 标准化 sources
Agent
```

结果数量上限由 DSH seam 统一执行（`dsh-tool-web` 的
`searchMaxResults`，默认 8）。provider 只负责尽量多取几页，最终由 seam
截断并标记 `truncated`。

## 服务端前提

SearXNG 默认只输出 HTML。需要在实例的 `settings.yml` 中启用 JSON：

```yaml
search:
  formats:
    - html
    - json
```

改完重启 SearXNG，验证：

```bash
curl 'http://127.0.0.1:8080/search?q=test&format=json'
```

返回 `application/json`（而不是 403/HTML）即可。公网实例建议设置独立的
`server.secret_key`、限流和 TLS；不要把无认证的实例直接暴露在公网。

## npx 一键安装

仓库推到 GitHub 后，可以直接用 npx 跑安装器，不需要先全局装包：

```bash
npx github:nvbb/dsh-searx-plugin setup --url https://search.example.com/searxng --profile web
npx github:nvbb/dsh-searx-plugin status --profile web --check
```

`setup` 会：

1. 请求 `/search?format=json`，确认实例真的可用；
2. 执行 `dsh plugin --profile web add github:nvbb/dsh-searx-plugin`；
3. 备份并修改 profile 的 `cordis.patch.yml`；
4. 打印重启提示。

常用选项：

| 选项 | 作用 |
|---|---|
| `--url <url>` | SearXNG 地址（setup/check 必填） |
| `--profile <name>` | DSH profile，默认 `web` |
| `--language <code>` | 如 `zh-CN` |
| `--engines <list>` | 如 `bing,duckduckgo` |
| `--categories <list>` | 如 `general` |
| `--no-check` | 跳过 HTTP JSON 检查 |
| `--skip-install` | 只改配置，不跑 `dsh plugin add` |
| `--profile-file <path>` | 覆盖 `cordis.patch.yml` 路径（测试用） |
| `--dsh <path>` | 指定 dsh 可执行文件 |

本地开发也可以直接：

```bash
node bin/cli.js setup --url https://search.example.com/searxng --skip-install --no-check
node bin/cli.js status --check
```

> **npm 名称提示**：`dsh-web-search-searxng` 在 npm 上已被另一个项目占用
> （0.5.1），所以本仓库默认用 `npx github:...`。如果要发布 npm，请先把
> `package.json` 的 `name` 改成 `dsh-searx-plugin`（目前可用）或自己的
> scoped name，并同步 `cordis.patch.yml` 里的 `name` 与 profile 依赖。

## 安装

### 方式一：脚本（推荐）

先停掉正在运行的 `dsh web`（Windows 上 node 会锁住 profile 的
`node_modules`），然后：

```powershell
cd D:\path\to\dsh-searx-plugin
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -BaseURL 'https://search.example.com/searxng' `
  -Language 'zh-CN'
```

脚本会：

1. 校验 URL（必须是 http/https，不能带账号、query、fragment）；
2. `dsh plugin --profile web add file:<本目录>`；
3. 备份并修改 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`：
   - 把 `web` 行的 `searchProvider` 改成 `searxng`；
   - 写入 `web-search-searxng` 的 `baseURL` 等配置；
4. 打印验证和回滚命令。

可选参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -BaseURL 'https://search.example.com/searxng' `
  -AuthHeader 'Bearer <token>' `
  -Language 'zh-CN' `
  -Engines 'bing,duckduckgo' `
  -Categories 'general' `
  -Profile 'web'
```

`-SkipInstall` 只改配置不装包；`-NoRestart` 不打印重启提示。

### 方式二：手动

```powershell
dsh plugin --profile web add 'file:D:/path/to/dsh-searx-plugin'
```

在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 中合并：

```yaml
- id: web
  config:
    searchProvider: searxng

- id: web-search-searxng
  config:
    baseURL: "https://search.example.com/searxng"
    language: "zh-CN"
```

如果已经存在 `- id: web`，只改它的 `searchProvider`，不要重复写第二个
`web` 行。

### 重启并验证

```powershell
dsh web
```

然后在会话里调用 `web_search`，或检查组合配置：

```powershell
dsh --profile web --dump-config
```

应能看到 `searchProvider: searxng` 和 `web-search-searxng` 一行。

## 在聊天里改网址（不用改配置文件）

插件在 Web profile 里注册了 `/searxng` 命令：

```text
/searxng https://search.example.com/searxng
/searxng status
/searxng reset
```

- `/searxng <url>`：校验并保存 `baseURL`，同时把 `web.searchProvider` 设为
  `searxng`；下一次 `web_search` 立即生效。
- `/searxng status`：显示当前 provider 和 baseURL。
- `/searxng reset`：清掉 baseURL，恢复 `deepseek-search-api`。

它走 `ctx.configEditor`，会保留 `cordis.patch.yml` 里的注释和其他配置，
不是手写 YAML。命令依赖 Web profile 的 `commands` 与 `configEditor`
服务；无头/自动化 profile 没有这两个服务时命令不会注册，provider 本身仍可用。

> DSH 目前没有给第三方插件自动生成侧栏设置页的通用客户端；官方「网页搜索」
> 页只编辑 DeepSeek 的几个命名空间。要在侧栏做完整表单，需要额外的 client
> 插件（React + `dsh.client` bundle）。`/searxng` 是当前最轻的插件内配置方式。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | 空 | SearXNG 地址，可带反向代理子路径。空时读 `$SEARXNG_BASE_URL` |
| `authHeader` | 空 | 原样作为 `Authorization` 头发送；也读 `$SEARXNG_AUTH_HEADER` |
| `language` | 空 | SearXNG `language`，如 `zh-CN`；空 = 实例默认 |
| `categories` | 空 | 逗号分隔的分类，如 `general,news` |
| `engines` | 空 | 逗号分隔的引擎白名单，如 `bing,duckduckgo` |
| `timeRange` | 空 | `day` / `month` / `year`；空 = 不限 |
| `safesearch` | `-1` | `0` / `1` / `2`；`-1` = 不传 |
| `maxPages` | `2` | 一页不够 `maxResults` 时最多再翻几页（1–5） |
| `timeoutMs` | `15000` | 单次 HTTP 超时；DSH 工具本身默认 30s |
| `cacheTtlMs` | `0` | 进程内缓存；0 = 关闭。只缓存非空结果 |
| `includeAnswers` | `false` | 是否把 SearXNG 的 `answers` 作为 `content` 暴露 |
| `userAgent` | `dsh-web-search-searxng/0.2` | 请求 UA |

## 行为与错误

- **URL 构造**：使用 `URL` 对象，不用字符串拼接；拒绝带账号/query/fragment
  的 baseURL。
- **映射**：`url → url`、`title → title`、`content → snippet`、
  `publishedDate → publishedAt`；只保留 HTTP(S) URL，重复 URL 去重。
- **分页**：首页不足 `maxResults` 时请求 `pageno=2..maxPages`；空页或无新增
  结果即停止。
- **取消/超时**：`AbortSignal` 传到 `fetch`；调用方取消返回
  `WEB_ABORTED`，自己的超时返回 `WEB_PROVIDER_ERROR`。
- **HTTP**：403 提示检查 `search.formats`；429 提示限流；401 提示
  `authHeader`；200 但返回 HTML 也会提示启用 JSON。

## 常见问题

| 现象 | 处理 |
|---|---|
| `WEB_PROVIDER_CONFIGURED_MISSING` | `searchProvider` 写了 `searxng`，但插件没装上/没重启 |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | `baseURL` 为空或非法；检查配置和 `$SEARXNG_BASE_URL` |
| `WEB_PROVIDER_AMBIGUOUS` | 同时有多个可用搜索 provider；在 `web` 行显式写 `searchProvider: searxng` |
| HTTP 403 + JSON 提示 | SearXNG 没开 `search.formats: [html, json]`，或反向代理拦了 |
| HTTP 429 | 实例限流；降低调用频率或调整 limiter |
| 请求超时 | VPS 不可达/防火墙；先在服务器本机 `curl` 验证 |
| `fetch failed` / TLS | 地址、端口、证书；Node 不会自动走系统代理 |

## 开发与测试

正常环境：

```bash
npm test          # 22 个用例：provider、真实 ctx.web seam、/searxng 命令
```

当前 DSH 会话沙箱不允许 `node --test` 再 spawn 子进程，所以在会话内用：

```powershell
npm run test:local
```

`test/loader.mjs` 只把 `@deepseek-ai/dsh-web`、`@deepseek-ai/schemastery`
和 `@deepseek-ai/cordis` 指向本机 DSH profile 里的真实包，不改变运行时。
公开 CI 需要自行安装 `@deepseek-ai/dsh-web` 与
`@deepseek-ai/schemastery` 作为 devDependencies。

## 已知限制

- **不做网页抓取**：只替换 `web_search`；`web_fetch` 仍是原 provider。
- **没有侧栏 GUI 设置页**：DSH 目前没有第三方插件通用设置页；用
  `/searxng` 或配置文件。
- **没有内置代理**：provider 用 Node 全局 `fetch`，不自动使用系统代理；
  需要代理时在启动环境/基础设施层解决。
- **依赖 SearXNG 的 JSON 输出**：实例必须启用 `search.formats: [json]`。
- **结果质量取决于实例**：上游引擎是否可用、限流、排序都由 SearXNG 决定。

## 相关项目

- [dsh-searxng](https://github.com/rogerdigital/dsh-searxng)：功能更重的上游
  实现（Docker 部署、CLI、多实例 failover、doctor/tune）。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
- [nvbb/dsh-searx-plugin](https://github.com/nvbb/dsh-searx-plugin) — Self-hosted SearXNG search provider for DSH: `web_search` without a paid API or a model turn per search.
## License

MIT
