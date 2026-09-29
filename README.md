# mcp-zh

把官方 MCP 注册表（36,888 条）全量翻译成中文，用**和官方完全相同的 registry 分页协议**对外提供。

在 MCP 市场里加**一个源**即可看到全中文市场：

```
类型  Registry 协议
URL   https://<你的 Worker>.workers.dev/servers
```

不装插件、不改设置、严格网络模式可用、完全免费。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mycatxl/mcp-zh)

**一键部署**：点按钮 → 授权你的 Cloudflare 账号 → 自动建库、灌入 34,279 条中文数据、部署完成。**不用 API Token，不用命令行，不在这台机器上跑任何东西。** 详见 [部署](#部署)。

---

## 它是怎么工作的

```
官方 registry（英文，PostgreSQL 服务器）
        │  GitHub Actions 每天 03:17 抓取 + 翻译
        ▼
   data/import.sql（43.5 MB）
        │
        ├────► 发布成 release 资源（压缩后 7.8 MB，公开可下）
        │          └── 给「一键部署按钮」和 `npm run build` 取用
        │              所以别人不用跑那 19 分钟的抓取
        │
        │  内容指纹变了才导入（避免每天烧掉 69% 的 D1 日额度）
        ▼
Cloudflare D1 ── 34,279 条中文记录 + 中文 FTS5 搜索索引
        ▲  查询
Cloudflare Worker ── 说和官方一模一样的 registry 协议
        ▲  HTTPS
PI-Desktop 市场 ── 你加一个源
```

**分工的原因**：CF 免费版 Cron Trigger 每次只有 **10ms CPU**，而抓取要 **19 分钟**，差 11 万倍，所以刷新必须在能跑长任务的地方做。GitHub Actions 负责刷新，Cloudflare 负责托管，两边都免费。

---

## 部署

### 方式一：一键按钮（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mycatxl/mcp-zh)

1. 点上面这个按钮
2. 用你的 Cloudflare 账号授权（没有就现场注册，**免费、不用绑卡**）
3. 配置页里构建/部署命令已经预填好了，直接确认
4. 等几分钟。Cloudflare 会自动：建一个 D1 数据库 → 回填 `database_id` → 下载数据集 → 解压校验 → 导入 **34,279 条中文记录** → 部署 Worker
5. 完成后会给你一个 `https://mcp-zh.<你的子域>.workers.dev` 地址

**不需要 API Token，不需要命令行，不需要在这台机器上做任何事。** 数据库、Worker、URL 全程只落在你自己的账号里。

#### 它是怎么拿到数据的

全新克隆里既没有 `data/` 目录，也没跑过那 19 分钟的抓取，所以构建步骤（`npm run build` → `scripts/seed.mjs`）会去下载预先发布好的数据集。

下载会**先取 `MANIFEST.json`，再用 sha256 和解压后的长度校验**，两个都对上才落盘，而且是先写 `.tmp` 再原子改名。这不是洁癖：一个被截断的导入文件会**安安静静地导入成功**，然后留下一个条目少了一半的市场 —— 不校验的话，这种故障在界面上和成功长得一模一样。

#### 为什么 `wrangler.toml` 必须在仓库根目录

Cloudflare 读**根目录**的 wrangler 配置来决定创建哪些资源、并回填 id。放在子目录里它找不到，结果就是 Worker 部署成功、但没绑定数据库 —— 看起来一切正常，直到第一次查询返回空。

随后跑的 `deploy` 脚本用**绑定名**（`DB`）而不是数据库名寻址。这是有意的：你在配置页里把数据库改成别的名字，脚本照样能跑。

### 方式二：本机命令行

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mycatxl/mcp-zh)

#### Windows 用户先看这条

PowerShell 执行策略**禁止运行 `npm.ps1`**，所以 `npm install` / `npm run ...` 会报 `running scripts is disabled`。

**用 `node` 直接跑脚本**（推荐），或把 `npm` 换成 `npm.cmd`。

#### 授权

两种方式，任选：

**A. API Token（不弹浏览器）**

1. 打开 https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** → 用 **"Edit Cloudflare Workers"** 模板（含 D1 权限）
3. 复制 token，设成环境变量：

```powershell
setx CLOUDFLARE_API_TOKEN "你的token"
```

> Windows 上脚本会**直接从注册表 `HKCU\Environment` 读**这个变量。因为长时间运行的程序（PI-Desktop、IDE、已开的终端）保留的是启动时的环境块，`setx` 之后的变量在 `process.env` 里看不到，但注册表里是最新的。已实测（`node test/env-token.js`，7 项断言）。

**B. OAuth 登录（点一下浏览器）**

```powershell
node scripts/deploy.mjs
```

没登录时会自动打开浏览器。账号免费、不用绑卡。

> **关于 `localhost:8976`**：这是 wrangler 为接收授权码**临时**起的本地回调口，只在授权那几秒存在。**它和部署后的服务毫无关系** —— 部署产物里没有任何 localhost，服务跑在 Cloudflare 边缘节点。浏览器够不到本机时（远程 shell、容器）用设备码模式：
> ```powershell
> node node_modules/wrangler/bin/wrangler.js login --device
> ```

#### 部署

```powershell
cd D:\WorkSpace\Chat\mcp-zh
node scripts/deploy.mjs
```

脚本会自动：检查登录 → 创建/复用 D1 数据库 → 回填 `wrangler.toml` → 建表 → 导入 → 部署 → **把 URL 写回 `project.json`** → 打印要填进市场的 URL。

数据集不在仓库里（43.5 MB，每次刷新都会变）。本机没有时它会让你先跑 `node scripts/seed.mjs` 下载 —— 大概率是**秒下**，因为它已经以 7.8 MB 压缩包的形式发布在 release 里。

**URL 只存在 `project.json` 一处** —— 换 CF 账号时 `*.workers.dev` 子域会变，workflow、DevTools 代码片段、测试全部自动跟着走，不用手改任何文件。

#### 常用参数

```powershell
node scripts/deploy.mjs --check          # 干跑：只报告会做什么
node scripts/deploy.mjs --login-only     # 只解决授权
node scripts/deploy.mjs --skip-import    # 只建表+部署，不导数据
node scripts/deploy.mjs --db=名字        # 换数据库名
node scripts/deploy.mjs --worker=名字    # 换 Worker 名（决定 URL）
node scripts/deploy.mjs --cloud          # 库已建好且已绑定（一键按钮走的模式）
```

#### 部署后自检

```powershell
curl https://<你的 Worker>.workers.dev/health
# {"ok":true,"entries":34279,"contentHash":"...","protocol":"registry",...}
```

---

## 让市场显示中文（重要）

PI-Desktop 的 MCP 市场有个 **bug：添加的源自会丢**。

「添加源」的处理函数只改了 React 内存，**从未写入存储**：

```js
te = () => {
  j(Z => [...Z, {id:`custom-${...}`, ...}]),   // ← 只改内存
  G({name:"", url:"", kind:"registry"})        // ← 清空输入框
}
```

对比隔壁技能市场（同一个文件）：`function nc(s){ localStorage?.setItem(Ai, JSON.stringify(s)) }` —— **有**写入。

**证据**：存储里实际只有 `[{"id":"official",...}]`，你加的源从没被写进去。

### 绕过方法

1. 设置 → **常规** → 打开「**开发者模式**」（"启用开发者工具和 F12"）
2. 按 **F12** 打开控制台
3. 粘贴 `docs/console-snippet.txt` 里那一行（由 `node scripts/make-snippet.mjs --write` 生成）
4. 回车，应输出 `mcp-zh > official`

**那行代码为什么必须写成这样**：

| 要求 | 原因 |
|---|---|
| id 匹配 `^[a-z][a-z0-9_-]{0,63}$` | 否则被静默丢弃 |
| 官方源必须存在且 url 逐字节相同 | 否则被跳过，然后官方源被顶到最前 |
| **我们的源写在最前面** | 只存我们的源 → 官方源被 `unshift` 到最前 → 还是先看到英文 |
| 幂等 | 重复执行不产生重复项 |

全部用**从 app.asar 提取的宿主真实函数**验证过（`node test/source-snippet.js`，21 项断言）。

---

## 自动更新

每天 03:17 UTC 自动跑：

```
抓取（19 分钟）→ 翻译（只翻新增）→ 全部检查
        ↓
算内容指纹，和线上 /health 的对比
        ↓
  相同 → 整个跳过（不烧 D1 额度，也不churn release 资源）
  不同 → 先发布数据集到 release → 再导入 D1 + 重新部署
```

**为什么要内容指纹**：全量导入要花 **68,564 行写入 = 69% 的日额度**（实测）。每天无脑导一遍会烧光额度，出错时没有余量重试。

**为什么数据集先发布、再导入 D1**：这样即使导入失败（额度用尽、网络抖动），一个校验过的、可用的数据集仍然对所有克隆、fork 和一键部署可用。顺序反过来的话，一次失败的导入会同时毁掉自动更新和所有人的一键部署。

**需要配置两个 GitHub Secrets**（Settings → Secrets and variables → Actions）：

| 名称 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 用 "Edit Cloudflare Workers" 模板创建 |
| `CLOUDFLARE_ACCOUNT_ID` | 面板 URL 里的账号 id |

没配也不会失败 —— 检查照跑，只跳过发布并给警告（fork 和全新克隆不会红）。

> **如果你是用一键按钮部署的**：Cloudflare 会把仓库克隆一份**到你的账号下**，自动刷新要在**那一份**里跑。所以 Secrets 得加在**你自己的仓库**（Settings → Secrets and variables → Actions），加在这个源仓库上对你不生效。刷新出来的数据集也会发布到你的仓库，而不是这里。

---

## 数据

| 项 | 值 |
|---|---|
| 抓取 | 36,888 条（369 页，18.9 分钟） |
| 翻译 | 59,985 段文本，0 失败 |
| 对外提供 | **34,279 条** |
| 剔除 | 2,599 条（客户端本来就会丢弃） |
| 分类 | devtools 23,807 / web 5,356 / productivity 3,112 / data 1,582 / docs 422 |
| 每页体积 | ~90 KB（4 MB 上限的 **46 倍余量**） |
| 导入写入 | 68,564 行 = 日额度 **69%**，用时 **5.2 秒** |

### 为什么剔除 2,599 条

宿主的 `mapRegistryServer()` 对"既没有 npm/pypi 包、也没有可用 streamable-http 远端"的记录返回 `null`，`ingest()` 随即丢弃。这种记录**永远不可能被显示**，但服务出去会白占一页 100 个名额里的一个。

判定用的是**宿主自己的函数**（从 app.asar 提取），不是重写的近似版 —— 后者会漏掉 12 条（`requiredEnv` 未声明、command 含 `..`、url 非公网 https 等更隐蔽的理由）。

---

## 三个必须避开的坑

### 1. id 撞车 —— 后缀会被截断吃掉

客户端按 `entry.id` 合并多源、先到先得，官方源被强制置顶。**id 一旦和官方撞上，我们的记录就被静默丢弃。**

`registryIdFromName()` 把 slug 截断到 60 字符，所以标记位置是决定性的：

| 方案 | 撞车条数 |
|---|---|
| `name + "/zh/<分类>"`（后缀） | **158 条** ❌ |
| `"zh/<分类>/" + name`（前缀） | **0 条** ✅ |

### 2. 分类塌陷

`guessCategory()` 用**英文关键词**匹配 `name + title + description`。直接服务中文会让几乎全部条目塌进 devtools（实测 100 条里 80 → 93）。

解法：分类用**英文原文**算好，关键词停在一个 UI 不显示的字段（name）里。实测漂移 **0 / 34,279**。

### 3. 中文搜索需要 bigram 折叠

中文没有词分隔，FTS5 的 unicode61 会把整句当成一个 token，子串搜索永远匹配不到。

`shared/fold.js` 把 CJK 串折叠成重叠二元组，带引号的二元组序列就是 FTS5 短语查询 = 精确子串语义。生成端和 Worker 共用同一份代码，两边必须折叠得完全一致。

---

## 免费额度

D1 免费版每天 **10 万行写入**。FTS5 的索引方式直接决定能否一次导完：

| FTS5 方案 | 写入行数/条 | 全量 | 结论 |
|---|---|---|---|
| 默认（自带文本副本 + docsize） | ~3x | 约 3 倍额度 | **超了** |
| **外部内容 + `columnsize=0`（当前）** | **2.00** | **68,564 = 69%** | 一次导完 ✅ |

模块名必须小写 `fts5`，D1 对大写 `FTS5` 返回 `not authorized`。

`servers` 表**故意不加二级索引**：每个索引给每次插入多加一行写入，两个索引就是给全量导入多加约 6.8 万行。

**注意**：外部内容模式下 FTS5 **不读** `servers` 表，所以 `rebuild` 会把**未折叠**的原文拿去建索引、静默弄坏所有中文搜索。索引必须在导入时喂 `fold()` 过的文本。

---

## 搜索设计

- 索引只含 `title` + `description`，因为客户端还会用 `[entry.name, entry.description, entry.author]` 二次本地过滤。索引别的字段会让命中在客户端被丢弃、白占名额。
- 分页游标压在 `f.rowid`（FTS 侧）而不是 `s.id`（连接表侧）。后者会让 SQLite 收集全部命中再排序（`USE TEMP B-TREE FOR ORDER BY`）。已用 `EXPLAIN QUERY PLAN` 验证。
- 单个 CJK 字符无法表达成二元组短语，走 LIKE 分支。
- `/health` 只读 `meta` 表和 `MAX(id)`，不 `COUNT(*)` 扫全表。

---

## 项目结构

```
project.json                  身份唯一来源：源 id/名称、Worker 名、数据库名、已部署 URL、数据集地址
wrangler.toml                 Worker 配置。必须在仓库根目录 —— 一键部署按钮据此识别 D1 绑定
generator/
  step1-fetch.js              抓官方全量 → data/raw.jsonl
  step2-sample.js             抽样翻译并打印对照（质量评审）
  step3-sql.js                翻译 + 生成 import.sql（含内容指纹）
  step4-verify.js             用真实 SQLite 验证导入、搜索、分页
  update.js                   刷新（全量重抓 + 本地 diff）
  extract-host-mapper.js      从 app.asar 提取宿主映射函数
  extract-sanitize.js         从 app.asar 提取 sanitizeMarketSources
  check-id-collision.js       验证 id 方案不与官方撞车
  check-served.js             用宿主真实函数验证每条记录可视
  check-titles.js             标题组成审计
  measure-writes.js           测量各种 schema 的真实写入行数
  lib/schema.sql              D1 建表（servers / search / meta）
  lib/translate.js            批量翻译（术语保护 + 品牌名保护 + 缓存）
  lib/*.generated.js          自动生成，勿手改
shared/
  fold.js                     中文 bigram 折叠 + FTS5 查询构造
  shape.js                    记录形状 + id 派生 + 分类保护
worker/src/index.js           registry 协议实现
scripts/
  deploy.mjs                  一键部署；--cloud 是一键按钮走的模式
  seed.mjs                    取数据集：本地已有就跳过，否则下载 + 校验
  publish-seed.mjs            把数据集发布成 release 资源（每次刷新自动跑）
  make-snippet.mjs            生成 DevTools 代码片段
  summary.mjs                 数据摘要（CI 与本地共用）
  lib/project.mjs             project.json 读写 + 校验
test/
  host-mapper.js              宿主映射函数单元测试
  source-order.js             源顺序规则（用宿主真实函数）
  source-snippet.js           DevTools 片段验证
  deploy-parse.js             部署脚本解析 + 安全约束
  env-token.js                API token 路径验证
  limits.js                   D1 硬限制预检
  seed.js                     一键部署路径（布局、脚本契约、下载校验）
  e2e.js                      对运行中的 Worker 做端到端断言
docs/console-snippet.txt      生成的 DevTools 片段
```

## 命令

```powershell
npm run build                       # 取数据集：本地已有就跳过，否则下载并校验
npm run deploy                      # 建表 + 导入 + 部署（一键按钮跑的就是这条）

node scripts/deploy.mjs             # 同样的事，但自己按名字查/建 D1 ← 本机最常用
node scripts/seed.mjs --check       # 只报告数据集会从哪来
node scripts/publish-seed.mjs       # 把当前数据集发布成 release 资源
node scripts/make-snippet.mjs       # 打印 DevTools 片段
node scripts/summary.mjs --text     # 数据摘要

node generator/step3-sql.js         # 翻译 + 生成 import.sql
node generator/step4-verify.js      # 真实 SQLite 全量验证
node generator/check-id-collision.js
node generator/check-served.js
node test/limits.js                 # D1 硬限制预检
node test/seed.js                   # 一键部署路径契约
node test/source-order.js           # 源顺序规则
node test/source-snippet.js         # 片段验证
node test/e2e.js                    # 端到端（需 Worker 在 8788 或线上）
```

## 升级 PI-Desktop 后

宿主的接收规则是本项目镜像的协议的一部分，升级后重新提取并跑检查：

```powershell
node generator/extract-host-mapper.js --bundle=<app.asar 解出的 main/index.js>
node generator/extract-sanitize.js    --bundle=<同上>
node generator/check-served.js
node test/source-order.js
```

两个提取器都会在报告成功前对生成的文件做语法检查，因为一个被截断的定义会生成"看起来合理"但一 import 就崩的文件。

> 已验证：**0.15.9 → 0.15.10 之间，我依赖的 9 个宿主函数逐字节相同**，所有数值常量（4MB 上限、8s 超时、16 源、2000 缓存、每页 100）也没变。
