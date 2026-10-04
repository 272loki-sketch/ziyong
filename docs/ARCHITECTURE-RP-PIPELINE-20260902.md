# 正文剧情链与导演室架构（2026-09-02）

> 本文的一拍依赖图保留为设计基线；v1.7.3 的提交确认、元数据叶守卫、非破坏性容量预检、完整阶段指标和用户承诺来源门禁，以各 PLAN 顶部校准段及架构总览为准。标题日期并非当前运行版本。

> 当前实现校准：2026-09-18。新增的正文输入构成诊断、记忆压缩可靠性和检索证据回读见文末 §9；API 能力矩阵见 `docs/WRITER-API-COMPATIBILITY.md`。

本文是梨园当前代码实现的工作流说明，优先于早期计划文档。候选 agent 只产生候选；只有实际正文、场记账本和通过门禁的拍后快照才是事实来源。

## 一拍依赖图

```text
arrival / continuity / memory（并行）
                 ↓
          plot adaptation
                 ↓
             director
                 ↓
           scene conductor
                 ↓
               writer
                 ↓
     scribe + plan-vs-fact（正文后）
                 ↓
      world aftermath + ecology aftermath
                 ↓
          outline reconcile（异步）
```

### 可以并行的阶段

- 连续性、记忆召回、生态 arrival。
- 世界事实提取与生态事实提取；如果生态必须看到世界转移结果，则改为依赖 world proposal。
- 压缩 evidence 归档和 envelope 事件入库在摘要落树前完成；滚动事件入库位于正文关键路径之外。
- 下一拍生态池检索在后台运行，不阻塞当前正文。

### 不应并行的阶段

- `plotAdaptation` 必须读取 arrival 后的生态切面。
- `sceneConductor` 必须等待导演。
- writer 必须等待场面编排。
- scribe、计划—事实对照必须读取已落地正文。
- outline reconcile 必须读取正文、账本、世界与生态最终提交结果。

## 各阶段提示词边界

| 阶段 | 输入 | 输出 | 硬边界 |
| --- | --- | --- | --- |
| continuity | 近期正文、状态、世界书 | 连续性约束 | 不创造事实 |
| arrival | 生态状态、人物、地点、时间 | 本轮生态候选快照 | 不推进已发生事实，不泄露 secret |
| plot adaptation | 卡级语法、相关生态工作集、大纲候选、当前状态 | selected + reserves | 候选最多 1+2，只推进一次互动 |
| director | 连续性、生态候选、用户输入、大纲 | 场景压力、人物主动性、停点 | 不替用户行动 |
| scene conductor | 导演、适配候选 | 行动顺序、信息差、压力变化、停点 | 不写完整对白，不创造事实 |
| writer | 全部候选工件与权威状态 | 分段正文 | 遵守玩家行动权与停点；正文才是事实 |
| plan-vs-fact | 候选、场面编排、实际正文 | 兑现程度、伏笔状态、下一压力 | 没有正文证据时必须 not-used/not-planted |
| scribe | 实际正文、用户输入、当前账本 | 结构化账本补丁 | 只记正文证据，不接受候选自证 |

当前正文关键路径不包含逐角色排演。人物主动性由 `director` 一次性综合处理，旁路调用次数不再随在场角色数量线性增长。

所有候选注入均使用 `candidate_not_fact` 标记。secret、discoverable 信息只允许在满足知情条件后进入正文。

## 重 Roll 语义

重 Roll 复用同一拍的 continuity、生态、director、plot adaptation 和 scene conductor，只重新运行 writer；失败时回退到重 Roll 前叶。复用工件统一保存在 assistant 的 `rpPrep` 中，诊断状态必须与实际注入一致。

## 上下文和并发预算

- 生态适配先做确定性相关性排序，每类最多 12 条工作集；完整池仍保留在磁盘。
- 每拍旁路共享总预算；超时只降级，不阻塞 writer 入口。
- world/ecology 提交必须使用叶守卫和原子顺序，分支切换时丢弃异步结果。
- 正文输入不额外硬裁剪正常分支历史；assistant details 的 `rpInputComposition` 记录初次 writer 请求的各组成部分字符数，供诊断输入异常。

## 导演室与总控台

导演室用于讨论、规划和提案审阅，不直接写入正文事实。总控台的“本拍工作流”展示安全投影：连续性、生态适配、导演、场面编排、writer、拍后提交和 outline 状态；不展示隐藏思维链、原始 prompt、secret 或幕后线。

诊断重点看：阶段状态（成功/降级/跳过/复用）、稿段与拒收数、模型轮次、旁路耗时、计划—事实对照和最终提交结果。

## 故障降级顺序

旁路调用失败 → 保留上一快照/跳过该候选 → writer 使用权威状态继续 → scribe 记录失败诊断 → outline 仅依据实际正文校准。任何候选失败都不能自动变成剧情事实。

## 8. 2026-09-17 运行时修订

- 主 writer 流逐次等待有 15 分钟硬超时，`ask` 有 30 分钟等待上限；坏网关不能永久占用回合锁。
- API 明确不支持工具，或返回文本化 DSML/pseudo-tool 协议时，清除协议展示并最多自动重试一次纯文本主演模式。纯文本模式直接收完整正文，随后仍运行场记及拍后旁路，但不伪造工具调用。
- `beat_plan` 与首次正文写入强制分轮；同一模型轮只允许一次正文写入/修改；检索最多三次。
- 正文变化会重新打开封笔并废弃旧账本 patch；编辑重新经过格式、段落和单拍边界门禁。
- 用户明确的时间/地点推进由 `transitionAuthorized` 统一作用于计划、正文收稿和编辑。
- 谢幕不再在 writer 循环内提前生成，而是在 assistant 正文落树、场记、世界和生态结算后读取最终分支状态生成；图片要求由 format plan 决定。
- SessionManager 显式 `branch()` 的下一次 append 保留指定父节点，保证重 Roll 回复是同一 user 下的 sibling。

## 9. 2026-09-18 正文输入与记忆修订

### 正文输入

正文保持既有分支语义：压缩前读取当前分支活跃历史；压缩后读取 `rp-summary`、最近保留正文和必要的有限剧情记忆。原始角色卡 JSON、小说全文和全部世界书不是正文阶段的单独全量输入。

不对正常正文历史增加硬裁剪，因为它会改变连续性和分支恢复语义。引擎在 assistant details 写入 `rpInputComposition`，包括：

- `systemChars`
- `summaryChars`
- `historyChars`
- `injectionChars`
- `latestUserChars`
- `toolSchemaChars`
- `initialChars`

这是一项可观测性记录，不是新的正文输入门禁。

### 记忆可靠性

- 压缩归档和压缩 envelope 事件先写入记忆库，再追加 `rp-summary`，避免摘要推进叶后触发自取消。
- 周期记忆按完整 `everyNTurns` 窗口保存，并为每个块携带 entry、字符区间、拍序和分支叶来源。
- narrative digest、event、evidence 的读改写共享 keyed lock；SQLite 使用 `(scope_id, store_id, id)` 复合主键。
- 事件召回后，台上和助手都可继续回读 Session Tree evidence；搜索、列表和弧线召回均遵守当前祖先链。
- 旧数据缺少 `sourceRefs` 时只能兼容读取，不能凭空推断它属于哪个分支。
