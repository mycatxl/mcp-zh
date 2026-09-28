# MCP 中文源

把官方 MCP 注册表（36,888 条）全量翻译成中文，**提供两种接入方式**：

| 方式 | 托管 | 需要账号 | 源数量 | 搜索 | 更新 |
|---|---|---|---|---|---|
| **A. 静态文件（推荐）** | GitHub 仓库 + jsDelivr/GitHub Pages | 只要 GitHub | 4 个文件 | 本地过滤 | push 即生效 |
| **B. Cloudflare Worker** | Cloudflare Workers + D1 | Cloudflare | 1 个 URL | 服务端 FTS5 | 重新导入 |

两种都**零成本**，都支持严格网络模式。想简单就用 A。

---

## 先说清楚：为什么必须"切"

这是你最该问的问题，答案在数字里。

宿主对**单次响应**有硬上限 `MAX_SOURCE_RESPONSE_BYTES = 4 MB`（实测自 `app.asar`）。而两种源格式的取数方式完全不同：

| 源格式 | 取数方式 | 能否分页 |
|---|---|---|
| `registry` | `?limit=100&cursor=x` 逐页拉 | **能**，每页几十 KB，永远碰不到 4MB |
| `catalog` | 一次性拉全量，无分页 | **不能**，整个文件必须 < 4MB |

**官方源用的是 `registry`，所以它不需要切。** 我实测过它：

```
GET https://registry.modelcontextprotocol.io/v0/servers?version=latest&limit=100
→ 200 OK，100 条，82 KB，带 nextCursor
```

`limit=1000` 直接被拒（`expected number <= 100`）。它一次只给 100 条 —— **官方源自己就是"切"的，只是它切的是"页"，不是"文件"**。

关键区别是：**官方源是一台服务器，我的静态方案是一堆文件。** 服务器能按需分页，静态文件不能 —— 客户端要什么就只能整份给什么。

那全量到底多大？实测（不是估算）：

```
全量 catalog 格式   34,299 条   12.54 MB   →  超限 3.1 倍
```

而且**下限是算术决定的，不是调优能解决的**：

| 字段 | 占用 |
|---|---|
| 中文描述 | 3.22 MB |
| 中文标题 | 0.88 MB |
| id | 1.27 MB |
| url | 0.99 MB |
| **仅前两项** | **4.10 MB** ← 已经超过 4MB |

也就是说：**光把标题和描述放进去就已经超了**，一个 id、一个花括号都还没算。单文件装全量在数学上不可能。

但宿主的源数量上限是 `MAX_MARKET_SOURCES = 16`，所以切成 4 个文件就全覆盖了 —— 这不是妥协，是用对了额度。

---

## 方案 A：放 git（推荐）

### 产物

```
catalog/
  mcp-zh-01.json   11,610 条   3.60 MB
  mcp-zh-02.json    7,444 条   3.60 MB
  mcp-zh-03.json   10,422 条   3.60 MB
  mcp-zh-04.json    4,823 条   1.74 MB
  manifest.json                 校验摘要
```

**34,299 条，100% 覆盖，0 条被宿主丢弃。**

### 部署（3 步，不用任何服务器）

```bash
# 1. 建一个 GitHub 仓库，把 catalog/ 目录推上去
git add catalog && git commit -m "catalog" && git push

# 2. 在 PI-Desktop 里加 4 个源（MCP 市场 → 源管理 → 添加源）
#    类型选 catalog，URL 用 jsDelivr：
https://cdn.jsdelivr.net/gh/<你的用户名>/<仓库名>@main/catalog/mcp-zh-01.json
https://cdn.jsdelivr.net/gh/<你的用户名>/<仓库名>@main/catalog/mcp-zh-02.json
https://cdn.jsdelivr.net/gh/<你的用户名>/<仓库名>@main/catalog/mcp-zh-03.json
https://cdn.jsdelivr.net/gh/<你的用户名>/<仓库名>@main/catalog/mcp-zh-04.json

# 或者用 GitHub Pages（同样免费，首次要等几分钟生效）：
https://<你的用户名>.github.io/<仓库名>/catalog/mcp-zh-01.json
```

**严格网络模式直接可用** —— 两者都是公网 https。

### 为什么用 jsDelivr 而不是直连 GitHub

GitHub 的 `raw.githubusercontent.com` 对未认证请求限速严格，且不保证 CDN 缓存。jsDelivr 免费、全球 CDN、无流量费，缓存 7 天（`max-age=604800`）。

实测它能拉 8.72 MB 的文件，**它自己没有 4MB 限制** —— 4MB 是 PI-Desktop 的墙。

### 更新

```bash
node generator/update.js                    # 重新抓取
node generator/step3-sql.js --chunk=8000    # 翻译（只翻新条目）
node generator/build-catalog.js             # 重新生成 catalog/
git add catalog && git commit -m "update" && git push
```

jsDelivr 缓存 7 天；想立刻生效就用 GitHub Pages，或把 URL 里的 `@main` 换成 `@<commit-sha>`。

---

## 方案 B：Cloudflare Worker（带服务端搜索）

只有在你想要**服务端搜索**（而不是前端过滤 11k 条）时才需要它。

```
https://mcp-zh.<你的子域>.workers.dev/servers
```

实现的是和官方**完全一样**的 registry 协议，所以客户端行为（翻页、搜索、去重、安装）全部原样适用。

```bash
cd worker
npx wrangler login
npx wrangler d1 create mcp-zh          # 把 database_id 填进 wrangler.toml
npx wrangler d1 execute mcp-zh --file=../generator/lib/schema.sql --remote
npx wrangler d1 execute mcp-zh --file=../data/d1/part-01.sql --remote   # 每天一份，共 5 份
npx wrangler deploy
```

### 为什么这里也要分 5 份

D1 免费版**每天 10 万行写入**。全量导入要写约 15–20 万行（每条服务一行 + FTS5 内部索引行），一次导完会被中途截断。`--chunk=8000` 切成 5 份，每份约 2.4 万行，一天一份。不想等就升 Workers Paid（$5/月）。

### 免费额度对照

| 项目 | 免费额度 | 用量 |
|---|---|---|
| Worker 请求 | 10 万/天 | 每次翻页 1 次 |
| CPU 时间 | 10 ms/次 | 单次索引查询 1–3 ms |
| D1 行读取 | 500 万/天 | 每页 100 行 |
| D1 存储 | 500 MB/库 | 约 60 MB |

---

## 其他免费托管选项（实测/查证）

| 服务 | 免费额度 | 适合本方案？ |
|---|---|---|
| **jsDelivr** | 无流量费，缓存 7 天 | ✅ **推荐**，已实测 8.72MB 无压力 |
| **GitHub Pages** | 100 GB/月，1 GB 站点 | ✅ 推荐，直连无需 CDN |
| **Cloudflare Pages** | 无限带宽，单文件 25 MiB | ✅ 可用，但要 CF 账号 |
| **Netlify** | 100 GB/月 | ⚠️ 可用，但免费额度有上限 |
| **Vercel** | 100 GB/月 | ⚠️ 同上，且商用需付费 |
| **Deno Deploy / Val Town** | 有免费额度 | ⚠️ 可跑动态，但额度比 CF 小 |

**静态托管只需 GitHub 账号**（jsDelivr 和 Pages 都从 git 读），这是最省事的路。

---

## 官方源和其他市场到底怎么供数的

我把三大市场的机制都挖出来了，供你参考：

### MCP 市场（本项目的目标）

- **官方源**：`registry` 协议，`?limit=100&cursor=x` 分页。服务器动态生成，一次 100 条 82KB。
- **也支持 `catalog`**：一次性静态 JSON，整份必须 < 4MB。**本项目方案 A 用的就是它。**

### 插件市场

- 单个静态 catalog：`https://plugins.aiuo.net/catalog.json`，**229 KB，40 个插件**。
- 它自带多语言字段，所以官方插件本身就有中文：

```json
{
  "id": "io.github.muzimu217.deps-audit",
  "name": "Deps Audit",
  "description": "依赖漏洞扫描：唤起 osv-scanner 扫描工作区…",
  "i18n": {
    "en": { "name": "Deps Audit", "description": "Dependency vulnerability audit: …" }
  }
}
```

**这是关键区别**：插件市场有 `i18n` 字段所以能显示中文，而 MCP 市场**没有这个字段** —— 它的 `description` 是单语言的。这就是为什么 MCP 市场必须靠外部源来提供中文。

### 技能市场

- 源格式是 `{id, name, url}`，url 指向 **GitHub 仓库**。
- 它通过 `api.github.com` 拉仓库的文件树，找出所有 `SKILL.md`：

```
GET https://api.github.com/repos/{owner}/{repo}          → 拿默认分支
GET https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1
   → 遍历所有 *.md，读 SKILL.md 的内容
```

**技能市场根本不需要自己托管** —— 直接指向一个 GitHub 仓库就行。这也是为什么它默认有 7 个源（anthropics/skills、obra/superpowers 等）。

### 三种模式对比

| 市场 | 供数方式 | 需要托管吗 | 能否中文化 |
|---|---|---|---|
| 插件 | 静态 catalog（含 i18n） | 官方托管 | ✅ 官方自带 |
| MCP | registry 分页 / catalog 静态 | 官方托管 | ⚠️ 需外部源（本项目） |
| 技能 | 直读 GitHub 仓库的 SKILL.md | **不需要** | ⚠️ 内容在仓库里 |

---

## 两个必须处理的坑（都已解决）

### 1. id 冲突会让中文条目被静默丢弃

客户端按 `registryIdFromName(server.name)` 派生条目 id，多源合并是**先到先得**，而官方源被 `sanitizeMarketSources()` 强制插到最前：

```js
if (!sources.some((s) => s.source.id === DEFAULT_MARKET_SOURCE.id)) {
  sources.unshift(DEFAULT_MARKET_SOURCE);   // 永远第一
}
```

所以 id 一旦相同，中文条目就被英文顶掉。我写了复现脚本验证过三种场景。

**踩到的第二个坑**：一开始我用 `zh` 后缀（`.../zh/api`），但 `registryIdFromName` 会**截断到 60 字符** —— 长名字的后缀被整个切掉，id 又塌回官方那个（实测 80 条中招）。

**解法**：改用 **前缀** `zh-`。前缀在截断之后才拼上，永远删不掉：

```js
function zhId(sourceName) {
  const natural = registryIdFromName(sourceName);
  return `zh-${natural.slice(0, 60 - 3)}`;   // 60 是宿主的截断长度
}
```

### 2. 分类会全部塌进 devtools

客户端的 `guessCategory()` 用**英文**关键词匹配 `name + title + description`。换成中文后实测 100 条里 **80 → 93 条塌进 devtools**。

**解法**：分类在翻译前用英文原文算好，然后把对应关键词塞进 `name` —— 这是唯一在标题存在时不被显示的字段。最终分布：

```
devtools=23820  web=5359  productivity=3112  data=1586  docs=422
```

### 3. 校验器会静默丢条目

`validateMcpCatalogFile()` 对不合格的条目**不报错，直接跳过**。3.4 万条的 catalog 可能只加载出 3 万条而你毫无察觉。

所以 `build-catalog.js` 内置了从 `app.asar` 逐字抄来的校验规则，生成时逐条验证，并报告丢弃数（当前 **0**）。规则包括：

- id 必须匹配 `^[a-z][a-z0-9_-]{0,63}$`
- `transport` 必须是 `stdio` 或 `http`
- stdio 必须有 `command` 且不能含 `..`
- http 的 url 必须是**公网 https**
- `categories` 只能是 `devtools`/`web`/`docs`/`data`/`productivity`
- `env` 里每个 `${VAR}` 必须在 `requiredEnv` 里声明（最容易踩的一条）

---

## 结构

```
generator/
  step1-fetch.js        拉官方全量 → data/raw.jsonl
  step2-sample.js       翻译 200 条样本并打印对照（质量评审用）
  step3-sql.js          全量翻译 → data/import.sql + data/d1/part-NN.sql
  step4-verify.js       用真实 SQLite 验证导入和搜索
  build-catalog.js      生成 catalog/ 静态文件（方案 A）
  measure-catalog.js    测量体积上限，解释"为什么必须切"
  update.js             增量刷新
  lib/registry.js       游标翻页 + 重试（官方端点偶发 500）
  lib/translate.js      批量翻译（术语保护 + 品牌名保护 + 缓存）
  lib/glossary-words.js 判断名字里的词是品牌还是通用词
  lib/schema.sql        D1 建表
shared/
  fold.js               中文 bigram 折叠 + FTS5 查询构造
  shape.js              记录形状 + 可安装性判定 + id 派生
worker/
  src/index.js          Worker：registry 协议实现（方案 B）
test/
  catalog.js            26 项静态文件断言
  e2e.js                42 项 Worker 端到端断言
```

---

## 翻译怎么做的

用免费的 Google 网页接口批量翻译（30 条/请求，实测约 120 条/秒，全量约 6 分钟，零成本）。三项质量控制：

1. **占位符保护** —— `[[A1]]` 能原样穿过翻译引擎，需要保持原样的 token 先藏后还原。裸 token 会被乱翻（"Getlead"→"格利德"、"JustIdea"→"正意"、"hood"→"兜帽"）。
2. **品牌词保护** —— 从注册表名提取品牌词逐个保护，通用词照常翻译。所以 "Propick Integration MCP" 保住品牌，而 "Business Contact Finder" 正常翻成中文。
3. **术语预替换** —— 把中文术语直接写进原文（"coding 智能体"），引擎会原样输出，修掉 "agent"→"代理"（proxy）、"integration"→"积分"（数学积分）这类错误。

---

## 已知边界

- **同一服务会出现两张卡片**（官方英文 + 本项目中英），因为 id 必须不同才能不被顶掉。中文搜索只命中中文那张。
- **2,589 条（7%）无法安装**：官方注册表里既没有 npm/pypi 包、也没有可用的 streamable-http 远端。官方源同样会隐藏这些。
- **953 条没有中文**：原文是专有名词或已经是中文，翻译引擎原样返回。
- **方案 A 的搜索是前端过滤**（11,610 条本地过滤，很快）；想要服务端搜索就用方案 B。
- **方案 B 浏览模式最多显示前 2000 条**（客户端 `MAX_CACHED_ENTRIES = 2000` 上限），超出靠服务端搜索。方案 A 无此限制。
- **机器翻译**，术语已尽量校正，但不保证 100% 准确。
