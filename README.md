# MCP 中文源

把官方 MCP 注册表（36,888 条）全量翻译成中文，用**和官方完全相同的 registry 分页协议**对外提供。

在 MCP 市场里加**一个源**即可：

```
URL   https://mcp-zh-registry.<你的子域>.workers.dev/servers
类型  registry
```

不装插件、不改设置、严格网络模式可用、完全免费。

---

## 部署

### Windows 用户先看这一条

这台机器上 PowerShell 的执行策略**禁止运行 `npm.ps1`**，所以 `npm install` 和 `npm run ...` 会直接失败，报 `running scripts is disabled on this system`。

**用 `node` 直接跑脚本**（最省事），或者把 `npm` 换成 `npm.cmd`。依赖已经装好了，通常不需要再 install。

### 授权方式二选一

| | 方式 | 需要做什么 |
|---|---|---|
| **A** | **API Token**（推荐，无需浏览器） | 去面板建一个 token，设成环境变量 |
| **B** | **OAuth 登录** | 跑命令，浏览器点一下 Authorize |

#### 方式 A：API Token（不弹浏览器）

1. 打开 https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** → 用 **"Edit Cloudflare Workers"** 模板（它已包含 D1 权限）
3. 创建后**复制 token**（只显示一次）
4. 设成环境变量：

```powershell
setx CLOUDFLARE_API_TOKEN "你的token"
```

然后直接跑部署：

```powershell
cd D:\WorkSpace\Chat\mcp-zh-registry
node scripts/deploy.mjs
```

> **为什么 `setx` 就够了**：Windows 上脚本会**直接从注册表 `HKCU\Environment` 读取**这个变量。
> 因为长时间运行的程序（PI-Desktop、IDE、已开着的终端）保留的是启动时的环境块，
> 之后 `setx` 设的变量在 `process.env` 里看不到，但注册表里是最新的。
> 这条路径已实测（`node test/env-token.js`，7 项断言）。

#### 方式 B：OAuth 登录（点一下浏览器）

```powershell
cd D:\WorkSpace\Chat\mcp-zh-registry
node scripts/deploy.mjs
```

没登录时它会自动打开浏览器。Cloudflare 账号**免费、不用绑卡**，没账号就在打开的页面上点 Sign up。

> **关于 `localhost:8976`**：这是 wrangler 为了接收授权码而**临时**起的本地回调口，
> 只在授权的那几秒存在，拿到凭据立刻关闭。**它和部署后的服务毫无关系** ——
> 部署产物里没有任何 localhost，服务跑在 Cloudflare 边缘节点上，你关机网友照样能用。
>
> 如果浏览器够不到本机（远程 shell、容器），用设备码模式，不需要回调到本机：
> ```powershell
> node node_modules/wrangler/bin/wrangler.js login --device
> ```

### 脚本会做什么

| 步骤 | 做什么 |
|---|---|
| 0 | 检查 wrangler 装了没、`data/import.sql` 在不在 |
| 1 | 解析凭据：有 token 就用 token，否则走 OAuth |
| 2 | 创建 D1 数据库（已存在就复用） |
| 3 | 把数据库 id 写进 `worker/wrangler.toml` |
| 4 | 建表（会 drop 重建两张表） |
| 5 | 导入 43.5 MB 全量数据，读回**真实写入行数**核对额度 |
| 6 | 部署 Worker，**打印出要填进市场的 URL** |

可重复执行，也兼作更新流程。

### 填进市场

把最后打印的那行 URL 填进市场：

```
MCP 市场 → 源管理 → 添加源
  URL   https://mcp-zh-registry.xxxxx.workers.dev/servers
  类型  registry
```

**注意**：要带 `/servers` 后缀，不要写成 `/v0/servers`。

### 导入到底是怎么跑的（为什么 43 MB 不是问题）

`wrangler d1 execute --file --remote` **不是**把 SQL 拆开一条条发。它会：算文件 md5 → 让 D1 初始化一次导入 → 把**整份文件** PUT 到一个签名的 R2 地址 → 通知 D1 摄取 → 轮询到完成。

所以：

- 43 MB 一次性上传，**不会**因为体积失败
- 整个导入是**单个事务**，失败会回滚到导入前的状态，**可以安全重试**
- 真正适用的硬限制只有**单条语句 100 KB** 和**单行 2 MB**。`node test/limits.js` 会拿生成的 SQL 逐条核对这两项 —— 因为超限报的是 `SQLITE_TOOBIG`，而那是在上传**之后**才发生的
- **导入期间数据库对外不可用**（通常 1-3 分钟），所以这是手动步骤，而不是让 CI 每天自动跑

脚本会读回导入报告里的**真实 `rows written`**，和推算对比，超额度会直接报错退出。

### 常用参数

```powershell
node scripts/deploy.mjs --check          # 干跑：只报告会做什么，不改任何东西
node scripts/deploy.mjs --login-only     # 只解决授权，别的都不做
node scripts/deploy.mjs --skip-import    # 只建表+部署，不导数据
node scripts/deploy.mjs --db=my-db       # 换个数据库名
node scripts/deploy.mjs --worker=my-zh   # 换个 Worker 名（决定 URL 前缀）
```

### 部署后自检

```powershell
# 健康检查：应该看到 entries: 34279
curl https://mcp-zh-registry.xxxxx.workers.dev/health

# 拿 2 条看看中文
curl "https://mcp-zh-registry.xxxxx.workers.dev/servers?version=latest&limit=2"

# 搜个中文词
curl "https://mcp-zh-registry.xxxxx.workers.dev/servers?version=latest&search=数据库&limit=3"
```

---

## 为什么必须用服务器

宿主对**单次响应**有硬上限 `MAX_SOURCE_RESPONSE_BYTES = 4 MB`，而两种源格式的取数方式完全不同：

| 源格式 | 取数方式 | 能否分页 |
|---|---|---|
| `registry` | `?limit=100&cursor=x` 逐页拉 | **能**，每页几十 KB |
| `catalog` | 一次性拉全量，无分页 | **不能**，整份必须 < 4MB |

官方源用的就是 `registry`，实测：

```
GET .../v0/servers?version=latest&limit=100
→ 200 OK，100 条，82 KB，带 nextCursor

limit=1000  →  422  expected number <= 100
```

**官方源自己也是一次只给 100 条的** —— 只是它切的是"页"，不是"文件"。服务器能按需分页，静态文件不能。

全量 catalog 实测 34,299 条 = 12.54 MB，超限 3.1 倍；而且光中文描述 3.22 MB + 中文标题 0.88 MB = **4.10 MB 已经超了**，一个 id 都还没算。**单文件装全量在数学上不可能**，唯一正确的做法就是服务器 + 分页 —— 也就是官方源的做法。

---

## 数据

| 项 | 值 |
|---|---|
| 抓取 | 36,888 条（369 页，18.9 分钟） |
| 翻译 | 59,985 段文本，0 失败 |
| 对外提供 | **34,279 条** |
| 剔除 | 2,599 条（客户端本来就会丢弃，见下） |
| 分类 | devtools 23,807 / web 5,356 / productivity 3,112 / data 1,582 / docs 422 |
| 每页体积 | ~90 KB（4 MB 上限的 **46 倍余量**） |
| 导入写入 | ~36,519 行 = 免费额度 10 万/天的 **37%**，**一次导完** |

### 为什么剔除 2,599 条

宿主的 `mapRegistryServer()` 对"既没有 npm/pypi 包、也没有可用 streamable-http 远端"的记录返回 `null`，`ingest()` 随即丢弃。这种记录**永远不可能被显示**，但服务出去会白占一页 100 个名额里的一个、以及浏览缓存 2000 个名额里的一个 —— 把本来能显示的记录挤掉。

判定用的是**宿主自己的函数**（从 app.asar 提取，见 `generator/lib/host-mapper.generated.js`），不是我重写的近似版 —— 后者会漏掉 12 条（`requiredEnv` 未声明、command 含 `..`、url 非公网 https 等更隐蔽的拒绝理由）。

---

## 三个必须避开的坑（都实测过）

### 1. id 撞车 —— 后缀会被截断吃掉

客户端按 `entry.id` 合并多源、先到先得，而官方源被 `sanitizeMarketSources()` 强制置顶。**id 一旦和官方撞上，我们的记录就被静默丢弃。**

`registryIdFromName()` 会把 slug 截断到 60 字符，所以标记的位置是决定性的：

| 方案 | 撞车条数 |
|---|---|
| `name + "/zh/<分类>"`（后缀） | **158 条** ❌ |
| `"zh/<分类>/" + name`（前缀） | **0 条** ✅ |

前缀写在最前面，截断碰不到它。视觉上零损失：UI 显示的是 `title`，只有没有 title 时才会退回显示 name 的最后一段，而我们服务的每条都有中文标题。

（另有 10~12 条是**我们内部**重复 —— 注册表里存在只差大小写/标点的名字，派生出的 id 相同。这个预期内，生成器保留第一条、跳过其余，因为客户端本来也会丢掉第二条。）

### 2. 分类塌陷

`guessCategory()` 用**英文关键词**匹配 `name + title + description`。直接服务中文会让几乎全部条目塌进 devtools（实测 100 条里 80 → 93）。

解法：分类用**英文原文**算好，把关键词停在一个 UI 不显示的字段（name）里。实测漂移 **0 / 34,279**。

### 3. 中文搜索需要 bigram 折叠

中文没有词分隔，FTS5 的 unicode61 会把整句当成一个 token，子串搜索永远匹配不到。

`shared/fold.js` 把 CJK 串折叠成重叠二元组，带引号的二元组序列就是 FTS5 短语查询 = 精确子串语义。生成端和 Worker 共用同一份代码，两边必须折叠得完全一致，否则搜索会静默失配。

---

## 免费额度

D1 免费版每天 **10 万行写入**。FTS5 的索引方式直接决定能否一天导完 —— 这是实测的物理行数：

| FTS5 方案 | 全量写入行数 | 结论 |
|---|---|---|
| 默认（自带文本副本 + 每行 docsize） | 102,882 | **超了**，导入会中途被截断 |
| **外部内容 + `columnsize=0`（当前）** | **36,519** | 37%，一次导完 ✅ |
| 无内容（contentless） | 70,740 | 能过，但拿不到行位置 |

注意模块名必须小写 `fts5`，D1 对大写 `FTS5` 返回 `not authorized`。

`servers` 表**故意不加任何二级索引**：每个索引都会给每次插入多加一行写入，两个索引就是给全量导入多加约 7.4 万行写入，而浏览读的是主键范围、分类过滤在客户端做，索引毫无收益。

`columnsize=0` 是安全的：我们只取 `rowid`，而且实测 `bm25()` 在关闭 columnsize 后依然可用。

**注意**：外部内容模式下 FTS5 **不会**去读 `servers` 表，所以 `rebuild` 命令会把**未折叠**的原文拿去建索引、静默弄坏所有中文搜索。索引必须在导入时喂 `fold()` 过的文本。

---

## 搜索设计

- 索引只含 `title` + `description`，因为客户端还会用 `[entry.name, entry.description, entry.author]` 二次本地过滤。索引别的字段会让命中在客户端被丢弃、白占一页名额。这样每个命中都保证能活过那道过滤。
- 分页游标压在 `f.rowid`（FTS 侧）而不是 `s.id`（连接表侧）。两者结果相同，但压在连接表侧会让 SQLite 把全部命中收集起来排序（`USE TEMP B-TREE FOR ORDER BY`）；压在索引侧游标能进 FTS 扫描本身。已用 `EXPLAIN QUERY PLAN` 验证。
- 单个 CJK 字符无法表达成二元组短语，走 LIKE 分支。

---

## 项目结构

```
generator/
  step1-fetch.js              抓官方全量 → data/raw.jsonl
  step2-sample.js             抽样翻译并打印对照（质量评审用）
  step3-sql.js                翻译 + 生成 data/import.sql
  step4-verify.js             用真实 SQLite 验证导入、搜索、分页完整性
  update.js                   刷新（全量重抓 + 本地 diff）
  extract-host-mapper.js      从 app.asar 提取宿主的映射函数（升级后重跑）
  check-id-collision.js       验证 id 方案不与官方撞车
  check-served.js             用宿主真实函数验证每条记录客户端都会显示
  measure-writes.js           测量各种 schema 的真实写入行数
  lib/host-mapper.generated.js  自动生成，勿手改
  lib/schema.sql              D1 建表
  lib/translate.js            批量翻译（术语保护 + 品牌名保护 + 缓存）
shared/
  fold.js                     中文 bigram 折叠 + FTS5 查询构造
  shape.js                    记录形状 + id 派生 + 分类保护
worker/src/index.js           registry 协议实现
scripts/deploy.mjs            一键部署
scripts/summary.mjs           数据摘要（CI 与本地共用）
test/
  host-mapper.js              宿主映射函数的单元测试
  deploy-parse.js             部署脚本解析逻辑 + 安全约束
  limits.js                   D1 硬限制预检（语句 100KB / 行 2MB / 无二级索引）
  e2e.js                      对运行中的 Worker 做端到端断言
```

## 命令

Windows 上把 `npm` 换成 `npm.cmd`；或者全部用 `node` 直接跑，更省事。

```powershell
npm.cmd install        # 装依赖（wrangler）

node scripts/deploy.mjs   # 一键部署 ← 你只需要这条
node scripts/summary.mjs --text   # 看当前数据摘要

node generator/step3-sql.js       # 翻译 + 生成 import.sql
node generator/step4-verify.js    # 真实 SQLite 全量验证
node generator/check-id-collision.js  # id 撞车检查
node generator/check-served.js        # 客户端可见性检查
node test/limits.js                   # D1 硬限制预检
node test/host-mapper.js              # 宿主映射函数单元测试
node test/deploy-parse.js             # 部署脚本自检（41 项）
node test/env-token.js                # API token 路径自检（7 项）
node test/e2e.js                      # 端到端（需 Worker 在 8788 跑）
```

## 更新数据

```powershell
node generator/update.js        # 重新抓取（约 19 分钟）
node generator/step3-sql.js     # 只翻译新增的（有缓存，秒级）
node scripts/deploy.mjs         # 重新导入 + 部署
```

`.github/workflows/refresh.yml` 每天自动跑**抓取 + 翻译 + 全部检查**，但**故意不导入 D1** —— 导入期间数据库不可用，且要花掉 37% 的日写入额度，这种决定不该让 cron 替你做。

翻译缓存（约 6 MB）通过 `actions/cache` 在 CI 各次运行之间传递，而不是提交进 git —— 否则仓库历史会被它撑大。

## 升级 PI-Desktop 后

宿主的接收规则是本项目镜像的协议的一部分，升级后重新提取并跑检查：

```powershell
node generator/extract-host-mapper.js --bundle=<app.asar 解出的 main/index.js>
node generator/check-served.js
```

提取器会在报告成功前对生成的文件做语法检查，因为一个被截断的定义会生成"看起来合理"但一 import 就崩的文件。
