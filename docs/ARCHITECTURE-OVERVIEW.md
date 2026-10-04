# 梨园（Liyuan）架构总览

> 当前代码实现基线：2026-10-03（当前 VPS 已同步部署 v1.7.3）。本文描述已经落地的代码；早期 PLAN 文档中的待办、旧实验数字和旧状态机不覆盖本文。

> 面向 AI 助手与后续维护者的第一手结构说明：先读本文件，再按需深入各 PLAN 权威文档。
> 更新准则：任何引擎/提示词改动都要能回答「离 `docs/PLAN-ROUND-FLOW.md` 近了多少」、
> 「离 `docs/PLAN-RP-MEMORY.md` 近了多少」，并保持「状态进分支树、规则进 Skill、
> TS 只做编排与安全门禁」这条铁律。

本质一句话：**梨园把 coding-agent 的能力（skill、工具调用、决策卡、面板、世界线/分支）翻译进
角色扮演场景，让剧情模型只写正文，系统事务交给 harness 的旁路与确定性门禁。**

---

## 1. 权威边界（不可同时存在第二套）

```text
Liyuan Session Tree      = 聊天、分支、回复变体、世界线权威（f(分支)）
rp-state                 = 镜头内角色账本（time/location/characters/inventory/flags/plot_threads）
rp-world-state           = 模块化世界权威（ModularWorldState v2；旧 v1 快照内存迁移为 legacy 模块）
rp-world-manifest        = 当前分支采用的卡级世界适配版本
rp-world-audit           = 世界转移审计留痕（不进主演上下文）
rp-ecology-state         = 人物生活、地点活动、日程、通讯、认知、可错过事件
rp-outline               = 当前分支动态大纲（未来方向、人物弧线、伏笔；低于已提交事实）
rp-outline-proposal      = 大纲 pending/approved/rejected 提案与审计留痕
rp-outline-chat          = 导演室讨论记录与即时场景建议（非正文、非事实）；清空讨论追加 `rp-outline-chat-clear` 标记，`#chats()` 只读标记之后的内容
rp-summary               = 长局压缩接力摘要（**第二套事实权威**：被覆盖早期正文不进上下文后，早期事实/角色记忆以摘要为准；细节由 .liyuan-memory 归档召回）
rp-curtain-override      = 状态栏重 Roll 覆盖工件（只改展示）
rp-turn-diagnostic       = 只读结算留痕（场记结果、不成为第二套账本权威）
rp-turn-performance      = 绑定 narrativeEntryId 的只读阶段性能留痕（耗时、harness attempts、已观测 usage）
.liyuan/outline/research/corpus/ = 小说消化产物（documents.json / texts / digests；`documents` 入 OutlineResearchView，机制进 mechanisms.json）
.liyuan-memory           = 检索记忆（SQLite `memory.sqlite`，首访自动迁入旧 jsonl）：narrative 剧情库（事件卡 event / 滚动纪要 digest / 归档证据 evidence）+ external 额外库；事件卡带原文锚点 sourceRefs（逐 entry、精确到 char 区间），两阶段召回（事件→证据），可见性一律「sourceRefs 全落当前祖先链」
.liyuan/world/cards/<key>/profile.json = 卡级长期世界画像（跨会话）
StageEngine              = 唯一正文所有者 + 独立谢幕格式轮唯一时机
```

禁止引入第二套 Writer、第二套持久 Session 或第二套 canonical 世界/人物/事件状态。
日历、舆情、认知展示、诊断投影都是已提交状态的只读投影，不写回权威。
记忆系统（`docs/PLAN-RP-MEMORY.md`）依循同一原则：事件卡是检索投影 + 原文锚定，
不推翻 rp-state / rp-outline；正文唯一事实源仍是 Session Tree，记忆库只做总结与召回投影。

---

## 2. 目录地图

| 路径 | 职责 |
|---|---|
| `src/stage/engine.ts` | **台上引擎**：performTurn/regenerate/regenerateCurtain/abort、拍前并行、writer 分段、记账、拍后世界/生态、压缩、场记结算留痕、`#draftForwarder` 流式转发稿件 |
| `src/stage/workspace.ts` | 回合工作区（稿纸）：beat_plan/draft_append/draft_seal/draft_edit/world_state_update、单拍边界门禁、write 工具 |
| `src/stage/assemble.ts` | 装配：字节稳定的 system prompt + 每拍末端注入；rebuildHistory 只回读正文 |
| `src/stage/tools.ts` | 台上工具 schema 与执行路由（读侧检索 / 写侧稿纸 / ask） |
| `src/stage/scribe-run.ts` | 场记兜底记账（主演未记账时） |
| `src/stage/compact.ts` | 长局压缩（rp-summary v2 两段式增量 + 事件卡提取 + 证据归档） |
| `src/memory/*` | **记忆服务**（PLAN-RP-MEMORY）：`types.ts` 事件卡/证据类型与分级保活；`store.ts` **SQLite 存储**（`memory.sqlite`，事务/WAL/索引，首访迁入旧 jsonl）与 `evictByPriority`；`service.ts` 事件卡读写、两阶段召回、归档 sourceRefs（逐 entry + char 区间）、`memoryRecallForTurn`、keyed 写锁防并发丢写 |
| `src/scribe.ts` | 场记提示词 + **接力摘要两段式**（初建 `RP_SUMMARY_SECTIONS` / 增量带 `<previous-summary>`） |
| `src/stage/diagnostics.ts` | **本拍诊断只读投影**：从 Session Tree 动态构造回合诊断（关联、状态判定、安全裁剪、超大型截断与来源校验） |
| `src/stage/literary-*.ts` | 文学工作流各步：连续性、Sogon/Sigon、director、world-profile、world-modular、world-transition、world-signals、ecology |
| `src/outline/` | 独立大纲系统：Schema/runtime parser、分支恢复、Proposal/Audit/Commit、研究库、消费者安全投影与 OutlineEngine |
| `src/outline/corpus.ts` | **小说长文消化管道**（PLAN-NOVEL-DIGEST）：解码/清洗/分章/分块纯函数 + CorpusEngine（断点续跑、暂停/恢复/删除、独立取消、预算闸门、内容 fingerprint、append-only source version、冻结 layout 和旧 chunk 摘要复用；研究旁路不叠加 SDK 隐式重试） |
| `src/outline/corpus-scheduler.ts` | 小说研究自动任务：按本地时间每日调度 Kakuyomu 搜索，候选去重后最多 3 部入 CorpusEngine；不进入正文关键路径 |
| `src/outline/kakuyomu.ts` | Kakuyomu 作品页与搜索适配器：URL 校验、候选发现、Episode 列表提取、章节正文解析（Apollo State / ruby / 连续段落），用于手动 URL 与每日自动任务 |
| `src/stage/calendar.ts` | 确定性历法/日期/跨月区间/年度重复投影（纯函数） |
| `src/stage/skill-store.ts` | Skill 装载（内置 `skills/` + 用户覆盖 `.liyuan-stage-skills/`） |
| `src/presentation.ts` | 状态栏/日历/选项原生投影（只读视图） |
| `server/main.ts` | HTTP/WS 宿主、广播、会话管理、模型路由、REST 宿主接线、大纲异步校准调度与运行时诊断状态管理 |
| `server/rest.ts` | REST API（card/config/world-profile/world-state/skills/diagnostics…） |
| `server/wire.ts` | 会话树 → 前端 wire 协议翻译；`workflowView` 安全投影导演/连续性工件 |
| `web/src/` | React 前端；`Messages.tsx` 渲染消息、世界/生态卡、本拍工作流卡 |
| `web/src/planning/` | 独立导演工作台（梨园导演室）：分组侧栏（创作对谈 / 提案审阅 / 故事脉络 / 人物成长 / 伏笔追踪 / 藏书消化 / 研究搜索 / 创作素材库 / 演出回放 / 版本与设置），七种讨论模式，每 5 秒自动刷新诊断页；支持手动选书与 Kakuyomu URL 抓取、公开资料研究搜索（`POST /api/outline/research/search`） |
| `skills/` | 内置工作流 Skill（随版本更新） |
| `.liyuan-stage-skills/` | Skill 用户覆盖（gitignore，不随版本覆盖） |
| `packages/` | `@liyuan/*` agent 内核（pi fork，file: 依赖）；`packages/ai` 含 provider 请求与重试 |

---

## 3. 一拍完整流程（普通拍骨架）

```text
用户输入
  ├─ 追加 user 条目、捕获 expectedTurnLeafId（用户消息后固定，≤这个叶之内配套门禁）
  ├─（无 Manifest 时：检测到已存在卡级 profile → 只播种 Manifest，不改变预期叶）
  ├─ 后台：世界画像 / Sogon / Sigon 后台生成，下一拍生效（不阻塞正文首字）
  ├─ 并行：
  │   生态 arrival  ─┐
  │   文学连续性      ─┴→ Promise.all（条件触发）
  ├─ Stitches 导演（吸收 arrival + continuity + profile，统一处理人物主动性）
   ├─ writer 分轮：beat_plan（与落笔强制分轮）→ draft_append（每轮只受理一次正文写入）→ 回看/重拟 → draft_seal
  ├─ 主演记账（world_state_update → rp-state）；未记则由场记兜底
  │   └─ 场记结算留痕（rp-turn-diagnostic，记录跳过/失败/丢弃原因）
  ├─ 拍后（并行计算、顺序落树）：
  │   世界链：事实信封 → 到期模块提案 → 独立审计 → TS 门禁 → 原子 commit → rp-world-audit
  │   生态 aftermath → rp-ecology-state
   ├─ 独立谢幕格式轮 → rpCurtain（场记/世界/生态结算后读取最终分支状态生成）
  ├─ agent end 后：OutlineEngine 按 manual/suggest/auto 异步校准（不阻塞正文；下一拍生效）
  │   └─ 异步校准状态：pending → stable / committed / proposal / failed
  ├─ 压缩（按 everyNTurns，0=关闭自动）
  └─ onTurnEnd → agent:end → resyncAll（hello 全量重放）
```

关键设计：

- **正文唯一入口是稿纸**；`draft_append` 一次模型生成轮只接一段（硬门禁）。
- **小说版本不可变**：新版完整原文必须逐字追加旧版；旧 Corpus、旧 package、旧卡和旧 Session 不覆盖。追加作品包只继承旧节点并提取新增分块。
- **小说升级进分支树**：`rp-novel-play-upgrade` 只在一次性、绑定 session/card/leaf 的升级预览令牌确认后追加；不切卡、不新建 Session，回档自然恢复旧 revision。
- **小说场景召回**：当前原著节点所在 stage 的公开事件会组成同场事件组，带标题、摘要和原文证据，作为候选同时交给导演、场面编排和主演；生态候选只能补充，不能覆盖原著候选。
- API 声明或实际表明不支持工具调用时，主演自动切换为纯文本模式：不发送工具清单，第一份完整文本直接收稿；该模式不提供分段工具、主演主动检索或主演主动记账。
- **计划是假设，不是剧本**：每段后重新评估，可重拟；明确长篇目标时计划上限按 `wordRange` 动态放宽至最多 8 条。
- 字数目标支持区间、约数和“不少于”表达；正文明显低于目标时前两次 `draft_seal` 会软拒绝，要求继续当前场景。
- **单拍边界**：默认只能推进当前场景；用户明确要求时间跳转才放行（`transitionAuthorized`）。
- `transitionAuthorized` 由用户本拍明确的推进/移动意图确定性提取，并同时作用于计划、追加、全量收稿和局部改稿；内部纯文本兜底也不能绕过边界。
- 正文 `rpNarrative` 与格式 `rpCurtain` 分工件落树；历史只回读正文。
- 拍后世界/生态在 `agent end` 前完成，保证下拍读到完整分支。
- 诊断数据只从已落树的 assistant `details`、`rp-turn-diagnostic` 和拍后 custom 条目读取，不新增权威状态。
- 人物画像允许读取完整人物剧情弧线以塑形；画像是条件资料，不是当前分支事实。具体原著事件、身份揭示和结局仍由作品包候选与当前分支校准处理。
- **人物身份优先**：当前账本和角色卡中已确认的人物身份会作为确定性参考注入；生态或导演候选不得把已确认人物改写成陌生人、女仆或其他无证据身份。
- **场记事实门禁**：场记只能从用户输入和主演定稿中提取事实；导演候选、生态候选、原著参考和推测不得直接写入 `rp-state`。
- **人物主动性由导演统一分析**；正文关键路径不再按在场角色逐个调用排演模型。
- 主 writer 每个流请求有 15 分钟硬超时；`ask` 等待有 30 分钟上限。超时、取消或坏网关不能永久占住回合锁。

---

## 4. 关键机制的当前形态

### 4.0 记忆系统（PLAN-RP-MEMORY，2026-08-28 迭代）
- **SQLite 存储后端**：`better-sqlite3` 单文件 `memory.sqlite`（事务 + WAL + 索引）；首访幂等迁入旧 `scopes/**/chunks.jsonl` 与 `memory-diff.jsonl`；写作只读 `searchStore` 过滤 embedding 模型兼容块。
- **三级金字塔**：弧线骨架（L1 确定性聚合 → 线召回） / 事件卡（L0 检索投影 + sourceRefs） / 原文证据（L2 回源 Session Tree）。每个事件卡带 `arc`（弧线名）、`links`（caused_by / evolved_from / resolved_the / contradicts）与 `op`（提取旁路去重意图）。
- **滚动事件提取**：每 `everyNTurns` 拍 engine 在正文关键路径外按最老待处理窗口旁路提取（memoryEvents 60s / 重试 1），完整窗口 + `<existing-events>` 去重上下文 → 产出事件卡含 merge/evolved_from 链路 → 入库经代码级 cosine 去重兜底 + 字段合并 + `memory-diff.jsonl` 审计日志。**游标只在全部非 skip 事件保存成功后推进**，失败恢复不跳过旧窗口。
- **拍前召回分档**：`classifyRecallIntent` 判定 sweep（线召回：弧线骨架块，零模型）vs point（锚词直通 + embedding）；注入 `— 剧情脉络 —` / `— 相关片段 —`，整块 ≤2500 字。
- **分支隔离收紧**：带 sourceRefs 的内容须**全部 refs 落在当前祖先链**才可见（`every`），并统一应用到自动召回、`memory_search`、事件列表与显式 merge（跨分支 merge 目标无共享来源即拒）。
- **逐 entry 证据锚点**：压缩归档 perEntry 切块，sourceRefs 精确到 `entryId + charFrom/charTo`；事件→证据两阶段召回优先返回同 entry 且区间重叠的原文块。
- **摘要严格校验 + canonical 统一**：新生成摘要须通过 `wasEnvelope`/10 节结构校验（纯 Markdown 兜底需 ≥3 标题）；摘要与事件卡共用被压缩区间 refs 作为 canonical 种子，id 不分叉。
- **分级保活**：event core/major 永不被自动淘汰；event normal 优先级高于 evidence 缓存（可回源 session tree）。
- **语义去重**：canonical id 命中 → 字段合并非替换（sourceRefs 累积、importance 取高、旧 title 优先）；id 不匹配 → cosine ≥ threshold(local 0.75 / cloud 0.92) → 并入最像旧卡。

### 4.1 中断 / 错误降级（8/19 实测修复）
- `#draftForwarder` 记录已实际送显的 `draft_write/append` 参数片段，返回 `pendingText()`。
- 取消或后续 provider 报错（429/断流）时，已受理稿段 + 当前半截合并为
  `stopReason: aborted` 的未完成回复落树；`finalTimeline` 保留前段、半截作独立末段。
- 被 `stream:clear` 标记的计划旁白不会复活。
- 中断/失败稿不记账、不推进世界/生态、不落媒体交付。
- 没有 provider final 时，只要有稿，也会合成 aborted assistant 记录。

### 4.2 请求重试
- 主演与普通旁路调用：provider 层自动重试，初次之外最多 9 次，遵循退避与 `Retry-After`；小说研究旁路关闭该隐式重试，由 CorpusEngine 统一控制。
- abort signal 立即停止；耗尽重试后已写正文不丢。

### 4.3 ask 决策门禁
- `ask` 工具在宿主注入 `askUser`（选择卡通道）时才会装配；`creationMode: ask` 才有意义。
- 触发：用户求方向、开局未定变量、演段后自然分岔。
- ask 结果是「这一拍有戏」的结构信号（lookups++）。

### 4.4 生态门禁（validateEcologyTransition）
- 终态不可重开；`message` 认知只来自已送达且收件人匹配的通讯。
- 公共事件/外部公告（OAA、广播）**不要求**引用当前 actor 工作集或当前跨域信号（避免首次建态误拒）。
- 仅本域 `occurrence:/secret:` 引用严格校验；通讯终态（delivered/failed/cancelled）不可倒退。

### 4.5 世界画像 / Manifest / 世界链
- 卡级 profile 按内容身份哈希；`draft` 每 8 拍复盘，`stable` 锁定。
- 已存在 profile 而分支无 Manifest：下一拍直接播种（不依赖后台候选）。
- `workflow: world` 缺内置回退时会整链停摆的教训已内置 `skills/世界推演/`。
- 世界只推进到期模块；秘密保持 secret；跨域用 `originRefs/kernel.links` 引用不复制。

### 4.5.1 大纲弧线角色与导演建议精度（8/24）

- **弧线形状末端锚定**：`computeArcShapeRole()` 纯函数从活跃 beats 序列确定性派生 `setup|rising|hardest|climax` 角色——高潮永远绑定最后一个活跃 beat、hardest 永远绑定倒数第二个，跳过或重构中间 beats 不漂移。
- **Goal/Objective 分离**：`sceneAdvice` 新增 `playerObjective / naturalReason / intendedConsequence` 三个字段，把导演建议拆成「幕后方向」（`recommendedBeat`）与「用户可见动作」（`playerObjective`）两层——用户不需要知道幕后秘密也能合理行动。
- **研究证据门禁**：小说提炼以块级/弧线级 evidence ID 绑定来源，独立审计后入库；研究可信度分旧定位、系统定位、审计通过。日常剧情固定三张、做结构差异检查并要求当前剧情接入钩子；这些都是导演旁路工件，不改变 StageEngine 正文所有权。
- **beat 兑现五态**：`OutlineArcBeatOutcome` 替代二元完成/未完成，区分 `progressing`（已有迹象但不够）/ `uncertain`（证据不足不提前揭晓）/ `fulfilled`（可信证据成立）/ `failed`（后果保留，旧尾段退役、新尾段新 ID 追加）/ `rerouted`（偏航时退役软 beats，已 fulfilled 不动）。
- **节奏意图**：`OutlinePaceIntent` 提供 `seed|normal|push|building|climaxing`——用户可表达的短期节奏信号，只影响未来编译，不改变既有事实，不越级推进 `rp-state`。
- 以上均在 `src/outline/schema.ts|projection.ts` 中；规则在 `skills/故事编剧室/SKILL.md` 和 `skills/剧情自动校准/SKILL.md`。

### 4.6 前端可观测性

**消息内工作流卡（`rpWorkflowView`）**：
- 消息下默认折叠「本拍工作流」卡：连续性、导演、生态抵达、主演分段、谢幕 + 主演指标。
- 展开可看安全的导演工件（压力/主动性/候选拍点/停点）；幕后线、暂扣信息、知情边界只显数量。
- 该卡绝不发送 prompt、原始模型输出或隐藏 reasoning。

**导演室「本拍诊断」页面**：
- 最近最多 20 回合按拍倒序展示，每拍拆成 12 个独立诊断节点：
  - 文学连续性 / Stitches 导演 / 生态抵达
  - 主演分段演出 / 角色账本
  - 拍后事实信封 / 世界转移提案 / 世界转移审计 / 世界原子提交
  - 生态 aftermath / 独立谢幕格式 / 大纲异步校准
- 节点状态覆盖完整生命周期：成功、降级、跳过、复用、失败、被拒绝、待确认、审计通过、稳定、已提交、不可用。
- 可查看主演轮次、稿段、拒收次数、耗时、token、账本修改审计、分支提交摘要和独立谢幕格式原文。
- 账本状态精确区分：成功提交、场记确认无变化、场记输出不可解析、场记因分支变化被丢弃。
- 世界链失败可定位到具体阶段：事实信封失败 / Proposal 预审拒绝 / 独立审计拒绝 / Audit 调用失败。
- 大纲异步校准显示：后台运行中 / 当前大纲稳定 / 等待用户确认 / 低风险自动提交 / 校准失败。
- 数据由 Session Tree、assistant `details`、`rp-turn-diagnostic` 和拍后已提交条目动态投影。
- 切换会话、导航分支、清空模块时缓存自动失效。
- 安全投影：不发送完整 prompt、生态秘密/幕后真相、世界书来源路径、隐藏 reasoning。
- 谢幕格式上限 32,000 字符，超出明确标记「已截断」。
- 旧会话缺少工作流工件的消息自动跳过，不生造假失败诊断。
- 手动大纲操作（编剧讨论/首次规划/手动确认）不混入本拍自动校准。
- 打开诊断页后每 5 秒自动刷新；后台校准完成后无需手动刷新。

### 4.7 本拍诊断 REST 接口
- `GET /api/turn-diagnostics?limit=N`（1–20，默认 12）—— 无模型调用、只读投影。
- `Cache-Control: no-store`，非法/浮点/超限 limit 均规范化。
- 安全性：在实例配置了 access password 时受全局 /api 鉴权保护。

### 4.8 真实渠道验证边界（2026-08-28）
- 当前正文 writer 使用 `new/gpt-5.6-luna`；该模型带函数工具时不发送未声明支持的 `reasoning_effort` 参数。
- 真实实教卡回合已确认能进入 StageEngine，并出现计划、路标、选择卡、Skill、面板、
  记账和拍后世界处理等阶段信号。
- 该次测试在最终完整收束前中止，故不能宣称真实端到端记忆结算已验收；完整验收必须
  同时确认 `agent:end`、assistant 正文落树、记忆 settlement 和事件卡 API 结果。
- 旁路超时会产生降级快照；活动日志本身不代表主流程仍在推进，watchdog 需以正文增量、
  工具受理、终态和落树结果共同判定。

### 4.9 2026-09-14 演出链与运行时修订

- 预设自然语言篇幅目标已结构化提取：区间、约数和“至少/不少于”均可识别；约 3000 字目标生成最多 6 条路标，最高 8 条。
- 明确篇幅目标时，正文低于下限的前两次 `draft_seal` 会软拒绝并要求继续当前场景；第三次允许收束，避免无限循环。
- 正文关键路径移除逐角色模型排演；导演一次性处理人物主动性，`sceneConductor` 只读取导演与生态适配候选。
- 连接面板选择模型时同步 `stepModels.writer`；设置页保存主演正文插头时同步当前会话模型。两者均为热切换，不要求重启。
- 带函数工具的 OpenAI 兼容请求仅向明确声明支持 `reasoning_effort` 的模型透传该参数；Luna 等未声明模型按最低公分母发送。
- 实教二年级篇回归：修复前正文为 642–1085 字；篇幅门禁修复后单回合正文约 2289 字、净正文约 2229 字，稿段 7 段，逐角色排演调用为 0。

### 4.10 2026-09-17 正文稳定性与 API 兼容修订

- 正文在封笔后被追加、重写或编辑时会重新打开封笔，并废弃基于旧稿提交的账本 patch；编辑再次经过格式、段落和单拍边界门禁。
- `beat_step_done` 必须有正文证据并按未完成路标顺序推进；同一生成轮禁止计划后立即落笔，也禁止第二次正文写入或修改。
- `MAX_LOOKUPS=3` 由引擎实际执行。主 writer 流有 15 分钟硬超时，`ask` 等待有 30 分钟上限。
- API 明确不支持工具，或返回文本化 DSML/pseudo-tool 协议时，最多自动降级一次到纯文本主演模式；该模式不伪造工具调用，但仍执行场记和拍后旁路。
- OpenAI Chat 旧式 `delta.function_call` 会归一为统一 `toolCall`；SessionManager 显式 `branch()` 保留指定父节点，重 Roll 回复保持 sibling。
- 独立谢幕读取场记、世界和生态结算后的最终分支状态；图片要求由 format plan 推导，诊断读取 `rp-curtain-override`。

### 4.11 2026-09-18 正文输入诊断与记忆可靠性修订

- 正文输入保持既有叙事语义：压缩前使用当前分支活跃历史，压缩后使用 `rp-summary` 加最近保留正文，需要时再注入有限剧情记忆；不把原始角色卡 JSON、小说全文或全部世界书直接全量作为正文输入。
- 正常正文历史不做额外硬裁剪；每条定稿 assistant 在 `details.rpInputComposition` 记录初次 writer 请求的 `systemChars`、`summaryChars`、`historyChars`、`injectionChars`、`latestUserChars`、`toolSchemaChars` 和 `initialChars`，用于区分正常历史增长与异常素材膨胀。
- 压缩归档和 envelope 事件写入在 `rp-summary` 追加前完成，避免摘要推进 Session Tree 叶后被叶守卫自行取消。
- 周期剧情记忆按完整 `everyNTurns` 窗口写入，携带 entry 级 `sourceRefs`、字符区间、拍序和 `branchLeafId`；事件游标从最老待处理窗口推进。
- narrative digest、event、evidence 共用 keyed lock；SQLite chunk 主键为 `(scope_id, store_id, id)`，避免跨作用域覆盖。
- 台上与助手的 `memory_search` 命中事件后均可继续获取 evidence；列表与搜索均按当前分支祖先链过滤。旧数据缺少来源锚点时只能按兼容规则处理。

---

### 4.12 2026-10-03 稳定性边界补充

- WS 撤权与广播/帧鉴权同步；可靠投递通过会话绑定、client ID、落树 ACK、恢复 outbox 与明确能力协商实现。
- 保持正文 sibling 结构的同时，将有效 model/thinking 元数据续在回复后；场记叶守卫区分纯设置变化和真实切支。
- writer 输入预检仅测量、警告，不裁正文/历史/卡材料；明确 context overflow 停止盲重试，TPM 与输出参数错误不冒称上下文超限。
- 拍后性能工件包括结算、谢幕、压缩，并区分首正文与计划旁白；背景跨拍备料不串入下一拍统计。
- 记忆删除/清空/删库等待同作用域写锁；Corpus 全阶段暂停/取消及持久实际尝试预算有回归。
- 生态新 committed 要求当拍用户来源证据；Skill 用户覆盖增加基线/更新/未知提示及非破坏性核对。
- 完整范围、验收结果、已部署状态与保证边界见 `docs/ITERATION-20261003-STABILITY.md`；不以此次专项结果宣称真实供应商、完整后端类型或三平台发行均已验证。

## 5. 权威文档导航

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE-OVERVIEW.md` | 本文件：结构总览 |
| `docs/PLAN-ROUND-FLOW.md` | 分轮演出流程最终形态 + 关键路径分级 + 落地记录（**唯一流程靶子**） |
| `docs/PLAN-WORLD-ENGINE.md` | 世界引擎：画像/Manifest/事实信封/模块化状态/提案/审计/原子 commit |
| `docs/PLAN-RP-MEMORY.md` | **记忆系统**（两级纪要 + 证据召回）：数据库式两段摘要、事件卡、分级保活、分支隔离 |
| `docs/PLAN-LIVING-ECOLOGY.md` | 鲜活世界：三层权威 + running/ready 双池 + 跨域信号 + 失败语义 |
| `docs/PLAN-OUTLINE-SYSTEM.md` | 动态大纲系统：Proposal/Audit/Commit、伏笔状态机、安全投影、导演室工作台（含本拍诊断） |
| `docs/PLAN-NOVEL-DIGEST.md` | 小说长文消化与研究库扩容：上传→分块摘要→套路库（§17 含实现状态与未做事项） |
| `docs/INCIDENT-20260901-NOVEL-DIGEST.md` | 小说研究故障复盘、根因、修复和生产验证 |
| `docs/STANDALONE-INTEGRATION-BASELINE.md` | 脱离 Luker 的整合基线：权威边界 + Skill 化 + 配置 + REST |
| `docs/DIRECTOR-ROOM.md` | 导演室用户参考：七种讨论模式、小说研究、即时建议卡、本拍诊断、建议如何转大纲 |
| `docs/LOCAL-UPSTREAM-UPDATES.md` | fork 的 `origin/main`/`local` 分支、安全同步、授权发布与恢复 |
| `docs/PRESET-SPLIT-TAXONOMY.md` | 预设拆层：A–I 类去留 |
| `docs/PLAN-RP-AGENT-EXEC.md` / `docs/PLAN-RP-AGENT.md` | RP agent 编排 |
| `docs/WRITER-API-COMPATIBILITY.md` | 主演 API 能力矩阵、纯文本降级与运行时保护 |
| `docs/NOVEL-PLAY.md` | 小说开演用户流程、API、边界、人物世界书与原著提示 |
| `docs/NOVEL-PLAY-MAINTENANCE.md` | Novel Play 维护规约、故障复盘、增量人物资料和真实验收 |
| `docs/PLAN-RP-TOOLING.md` | 工具 schema 与写入门禁 |
| `docs/READING-THINKING.md` | 读思考记录的正确方法（先读再碰会话文件） |
| `docs/THIRD-PARTY-INSPIRATION.md` | 参考过 ST-SevenDaysCal 与 world-backstage 的能力与来源说明 |

---

## 6. 测试与验证

```bash
npm test                            # 需 Node >= 22.19.0；完整后端测试
npx --yes node@22 --test --experimental-strip-types test/<file>.test.ts   # 指定文件
npm --prefix web run typecheck       # 前端类型检查
npm --prefix web run build           # 前端构建
```

- 领域/引擎测试用 `@liyuan/ai/providers/faux` 假 provider 离线整测，不联网。
- 真实供应商稳定性：远端 429/断流会造成部分拍「未完成」，本地会保留已写内容。
- 写测试优先断言「正文在树上 + 不记账」，避免把中断误标成成功定稿。
- 诊断投影测试用伪造分支条目离线验证关联、状态判定、安全裁剪与边界。
- 新增 `test/diagnostics.test.ts` 覆盖：阶段投影、世界失败、生态降级、limit 解析、旧消息排除、手动操作误归属、预审/审计区分、场记跳过/失败、超大型截断与异步大纲状态。
- 2026-09-17 回归覆盖：纯文本主演、工具拒绝降级、文本化伪工具识别、旧式 function_call、封笔后稿件变更、重 Roll sibling、结算后谢幕诊断。
- 2026-09-18 专项回归：压缩真实叶推进、完整 N 拍周期窗口、重复段落字符锚点、混合并发写入、复合主键隔离、长期事件最新来源、正文输入构成诊断。
- 历史专项记录（2026-09-21）：相关测试 `147 passed`，前端 typecheck/build 通过；当时完整套件有 NovelAI UI 和 Outline research 失败，此记录不代表当前代码的结果。
- 当前代码验证（2026-10-03）：正式 `npm test` 共 `1097 passed / 0 failed`，前端版本 fixture `6 passed`；前端 typecheck、隔离 outDir 构建和 7 项真实 HTTP/WS fixture 检查通过。已同步切换当前 VPS；未执行真实供应商演出或完整后端类型检查。

---

## 7. 维护要点（易踩坑）

1. **改流程先改 Skill**，不硬编码提示词进 TS。规则唯一权威在 `skills/` 与 `.liyuan-stage-skills/`。
2. **不要新增第二套状态**。要加的分支数据进 `rp-state/rp-world-state/rp-ecology-state` 对应权威，或作为只读投影（如 `rp-turn-diagnostic` 只记录场记结算摘要，不作为第二套账本权威）。
3. **叶守卫**：user 消息一旦落树即固定 expectedTurnLeafId；新增 custom 条目（如播种 Manifest）必须在捕获该叶之前，否则会被误判为「生成期间切分支」。
4. **取消/错误保留正文**：任何 provider 错误路径必须走 `#draftForwarder.pendingText()` 合并，避免半截丢失。
5. **`stream:clear` 语义**：工具轮流出的计划旁白应清屏，不能误当正文保存。
6. **`transitionAuthorized`**：明确用户推进时间才关闭单拍边界；不要在提示词里放宽或收紧正则导致误伤当前场景地点词。
7. **诊断归属不求位置**：世界链依赖 `narrativeEntryId`，状态/世界/生态依赖来源标识；不因条目紧邻某一拍就默认归属。
8. **主演 API 能力要分级**：禁止生成代码不等于不支持小说；拒绝 `tools` 才触发纯文本降级。完整矩阵和配置示例见 `WRITER-API-COMPATIBILITY.md`。
9. **诊断不展示原始模型输出**：安全投影字段白名单 + 明文裁剪 + 谢幕长度上限 + 提交记录数量上限；不新增不限长度的透传通道。

> 当前正文剧情链详细实现见：
> [ARCHITECTURE-RP-PIPELINE-20260902.md](ARCHITECTURE-RP-PIPELINE-20260902.md)
