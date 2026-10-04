# PLAN-RP-MEMORY：数据库式两级纪要 + 证据召回记忆系统

## v1.7.3 当前并发与接入补充

- `memoryDeleteChunk`、`memoryClearStore`、`memoryRemoveStore` 现在是异步接口，分别返回 `Promise<boolean>`、`Promise<void>`、`Promise<MemoryConfig>`；完成才表示删除实际生效。REST、台上工具及助手桥等待结果。
- 删除、清空、删库与添加/导入通过同一 `scope|store` 写锁串行执行。添加/导入取得锁后重读配置，避免队列里的旧请求重建刚删除的自定义库。
- 保证范围是同一进程、通过记忆服务入口的操作。多进程共享同一 SQLite 文件没有新增持久 generation/CAS，不能据此宣称跨进程一致性。
- 摘要、Session Tree、sourceRefs 与祖先链隔离权威不变；本轮未改变 legacy 无锚点 merge 政策，也没有把证据归档失败改成阻断摘要。
- 写入与删除/清空/删库的延迟 embedding 回归已增加。完整版本验证为后端 1097 项与前端版本 6 项通过；下文 147 项及旧失败描述属于对应历史阶段。

> 2026-08-26 立项。本设计承接用户定案：
> **采用 pi harness（`packages/agent`）已成熟的总结范式**——结构化固定格式、
> 初建/增量两套提示词、保留旧有效信息、无依据不编造；
> 并确认：**摘要 = 第二套事实权威**（正文不可能全量长期发送，长局必然只保留最近几楼
> 原文 + 早期摘要/记忆）。本文件是记忆系统改造的唯一决策契约。当前实现基线：v1.7.3；2026-09-18 修订是历史阶段。

## 0. 为什么采纳数据库的范式

梨园换引擎时 `session.compact()` 退场，长局压缩由台上自管 `rp-summary` 承担。但
pi harness 的 compaction/branch-summarization 系经过长期验证，有三个梨园当前
`rp-summary` 没有、但长局精确回照必须的东西：

1. **初建 / 增量两套提示词**（`SUMMARIZATION_PROMPT` / `UPDATE_SUMMARIZATION_PROMPT`）：
   - 初次：从零生成固定结构摘要；
   - 增量：`<previous-summary>` 传回旧摘要，明确「PRESERVE 旧有效信息 / ADD 新信息 /
     UPDATE 状态 / 不再相关可删 / 保留精确名称」——**不是摘要的摘要，是带旧底稿的改写**。
2. **固定输出结构**：不让模型自由发挥版式，字段把「事实」「进度」「决策」分开。
3. **无依据不编造**：摘要系统与 `memory_search` 都写明「不续写、不臆造、缺失令其模糊化」。

梨园复用其**范式与规则**，替换其**领域字段**（coding 的 Goal/Progress/Key Decisions →
RP 的 Story Phase/Characters/Events/Promises/Facts/Current Scene/Recall Index）。

## 1. 权威边界（本设计新增的部分，不推翻既有权威）

```text
Session Tree          = 正文/分支/用户输入的原始事实源（不被记忆库覆盖）
rp-state              = 镜头内角色账本（权威不变）
rp-world-state        = 模块化世界权威（权威不变）
rp-ecology-state      = 生态权威（权威不变）
rp-outline            = 动态大纲（权威不变）
rp-summary            = 长期故事纪要（**第二套事实权威**：覆盖区正文不进上下文后，
                        后续主演对早期事实以摘要为准；原始正文仍由 Session Tree 保留）
rp-event-digest       = 一级事件纪要（检索投影 + 原文锚定；不推翻 rp-state/outline）
memory archive        = 被裁原文证据（可与 rp-summary 冲突，赛氏以「摘要管事实、
                        归档管细节」为原则：细节以归档原文为准，事实以摘要+状态为准）
```

**不引入**第二套正文 Writer、第二套持久 Session、第二套 canonical 世界/人物/事件状态。

## 2. 两级纪要 + 证据归档

### 2.1 一级纪要：事件卡（event digest）

每轮/每场景生成短事件候选人，高价值事件晋升为长期保活卡。附原文锚点。

```ts
interface RpEventDigest {
  kind: "rp-event-digest";
  id: string;                // canonical id = event_<sha1(session|card|sourceRef|title)>，代码生成
  sourceKey?: string;        // 模型输出的稳定来源键；最终 id 由代码按 sourceRef 生成
  /** 2026-08-27 新增：提取旁路的去重意图；入库前消费，不持久化。 */
  op?: "create" | "skip" | `merge:${string}`;
  status: "candidate" | "active" | "resolved" | "retired";
  importance: "core" | "major" | "normal" | "minor";
  title: string;
  turnRange?: { from: number; to: number };
  sourceRefs: Array<{ entryId: string; entryType: string; turn?: number; charFrom?: number; charTo?: number }>;
  participants?: string[];
  time?: string;
  location?: string;
  /** 2026-08-27 新增：同一长期剧情线的稳定名称（如“初遇误会线”）。 */
  arc?: string;
  tags: string[];
  recallAnchors: string[];
  summary: string;
  evidenceLevel: "source-backed" | "summary-only";
  branchLeafId?: string;
  /** 2026-08-27 新增：与其他事件的因果/演进/化解/冲突关系。 */
  links?: Array<{ to: string; type: "caused_by" | "evolved_from" | "resolved_the" | "contradicts"; note?: string }>;
}
```

### 2.2 二级纪要：长期故事纪要（rp-summary v2）

沿用现有 `rp-summary` 条目（CustomEntry），但由数据库式统一提示词生成：

```text
## Story Phase         当前阶段 + 阶段目标 + 阶段起点
## Story Progress      时间序重大推进（谁做了什么 → 结果 → 影响哪条线）
## Characters          核心人物状态 + 关系演变 + 称呼习惯
## Core Events         稳定 id 列表（不重复写全文）
## Promises & Threads  未兑现承诺 / 未解决误会 / 未揭露真相 / 活跃伏笔
## Canon Facts         已确认时间线 / 物品归属 / 身体状态 / 身份 / 关键数值
## Knowledge Boundaries 谁知道什么 / 谁不知道什么 / 不能泄露的后台秘密
## Compression Boundary 被压缩区间结束时的时间/地点/人物/动作（早期摘要边界，不是续演点）
## Current Continuity   续演点：由最近保留正文与 rp-state 提供；不得用压缩旧场景冒充
## Recall Index        历史回照词 + 事件 id + 别名
```

### 2.3 证据归档（memory archive）

被压缩正文完整归档进剧情库，本次增强：
- 分块时携带 `entryId` / `entryType` sourceRefs；
- meta 增加 `kind: "evidence"`；
- 核心事件卡标注 `importance: "core"`，不受普通 FIFO 淘汰；evidence 是可回源缓存，
  容量不足时允许淘汰，命中事件后优先沿 sourceRefs 回 Session Tree。

## 3. 提示词：数据库式两段

### 3.1 一级纪要（随剧情库每 N 拍滚动提取 + 压缩 envelope 兜底）

一级纪要主要随 `everyNTurns` 节拍按完整窗口滚动提取：拍尾旁路把
窗口正文 + 既有事件卡（去重上下文）发给记忆 Skill，产出事件卡（含 `op`/`arc`/`links`），
入库经代码级 cosine 去重与字段合并（§3.1.1）。压缩 envelope 的 `events` 字段作为兜底
路径。

system：
> 你是梨园的记忆整理旁路。遵守 `skills/剧情记忆摘要/SKILL.md` 的规则：
> 输入 `<narrative>` + `<sourceRefs>` + `<existing-events>`（既有卡去重上下文）+ `<existing-arcs>`
> → 输出事件卡数组（含 `op: create | merge:<id> | skip`、`arc`、`links`、`sourceRefs`）。
> 同一事件演进用 `merge` + `evolved_from/resolved_the` 链接旧卡，不要堆新卡。
> 新事件由旧引发用 `create` + `caused_by`。每窗口至少给普通进程 `normal` 节点保时间线连续。
> 弧线名优先复用 `existing-arcs`。

user：`<narrative>` 窗口正文 + `<sourceRefs>` + `<existing-events>` + `<existing-arcs>` → 仅 JSON。
> 入库前经代码级 cosine 去重兜底（local 0.75 / cloud 0.92）：命中既有卡 → 字段合并——
> sourceRefs 累积、importance 取高、旧 title 优先、new summary 更新、links 并集。
> 合并轨迹写入 `memory-diff.jsonl` 审计日志（create/merge/update + 原因码）。
> 滚动提取失败不推进游标；恢复后从最老待处理窗口继续，输入过长时按完整拍缩小窗口，不能静默跳过早期窗口。

### 3.2 二级纪要·初建（复用数据库范式）

system：
> 你是长篇角色扮演的记忆整理旁路。读取已发生剧情，生成固定结构的长期故事纪要。不续写正文。

user：`<conversation>` 早期剧情 + `<state>` 状态快照
　→ 输出统一 envelope：`{"version":2,"summaryMarkdown":"(§2.2 十节)","events":[]}`。

### 3.3 二级纪要·增量（核心，对齐 UPDATE_PROMPT）

system：
> 你是长篇角色扮演的记忆整理旁路。读取「新剧情」并把它并入旧长期纪要。
> RULES：
> - PRESERVE 旧纪要中仍有效的信息；
> - ADD 新事件、新关系变化、新事实；
> - UPDATE Story Phase / Characters / Compression Boundary（写被压缩区间末端场景）；
> - MOVE 已兑现的承诺从未解决区 -> 历史结果（不丢事件 id）；
> - REMOVE 已不再相关且低价值的细节；
> - PRESERVE 人物姓名写法、物品名、事件 id、Recall Index、Knowledge Boundaries；
> - 不确定候选不得升级为事实；无足够证据的细节不补写；
> - 不续写剧情；只输出统一 envelope（`{"version":2,"summaryMarkdown":"...","events":[]}`）。

user：`<previous-summary>` 旧纪要 + `<new-events>` 新事件卡 + `<new-narrative>` 新正文
　→ 输出更新后的统一 envelope。

### 3.4 召回提示词（沿用现有 memory_search，补两阶段）

现有 `memory_search` 语义保留（合并两库取前 N、无命中不得臆造、可以模糊化）。
增量说明：
- 命中 `kind:event` 条目 → 是事件定位，可概括回忆，不得伪装逐字记忆；
- 命中 `kind:evidence` 条目 → 是原文证据，可准确回忆动作/物品/关键对白，但不得整段照抄，
  并按角色知情边界自然表达；
- 纪要与证据冲突时：事实以 rp-summary / rp-state / 当前分支为准，细节以证据原文为准。

### 3.5 统一摘要 envelope

压缩旁路一次调用，同时返回长期纪要 + 事件候选，避免「摘要模型」与「事件模型」各自
生成两套命名：

```json
{
  "version": 2,
  "summaryMarkdown": "## Story Phase\n…（完整 10 节 Markdown）",
  "events": [
    { "id": "source_exam_announced", "sourceKey": "source_exam_announced", "title": "…", "importance": "core", "tags": [], "recallAnchors": [], "summary": "…", "sourceRefs": [...] }
  ]
}
```

代码在入库前将每个事件的 sourceKey **重写成 canonical id**
（`event_<sha1(session|card|sourceRef|title)>`），并把摘要 Markdown 中的旧别名一并替换，
保证 Core Events / Recall Index / 事件卡引用同一 id。旧模型只回纯 Markdown 时，走
§3.1 补丁提取，但 canonical 化规则不变。

## 4. 两阶段召回（主演拍前自动接入）

不再只依赖主演主动调 `memory_search`；拍前装配由确定性注入：

### 4.1 召回构造

输入信号采用两阶段判定（2026-08-27 升级）：

1. **门控** `shouldRecallHistory()` 正则预判（命中…表达 / 扫荡词才进入后续），普通拍零 embedding；
2. **意图分档** `classifyRecallIntent(userText)`：`"sweep"`（线召回）vs `"point"`（点召回），扫荡词如「从头讲讲」「这些年」「一路走来」「来龙去脉」等。

输出（两阶段）：
1. `recall-for-turn(query)` （点召回）：锚词直通（query 命中 recallAnchors/tags 子串 → 直通加分，score=2）+ embedding 合并检索；去重后取最多 6 条；
2. `recallArcsForTurn` （线召回，仅 sweep）：纯本地，按弧线分组 → 每弧「◆ 弧线名（拍序范围 · 进度） + 事件骨架行」，cap 5 弧 × 12 事件/弧 × 1200 字总预算；
3. 命中事件再沿 `recallEvidence` / sourceRefs 回 Session Tree 原文。

注入【剧情记忆】分两节：`— 剧情脉络 —`（arc 骨架块）+ `— 相关片段 —`（现有事件/证据条目），整块 ≤ 2500 字硬截断。

### 4.2 注入位置（不破坏用户原话最后一句）

在 `buildStageInjection` 末尾、`【预设末端指令】` 之前插入：

```text
【剧情记忆】
本拍可能触及以下历史（按需自然融入，勿逐字照抄；与当前已提交事实冲突时以当前事实为准）：
— 剧情脉络 —
◆ 误会线（拍1–87 · 已化解）
  · 拍1 递伞与初误会 — ……
  · 拍23 关系恶化 — ……
— 相关片段 —
- 〔event_xxx〕……
```

### 4.3 预算与降级

- 召回不进入正文首字关键路径：拍前装配时按并行旁路等待，超时/失败 → 无【剧情记忆】，
  主演按摘要 + 状态照常演；
- 召回结果受叶守卫：本拍期间切换分支 → 整块丢弃（与拍前生态/连续性同一律）。

## 5. 触发与保活

### 5.1 触发

| 时机 | 动作 |
|---|---|
| 每拍收尾（定稿且记账后） | 低成本候选事件提取（旁路，不进正文关键路径） |
| 事件达 core/major | 立即持久化为长期卡 |
| 场景结束（确定性信号） | 固化场景纪要，可能晋升 major |
| 周期性（everyNTurns/压缩时） | 二级纪要增量更新 |

不每拍跑高成本大摘要；普通拍只做候选提取或延迟合并。

### 5.2 分级保活（替代纯 FIFO shift）

（2026-08-27 重排）淘汰优先级从低到高（rank 越大越不容易被删）：

| rank | 内容 | 说明 |
|---|---|---|
| 4 | event(core\|major) | 永不自动删除（`>= 4` 跳过） |
| 3.5 | event(normal) | 事件账本优先于可重建纪要和证据缓存 |
| 3 | evidence(core), importance major, event(minor) | 核心证据/重要标识/低价值事件 |
| 2 | digest normal / importance normal | 滚动纪要/普通标记 |
| 1 | evidence 无标记 / legacy / arc 骨架块 | 可回源/可重建，最先淘汰 |

event(minor) 从 1 提到 2.5，event(normal) 从 2 提到 3.5——事件卡是账本，
自然比可回源的 evidence 和可重建的 digest 存活更久。

## 6. 分支隔离

- 每个 event/evidence 记录 `branchLeafId` + `sourceRefs`（entryId 本身就在分支上，天然可逆）；
- 召回时：`getPathToRoot(leaf)` 得到当前分支祖先 id 集合；只返回 sourceRefs 全部落在这个
  祖先链上的条目（或 entryId 在当前分支可见）；
- 后台候选任务带 `expectedLeafId`，结束时比对，变了整体丢弃（沿用 R9 叶守卫）。
- evidence 回读优先直接从当前 Session Tree 按 sourceRefs 取原文；只有旧数据缺 sourceRefs
  或树条目不可读时才退回 evidence 向量缓存。

## 7. 现有数据迁移

- `rp-summary` 旧条目：保留，读时按 v2 结构解析失败则兼容展示（legacy）；
- narrative 滚动摘要 / archive：meta 补 `kind("digest"/"evidence")` 与 `importance` 缺省值；
  无 sourceRefs 的旧块标记 `evidenceLevel:"summary-only"`，不得直接当逐字证据；
- 不阻塞、不断言一次性破坏性迁移。

## 8. 落点（文件边界）

| 文件 | 改动 |
|---|---|
| `src/scribe.ts` | `buildRpSummaryInitialPrompt` / `buildRpSummaryUpdatePrompt` / `validateRpSummaryMarkdown`；摘要结构含 Compression Boundary + Current Continuity |
| `src/stage/compact.ts` | 压缩走统一 envelope：`parseRpSummaryEnvelope` 解析 `summaryMarkdown + events`；摘要落树前完成 archive/事件写入，并携带 sourceRefs（entryId/entryType/turn/charFrom/charTo） |
| `src/memory/event-id.ts` | `canonicalEventId()`：按 session+card+sourceRef+title 生成 `event_<sha1>` |
| `src/memory/types.ts` | meta 增加 `kind / importance / sourceRefs / recallAnchors / evidenceLevel / eventId / branchLeafId`；`RpEventDigest` 含 `sourceKey`、sourceRef 精确到字符区间 |
| `src/memory/store.ts` | `evictByPriority` 分级保活（core/major 事件卡保活，evidence 可淘汰） |
| `src/memory/service.ts` | 事件卡 upsert 统一 canonical id；`memoryEvidenceForEvent` 按 evidence kind 预过滤 + 精确 sourceRef 回读；`memoryRecallForTurn` 分支可见性过滤 |
| `src/stage/assemble.ts` | `buildStageInjection` 增 `memoryRecall` 注入块；释义表补纪要与证据之分 |
| `src/stage/engine.ts` | 拍前 `shouldRecallHistory` 预判 + 两阶段召回 + 15s 预算 + 去重 + 分支过滤；`#sideText` 绝对超时与分级重试；摘要 canonical id 重写；诊断留痕 |
| `src/stage/diagnostics.ts` | 新增「剧情记忆召回」「记忆压缩与事件索引」诊断节点 |
| `src/model-routing.ts` | SideModelStep 增 `memoryEvents`（独立超时/重试档） |
| `server/main.ts` | stage deps 注入 recallForTurn/recallEvidence/shouldRecallForTurn/upsertEventDigest；召回按当前分支事件 id 过滤 + Session Tree 原文回源 |
| `server/rest.ts` | 新增 `GET /api/memory/events` |
| `src/tools/memory.ts` | `memory_search` 描述补纪要与证据之分；命中正文 / 事件卡可读化 |
| `skills/剧情记忆摘要/SKILL.md` | 事件提取 Skill：sourceKey 语义 + sourceRef 限定 + JSON 输出 |

规则提示词正文优先落 `skills/`（用户覆盖在 `.liyuan-stage-skills/`），不硬编码进 TS。

## 9. 2026-09-18 可靠性修订

- 压缩归档与 envelope 事件写入改为在追加 `rp-summary` 前完成，避免摘要条目推进叶后被叶守卫自行取消。
- `everyNTurns` 周期写入改为完整 N 拍窗口；每个正文块携带 entry 级 `sourceRefs`、绝对拍序与 `branchLeafId`，不再只保存触发拍首尾片段。
- 周期纪要、事件卡和 evidence 统一使用同一 narrative keyed lock，避免 embedding 等待期间旧快照覆盖新写入。
- 滚动事件游标从最老待处理窗口向前推进；输入过长时按完整拍缩小窗口，不再截正文却保留整窗 refs。
- 台上与助手 `memory_search` 命中事件后补取 evidence；`memory_list` 与助手检索统一按当前祖先链过滤。
- 事件语义去重只比较同 embedding mode/model/维度；长期事件 refs 保留最新 24 条；同 entry 多区间证据全部参与重叠评分。
- SQLite chunk 主键升级为 `(scope_id, store_id, id)`，不同会话可安全复用旧数据 id。
- 正文流程骨架不变；每拍仅额外在 assistant details 的 `rpInputComposition` 留下 system/summary/history/injection/user/tools 字符构成诊断，不裁剪正常正文历史。

### 9.1 历史验收状态（2026-09-18）

- 记忆、压缩、正文引擎专项回归：`147 passed`。
- 前端 `typecheck` 与生产构建通过。
- 完整后端套件中剩余 NovelAI UI 源码结构断言和 Outline research 脱敏断言，均不属于本次记忆/正文主链。
- 旧数据没有 `sourceRefs` 时不能 retroactively 推断真实分支来源；需要严格隔离时，应从 Session Tree 重新归档/提取。

## 9. 验收目标（1000 楼回照场景）

- 第 1 楼初遇（递伞+误会）→ 产生 `event_first_meeting`（source-backed）；
- 长局压缩数次后 rp-summary v2 中仍有 Core Events 条目（事件不丢）；
- 第 1000 楼用户「还记得第一次见面吗」→ 拍前自动注入【剧情记忆】命中初遇事件，
  主演不必先主动调 `memory_search`；
- 追问「那天你递给我什么」→ 沿 sourceRefs 命中第 1 楼 archive 原文块，能答出信物；
- 分支 A 澄清 vs 分支 B 加深：各自召回只见祖先链内容，不串味；
- 中断/无命中：主演按摘要模糊化，不臆造原话。

## 10. 不做

1. 不把每拍正文全送给高成本模型做摘要（预算闸门 + 候选延迟合并）；
2. 不让事件卡推翻 rp-state / rp-outline；
3. 不新增第二套正文权威 / 第二套持久会话；
4. 不要求云端 embedding 才可工作（core 事件靠标签 + sourceRef 保证可回源）；
5. 不让记忆注入压住用户原话；
6. 不让后台记忆任务直接写正文。

## 11. 落地状态（历史记录，2026-08-26）

- ✅ memory 类型 + 分级保活 + sourceRefs（P1A types / P1B store / P1C service）
- ✅ 摘要两段提示词（scribe.ts）+ compact 增量接线
- ✅ 拍前自动召回（assemble 注入块 + engine 调用 + main.ts 依赖）
- ✅ 事件候选提取 + archive sourceRefs 增强；压缩写入在摘要落树前完成，滚动事件仍不阻塞正文
- ✅ 分支可见性过滤 + 叶守卫 + 诊断投影 + 针对性测试
- ✅ 摘要/事件统一 envelope：`version=2 + summaryMarkdown + events`；兼容旧 Markdown
- ✅ 事件 canonical id 由代码按 session/card/sourceRef/title 生成（`src/memory/event-id.ts`），模型 id 只作 source key
- ✅ 摘要提交门禁：`validateRpSummaryMarkdown` 校验 Story Phase→Current Continuity 共 10 节，缺结构 fail closed
- ✅ 摘要字段修正：新增 `## Compression Boundary`（压缩区间末端），`## Current Continuity` 只作续演点提示
- ✅ 证据召回先按 `kind=evidence/source=archive` 过滤，再取 topK；有 sourceRefs 时**优先回 Session Tree 取原文**，缓存兜底
- ✅ `#sideText` 旁路超时与分级重试：主演 15 分钟，普通旁路 90 秒，压缩 120 秒，事件提取 60 秒
- ✅ 历史回照预判 `shouldRecallHistory()`：普通拍不发云端 embedding 查询；召回 15s 预算 + 去重 + 上限 6 条
- ✅ 诊断投影新增「剧情记忆召回」「记忆压缩与事件索引」节点；`GET /api/memory/events` 数据面
- ✅ 测试：`test/rp-memory.test.ts`（9 条）+ `test/rp-memory-longrun.test.ts`（1000 楼冲刷模拟）

### 实弹（2026-08-26，实教二年级篇 + zhuzhan/deepseek-v4-pro）

- ✅ writer 演正文稳定：多条完整正史落树（最长 9710 字），工具轮/分段/封笔全正常；
  hajimi 流式端点为概率性 `all cf workers failed to stream`（2/5~4/8），故正文渠道改用
  `zhuzhan`（magicv4.ltd `deepseek-v4-pro`，见 `liyuan-profiles/zhuzhan.json`）。
- ✅ 拍前自动召回实弹命中：「查剧情库『八神拓也 测试玩家 搭档笔试』· 1 条」来自滚动入库记忆。
- ✅ 滚动入库生效：narrative chunks 按 everyNTurns 合并（counter=3 触发）。
- ✅ 世界链 / 生态 / 记账 / 诊断逐拍落树；旁路 90s 超时按降级路径处理，不断正文。
- 摘要 v2 + 事件卡需压缩线（活拍≥7）实弹触达，当前由单测覆盖；继续实弹见 §12。

**归档**：本实现以本地 git 提交落盘（见 `docs/LOCAL-UPSTREAM-UPDATES.md` §6.1）——
`4b2680e` 仅提交到 `local` 分支，**不推向 GitHub**；恢复点
`/root/backups/liyuan-update-20260826-200338/repository.bundle`。

### P0 约束补充

- 摘要旁路优先输出统一 envelope：`{"version":2,"summaryMarkdown":"...","events":[]}`；
  旧模型返回纯 Markdown 时保留兼容路径，但事件提取属于补偿路径。
- 模型事件 id/sourceKey 不作为 canonical id；代码用 `session + card + sourceRef + title` 生成
  `event_<sha1>`，并在摘要中的旧别名位置重写为 canonical id，避免摘要和事件库各自命名。
- 事件卡事件引用只接受当前压缩输入提供的 sourceRefs；证据回读优先从当前 Session Tree
  按 sourceRefs 取原文，取不到才搜 evidence 缓存。
- 普通拍不自动发云端记忆查询；只有「第一次/当年/还记得/那把……」等历史回照信号才触发
  `recallForTurn`。召回结果去重并限制为最多 6 条。
- `memory-recall` 与 `memory-settlement` 已进入本拍诊断投影；召回失败/超时显示降级，
  不把失败伪装成未触发。

## 11.1 落地状态（2026-08-27 · 本侧迭代）

- ✅ 事件卡 `arc` / `links` / `op` 字段（types.ts / skills/SKILL.md / engine 解析）
- ✅ 入库语义去重：candidate id 匹配 ⇒ 字段合并；cosine 门槛 local 0.75 / cloud 0.92 ⇒ merge；`memory-diff.jsonl` 审计
- ✅ `evictionRank` 重排（event 升格，evidence/legacy 靠后）
- ✅ 滚动事件提取：`eventBook` dep（游标+everyNTurns 完整窗口）+ engine 旁路 + 叶守卫
- ✅ 召回分档：`classifyRecallIntent` sweep/point + 锚词直通 + `memoryArcRecallForTurn` 弧线聚合
- ✅ 注入格式：`— 剧情脉络 —` + `— 相关片段 —`，整块 ≤2500 字
- ✅ 诊断 `mode` / `arcs` 投影；REST `GET /api/memory/diff`
- ✅ 测试：`rp-memory.test.ts` 7 条新 + `rp-memory-longrun.test.ts` 弧线演变
- ✅ 摘要增量提示词 +2 行（长度目标\Core Events id 约束）

### 参考来源

本设计吸收两家成熟系统的信息结构，保留梨园 agent 原生形态：

| 来源 | 吸收点 | 不采用 |
|---|---|---|
| [shujuku 数据库](https://github.com/AlbusKen/shujuku) | 账本纪律（逐行时间线、稳定编码、概要索引常驻、合并折叠）、列式元数据过滤 | 填表 DSL、美杜莎 CoAT、世界书 keyword 注入、每轮 300 字强制纪要 |
| [OpenViking](https://github.com/volcengine/OpenViking) | L0/L1/L2 三级预算（256/4000）。检索意图 TypedQuery 分档。向量预筛 + LLM 语义去重。记忆操作审计（memory_diff）。目录递归检索的弧线聚合思想 | VLM/AGFS/Python 服务端、PPR 图遍历、外部服务依赖 |

## 12. 后续优化（P1/P2 剩余）

- 导演室记忆诊断与事件卡管理页（触发原因/命中/超时/来源楼层/手动升/降）；`GET /api/memory/events` + `/api/memory/diff` 已提供数据面
- 「正文完成」与「后台结算完成」拆分、真实 API 低频回照回归测试继续补齐

## 11.2 落地状态（历史记录，2026-08-28 · SQLite 迁移 + 正确性加固）

存储后端从 JSONL 全文重写切换为 SQLite（`better-sqlite3`，原生事务/WAL/索引），并
按上一轮审计 P0/P1 完成六项正确性加固：

### SQLite 存储（`src/memory/store.ts`）

- 单文件 `.liyuan-memory/memory.sqlite`；表 `memory_chunks`（向量 JSON + meta JSON，
  索引按 scope+store+kind+eventId）+ `memory_diff`（审计行）。
- 首访自动迁入旧 `scopes/**/stores/*/chunks.jsonl` 与 `memory-diff.jsonl`（幂等，仅在
  目标 scope 尚无数据时导入）；删除路径会清理已迁入的旧 lain 目录。
- `searchStore` 只检索「embedMode + embedModel + 维度」与当前一致的块（杜绝跨向量
  空间误比）；排序去重加 `id` 兜底保证确定性。
- `upsertTexts` 支持按块独立 meta（逐 entry 证据锚点依赖它）。

### 正确性修复

1. **分支隔离统一**：`memoryHitVisibleOnBranch` 由 `some` 收紧为 `every`——带 refs 的
   内容须**全部** refs 落在当前祖先链才可见；source-backed 但缺 refs 默认不可见。
   过滤统一应用到自动召回、`memory_search` 工具、事件列表（提取上下文）、显式
   merge（`merge:<id>` 目标与本事件必须共享至少一个来源条目，否则 `stored:false`）。
2. **并发防丢写**：服务层 keyed async mutex（`scopeId|storeId` 与全局配置两把锁）包住
   事件 upsert / 归档 / 滚动入库 / 手工写入 / reembed 的读-改-写事务；叠加 SQLite 单
   写者事务与 WAL，消除服务层 await 交错造成的丢更新。
3. **事件游标结算**：`#rollMemoryEvents` 只在本窗口无事件或全部非 `skip` 事件保存成功
   后才推进游标；任一失败不推进，下一窗口扩展重试（upsert 幂等，不重复建卡），失败
   事件上报 onActivity。
4. **证据锚点精确到 entry**：压缩归档改由 `compact.ts` 生成 `perEntry`
   （`entryId + entryType + turn + 原始正文`），`memoryArchiveCompacted` 逐 entry 切块并
   带 `charFrom/charTo`（坐标对齐 Session Tree 原始 `message.content`）；两阶段召回优先
   返回「同 entry + 区间重叠」的证据块，不再整个压缩区间互扫首块误配。
5. **新摘要严格校验 + canonical 统一**：`parseRpSummaryEnvelope` 暴露 `wasEnvelope`；
   `validateRpSummaryMarkdown` 收紧——v2 envelope 缺 `## Story Phase` 或其他 10 节直接
   拒绝；纯 Markdown 兜底需 ≥3 个标题（拒绝截断/报错/无格式文本）。归一化摘要时用
   **被压缩区间 sourceRefs（不是整条分支）** 作为 canonical 种子，摘要别名与事件卡 id
   不再分叉。
6. **项目根测试命令**：新增依赖 `better-sqlite3`（`@types/better-sqlite3` 为 dev）；
   构建以 Node 22 为 ABI 目标（`npm rebuild better-sqlite3 --target=22.19.0`）。

### 新增回归测试（`test/rp-memory.test.ts`、`test/stage-compact.test.ts`、`test/stage-engine.test.ts`）

- 逐 entry 归档 → 事件证据精确命中所在条目（不误拉无关 entry）；
- 多 sourceRefs `every` 可见性（只看部分 refs → 整卡隐藏）；
- 显式 merge 跨分支目标被拒、共享来源放行；
- 6 路并发归档全部存活（锁串行化防丢写）；
- `wasEnvelope` 解析标志；
- 无结构/单节/缺节 v2 摘要一律拒绝提交。

**历史验证记录**：当时记忆相关 + checkout + engine + scribe + model-routing 等 141 条全过；该阶段完整
后端套件后来又增加了测试。当前结果以 2026-09-18 校准段为准。

## 11.3 实测记录（历史记录，2026-08-28 · new/gpt-5.6-luna）

- ✅ `new` 渠道已存在 `gpt-5.6-luna`，无需额外拉取；直接 `chat/completions` 请求返回
  HTTP 200。`liyuan.config.json` 的 `stepModels.writer` 已切换为
  `{ "provider": "new", "id": "gpt-5.6-luna" }`。
- ✅ 使用真实实教二年级篇角色卡启动 server、建立新会话并通过 WS 发起正文回合成功；
  实测收到计划接受、3 个路标演出、选择卡应答、角色/Skill 读取、面板创建、记账和
  拍后世界处理等阶段信号。
- ⚠️ 本次真实驱动在收到最终可判定的完整拍收束前被中止；因此**不能记为完整流程已
  跑通**，也不能把本次回合计入“滚动剧情入库 / 事件提取 / 事件卡落库”实测样本。
  后续验收必须同时看到 `agent:end`、assistant 正文落树、记忆 settlement，以及
  `/api/memory/events` 的新增/更新结果。
- ⚠️ 实测中 `ecologyRuntime`、`literaryWorld` 等旁路出现 90 秒超时并走降级快照；这
  不等于主流程卡死，但必须和“只有活动日志、没有正文/终态”的 watchdog 区分开。
- ✅ 确定性记忆链路另已验证：旧 JSONL 事件卡迁入 SQLite、云端 embedding、事件卡
  upsert、perEntry evidence、事件→证据召回、语义检索和 reembed 均成功；该结果不
  替代真实 StageEngine 端到端验收。

### 11.4 2026-09-14 演出链回归

- 实教二年级篇新会话完成三回合正文落树；修复前正文为 642–1085 字，修复字数目标识别和封笔软门禁后，单回合正文约 2289 字、净正文约 2229 字。
- 正文关键路径已移除逐角色排演；人物主动性由导演统一处理，回合中不再按出场人数额外调用模型。
- 模型热切换已验证：连接面板与设置页均可在不重启服务的情况下同步当前会话模型和 `stepModels.writer`。
