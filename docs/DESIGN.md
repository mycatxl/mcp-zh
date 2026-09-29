# 设计说明

README 之外的技术取舍，以及踩过的坑。每条都对应一个**真实的失败**，不是理论风险。

---

## 1. 一键部署的约束

Cloudflare 的 Deploy to Cloudflare 按钮会克隆仓库、**自动创建 `wrangler.toml` 里声明的资源**、然后跑 `package.json` 里的自定义 `deploy` 脚本。三件事必须同时成立：

| 约束 | 不满足会怎样 |
|---|---|
| `wrangler.toml` 在**仓库根目录** | Cloudflare 找不到它 → 不创建数据库 → Worker 部署成功但没绑定库。看起来一切正常，**直到第一次查询返回空** |
| `build` 在全新克隆里能跑 | Cloudflare 会自动预填 `build`/`deploy` 字段。若 `build` 是翻译步骤，在没有 `raw.jsonl` 的克隆里必然失败 |
| 数据集可公开下载 | 全新克隆里没有 `data/`，也就没有数据可导 |

因此：

- 翻译步骤改名为 `translate`，`build` 变成 `scripts/seed.mjs`（取数据集）。
- 数据集不进 git（43.5 MB，每天刷新会让历史线性膨胀），而是压缩成 7.8 MB 发布为 release 资源。`seedUrl` 指向**本源仓库**，所以 fork 和一键部署都能取到数据。
- `deploy.mjs --cloud` 用**绑定名**（`DB`）而不是数据库名寻址 —— `wrangler d1 execute` 的 `database` 参数官方说明就是 "The name or binding"。这样用户在配置页里把数据库改名也照样能跑。
- `--cloud` 下凭据缺失时**直接失败**，不退回 `wrangler login`：构建容器里没有浏览器也没有 stdin，退回去只会挂到任务超时。

### wrangler 放在 dependencies，不是 devDependencies

`deploy` 脚本要用 wrangler 干活，而 Cloudflare 的构建环境**不保证**装 devDependencies。`npm ci --omit=dev` 会把 devDependencies 整个跳过，那样按钮点下去就死在「找不到 wrangler」上。

放进 `dependencies` 后两种装法都会带上它（实测 `npm ci --omit=dev --dry-run` 会安装 wrangler 4.142.0）。对一个 CLI 来说这不太常见，但这里它是**运行时**需求，不是开发期工具。

> **连带坑**：`package-lock.json` 记录了依赖类型（`"dev": true`）。只改 `package.json` 而不重新生成锁文件，`npm ci` 会直接报「不同步」而失败 —— 恰好毁掉构建。改完必须跑 `npm install --package-lock-only`。

`scripts/deploy.mjs` 里还有一层 npx 兜底，但它是安全网而非主路径：`npx wrangler` 会**先解析本地 `node_modules/.bin/wrangler`**，即使写成 `wrangler@4` 也一样；只要本地留有一份过期或残缺的 shim，兜底反而会以 `MODULE_NOT_FOUND` 失败。真正让主路径可靠的是上面这个依赖类型的改动。

### 数据校验不是洁癖

`seed.mjs` 先取 `MANIFEST.json`，用 sha256 和解压后长度校验，先写 `.tmp` 再原子改名。

理由：**一个被截断的导入文件会导入成功**，然后留下一个条目少了一半的市场。界面上和成功没有任何区别 —— 这种故障不校验就发现不了。

### 刷新顺序：先发布数据集，再导入 D1

导入可能失败（额度用尽、网络抖动）。先发布数据集的话，一个校验过的、可用的数据集仍然对所有克隆和 fork 可用；顺序反过来，一次失败的导入会同时毁掉自动更新和所有人的一键部署。

### 连上仓库后会多出一条构建流水，所以导入必须是幂等的

一键部署会把 Worker 连到仓库，此后**每次推送到生产分支都会重新构建并部署**。而刷新工作流每天都会往那个分支推一次提交（`data/stats.json` 里含 `generatedAt`，每天必变），于是自动更新和 Workers Builds 会**各导一次**：68,564 × 2 > 100,000，第二天开始必有一天失败。

解法是让导入幂等：`meta` 表里记着已发布内容的指纹，`--cloud` 在导入前先读出来比对，**相同就整段跳过**，直接部署。

两个细节必须一起处理：

1. **建表和导入要一起跳。** 建表是 `DROP TABLE` + `CREATE`，只跳导入会留下一个**空库** —— 比浪费额度严重得多。
2. **读不到指纹要按「需要导入」处理。** 第一次运行时根本没有 `meta` 表；查询失败也不能被当成「已是最新」。

实测（对一个已发布的库跑 `--cloud`）：识别到指纹相同 → `[4] schema and import skipped` → 直接 `[6] deploying`，`rows_written: 0`，库里 34,279 条完好无损。

`--force` 可以强制重新导入；`--skip-import` 现在的语义是「只部署，完全不碰数据库」（原来它会应用 schema 却不导入，也就是清空一个已有数据的库 —— 和它自己的说明正好相反）。

### 工作流读指纹的来源一并改掉了

刷新工作流原来通过 `/health` 读已发布指纹，而 `/health` 需要部署后的 URL —— 那个 URL 存在 `project.json`，而它只在 **Cloudflare 的构建目录里**被写入，**不会回推到仓库**。结果就是：在一键部署这条（本项目推荐的）路径上，`publicUrl` 永远是 `null`，工作流永远读不到指纹，于是每天都判定「内容变了」，每天白导一次 69% 额度。

现在改成用 `scripts/published-hash.mjs` **直接查 D1 的 `meta` 表**，整条依赖链断掉：不需要部署 URL、不需要 `/health` 往返，全新的 fork（`project.json` 从未被写过）也能正确判断。

那个脚本的失败方向是刻意选的：任何异常（`meta` 表不存在、查询失败、没有 token）都返回「没有指纹」，也就是**照常发布**。判断错的代价是浪费一次导入；反过来判断错，市场会永远停在旧内容上。

---

## 2. id 撞车 —— 后缀会被截断吃掉

客户端按 `entry.id` 合并多源、先到先得，且官方源被强制置顶。**id 一旦和官方撞上，我们的记录就被静默丢弃。**

`registryIdFromName()` 把 slug 截断到 60 字符，所以标记放在哪一侧是决定性的：

| 方案 | 撞车条数 |
|---|---|
| `name + "/zh/<分类>"`（后缀） | **158 条** ❌ |
| `"zh/<分类>/" + name`（前缀） | **0 条** ✅ |

分类用英文原文算好，关键词塞进 UI 不显示的 `name` 字段里。

---

## 3. 分类塌陷

`guessCategory()` 用**英文关键词**匹配 `name + title + description`。直接服务中文会让几乎全部条目塌进 devtools（实测 100 条里 80 → 93）。

解法同上：分类在翻译前用英文原文算好。实测漂移 **0 / 34,279**。

---

## 4. 中文搜索需要 bigram 折叠

中文没有词分隔，FTS5 的 `unicode61` 会把整句当成一个 token，子串搜索永远匹配不到。

`shared/fold.js` 把 CJK 串折叠成重叠二元组；带引号的二元组序列就是 FTS5 短语查询，等价于精确子串语义。生成端和 Worker **共用同一份代码**，两边必须折叠得完全一致。

单个 CJK 字符无法表达成二元组短语，走 `LIKE` 分支。

---

## 5. FTS5 与写入额度

D1 免费版每天 **10 万行写入**。FTS5 的索引方式直接决定能否一次导完：

| FTS5 方案 | 写入行数/条 | 全量 | 结论 |
|---|---|---|---|
| 默认（自带文本副本 + docsize） | ~3x | 约 3 倍额度 | **超了** |
| **外部内容 + `columnsize=0`（当前）** | **2.00** | **68,564 = 69%** | 一次导完 ✅ |

- 模块名必须**小写** `fts5`，D1 对大写 `FTS5` 返回 `not authorized`。
- `servers` 表**故意不加二级索引**：每个索引给每次插入多加一行写入，两个索引就是给全量导入多加约 6.8 万行。
- **注意**：外部内容模式下 FTS5 不读 `servers` 表，所以 `rebuild` 会把**未折叠**的原文拿去建索引、静默弄坏所有中文搜索。索引必须在导入时喂 `fold()` 过的文本。
- 写入量按**实际写入的行**计费，不是最终存下的行。估算必须用实测校准值（见 `generator/measure-writes.js`）。

---

## 6. 搜索设计

- 索引只含 `title` + `description`：客户端还会用 `[entry.name, entry.description, entry.author]` 二次本地过滤，索引别的字段会让命中在客户端被丢弃、白占名额。
- 分页游标压在 `f.rowid`（FTS 侧）而非 `s.id`（连接表侧）。后者会让 SQLite 收集全部命中再排序（`USE TEMP B-TREE FOR ORDER BY`）。已用 `EXPLAIN QUERY PLAN` 验证。
- `/health` 只读 `meta` 表和 `MAX(id)`，不 `COUNT(*)` 扫全表。
- `SELECT COUNT(*) FROM search`（FTS5 外部内容表）读的是**内容表**而非索引，用它验证索引是否有内容会得到假阳性。

---

## 7. 源顺序规则

一源的方案不是"随便加一个"，顺序有硬性要求：

- 官方源**无法移除**（UI 对 `builtin:true` 不渲染删除按钮）。
- 只存我们的源 → 官方源会被 `unshift` 顶到**最前**，用户还是先看到英文。
- 所以必须存成 `[ours, ...其余, official]`，且官方源的 `url` 必须逐字节相同，否则会被跳过。

`test/source-order.js` 用**从 app.asar 提取的宿主真实函数**验证这套规则，不是重写的近似版。

---

## 8. 剔除 2,599 条

宿主的 `mapRegistryServer()` 对"既没有 npm/pypi 包、也没有可用 streamable-http 远端"的记录返回 `null`，`ingest()` 随即丢弃。这类记录**永远不可能显示**，但服务出去会白占一页 100 个名额里的一个。

判定用的是**宿主自己的函数**（`generator/extract-host-mapper.js` 从 app.asar 提取），不是手写近似版 —— 后者会漏掉 12 条更隐蔽的拒绝理由（`requiredEnv` 未声明、command 含 `..`、url 非公网 https 等）。

---

## 9. 升级 PI-Desktop 之后

宿主的接收规则是本项目镜像的协议的一部分。升级后重新提取并跑检查：

```bash
node generator/extract-host-mapper.js --bundle=<app.asar 解出的 main/index.js>
node generator/extract-sanitize.js    --bundle=<同上>
node generator/check-served.js
node test/source-order.js
```

两个提取器都会在报告成功前对生成的文件做语法检查 —— 一个被截断的定义会生成"看起来合理"但一 import 就崩的文件。

> 已验证：**0.15.9 → 0.15.10 之间，依赖的 9 个宿主函数逐字节相同**，所有数值常量（4 MB 上限、8 s 超时、16 源、2000 缓存、每页 100）也没变。

---

## 10. 生成的产物

`docs/console-snippet.txt` 是生成物，不是手写的：

```bash
node scripts/make-snippet.mjs --write
```

每次部署后都会重新生成，因为里面的 endpoint 取决于 Worker 落在哪个 Cloudflare 账号 —— 过期的片段会指向旧的 `*.workers.dev` 子域，注册一个解析不了的源。

该文件被有意 gitignore：它是 `project.json` 的构建产物，不是源码。

---

## 11. 翻译质量：标题为什么"不中不英"

### 根因：用停用表判断"哪个词是品牌"

注册名本身就是 slug，例如 `contractor-licence-changes`。它的词被用来**保护品牌名不被引擎乱译**（"Getlead" 单独送进去会变成"格利德"）。判断依据是一张手写的停用表：**在表里 = 普通词，可以翻译；不在表里 = 当成品牌，原样保留**。

停用表永远不可能完整，而它漏掉的每一个词都会被**静默当成品牌**、永远留在英文里。实测：手工列了 1,747 个词，仍漏掉 **15,859 个** name token，分布在 **23,097 条标题中的 11,647 条（50.4%）**。这就是"承包商执照 Changes"、"Licensed 房子 Painters"的来源。

### 解法：让语料自己当词典

不需要任何第三方词表。**一个词如果在大量不同记录的正文里出现，它就是普通词汇；如果只出现在"名字里含它"的那些记录的正文里，它就是品牌。**

| 词 | df（出现在多少条记录正文里） | nameCount（作为 name 词出现） | 比值 | 判定 |
|---|---|---|---|---|
| changes | 138 | 5 | 27.6 | 普通词 |
| signals | 286 | 42 | 6.8 | 普通词 |
| propick | 1 | 1 | 1.0 | 品牌 |
| agentutility | 17 | 17 | 1.0 | 品牌 |
| pipeworx | 2 | 1712 | 0.0 | 品牌 |

df 按**记录**计不按出现次数计 —— 一条记录里重复 40 次也只算 1 票，所以话多的记录无法把统计带偏。

判定阈值刻意保守：`df >= 5 且 df >= 2 * nameCount + 3`。两种错误**代价不对等** —— 少放行只是标题里多一个英文词；放行过头会把品牌交给引擎，把 "Hive" 译成"蜂箱"、把 "agentutility" 译成一句莫名其妙的中文。实测在一个手工标注集上：**19 个普通词放出 16 个，22 个品牌零误放**。

产物 `generator/lib/word-stats.generated.js`（2,326 词 / 25 KB）由 `generator/build-word-stats.js` 从 `data/raw.jsonl` 生成，**提交进仓库**（全新克隆和一键部署都没有 raw.jsonl），CI 里在抓取之后、翻译之前重新生成。

另外补了**词形还原**：停用表存的是原形，而注册名里全是屈折形式（`changes`/`licensed`/`painters`/`signals`），只比对原形必然漏。

### 效果（改动前 → 改动后，全量 34,279 条）

| 指标 | 改动前 | 改动后 |
|---|---|---|
| 标题里残留**普通英文词**的条数 | 3,327 | **1,481**（−55.5%） |
| 残留普通英文词总个数 | 4,146 | **1,889**（−54.4%） |
| 含中文的标题数 | 12,027 | **13,144** |

> 剩余的 1,889 里大部分是**应当保留**的专有名词（`x402`、`stripe`、`linkedin`、`solana`、`mercado` 这类产品/机构名），审计脚本把它们也算成残留，所以这是个上界。真正还能改的残留很少。

### 同一批修掉的两个真 bug

**1. 标记之间的空格被吃掉后拼成一个词。** `unmask` 里"先替换标记、后补回空格"，顺序反了 —— 替换完成后 `]][[` 已经不存在，空格永远补不回来，两个词粘成一个：`CertScore.ai MCP Blade` → `CertScore.aiMCP 刀片`。

正确顺序是**先补空格、后替换**。这样做安全的前提是 `mask` 已经把**原本就连在一起**的标记合并成一个（`CertScore` + `.ai` 本就是一个词 `CertScore.ai`）。两处必须成对修改：只改一处会让 `CertScore.ai` 变成 `CertScore .ai`。

**2. 品牌后面的 ASCII 句点被转成全角。** 句点留在标记外，引擎会把它转成 `。`：`hood. — .hood name service` → `hood。 — .hood 名称服务`。现在品牌连同紧跟的句点一起保护。

### 还没做的：源文不是英文的记录

约 **208 条（0.9%）**的标题本身就是非英文（俄语、德语、西语、葡语、波兰语…），而管线固定用 `sl=en` 去翻译，于是原样透传，在中文市场里显示为一张非中文卡片。

- `sl=auto` **不可用**：这个免费端点对 `sl=auto` 返回空字符串。
- 但**显式源语言有效**：`sl=ru`/`es`/`nl`/`pl`/`pt`/`de` 实测都能正确翻成中文（如 "Repuestia - Repuestos Automotrices Chile" → "Repuestia - 智利汽车备件"）。

可行做法是：主翻译后挑出"结果里完全没有中日韩字符"的文本，按脚本（西里尔/希腊/阿拉伯…）或候选语言批量试译，取中日韩字符最多的那个。成本很低（语言候选按批发，约几十次请求），收益是 0.9% 的条目从"非中文"变成"中文"。**尚未实现**。
