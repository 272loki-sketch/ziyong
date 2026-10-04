# PLAN-WORLD-ENGINE：角色卡自适应模块化世界引擎

> 2026-08-16 起稿，2026-08-17 定稿为模块化 v2。本文定义梨园后台世界引擎的**最终形态**：
> 卡级长期画像、分支 Manifest、拍后事实信封、模块化状态、Proposal/Commit、独立审计、后台
> 关键路径分级与两级重 Roll。它是世界引擎相关改动的唯一靶子。
>
> 来源：缝合 [DlSNlGHT/World](https://github.com/DlSNlGHT/World)（SillyTavern「世界引擎 + 记忆引擎」）
> 的世界推演部分。缝合原则：**状态进分支树、规则进 Skill、代码只做编排与安全门禁**。

## 1. 要解决什么

原流程里世界只在**主演写到**时才动；势力、风声、声誉、经济等「场外世界」全靠演员脑补，
且一拍之内正文 → 记账 → 世界**耦合**——正文一旦重写，账本/世界/状态栏全要跟着重来。

本文引入四件事：

1. **卡级长期画像**：同一张真实卡形成自己独立、可持续优化、可锁定稳定的世界适配；
2. **后台世界推演**：每拍定稿后让「世界本身」向前走一步，状态存进分支树；
3. **模块化世界状态**：按角色卡 Manifest 只建立需要的模块，不把校园/都市/修仙/TRPG/亲密
   硬塞进一套固定宏观表；
4. **两级重 Roll**：重Roll正文（从 writer 重写，下游重跑）与重Roll状态栏（只重做 `rpCurtain`）。

## 2. 一拍完整流程（骨架，v1.6 现状）

```text
用户输入
  → 拍前关键路径（正文必须等）：
      装配（system + 末端注入，含【世界动态】【鲜活世界】【角色校准】【导演候选】）
      生态 arrival ‖ 条件连续性 → 并行
      Stitches 导演（吸收两者）
  → writer 分段演出（beat_plan → draft_append → draft_seal）
  → 主演记账（world_state_update → rp-state）            [未记则场记旁路]
  → 拍后世界链（与生态 aftermath 并行，模型完成统一叶守卫）：
      事实信封 world-facts → 模块提案 world → 独立审计 world-audit → TS 门禁 → 原子 Commit
  → 独立谢幕格式轮（writer 续跑 → rpCurtain）
  → 长局压缩
```

后台非关键候选（**当前正文不等**）：

```text
角色卡世界画像 world-profile   本拍开始后台分析，下一拍播种
Sogon / Sigon 文学画像         本拍开始后台生成，下一拍采用
生态搜索/全局池/卡池备料        本拍开始后台计算，成熟后被后续拍消费
```

- 拍后世界链与生态 aftermath 并行计算，但分支写入严格串行
  （`rp-world-audit → rp-world-state → rp-ecology-state`），模型回调绝不直接写树。
- 世界 = f(分支)；`/back`、分支、变体切换、重生成各自从自己的最近快照重建。

## 3. 权威边界

```text
Liyuan Session Tree        = 聊天、分支、回复变体和世界线权威
rp-state                   = 角色账本权威（time/location/characters/inventory/flags/plot_threads）
rp-world-state             = 模块化世界权威（ModularWorldState v2；旧 v1 快照内存迁移为 legacy 模块）
rp-world-manifest          = 当前分支采用的卡级适配版本（f(分支)，回档恢复当时版本）
rp-world-audit             = 世界转移审计留痕（提交/拒绝/各阶段失败及原因，不进主演上下文）
rp-ecology-state           = 人物生活、地点活动、日程与可错过事件的分支权威
.liyuan-memory             = 检索记忆
StageEngine                = 唯一正文所有者 + 独立谢幕格式轮唯一时机
rp-curtain-override        = 状态栏重 Roll 覆盖工件（只改展示，不改正文/账本/世界）
.liyuan/world/cards/<key>/profile.json = 卡级长期世界画像（跨会话，gitignore 级数据目录）
```

- **双快照并行**：角色账本与世界模块互不写对方字段；合并发生在「读」侧（装配各取各的）。
- **跨域引用**：世界与生态只交换上一份已提交快照派生的**只读信号**；跨域因果用
  `originRefs` / `kernel.links` 引用，不复制人物、地点、occurrence、制度或宏观状态。
- 制度日历仍是世界模块记录，NPC 当前日程与具体活动仍是生态 actor/occurrence；公开传播只是既有
  事实的投影。不得因外部日历或后台世界插件引入第二套时间、人物、事件或舆情权威。
- 自定义历法以 `institution-calendar/calendar-definition` 记录表达；当前日期始终从 `rp-state.time`
  解析。代码只负责历法校验、日期算术、区间/年度重复展开和秘密过滤，模型不能直接维护日历投影。

## 4. 模块化世界状态（src/stage/literary-world-modular.ts）

```ts
interface ModularWorldState {
  version: 2;
  round: number;
  digest: string;
  kernel: {
    cardKey?: string;             // 当前卡身份
    manifestRevision?: number;    // 采用的卡级画像版本
    lastAuditHash?: string;       // 上拍审计哈希
    links: WorldKernelLink[];     // 跨模块/跨域引用
  };
  modules: Record<string, GenericWorldModuleState>;
}

interface GenericWorldModuleState {
  id: string;                     // 与 Manifest module.id 相同
  kind: WorldModuleKind;          // institution/social/infrastructure/rules/objective/
                                  // mystery/strategy/survival/environment/custom/legacy
  revision: number;               // 仅模块实际变化时 +1
  summary: string;
  records: WorldModuleRecord[];   // 统一受限记录（facet/status/visibility/attributes/originRefs）
}
```

限制统一在 normalize 层：最多 16 模块、每模块 80 记录、attributes ≤24 键、
links ≤120、ID 稳定、模块 `id/kind` 不允许模型在转移中修改。

### 旧 v1 兼容

- `LiteraryWorldState v1` 保留为**派生兼容投影**（`projectLiteraryWorldV1`），供旧世界卡、
  状态栏和旧调用方读取。
- 读取旧 v1 快照时**内存确定性迁移**为 `legacy-events / legacy-organizations /
  legacy-information / legacy-macro / legacy-secrets` 五个 legacy 模块。
- 下一次成功提交才写 v2 `rp-world-state`；旧会话无需批量迁移，分支内 v1/v2 可并存。

### 模块类型与 Skill 包

画像为每个模块声明 `kind / skillPack / cadence`。内置领域包：

| kind | 典型模块 id | 适合场景 |
|---|---|---|
| institution | `institution-calendar` | 校园校历、轮班、门禁、制度期限 |
| social | `public-information` `reputation-social` `relationship-dynamics` `household-routine` | 消息、圈层评价、NPC 关系、共同生活 |
| infrastructure | `infrastructure-city` `economy-market` | 城市交通、机构响应、市场供需、物流 |
| rules | `cultivation-system` `magic-system` `technology-system` `mechanics-resolution` `combat-tactical` | 修炼、魔法、科技、TRPG 检定、战斗 |
| objective | `quest-objective` | 任务、委托、期限、可干预窗口 |
| mystery | `mystery-evidence` | 真相、证据、假说、渐进揭露 |
| strategy | `organization-strategy` `war-front` | 组织项目、外交、战线、长期战略 |
| survival | `survival-pressure` | 饥渴、庇护、物资、环境威胁 |
| environment | `regional-environment` | 季节、天气、灵潮、区域灾害 |
| custom | 未知 id | 角色卡特有持续系统 |
| legacy | `legacy-*` | v1 快照迁移 |

引擎只加载**本拍到期模块**对应的 Skill 包；卡未启用的题材不会进入 prompt。

## 5. 规则 Skill 化（铁律：规则不进 TS）

| Skill（扩展能力 → Skill） | workflow | 角色 |
|---|---|---|
| `角色卡世界画像` | world-profile | 从卡、选中开场、世界书、预设与近期实弹生成卡级长期适配 |
| `世界推演`（用户） | world | 模块化世界转移提案；规则唯一权威在 `.liyuan-stage-skills/世界推演/` |
| `拍后事实信封` | world-facts | 从用户原话、冻结正文、最终账本提取带证据事实与经过时间 |
| `世界转移审计` | world-audit | 独立检查因果、信息边界、时间尺度、模块权限与用户主权 |
| `世界模块-*` | —（world-module: kind） | 各领域演化规则，按到期模块动态装载 |
| `世界模块-通用` | —（custom） | 角色卡特有系统的保守兜底 |

代码只做：prompt 拼装、到期模块路由、解析与钳制、基线哈希/轮次/revision 校验、
分支落树与叶守卫、安全投影。

## 6. 卡级长期画像与分支 Manifest

### 6.1 卡级画像（.liyuan/world/cards/<key>/profile.json）

- `cardKey` 由角色卡**内容身份**（name/description/personality/scenario/tags/book 等）哈希生成，
  移动文件或项目迁移仍能复用；兼容旧路径哈希读取。
- 画像保存：`labels / primaryScale / defaultTimeStep / worldActivity / modules(含 kind、skillPack、
  mode、cadence、confidence、reason、stateFocus、writerProjection) / disabledModules /
  userRequirements / optimizationNotes / unresolvedQuestions / evidence / status(draft|stable)`。
- **持续优化**：`draft` 状态每 8 个完成叙事拍结合近期实弹重新分析；`stable` 停止自动重建，
  直到用户主动“重新分析适配”。
- **用户主权**：`userRequirements` 是并集保留，模型不能删除已钉死要求；`optimizationNotes`
  记录实弹调节，重分析继续参考。

### 6.2 分支 Manifest（rp-world-manifest）

- `Manifest = f(分支)`：同一卡不同开场/世界书/预设组合由 `playKey` 区分玩法槽。
- 回档后继续演出不被卡级最新画像静默覆盖；新分支无 Manifest 时才从画像播种。
- 用户在设置面板“重新分析适配”才明示向当前分支追加新版本。

### 6.3 关键路径分级

- **正文必须等**：素材/分支快照、生态 arrival、条件连续性、Stitches 导演、writer 演出、记账谢幕。
- **后台、下一拍生效**：Sogon/Sigon 文学画像、角色卡世界画像、生态双池备料。
- **拍后、不影响正文首字**：事实信封 → 模块提案 → 审计 → 世界 Commit → 生态 aftermath → 压缩
  （当前仍在 `agent end` 前结算，保证下拍读到完整分支）。

## 7. 世界转移（Proposal → Audit → Commit）

```text
定稿正文 + 最终 rp-state
  → world-facts：BeatFactEnvelope（facts/evidence/elapsed/trigger/uncertainties）
  → due modules 按 cadence 筛选 → 只拼到期模块 Skill
  → world：ModularWorldTransitionProposal（moduleChanges 引用 factIds + 到期 moduleId）
  → TS 预审：base hash / base round / module revision / cadence / 事实存在 / 未使用计划
  → world-audit：独立语义审计（只能批准或拒绝，不能改提案）
  → TS 终审 → 原子 commit（round+1、变更模块 revision+1、记 lastAuditHash）
  → rp-world-audit 留痕 → rp-world-state
```

确定性门禁（TS）：

- `baseRound` 与 `baseStateHash` 必须匹配；
- 只允许 `dueWorldModules()` 返回的 active 模块；
- 每个变化引用已发生事实（`intent/plan/hypothesis` 不得驱动世界）；
- `nextModule.id/kind` 与 Manifest 和旧状态一致；
- 未列出的模块逐字节不变；`stable` 禁止任何模块/链接变化；
- 全部模块解析通过后一次提交，禁止部分成功。

## 8. 两级重 Roll

- **重Roll正文**：复用 `details.rpPrep` 从 writer 直接重写；下游记账、世界链、生态、状态栏重跑；
  旧回复保留为 sibling 变体，`rp-state / rp-world-state / rp-world-audit / rp-ecology-state`
  都随分支恢复。新变体不复用旧事实信封/提案/审计。
- **重Roll状态栏**：只重做 `rpCurtain`，写 `rp-curtain-override`；正文/账本/世界/审计均不动；
  残缺输出拒绝覆盖且不自动重试。

## 9. 失败语义（诚实原则，fail closed）

| 场景 | 行为 |
|---|---|
| 画像/事实/提案/审计任一失败或不可解析 | 保留上一世界快照；落对应 `rp-world-audit` 状态 |
| 模块越权 / cadence 未满足 / hash 不匹配 | 确定性拒绝提案，不调审计或拒绝后不提交 |
| 生成期间切分支 | 叶守卫整体丢弃（正文/账本/世界/生态都不误写） |
| 状态栏重 Roll 残缺 | 保留旧状态栏，通知手动重试 |
| 正文重 Roll 无可用工件 | 通知并退回完整重跑 |
| 任何阶段 | 不自动循环重试，token 只由用户操作触发 |

## 10. 前端形态

一条最新回复下方：

- 正文 + `重Roll正文` / `重Roll状态栏` 两个明确按钮；
- **世界模块卡**（默认折叠）：按 Manifest 顺序列出活跃模块；公开记录直接显示、
  可探索记录折叠、秘密只显示数量；每模块显示 revision；审计状态与 warning 可见；
- 无 v2 视图时回退旧 v1 世界卡；
- **世界画像管理**（设置面板「角色卡世界适配」）：首次分析/重新分析、锁定稳定、
  后台活跃度、逐模块切换 active/observe/suspended、清空某模块当前分支运行态、
  维护长期要求与实弹优化记录、查看待确认问题。

## 11. 落点清单

| 面 | 落点 |
|---|---|
| 卡级画像/Manifest | `src/stage/literary-world-profile.ts`（worldCardKey/画像/指纹/playKey） |
| 模块化状态 | `src/stage/literary-world-modular.ts`（v2/迁移/投影/wire view/注入） |
| 世界转移 | `src/stage/literary-world-transition.ts`（事实信封/提案/审计/原子 commit） |
| 跨域信号 | `src/stage/literary-world-signals.ts`（world⇄ecology 只读信号） |
| 旧 v1 类型 | `src/stage/literary-world.ts`（LiteraryWorldState + 兼容解析） |
| 编排 | `src/stage/engine.ts`（#turn 关键路径 + 后台 prep/ready + 拍后链 + 叶守卫） |
| Skill 槽 | `src/stage/skill-store.ts`（workflow + world-module 元数据） |
| 模型插头 | `src/model-routing.ts`（literaryWorld / worldProfile / literaryWorldFacts / literaryWorldAudit） |
| REST | `server/rest.ts`（/api/world-profile、/api/world-state） |
| wire | `server/wire.ts`（world / worldModules / worldAudit） |
| 前端 | `web/src/components/Messages.tsx`（模块卡）；`WorldProfileSection.tsx`（画像管理）；`SkillLibrary.tsx` |
| 规则 | `skills/`（内置）+ `.liyuan-stage-skills/`（用户覆盖，gitignore） |
| 测试 | `test/literary-world*.test.ts` 系列 |

## 12. 历史与迭代记录

- **第一阶段（08-17）**：卡级长期画像 + 分支 Manifest + 首次自动适配。
- **第二阶段（08-17）**：拍后事实信封、受 Manifest 约束的世界提案、独立审计、fail closed。
- **第三阶段（08-17）**：模块化 `rp-world-state v2`、v1 迁移与兼容投影、动态模块 Skill 路由、
  世界/生态跨域信号、动态前端模块卡、REST 管理。
- **关键路径分级（08-17）**：画像/双池移出正文关键路径；writer 固定叶守卫；队列按会话/卡
  绑定；生态双池拆 running/ready 并串行写盘；停止拍时取消队列。

## 13. 后续候选（暂不做，记录方向）

- 把「正文完成」与「后台结算完成」拆成两个 UI 状态，让输入框在正文完成后立即可用
  （需要 pending commit 与拍间依赖，不能只丢 Promise）。
- ~~记忆引擎（实体记忆 / 两级纪要）暂未缝合~~ **已缝合（2026-08-26）**：两级纪要 +
  证据召回记忆系统落盘为 `docs/PLAN-RP-MEMORY.md`；世界链的记忆边界仍以
  rp-world-state 为权威，事件卡只做检索投影 + 原文锚定，不改变世界权威。
- 更多题材模块：按 `skills/世界模块-*/` 模式新增，无需改核心 Schema。
