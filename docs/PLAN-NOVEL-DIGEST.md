# PLAN-NOVEL-DIGEST：小说长文消化与研究库扩容

> 2026-08-23 定稿设计。定位：**导演室研究系统的扩容**——研究材料从「搜索结果摘要」升级为
> 「作品本体全文」，让大纲系统能基于真实小说文本总结剧情结构、人物弧线与叙事套路。
> 本文是实施唯一依据：新会话按本文动手，遇与现状冲突处以本文为准并回报。

---

## 实现状态（2026-08-24 实弹验证，gemini 3.7 flash 全链路）

**阶段 1（上传/URL → 后台消化 → 梗概+套路+日常卡 → 入研究库 → 导演室页签）已实现；阶段 1.1 已补结构化素材资产与按 focus 分配；阶段 1.2 已补每日自动发现与三部 TXT 消化。**

落地文件：`src/outline/corpus.ts`（管道与结构化资产）、`src/outline/kakuyomu.ts`（Kakuyomu 适配器与搜索候选发现）、`src/outline/corpus-scheduler.ts`（每日定时发现/去重/最多三部入队）、`src/outline/engine.ts`（带 focus/query 的 researchWorkspace 投影）、`src/outline/projection.ts`（安全裁剪与相关性分配）、`server/main.ts` + `server/rest.ts`（REST 接线与配置校验）、`web/src/planning/`（小说研究页签 + 日常剧情模式 + 前端卡片）、`skills/小说消化/SKILL.md`（digest-extract 产出 dailyPatterns 与三类中尺度 assets）、`skills/故事编剧室/SKILL.md`（新增 daily focus + dailyPlan 结构）、`test/kakuyomu.test.ts`。

### 历史验收结果（2026-08-24，hajimi/gemini-3.7-flash）

用 `POST /api/outline/corpus/url` 连续消化多部 Kakuyomu 公开作品，全部自动完成（零人工干预）；另实测每日 3 部自动任务并行完成：
> 当前生产插头已于 2026-09-01 切换为 `new/gpt-5.6-sol`，以下表格保留为历史验收记录；最新故障修复验收见 §17.8 及事故复盘。

| 作品 | 话数 | 字数 | 块数 | 线索套路 | 日常剧情卡 | 模型 |
|---|---|---|---|---|---|---|
| 異能の姫は後宮の妖を祓う | 90 | 22万 | 12 | 5 | 3 | gemini-3.7-flash |
| １０歳から始める冒険者生活 | 55 | 13万 | 7 | 5 | 4 | gemini-3.7-flash |
| コミュ障の俺に罰ゲームで… | 52 | 15万 | 8 | 6 | 2 | gemini-3.7-flash |

共 25 条机制入 `mechanisms.json`（16 条长期叙事套路 + 9 条可直接落成的日常剧情卡），sourceIds 均为 `doc-*`，关联当前卡。删除精确清理 `removedMechanisms`、磁盘/文档/机制归零。

2026-08-24 追加校园样本并验证并行管道：

| 作品 | 字数 | 块数 | 线索套路 | 日常剧情卡 | 结果 |
|---|---:|---:|---:|---:|---|
| 学校で男子を全く寄せ付けないという噂の美人双子姉妹… | 31万 | 15 | 4 | 3 | ready |
| 学校では他人のふりの幼馴染が… | 22万 | 12 | 7 | 3 | ready |
| 他校の氷姫を助けたら、お友達から始める事になりました | 70万 | 40 | 6 | 4 | ready |

三部在同一 `CorpusEngine` 中同时运行，运行池上限为 3；每部完成后独立入库。

### 踩坑与修复记录

- **Kakuyomu 作品页解析**：章节需从 `__APOLLO_STATE__` 的 `"Episode:<id>"` 键提取（非 HTML 硬编码）；正文为连续编号 `<p id="pN">` 段落；ruby 需处理 `<rb>/<rp>` 避免括号重复。
- **hajimi 中转 User-Agent**：OpenAI SDK 默认 `User-Agent: OpenAI/JS ...` 被 `fuzhan.magicv4.ltd` 拦截（403），所有 gemini 调用均失败。修复：对 baseUrl 为该域名时注入 `header: user-agent: undici`。
- **hajimi 中转上下文过大**：OutlineEngine 的 `#modelContext` 把完整角色卡（含 card.book）原样注入（实测单次请求 userText 达 1,398,658 字符），触发中转拒绝。修复：对 card/history/world/ecology 做递归裁剪（预算 70,000 字符），研究资产使用独立安全投影。
- **大纲旁路流式中断**：hajimi 中转的 SSE 结束格式与梨园 OpenAI SDK stream parser 不兼容，报 `all cf workers failed to stream`。修复：大纲旁路（outlineChat/bootstrap 等）强制非流式（`forceNonStreaming:true` + `compat.streaming:false`）。
- **digest 研究假死**：研究旁路曾同时受到非严格 JSON、`EventStream.result()` 最终消息读取错误、模型 reasoning 协议不匹配和 SDK 隐式重试叠加影响，表现为“最终消息无文本”或数小时不完成。修复：所有 digest 步骤非流式；正确读取绑定的 `stream.result()`；研究旁路关闭 SDK 隐式重试，由 CorpusEngine 统一控制单次调用最多 4 次、硬超时 60 秒，文档级最多重入队 3 次；reduce 的中文引号做容错解析，增强 extract 部分失败时降级为 `ready`。对应测试 `test/novel-digest.test.ts` 通过。

通用目录页 URL 抓取（§12）仍未做，schema 保留（`sourceKind:"url"`）。未做事项细节见 §17。

## 0. 一句话与原则

**给导演室加一条「上传小说 → 后台消化 → 剧情梗概 + 套路库」的管道；产物进现有研究库
（OutlineResearchStore 的扩容），注入现有 researchWorkspace；全程后台，不进正文关键路径。**

三条铁律的映射：

1. **状态进分支树/研究库，不新增第二套权威**：消化产物（文档/梗概/套路）全部落在
   `.liyuan/outline/research/` 下，与现有 sources/mechanisms 同仓同语义；不新建平行知识库。
2. **规则进 Skill**：map/reduce/extract 三步的提示词全部写在新 Skill `skills/小说消化/`
   （`workflow: novel-digest`），TS 只做编排、分块与校验，不写提示词正文。
3. **TS 只做编排与安全门禁**：章节切分、编码检测、预算闸门、断点续跑、JSON 校验全在 TS；
   模型只负责读块写摘要、读梗概出套路。

非目标（明确不做）：

- 不做台上（stage）工具，不给剧情模型直接读全文——第一版只在导演室（planning）侧。
- 不改 StageEngine / 一拍流程，`PLAN-ROUND-FLOW.md` 的流程零改动。
- 不内置任何盗版站点；当前只接入 Kakuyomu 公开作品页，通用目录页抓取仍是后续事项。
- 不做 epub 在线书城搜索；来源=用户上传、用户提交的 Kakuyomu 作品 URL，或用户显式开启的 Kakuyomu 分类自动发现。

## 1. 现状与差距（为什么做）

现状（`src/outline/engine.ts` `research()` + `server/web-research.ts`）：

- 只搜不读：DuckDuckGo/Bing 返回的 `title+url+snippet`，snippet 截 600 字喂提炼模型，
  搜到的页面正文从未被打开。
- `skills/叙事研究提炼/` 的输入就是书评/影评摘要（二手解读），给不出桥段结构、
  钩子节奏、多卷伏笔铺法这类「只存在于正文里」的东西。
- 研究库 schema（`sources.json`/`mechanisms.json`）只认 URL 型来源。

本设计补的缺口：长文本获取（上传）→ 清洗分块 → 分层摘要（map-reduce）→
结构化提炼（剧情链/人物弧/桥段套路/钩子节奏/失败模式）→ 入库 → 注入大纲上下文。

## 2. 总体流程

```text
导演室「小说研究」页签
  ├─ 上传 txt/epub（走现有 POST /api/uploads → .liyuan-uploads/）
  ├─ POST /api/outline/corpus { file: "xxx.txt" }  → 建文档、入队、立即返回
  ├─ POST /api/outline/corpus/url { url: "https://kakuyomu.jp/works/..." } → 建文档、入队、立即返回
  ▼
后台消化管道（CorpusEngine，文档级有界并行，服务重启可续）
   ├─ 同时最多运行 3 部文档；每日自动任务正好可并行处理 3 部
   ├─ 每部拥有独立取消信号；暂停/删除一部不影响其他文档
  1) 取件：从 .liyuan-uploads 复制到 corpus 工作区（uploads 原件不动）
  2) 解码：utf-8 严格失败 → gbk/gb18030 → big5（TextDecoder，Node 22 全 ICU）
  3) 清洗：去站点水印/广告行；epub 走 ziplite 解压 → container.xml → opf spine → 拼接
  4) 分章：章节标题正则切分；无标题结构则按段落边界定长切块
  5) 分块：块 = 1~3 章，≤ CHUNK_CHARS(默认 20000)；超长章在段落边界硬切
  6) map：逐块调模型（novelDigest 插头）出「块摘要」——每块完成即落盘（断点续跑点）；不同文档并行
  7) reduce：块摘要 → 每卷/每 50 块「弧线摘要」 → 全书梗概 + 结构化字段
  8) extract：从弧线摘要+梗概出「套路条目」（mechanism/appliesWhen/failureWarning）
  9) 入库：merge 进研究库（documents + digests + mechanisms，关联当前卡）；研究库写链仍串行
  ▼
导演室轮询 GET /api/outline/corpus（5 秒，同诊断页模式）看进度
完成后：大纲模型下一拍经 researchWorkspace 读到「可用小说资产」
```

## 3. 数据模型

全部落在现有研究库根 `.liyuan/outline/research/` 下（`OutlineResearchStore` 扩容，
不另起炉灶）：

```text
.liyuan/outline/research/
├── sources.json            # 现有：URL 型来源（不动）
├── mechanisms.json         # 现有：套路/机制条目（扩：sourceIds 可引用 doc-*）
├── cards/<key>.json        # 现有：卡 → mechanismIds 关联（不动，复用）
└── corpus/                 # ★ 新增
    ├── documents.json      # 文档清单（含任务状态）
    ├── texts/<docId>.txt   # 清洗后的全文（唯一正文副本）
    └── digests/<docId>.json # 消化产物 + 进度
```

TS 接口（写在 `src/outline/corpus.ts`）：

```ts
export type CorpusDocStatus = "pending" | "cleaning" | "mapping" | "reducing"
  | "extracting" | "ready" | "failed" | "paused";

export interface CorpusDocument {
  id: string;               // doc-<sha256(originName+size).slice(0,16)>
  title: string;            // 文件名去扩展名，≤120 字
  sourceKind: "upload" | "url";
  originName: string;       // uploads 文件名或目录页 URL
  chars: number;            // 清洗后总字数
  encoding: string;         // "utf-8" | "gb18030" | ...
  chapterCount: number;
  chunkCount: number;
  status: CorpusDocStatus;
  error?: string;           // failed 原因
  createdAt: string; updatedAt: string;
}

export interface CorpusChunkDigest {
  index: number;            // 0-based
  chars: number;
  chapters: string[];       // 覆盖的章节标题（≤30 字/个）
  summary: string;          // 块摘要，≤1500 字
}

export interface CorpusArcDigest {
  title: string;            // 卷名或"第 N 段（块 a–b）"
  chunkRange: [number, number];
  summary: string;          // 弧线摘要，≤2000 字
}

export interface CorpusDigest {
  version: 1;
  docId: string;
  chunks: CorpusChunkDigest[];   // map 产物，逐块追加落盘
  arcs: CorpusArcDigest[];       // reduce 第一层
  synopsis: string;              // 全书梗概，≤3000 字
  structure: {                   // reduce 结构化字段（各 ≤2000 字）
    plotSpine: string;           // 主线事件链（因果链不是流水账）
    characterArcs: string;       // 主要人物弧线与关系演变
    hooksAndPacing: string;      // 卡章钩子/爽点节奏/张弛观察
  };
  extractedCount: number;        // extract 出的套路条数
  updatedAt: string;
}
```

研究库扩展（改 `src/outline/research.ts`）：

- `OutlineResearchView` 增加 `documents: CorpusDocument[]`（只读投影，含 status）。
- `merge` 保持签名不变；新增 `mergeCorpus(cardKey, document, digest, extracted)`：
  把套路条目写进 `mechanisms.json`（sourceIds 引用 `doc-xxx`，id 规则
  `mech-<sha256(mechanism+docId)>`），文档进 `documents.json`，并像现有 merge 一样
  把 mechanismIds 累进 `cards/<key>.json`（上限 100 不变）。
- 新增 `removeCorpus(docId)`：删 texts/digests/documents 行，并删除**只**被该文档
  引用的 mechanisms（被 Web 来源共同支撑的条目保留）。
- `view(cardKey?)`：无 cardKey 时 documents 全量返回；有 cardKey 时同样**全量返回**机制/
  文档/素材——消化提炼的是抽象可复用套路，跨卡共享（玄幻里的争风吃醋同样适用都市），
  cardKey 只用于给出当前卡的关联记录（cards 字段）。

## 4. 文本获取与清洗（阶段 1 = 上传）

### 4.1 入口与取件

- 前端复用现有上传通道（`POST /api/uploads`，原始字节 + 文件名走 query，
  见 `server/rest.ts` 1115 行附近；落 `.liyuan-uploads/`）。
- `POST /api/outline/corpus { file: "<uploads 文件名>" }`：
  - 校验文件存在、扩展名 `.txt`/`.epub`、大小 ≤ 50MB；
  - **复制**（非移动）到 `corpus/work/<docId>.raw`，uploads 原件不动；
  - 建 `CorpusDocument{status:"pending"}` 写入 documents.json，唤醒管道，立即返回 docId。
- 同一文件重复提交：按 originName+size 哈希幂等，返回已有 docId（不重复消化）。

### 4.2 解码

```ts
function decodeText(bytes: Buffer): { text: string; encoding: string } {
  for (const enc of ["utf-8", "gb18030", "big5"]) {
    try { return { text: new TextDecoder(enc, { fatal: true }).decode(bytes), encoding: enc }; }
    catch { /* 下一种 */ }
  }
  return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8(lossy)" };
}
```

utf-8 严格模式在前（合法 utf-8 必然成功，GBK 大概率含非法序列被排除）；
三者都失败退化为替换符解码（记 encoding 备查）。

### 4.3 清洗规则（TS 确定性，逐行过滤）

删除命中以下模式的**整行**（对清洗后文本做，逐行正则，大小写不敏感）：

- 站点水印：`本书首发|首发域名|笔趣|leshu|feiku|最新章节|请记住|无弹窗|广告|域名一|域名二`
- 站内导航：`上一章|下一章|返回目录|目录 页|加入书签|书页|章节错误|点此举报|报错`
- 空洞行：去首尾空白后长度 0 的连续行压成单个换行。
- 不做激进去重（防误删重复对白），不做同义改写。

### 4.4 epub 解析（复用 `src/ziplite.ts`，零新依赖）

`extractZipFile` 到临时目录 → 读 `META-INF/container.xml` 拿 opf 路径 → 解析 opf
的 `<manifest>` + `<spine>` 得到 xhtml 顺序 → 逐文件 `<h1-h6>` 转章节标题、正文剥标签、
`<p>` 转段落 → 拼成与 txt 相同结构的纯文本 → 走同一条分章/分块管道。

### 4.5 分章

```ts
const CHAPTER_RE = /^\s*(?:第\s*[0-9〇零一二三四五六七八九十百千两]+\s*[章节卷回部集话話幕]|(?:序章|序言|楔子|尾声|后记|番外))\s*[:：\s\S]{0,40}$/;
```

- 逐行扫描命中即切章；标题行保留为章节名。
- 全文命中 < 5 处视为「无章节结构」：跳过分章，直接定长切块。
- 章节名为空时用 `第 N 节` 占位。

### 4.6 分块

- 目标块 ≤ `CHUNK_CHARS`（默认 20000，配置可调，硬上限 50000）。
- 贪心装箱：从当前章开始累加整章；加下一章会超限则封块；单章超限则在**段落边界**
  （`\n\n`）二分硬切，切出的块标记同章节名。
- 块数上限 `MAX_CHUNKS = 600`（≈1200 万字封顶，超出直接 failed：`文档过大`）。

## 5. 消化管道（CorpusEngine）

新文件 `src/outline/corpus.ts`，采用文档级有界并行 + 研究库串行写链，并沿用生态双池的 running/ready 语义：

```ts
export interface CorpusEngineDeps {
  cwd: string;
  runSideModel: OutlineEngineDeps["runSideModel"];  // 同一签名，step 用 "novelDigest"
  loadSkill: () => string | undefined;              // workflowSkill(skills, "novel-digest")?.body
  cardKey: () => string;                            // getContext()?.cardKey ?? config.card
}

export class CorpusEngine {
  enqueue(doc: CorpusDocument): void;               // 放入最多 3 部的并行池
  status(): { running?: Array<{ docId: string; step: string; done: number; total: number }> };
  pause(docId: string): void;                       // 当前块完成后停
  resume(docId: string): void;                      // 重扫 digests 续跑
  retry(docId: string): void;                       // failed → pending，保留已完成块
  remove(docId: string): Promise<void>;
}
```

要点：

1. **文档级有界并行**：同一时刻最多消化 3 部文档；每日自动任务的 3 部作品不互相等待。
   单部文档内部仍按 cleaning → mapping → reducing → extracting 顺序执行，避免同一本书的
   reduce 读到不完整摘要。研究库 `mergeCorpus` 继续使用串行写链，避免 JSON 文件覆盖。
2. **断点续跑**：每块 map 完成**立即**把 `CorpusChunkDigest` 追加写进
   `digests/<docId>.json`（原子写，tmp+rename 同现有 `#atomic`）。`resume`/`retry`
   重扫已有 chunk.index，跳过已完成块。服务重启后 `enqueue` 恢复时同样跳过。
3. **每步的模型调用**（step 一律 `"novelDigest"`）：
   - map：`runSideModel("novelDigest", skill, JSON({task:"digest-map", ...块内容}), { maxTokens: 4096 })`
   - reduce-arc：输入为该弧线的块摘要串（不再进原文），`maxTokens: 4096`
   - reduce-final：全部弧线摘要 → synopsis + structure，`maxTokens: 8192`
   - extract：arcs + synopsis + structure → 套路条目数组，`maxTokens: 8192`
4. **JSON 校验与降级**：沿用 `parseObject` 的严格校验（`src/outline/` 内已有）；
   map 输出非法 → 该块重试 1 次，仍非法 → 该块 summary 记
   `"(本块摘要生成失败，仅保留章节列表)"`，不中断整书；reduce/extract 失败 → 任务
   `failed` 留 error，已完成块保留，可 retry。
5. **预算闸门（TS 硬门禁）**：
   - 建 doc 时预估成功路径 = chunkCount + ceil(chunkCount/50) + 4（final + 三个 extract）+ 1（可能发生的 audit），单块无 audit 实调 6 次、有 audit 7 次；追加版本减去复用的 map 块。估算不含重试，随 `POST corpus` 返回 `estimatedCalls`。
   - `novelDigest.maxCallsPerDoc` 默认 800，是整部文档的**实际尝试硬预算**，不是 map/task 数：每次模型请求发出前同步预留并持久化扣额；并发 extract、`#call` 内重试、解析重试、文档自动重入队、手动 retry/resume 都累计，重启不重置。预留后崩溃也不退还额度。
   - `CorpusDocument.modelUsage.version=1` 保存 attempts/limit/exhausted；旧文档历史实调无法从摘要推断，迁移时显式 `legacyAttemptsUnknown=true`，attempts 从迁移后的已知尝试开始累计。已有版本化计数不可丢弃；未知版本/坏计数拒绝续跑。预算耗尽直接 failed，不自动重试；只有明确提高配置上限（服务重新加载配置后）再 resume 才能继续使用剩余 checkpoint。
   - 每次调用/重试/阶段推进及 ready 前统一检查暂停/删除。暂停允许已发出调用保存结果，但不失败、不进入 ready；map、逐段 reduce、final、各 extract、audit 和已完成入库钩子均有续跑 checkpoint。删除立即取消模型等待并阻止晚到结果落盘；已经发出的 onReady 需结算后再做 onRemoved 清理。已记录完成的 onReady 不因 resume 重复执行；外部钩子与本地 checkpoint 不构成跨进程原子事务。
6. **进度对外**：`GET /api/outline/corpus` 返回 documents + running 数组，每项含
   `{docId, step, done, total}`；不做 WS 推送，前端 5 秒轮询（同诊断页）。

## 6. Skill：`skills/小说消化/SKILL.md`

frontmatter（对齐 `叙事研究提炼` 的格式）：

```yaml
---
name: 小说消化
description: 分块摘要小说文本并提炼剧情结构、人物弧线与叙事套路，不复刻原文。
workflow: novel-digest
resident: false
每轮: false
---
```

正文为一个系统提示词管三个 task（task 字段在 user JSON 里区分，同 `故事编剧室`
一 Skill 多 task 的先例）。**提示词全文如下，落地时可微调措辞但结构不变**：

```markdown
# 小说消化

你只负责消化研究材料，不为当前故事写剧情。输入是脱敏后的小说文本或其摘要层，
按 task 分工。所有输出只返回 JSON，不输出 Markdown 或 JSON 外文字。

## task: digest-map
输入：{ task, doc_title, chunk: { index, chapters, text } }
写出这一块的剧情摘要，≤1500 字。必须包含：
- 事件链：这块发生了什么（因果顺序，不是流水账）
- 人物动态：谁出场、动机与关系变化
- 悬置物：新抛出的悬念/伏笔/未回收的承诺（原样列出）
- 钩子：块末如何收（卡在哪、凭什么让读者往下翻）
禁止：评论文学质量；引用原文连续超过 40 字。
返回：{ "summary": string, "chapters": string[] }

## task: digest-reduce-arc
输入：{ task, doc_title, arc_title, chunk_summaries: string[] }
把这组块摘要归并成弧线摘要，≤2000 字：这段的主线推进、关键转折点（块定位）、
人物弧线走向、已回收/仍悬置的伏笔清单。返回：{ "summary": string }

## task: digest-reduce-final
输入：{ task, doc_title, arc_summaries: string[] }
产出全书级结论。返回：
{
  "synopsis": string,          // 全书梗概 ≤3000 字（按因果链写）
  "structure": {
    "plotSpine": string,       // 主线事件链：起爆点→升级→转折→高潮→收束
    "characterArcs": string,   // 主要人物弧线与关系演变阶段
    "hooksAndPacing": string   // 卡章钩子手法、爽点/松弛节奏规律
  }
}

## task: digest-extract
输入：{ task, doc_title, synopsis, structure, arc_summaries }
提炼**可复用的叙事套路**，不是复述剧情。每条必须：
- mechanism：去掉作品专名后的可复用手法（桥段结构/信息分配/节奏手段/关系推进方式）
- appliesWhen：适用的人物动机、关系阶段、压力与前置条件
- failureWarning：这套手法用滥/用错会怎么翻车（OOC、拖节奏、伏笔崩）
- sourceIds：固定填输入里的 docId（形如 ["doc-..."]），locator 用"第X–Y章"
禁止：输出原作专名、台词、标志性场景序列、完整反转、可识别的换皮方案；
不能从输入确认的内容不要编造。最多 40 条，材料不足返回空数组。
返回：{ "tropes": [{ "mechanism": string, "appliesWhen": string,
  "failureWarning": string, "locator": string }] }
```

extract 产物在 TS 侧转成 `OutlineResearchExtraction`（locator 并入 mechanism 末尾
`（出处：第X–Y章）`），走 `mergeCorpus` 入 mechanisms.json。

## 7. 研究工作区投影（注入与 token 预算）

`OutlineEngine.#modelContext` 现有 `researchWorkspace: this.#research.view(cardKey)`。
扩容后 view 多了 documents/digests，**不能整包注入**，做安全投影（`src/outline/projection.ts`
加一个纯函数 `projectCorpusWorkspace(view, { maxDocs: 3 })`）：

```ts
// 注入大纲模型的东西（严控体积）：
{ documents: [{ title, chars, synopsis: 前400字, tropeCount }],
  mechanisms: [...],
  assets: [...],
  dailyPatterns: [...] } // 按 focus/query 限量筛选
```

- 只注入 `status === "ready"` 且与当前卡关联的文档，按关联时间倒序取前 3。
- 块摘要/弧线摘要**不进**大纲上下文——它们只在导演室 UI 展示与 extract 输入。
- `assets` 按 `focus` 和用户当前问题轻量相关性排序，通常最多注入 8 条；`dailyPatterns` 在 `focus:daily`
  时最多注入 6 条，其他模式只带少量候选。
- 讨论中模型若要细节：导演室前端可把某文档 synopsis 全文「钉进」下次 chat 的
  context（复用现有 `POST /api/outline/chat` 的 focus/上下文通道，阶段 1 可不做）。

## 8. REST API 契约（加在 `server/rest.ts` outline 区块后）

| Method & Path | Body | Resp | 错误 |
|---|---|---|---|
| `POST /api/outline/corpus` | `{ file: string }`（uploads 文件名） | `201 { doc, estimatedCalls }` | 400 文件不存在/类型不符/超 50MB/超块数上限；409 已在消化 |
| `POST /api/outline/corpus/url` | `{ url: string }`（当前支持 Kakuyomu 作品 URL） | `201 { doc, estimatedCalls: 0 }` | 400 URL 不合法/作品页无法解析；已存在时幂等返回 |
| `GET /api/outline/corpus` | — | `{ documents, running?: Job[] }` | — |
| `GET /api/outline/corpus/:id` | — | `{ doc, digest }`（ready 才含 digest 全文） | 404 |
| `POST /api/outline/corpus/:id/pause` | — | `200 { doc }` | 404/409（非运行态） |
| `POST /api/outline/corpus/:id/resume` | — | `200 { doc }`（幂等：pending/failed 也走这里续跑） | 404 |
| `DELETE /api/outline/corpus/:id` | — | `200 { ok: true, removedMechanisms: n }` | 404 |

- 全部走现有 `/api` 全局鉴权（access password 生效时）。
- 路由风格照抄 outline 区块（`case "GET /api/outline/corpus"` + 正则取 `:id`）。

## 9. 前端：导演室「小说研究」页签

`web/src/planning/` 内改三处：

1. `client.ts`：加 `corpusList/corpusCreate/corpusCreateUrl/corpusGet/corpusPause/corpusResume/corpusDelete`
   七个 fetch 封装（照现有 outline 函数风格）。
2. `types.ts`：`CorpusDocument/CorpusDigest` 与后端接口对齐（可从后端 import 类型或复制）。
3. `StoryPlanningWorkbench.tsx`：新增页签「小说研究」：

```text
┌─ 文档列表 ────────────────────────────────────┐
│ [上传 txt/epub]（复用现有上传逻辑，选完即 POST corpus）│
│ ┌──────────────────────────────────────────┐ │
│ │ 书名.txt   ready   2,340,000字 · 128块      │ │
│ │   [梗概▾] [删除]                            │ │
│ │ 《另一本》  mapping 45/130  ▓▓▓▓░░ [暂停]    │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
展开 ready 文档：synopsis / structure 三字段 / 弧线摘要折叠列表 / 套路条目表
（mechanism·appliesWhen·failureWarning·locator，样式复用研究库条目卡）
```

- 进度轮询 5 秒（进页签才开，离开即停，照诊断页模式）。
- `POST corpus` 返回 estimatedCalls > 200 时弹确认（「约 N 次旁路调用，继续？」）。
- 消化完成时页签角标 +1（不弹窗打扰）。

## 10. 配置与模型插头

- `src/model-routing.ts`：`SIDE_MODEL_STEPS` 数组加 `"novelDigest"`（加在
  `"outlineResearch"` 之后）。`normalizeStepModels` 自动支持覆盖；**回退顺序**：
  `novelDigest` 覆盖 → `outlineResearch` 覆盖 → 总插头。在解析覆盖的 fallback 处
  加一行即可（现有代码按步骤直查，需补这条链式回退）。
- 设置面板若按 SIDE_MODEL_STEPS 枚举插头，同步加标签「小说消化」（查
  `ModelPlugSelector.tsx`/`SettingsPanel.tsx` 的步骤名→中文映射，有映射表就补一行）。
- `liyuan.config.json` 新增（example 同步）：

```json
"novelDigest": { "enabled": true, "chunkChars": 20000, "maxCallsPerDoc": 800 }
```

实际配置还可包含自动发现计划：

```json
"novelDigest": {
  "enabled": true,
  "chunkChars": 20000,
  "maxCallsPerDoc": 800,
  "autoSchedule": {
    "enabled": true,
    "hour": 5,
    "minute": 0,
    "maxPerRun": 3,
    "queries": ["学園 日常", "現代 日常 社会人", "青春 日常"]
  }
}
```

`enabled: false` 时 REST 返回 403、前端页签显示「未启用」。`autoSchedule.enabled` 显式开启后，
服务每天按本地时间执行一次，最多发现并入队 3 部新 Kakuyomu 公开作品；自动任务仍在导演室后台，
不进入正文关键路径。默认配置关闭自动计划，当前项目工作配置已开启。

## 11. 安全、版权与预算护栏

- **全文不出服务器**：`corpus/texts/` 只被 map 步读块；不进任何 web 请求、不进
  大纲上下文（只有投影后的 synopsis 摘要进）、不进台上 stage。
- **防复刻**：Skill 三处硬禁令（连续引用 ≤40 字 / extract 禁专名 / 禁换皮方案），
  与 `叙事研究提炼` 同一护栏级别。
- **版权边界**：上传文本必须由用户主动提供并限于有权使用的个人研究；自动任务只读取 Kakuyomu
  公开免费作品页，不提供付费内容或盗版来源，也不做未经授权的再分发。README/页签明确提示
  「请仅抓取或上传你有权使用的文本」。
- **预算**：建档前预估调用数确认 + maxCallsPerDoc 硬顶 + 文档级最多 3 并发（防止无界并发烧钱）；
  pause 粒度=当前块完成。
- **磁盘**：50MB/文档 × 上限默认 20 文档（documents.json 超限时 POST 拒绝），
  删除即级联清磁盘。

## 12. 阶段 2：通用 URL 抓取（Kakuyomu 专用入口已实现）

- `server/web-research.ts` 导出 `requestText`（现为模块私有，加 export 即可）。
- `POST /api/outline/corpus/url { tocUrl }`：通用目录页抓取仍是后续事项；当前实际入口接受 Kakuyomu 作品 URL，
  由 `src/outline/kakuyomu.ts` 解析作品页与 Episode 列表并拼接 UTF-8 TXT。
- 通用目录页未来仍按以下设计：抓目录页 → 启发式取「同域最大同构链接组」
  为章节列表（≥5 条才算）→ 逐章抓取（间隔 ≥2s，复用代理与超时）→ 边抓边落
  `texts/<docId>.part` → 全部完成后走同一条清洗/分块/消化管道。
- 护栏：章节数 ≤3000；私人角色名不得出现在 URL（复用 `sanitizeWebResearchQuery`
  的脱敏思路）；抓取失败章节记占位 `(抓取失败)`，不中断。
- `CorpusDocument.sourceKind: "url"`、originName 记目录页 URL——schema 阶段 1 已留好。

## 13. 落地文件清单（逐文件）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/model-routing.ts` | 改 | SIDE_MODEL_STEPS + novelDigest；覆盖回退链 |
| `skills/小说消化/SKILL.md` | 新建 | §6 全文 |
| `src/outline/corpus.ts` | 新建 | 解码/清洗/分章/分块（纯函数，导出可测）+ 文档级三并行 CorpusEngine（§5） |
| `src/outline/corpus-scheduler.ts` | 新建 | 每日 05:00 Kakuyomu 候选发现、去重和最多三部入队 |
| `src/outline/research.ts` | 改 | documents 投影、mergeCorpus、removeCorpus、view 扩展（§3） |
| `src/outline/projection.ts` | 改 | projectCorpusWorkspace（§7） |
| `src/outline/engine.ts` | 改 | #modelContext 的 researchWorkspace 换投影函数（约 3 行） |
| `server/main.ts` | 改 | 实例化 CorpusEngine 与每日自动调度器，挂到 host（cwd/runSideModel/skill/cardKey），启动时恢复未完成任务 |
| `server/rest.ts` | 改 | §8 七个端点（上传、Kakuyomu URL、列表、详情、暂停、恢复、删除） |
| `src/uploads.ts` | 不动 | 复用 |
| `web/src/planning/client.ts` / `types.ts` / `StoryPlanningWorkbench.tsx` | 改 | §9 |
| `web/src/components/ModelPlugSelector.tsx` 或 SettingsPanel | 改 | 插头标签（如有映射表） |
| `liyuan.config.example.json`（及配置默认值处，查 `src/agent-config.ts`） | 改 | novelDigest 默认值 |
| `test/novel-digest.test.ts` | 新建 | §14 |
| `docs/PLAN-NOVEL-DIGEST.md` | 本文档 | — |

预计规模：后端 ~600 行、Skill ~90 行、前端 ~350 行、测试 ~250 行。

## 14. 测试计划（faux provider 离线，照 `test/*.test.ts` 现有风格）

1. **解码**：utf-8 / gb18030 / 混杂坏字节退化三分支。
2. **清洗**：水印行删除、空行压缩、正常对白不误删。
3. **分章**：标准「第N章」、序章/番外、无章节结构退化、超长章节段落二分。
4. **分块**：贪心装箱不超 CHUNK_CHARS、块数上限拒绝、章节名正确携带。
5. **管道**：faux provider 返回合法 JSON → 走到 ready；map 返回非法 JSON → 模型层与文档层
   自动重试后恢复；reduce 失败 → 自动重试且 chunks 保留；retry 从断点续（faux 计数验证
   只补缺失块）；三部文档并行且单部失败不影响其他文档。
6. **入库**：mergeCorpus 写 mechanisms/cards 原子性；removeCorpus 只删独占条目、
   保留 Web 来源共撑条目。
7. **投影**：synopsis 截 400 字、maxDocs=3、非 ready 不注入。
8. **REST**：六端点 happy path + 400/404/409；鉴权开启时 401（照现有 access 测试）。
9. **回归**：`npx tsx --test test/*.test.ts` 全绿；`npm --prefix web run typecheck`。
10. **自动调度**：搜索页候选提取去重、已入库排除、最多三部选择、05:00 下一次执行时间计算。

## 15. 验收清单

- [x] 上传 ≥50 万字 txt：已通过（564KB/~20 万字），管道逻辑由单测覆盖
- [x] URL 入口 → ready 全链路：**使用独立研究插头完成三部真实 Kakuyomu 文档；2026-09-01 修复后全部进入 ready**
- [x] 日常剧情卡产出：`digest-extract` 新增 `dailyPatterns`，当前三部产出 9 条例行日常卡
- [x] 导演室能看到 梗概/结构/弧线/套路条目 + 日常剧情卡：字段同步至 `documents.json`
- [x] 大纲模型下一拍上下文含 documents 投影（synopsis 400 字 × ≤3 本）
- [x] 删除文档后研究库不留孤儿 mechanisms：精确清理 + 磁盘归零
- [x] 自动重试：模型层 `#call` 初次 + 3 次重试，研究旁路不叠加 SDK 隐式重试；文档级自动重新入队最多 3 次
- [x] 导演室「日常剧情」模式（`focus:daily`）：输出完整 `dailyPlan` 卡含发糖/误会/关系变化/停点
- [x] 小说研究与 Kakuyomu 测试全绿，包含文档级三并发测试
- [x] 正文关键路径（一拍流程）无任何新增 await——管道完全在导演室侧，`StageEngine` 零改动

## 16. 边界与已知取舍
- 块摘要质量受 flash 级模型限制；插头可换强模型（这正是 novelDigest 独立插头的理由）。
- 消化产物是**抽象方法论**：机制/日常卡/素材跨卡共享，创作素材库所有卡可见；文档本体仍绑定建档时的卡（cardKey 快照，用于删除与归属），但不再限制素材可见范围。
- 2000 万字级超长文会被 MAX_CHUNKS 拒绝。
- URL 抓取当前支持 Kakuyomu 作品页（`src/outline/kakuyomu.ts`）；通用目录页仍为预留。

## 17. 未做事项与后续启动清单

### 17.1 未实现：通用 URL 抓取

Kakuyomu 专用入口已实弹验证，并已用于每日自动发现任务。通用目录页 URL 仍按原 §12 设计，
需补多站点章节组识别与站点级安全护栏；不能把通用抓取误写成当前已完成能力。

### 17.2 当前架构关键点（防误判）

- **novelDigest 模型插头**：当前生产配置为 `new/gpt-5.6-sol`；原 `new/zai/glm-5.3-flash` 在该中转站的长结构化 prompt 会耗尽 reasoning 输出，已不作为小说研究插头。回退链仍为 `novelDigest → outlineResearch → 总插头`。
- **自动重试机制**：研究旁路不叠加 SDK 的隐式重试；CorpusEngine 单次调用最多 4 次、硬超时 60 秒，文档级失败最多自动重入队 3 次。增强提炼失败时记录降级并保留核心摘要，无需用户手动 resume。
- **日常剧情卡**：`CorpusDigest.dailyPatternCount` 存储在 digests JSON，同时同步到 `CorpusDocument.dailyPatternCount` 供 REST 视图。
- **上下文裁剪**：`OutlineEngine.#modelContext` 对 card/history/world/ecology 做 70,000 字符预算裁剪，研究资产走独立安全投影（`projectCorpusWorkspace`）。
- **hajimi 中转 UA**：`server/main.ts runSideText` 对 `fuzhan.magicv4.ltd` 注入 `user-agent: undici`。

### 17.3 回归与验证命令

```bash
cd /root/Liyuan
PATH=/opt/node22/bin:$PATH npx tsx --test test/novel-digest.test.ts test/kakuyomu.test.ts
PATH=/opt/node22/bin:$PATH npx tsx --test test/*.test.ts
PATH=/opt/node22/bin:$PATH npm --prefix web run typecheck
PATH=/opt/node22/bin:$PATH npm --prefix web run build
```

### 17.4 已落地：素材资产化与按任务分配

- `CorpusDigest` 现在保留完整 `dailyPatterns`，不再只保留数量或把字段压成普通机制字符串。
- `digest-extract` 额外产出三类中尺度素材：`scene-pattern`、`relationship-beat`、`dialogue-move`；素材包含适用条件、推进步骤、转折、停点与失败警告。
- 小说研究页直接展示日常卡与可调度素材；它们仍是研究资产，不是剧情事实。
- 2026-08-24 研究可复查性加固：`digest-extract` 不再允许模型自报章节定位，而是只能引用引擎生成的 `evidence_index` ID；引擎由块摘要中已记录的章节名与块范围确定性生成 locator，并把有限 evidence summary 随机制入库。旧机制读取时兼容拆分标题末尾的“出处”，前端以小说标题/原始 URL + 定位展示来源，避免机制正文与标题重复，也避免只有 `doc-*` 无法人工复查。
- 2026-08-24 第二轮加固：证据索引细化为 `chunk-*` + `arc-*`，具体桥段必须引用块级证据；提炼拆成 mechanisms/daily/assets 三个独立并行任务，任一不可解析时记录降级并保留其他提炼结果，不阻塞文档 ready。提炼后增加 `digest-audit`，把条目标为 supported/weak/unsupported，unsupported 不入库。机制可信度显式区分 `legacy-claimed|system-grounded|audited`，旧模型自报定位不会伪装成新审计结果。
- 非权威使用反馈落在研究库 `usage.json`，只作为检索排序信号，记录研究子 agent 选中和导演实际引用次数；不进入 Session Tree，不改变剧情事实或大纲。
- `projectCorpusWorkspace` 根据编剧室 `focus` 和用户请求对机制/素材做轻量相关性排序，只向大纲模型注入有限候选；不改变 StageEngine 和一拍正文关键路径。

### 17.5 已落地：每日自动发现三部小说

- `novelDigest.autoSchedule` 支持 `enabled/hour/minute/maxPerRun/queries`；当前工作配置为每天本地时间 `05:00`，最多 3 部，检索词为「学园·日常」「现代·日常·社会人」「青春·日常」。
- 服务启动后注册不阻塞正文的本地定时器；到点读取 Kakuyomu 搜索页，按年度日期轮换页码，排除已存在的 `doc-*`，最多把 3 部新作品送入现有并行 `CorpusEngine`。
- 服务器直接使用 `src/outline/kakuyomu.ts` 抓取并拼成 UTF-8 TXT，再走统一清洗/分章/分块管道；不依赖外部 Windows `kakuyomudl.exe`，也不走交互式 `-i`。
- 外部 `1432647/kakuyomu-downloader` 已确认支持 TXT，但当前 Actions 只产出 Windows 构建；若未来要改为调用外部二进制，需要另补 Linux 构建和非交互 `--format txt` 参数，当前不作为服务运行依赖。

### 17.6 已落地：文档级有界并行

- `CorpusEngine` 同时最多运行 3 部文档；每日自动抓取的 3 部作品不再互相等待。
- 单部文档内部仍按 `cleaning → mapping → reducing → extracting → ready` 顺序执行，块摘要和 digest 仍逐块原子落盘，断点续跑与失败重试不变。
- 每部文档拥有独立 `AbortController`；暂停/删除一部文档不会取消其他并行文档。
- 研究库的 `mergeCorpus` 继续使用既有串行写链，避免多个完成任务覆盖 `mechanisms.json` 或卡关联。
- `GET /api/outline/corpus` 的 `running` 由单对象扩展为运行任务数组，导演室可同时显示多部进度。

### 17.7 已落地：手动触发自动选书

- 导演室「藏书消化」新增「自动选取 3 部小说」；无需等待每日定时点，点击后立即按 `novelDigest.autoSchedule.queries` 搜索 Kakuyomu。
- `POST /api/outline/corpus/discover` 复用 `CorpusScheduler.runNow()`，排除已入库文档并固定最多选择 3 部，再送入现有 `CorpusEngine` 三文档并行池。
- 手动与定时触发共享运行锁；已有选书任务进行中时返回 `busy`，不会重复抓取或建立第二套任务状态。
- 接口返回候选数、选中项、成功入队项和逐项错误，前端据此给出明确结果；全文抓取和模型分析仍在后台任务中执行。


### 17.8 2026-09-01 生产故障修复

小说研究曾因非严格 JSON、`EventStream.result()` 未正确读取、模型 reasoning 协议不匹配和多层重试叠加而出现小时级不完成。完整复盘与生产验证见 [`docs/INCIDENT-20260901-NOVEL-DIGEST.md`](INCIDENT-20260901-NOVEL-DIGEST.md)。

当前语义：摘要/梗概是核心产物；套路、日常卡、中尺度素材是增强产物，部分增强任务失败只记录降级，不让整部文档回到 pending/failed。
