# mcp-zh

把官方 MCP 注册表全量翻译成中文，用**与官方完全相同的 registry 分页协议**对外提供。
在 MCP 市场里加**一个源**，整个市场就是中文的 —— 不装插件、不改设置、严格网络模式可用。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mycatxl/mcp-zh)

---

## 快速开始

### 一键部署（推荐）

点上面的按钮 → 授权你的 Cloudflare 账号 → 确认。

Cloudflare 会自动创建 D1 数据库、导入 34,279 条中文数据、部署 Worker，完成后给你一个地址。不需要 API Token，不需要命令行。

把地址填进市场（**市场 → 源 → 添加源**）：

| 字段 | 值 |
|---|---|
| 类型 | `Registry` |
| URL | `https://<你的 Worker>.workers.dev/servers` |

### 本机部署

```bash
npm run build        # 取数据集：本地已有则跳过，否则下载 7.8 MB 并校验
npm run deploy:local # 建库 → 建表 → 导入 → 部署
```

用这个的前提：已 `wrangler login`，或设了 `CLOUDFLARE_API_TOKEN`（用 **Edit Cloudflare Workers** 模板创建）。

> **不要在本机跑 `npm run deploy`** —— 那是给 Cloudflare 一键部署用的（`--cloud`）：它假定数据库已经建好并绑定，本机跑会因为没有数据库而停下。名字必须叫 `deploy`，因为 Cloudflare 就是用这个名字自动预填它的部署命令。

> **Windows**：PowerShell 默认禁止 `npm.ps1`，把 `npm` 换成 `npm.cmd`。或者直接用 `node scripts/deploy.mjs`，绕开 npm。`

---

## 自动更新

仓库里的 GitHub Actions 每天 03:17 UTC 重新抓取并翻译。**只有内容真的变了才重新导入** —— 一次全量导入要花 69% 的 D1 日写入额度，无脑每天导会把额度烧光。

要在你自己的部署上启用发布，在**你自己那份仓库**添加两个 Secrets：

| 名称 | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 用 **Edit Cloudflare Workers** 模板创建 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 面板 URL 里的账号 id |

没配也不会失败，只是跳过发布。

> **一键部署会把仓库连到 Workers Builds**，之后每次推送到生产分支都会重新构建部署。这不会重复烧额度：构建时若内容指纹未变，导入会整段跳过（见 `docs/DESIGN.md`）。

---

## 它是怎么工作的

```
官方 registry（英文）
    │  GitHub Actions 每天抓取 + 翻译
    ▼
data/import.sql（43.5 MB）
    │
    ├──► 发布为 release 资源（压缩后 7.8 MB）
    │        供一键部署与 npm run build 取用，
    │        所以别人不必先跑那 19 分钟的抓取
    │
    ▼
Cloudflare D1 ── 34,279 条中文记录 + 中文 FTS5 搜索索引
    ▲
Cloudflare Worker ── 与官方一致的 registry 协议
    ▲
PI-Desktop 市场 ── 加一个源
```

刷新放在 GitHub Actions 上是有原因的：Cloudflare 免费版 Cron Trigger 每次只有 **10ms CPU**，而抓取要 **19 分钟**。

下载数据集时会先用 `MANIFEST.json` 里的 sha256 和解压长度校验，先写 `.tmp` 再原子改名。一个被截断的导入文件会**安静地导入成功**，然后留下一个条目少一半的市场 —— 界面上和成功完全一样。

---

## 已知问题：市场手动加源会丢

PI-Desktop 的 MCP 市场有个 bug：「添加源」只改内存，**从不写入存储**，重启后消失。

绕过方法：

1. 设置 → 常规 → 打开「**开发者模式**」
2. 按 **F12** 打开控制台
3. 执行 `node scripts/make-snippet.mjs`，把打印出的那一行粘进去回车

应输出 `mcp-zh > official` —— 表示中文源排在官方源**前面**，中文卡片才会出现在市场首页。

---

## 数据

| | |
|---|---|
| 抓取 | 36,888 条 |
| 剔除 | 2,599 条（客户端必定丢弃） |
| 去重 | 10 条（id 派生后重复） |
| **对外提供** | **34,279 条** |
| 翻译 | 59,985 段文本，0 失败 |
| 分类 | devtools 23,807 / web 5,356 / productivity 3,112 / data 1,582 / docs 422 |
| 导入写入 | 68,564 行（D1 日额度的 69%） |
| 每页体积 | ~90 KB（4 MB 上限的 46 倍余量） |

被剔除的 2,599 条，是宿主的映射函数判定为「既没有可安装的包、也没有可用远端」的记录 —— 它们**永远不可能显示**，但服务出去会白占一页 100 个名额里的一个。

---

## 项目结构

```
wrangler.toml            Worker 配置（Cloudflare 从仓库根目录读取它来识别 D1 绑定）
worker/src/index.js      registry 协议实现
shared/                  中文 bigram 折叠、记录形状与 id 派生
generator/               抓取、翻译、校验
scripts/                 部署、取数据集、发布数据集
test/                    测试
```

## 开发

```bash
npm test                  # 全部测试
npm run fetch             # 抓官方全量（约 19 分钟）
npm run translate         # 翻译并生成 data/import.sql
npm run verify            # 用真实 SQLite 全量校验
node test/e2e.js --base=https://<你的 Worker>.workers.dev
```

设计取舍与踩过的坑见 [docs/DESIGN.md](docs/DESIGN.md)。

## License

[MIT](LICENSE)
