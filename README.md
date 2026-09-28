# MCP 中文源

把官方 MCP 注册表（36,888 条）全量翻译成中文，用**和官方完全相同的 registry 分页协议**对外提供。

在 MCP 市场里加**一个源**即可：

```
URL   https://mcp-zh-registry.<你的子域>.workers.dev/servers
类型  registry
```

不装插件、不改设置、严格网络模式可用、完全免费。

---

## 部署（一条命令）

```bash
npm install
node scripts/deploy.mjs
```

脚本会自动：检查登录 → 创建 D1 数据库 → 回填 `wrangler.toml` → 建表 → 导入全量数据 → 部署 Worker → **打印出要填进市场的 URL**。

可重复执行，也兼作更新流程。没有 Cloudflare 账号时会自动打开浏览器让你注册（免费，不用绑卡）。

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
  update.js                   增量刷新（全量重抓 + 本地 diff）
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
test/                         host-mapper / deploy-parse / e2e
```

## 命令

```bash
npm run build         # 翻译 + 生成 import.sql
npm run verify        # 真实 SQLite 全量验证
npm run check:ids     # id 撞车检查
npm run check:served  # 客户端可见性检查（用宿主真实函数）
npm run test          # 全部检查
npm run deploy:all    # 一键部署
```

## 更新数据

```bash
node generator/step1-fetch.js   # 重新抓取
node generator/step3-sql.js     # 只翻译新增的（有缓存）
node scripts/deploy.mjs         # 重新导入 + 部署
```

`.github/workflows/refresh.yml` 已配置每日自动刷新。

## 升级 PI-Desktop 后

宿主的接收规则是本项目镜像的协议的一部分，升级后重新提取并跑检查：

```bash
node generator/extract-host-mapper.js --bundle=<app.asar 解出的 main/index.js>
npm run check:served
```
