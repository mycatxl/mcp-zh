# MCP 中文源

把官方 MCP 注册表（36,881 条）全量翻译成中文，用**和官方完全一样的分页协议**对外提供服务。

PI-Desktop 的 MCP 市场把它当普通自定义源加进去就能看到全中文市场，**不需要装插件、不需要改设置、严格网络模式也能用**。

```
https://mcp-zh.<你的子域>.workers.dev/servers
```

---

## 它为什么能用

官方源不是"一次性吐全量"，它是**分页**的：

```
GET /servers?version=latest&limit=100&cursor=xxx
→ { servers: [...100 条...], metadata: { count, nextCursor } }
```

本项目实现同一个协议，所以客户端的全部行为（翻页、服务端搜索、去重、安装）都原样适用。关键常量（读自 `app.asar`）：

| 宿主限制 | 值 | 本项目 |
|---|---|---|
| 单响应上限 | 4 MB | 每页约 92 KB（**46 倍余量**） |
| 请求超时 | 8 秒 | 每页 30–60 ms |
| 浏览缓存上限 | 2000 条/源 | 生成时把可安装、有标题的排前面 |
| 服务端搜索 | `?search=` | FTS5 + 中文 bigram 索引 |

### 两个必须处理的坑（都已解决）

**1. id 冲突会让中文条目被丢弃。** 客户端按 `registryIdFromName(server.name)` 派生 id，多源合并是**先到先得**，而官方源被强制插在最前面。所以同 id 的中文条目会被英文顶掉。

解决：把中文条目的 `name` 加 `/zh/<分类>` 后缀，派生出的 id 就变成 `...-zh-api`，不再冲突，中文条目得以独立存在（副作用是同一服务会出现中英两张卡片，但中文搜索只命中中文条目，反而更好用）。

**2. 分类会全部塌进 devtools。** 客户端的 `guessCategory()` 用**英文**关键词匹配 `name + title + description`。我们提供中文文本后，实测 100 条里 80→93 条塌进 devtools。

解决：分类在翻译前用英文原文算好，然后把对应的英文关键词塞进 `name`（`name` 是唯一在标题存在时不被显示的字段），分类因此原样保留。

---

## 结构

```
generator/
  step1-fetch.js      拉官方全量 → data/raw.jsonl
  step2-sample.js     翻译 200 条样本并打印对照（质量评审用）
  step3-sql.js        全量翻译 → data/import.sql + data/d1/part-NN.sql
  step4-verify.js     用真实 SQLite 验证导入和搜索
  lib/registry.js     游标翻页 + 重试（官方端点会偶发 500）
  lib/translate.js    批量翻译（含术语保护、品牌名保护、缓存）
  lib/glossary-words.js  判断名字里的词是品牌还是通用词
  lib/schema.sql      D1 建表
shared/
  fold.js             中文 bigram 折叠 + FTS5 查询构造（生成端和 Worker 共用）
  shape.js            按官方格式组装记录 + 可安装性判定 + id 派生
worker/
  src/index.js        Worker：registry 协议实现
test/
  e2e.js              42 项端到端断言
```

---

## 本地跑通

```bash
npm install
node generator/step1-fetch.js            # 全量抓取，约 19 分钟
node generator/step3-sql.js --chunk=8000 # 翻译 + 生成 SQL，约 6 分钟（首次）

cd worker
npx wrangler d1 execute mcp-zh --file=../generator/lib/schema.sql --local
npx wrangler d1 execute mcp-zh --file=../data/import.sql --local
npx wrangler dev --port 8788 --local
```

另一个终端：

```bash
node test/e2e.js                          # 42 项断言
```

---

## 部署到 Cloudflare（免费）

```bash
cd worker
npx wrangler login
npx wrangler d1 create mcp-zh
# 把输出的 database_id 填进 worker/wrangler.toml

npx wrangler d1 execute mcp-zh --file=../generator/lib/schema.sql --remote
npx wrangler deploy
```

### 数据导入要分几天（免费额度限制）

D1 免费版**每天 10 万行写入**。全量导入会写约 15–20 万行（每条服务一行 + FTS5 内部索引行），所以一次性导入会被中途截断。

`--chunk=8000` 会把数据切成 5 份，每份约 2.4 万行，**每天导入一份**：

```bash
npx wrangler d1 execute mcp-zh --file=../data/d1/part-01.sql --remote   # 第 1 天
npx wrangler d1 execute mcp-zh --file=../data/d1/part-02.sql --remote   # 第 2 天
# ... 依次 5 份
```

想一次导完也可以升级 Workers Paid（$5/月）。

### 免费额度对照

| 项目 | 免费额度 | 本项目用量 |
|---|---|---|
| Worker 请求 | 10 万/天 | 每个用户每次翻页 1 次 |
| CPU 时间 | 10 ms/次 | 单次查询走索引，约 1–3 ms |
| D1 行读取 | 500 万/天 | 每页 100 行 |
| D1 行写入 | 10 万/天 | 仅导入时消耗 |
| D1 存储 | 500 MB/库 | 约 60 MB |

---

## 加进 PI-Desktop

1. 设置 → 扩展 → MCP 市场 → 源管理 → 添加源
2. 类型选 **registry**（不能选 catalog）
3. URL 填 `https://mcp-zh.<你的子域>.workers.dev/servers`

严格网络模式直接可用 —— 这个源是公网 https，不受"宽松网络模式"限制。

---

## 更新数据

```bash
node generator/step1-fetch.js             # 重新抓取（覆盖 raw.jsonl）
node generator/step3-sql.js --chunk=8000  # 翻译增量（有缓存，只翻新条目）
```

翻译缓存（`data/translation-cache.json`）按**原文 + 保护词**做键，所以重复运行只翻译新增和改动过的文本。

---

## 设计说明

**为什么不用 catalog 格式？** catalog 是一次性拉全量，6–9 MB 必然撞上 4 MB 上限。registry 协议每次只返 100 条，永远碰不到。

**为什么用 bigram 折叠？** 中文没有词分隔，FTS5 的 unicode61 分词器会把整句当一个 token，子串搜索永远匹配不上。把中文切成重叠的二元组后，"精确子串"就变成了普通的 token 匹配，而带引号的二元组序列就是 FTS5 的短语查询，语义完全等价。实测 `数据`（2 字）、`数据库`、`智能体`、`文档安装`、`MCP 文档` 全部命中。

**为什么索引只含 title 和 description？** 客户端拿到结果后会用 `[name, description, author]` 再过滤一遍。如果索引了别的字段（比如原始 name、分类），服务端命中的行可能被客户端丢掉，白白浪费一页 100 个名额中的一个。只索引这两个字段，就能保证服务端返回的每一条都活得下来。

**翻译怎么做的？** 用免费的 Google 网页接口批量翻译（30 条/请求，实测约 120 条/秒，全量 6 分钟，零成本）。三项质量控制：

1. **占位符保护** —— `[[A1]]` 能原样穿过翻译引擎，所以需要保持原样的 token 可以先藏起来再还原。裸 token 会被乱翻（"Getlead"→"格利德"、"JustIdea"→"正意"、"hood"→"兜帽"）。
2. **品牌词保护** —— 从注册表名里提取品牌词逐个保护，通用词（见 `glossary-words.js`）照常翻译。所以 "Propick Integration MCP" 保住品牌，而 "Business Contact Finder" 正常翻成中文。
3. **术语预替换** —— 把中文术语直接写进原文（"coding 智能体"），引擎会原样输出，修掉 "agent"→"代理"（proxy）、"integration"→"积分"（数学积分）这类错误。

---

## 已知边界

- **同一服务会出现两张卡片**（官方英文 + 本项目中英），因为 id 必须不同才能不被顶掉。中文搜索只命中中文那张。
- **2,587 条（7%）无法安装**：官方注册表里既没有 npm/pypi 包、也没有可用的 streamable-http 远端。官方源同样会隐藏这些，这里保留是为了让中文搜索能搜到它们。
- **浏览模式最多显示前 2000 条**（客户端缓存上限），超出部分靠服务端搜索。生成时已按"可安装 → 有标题 → 有描述"排序。
- **翻译是机器翻译**，术语已尽量校正，但不保证 100% 准确。
