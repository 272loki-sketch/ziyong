# Novel Play 维护与故障复盘

本文记录梨园 Novel Play 从不可用到当前可玩的实现过程，重点记录后续维护不能重复踩的坑。它不是用户操作说明；用户入口和当前功能以 [`NOVEL-PLAY.md`](NOVEL-PLAY.md) 为准。

## 1. 目标与玩法模型

Novel Play 不是第二套聊天引擎，也不是把整本小说全文塞给 writer。它把：

```text
原文 -> 可验证事件作品包 -> 开演卡 -> 原有 StageEngine
```

接管原有会话系统。

主要玩法有两个：

1. 接管原著角色：玩家知道原著剧情，可以看到当前节点附近的原著走向，并自行决定贴合或改写。
2. 断更续写：从导入文本真实 EOF 之后开始，后续不存在原著候选，全部由当前分支和用户选择原创。

不要把这两种玩法用一个“防剧透”策略处理。剧透限制是对新角色沉浸模式的默认保护；原著角色模式本来就是玩家知道原著的玩法。

## 2. 三套资料必须分开

### 2.1 事件作品包

路径：`.liyuan/novel-play/packages/`

内容：

- 完整 source chunks；
- stages；
- public/secret nodes；
- sourceRefs；
- dependsOn；
- canonical revision。

这是原著事件候选的不可变版本。人物资料更新不能修改它，否则会破坏事件 revision、旧卡绑定和 checkpoint 复用。

### 2.2 人物资料库

路径：`.liyuan/novel-play/profiles/`

这是可增量更新的资料层，不是事实状态。完整人物资料可以综合整部小说中该人物的剧情弧；它用于角色塑形，不用于向当前分支宣告后文事件。每个 chunk 可以独立提取人物条目，保存：

- 人物名和 keys；
- 结构化角色卡 JSON；
- evidence quote 和 chunk offsets；
- firstSeenChunk / lastSeenChunk；
- completedChunks。

人物资料最终写进 `character_book`，但人物条目必须是：

```text
constant=false
selective=true
keys=姓名/别名/称呼
```

这才是实教卡中蓝灯/绿灯世界书思路的正确适配：全书人物可以提前写入，但只有正文命中人物关键词才进 writer 上下文。

### 2.3 Session Tree

用户实际做出的选择、已经发生的剧情、`rp-state`、世界状态、生态和记忆仍只在原有 Session Tree/权威状态中。人物资料库不能代替当前事实，原著候选不能代替当前事实。

## 3. 人物资料提取规则

人物画像 Skill 位于：

```text
skills/小说人物画像提取/SKILL.md
```

它参考 TavernWeave `tavern-card-builder` 的方法，不是机械复刻实教卡：

```text
原文片段
 -> 原子人物结论
 -> 一个职责清晰的 worldbook entry
 -> 可回查 evidence quote
```

允许的角色资料层按题材调整：

- 基本信息；
- 背景；
- 外貌；
- 表象性格；
- 内核性格；
- 真实能力；
- 行为模式；
- 说话风格；
- 关系与当前状态；
- 题材专属层，例如境界、派系、技术权限、职务制度。

禁止写入人物画像正文：

- 知情边界；
- 系统规则；
- 运行时指令；
- CoT/提示词；
- future/candidate/activation/recipient 等开发字段；
- 后文剧情命令。

允许画像读取完整人物弧线，但画像正文只能归纳稳定人物特征；具体事件顺序、身份揭示、结局和未来时间线仍属于事件作品包/当前分支校准，不写入人物画像。

场记结算也会读取角色卡/世界书的人物身份基线：正文中出现端茶、叩门、巡夜等动作时，只记录动作和当前处境，不得据动作把已确认人物改写成女仆、侍女或陌生人。旧分支已经写入的错误 `rp-state` 不自动回写，需回档或追加纠正快照。

小说卡启动时会从卡内人物画像生成独立世界书 `assets/lorebooks/novel-play-<docId>.json` 并追加到当前配置的 `lorebooks`。该文件是可见的资料产物，条目仍保持 `constant=false`、`selective=true`；卡内 `character_book` 不删除，作为兼容和恢复来源。

允许画像读取完整人物弧线，但画像正文只能归纳稳定人物特征；具体事件顺序、身份揭示、结局和未来时间线仍属于事件作品包/当前分支校准，不写入人物画像。

TypeScript 只做 schema、长度、顶层人物名和证据定位校验，不自行编写性格。

## 4. 增量更新

事件作品包现在支持保守的 append-only successor：新版 Corpus 文档保留 `workId`、`parentDocId`、`sourceVersion` 和清洗正文 fingerprint；digest 保存冻结 layout，能逐字复用的旧块摘要直接继承。Novel Package successor 保存 lineage，旧节点 ID 和旧证据不改，只对新增分块调用 `小说续更事件提取` Skill。旧版本和旧卡永远不可变。

当前安全边界：新版必须是旧版清洗正文的逐字前缀追加，并且旧作品包的分块文本必须逐块保持不变。分块边界改变时拒绝自动追加，不做不可靠的 offset 映射。

当前人物资料构建 API：

```http
POST /api/novel-play/profiles
{
  "docId": "...",
  "revision": "..."
}
```

任务与普通 Novel Play build 共享状态查询：

```http
GET /api/novel-play/status/:jobId
```

每个 chunk 的处理顺序：

1. 读取现有 corpus；
2. 跳过已经完成的 chunk；
3. 调模型提取该 chunk 人物资料；
4. 每个引句在该 chunk 内校验唯一定位；
5. 合并人物名、keys、content 和 evidence；
6. 保存 corpus；
7. 更新 progress。

后续需要继续完善的增量字段是 `chunkFingerprints`。当前已保存的 corpus 用 completedChunks 断点；小说源文本发生中间修改时，必须增加 chunk fingerprint 比较，清理失效 chunk evidence，再重跑变更块。

不要重新构建事件作品包来更新人物资料。两者成本和版本语义不同。

## 5. 卡更新流程

API：

```http
POST /api/novel-play/profiles/apply
{
  "card": "assets/cards/novel-play-....json",
  "docId": "...",
  "revision": "..."
}
```

更新逻辑：

- 校验卡位于 `assets/cards/`；
- 校验卡扩展绑定指定 doc/revision；
- 保留开场定位、常驻开场事实和其他非画像条目；
- 删除旧的画像区间条目；
- 写入最新人物条目；
- 原子替换卡文件；
- 不修改 Session Tree、聊天正文或配置密钥。

当前实现用 `insertion_order >= 120` 区分画像区间。这是过渡约定；长期应在卡扩展中记录 `profileCorpusRevision` 或给画像条目加入明确来源标记，避免用户手工添加高 order 条目时误删。

## 6. 原著提示栏

原著提示栏不是人物资料库，也不是正文事实。服务在 WS `hello` 下发 `novelGuide`：

- 原著角色 + node：默认显示附近公开候选；
- 新角色 + node：默认关闭；
- source-end：显示无原著后续；
- 候选按钮只是填充用户输入，不直接写状态；
- 用户修改后当前分支优先，不强行拉回原著。

如果需要把“按原著推进”从用户文本升级为结构化意图，应新增一个用户侧 intent/projection 字段，不能把提示候选直接写入 `rp-state` 或 `rp-novel-play`。

## 7. 关键故障复盘

### 7.1 `gpt-5.6-sol` 预算耗尽

现象：流式、非流式、工具请求都在约几十秒后返回 `429 budget_exceeded`，没有 delta。

结论：不是世界书或 Novel Play 上下文缺失，是 provider 预算问题。

处理：切换到 `new/vertex_ai/gemini-3.7-flash`，并用最小非流式、流式和工具请求探测。

### 7.2 Gemini 3.7 Flash 接受 tools 但不返回 toolCall

现象：端点接受 tools 字段，却只返回普通文本。

处理：声明 `compat.supportsTools=false`，走纯文本主演模式。不要假装工具调用成功。

### 7.3 纯文本模式夹带状态格式

现象：模型返回 `<content>...</content>` 或状态/HTML 尾巴，稿纸拒收或被整体剥空。

处理：纯文本收稿前展开已知正文容器，再用 `extractDraftBody` 分离正文和格式尾巴；加入 StageEngine 回归测试。

### 7.4 Novel Play 卡缺少世界书

现象：独立挂载书保留，但生成卡没有 `character_book`。

处理：把开场证据验证的定位、公开人物、公开世界事实写入卡内世界书；后来进一步加入全书人物资料关键词条目。

### 7.5 开场只有一句“订婚仪式即将开幕”

现象：原文开场引文合法但过短，用户看到像摘要而不是小说开场。

处理：`first_mes` 必须使用作品包 source 中可回查的连续原文节选；不能用模型概括或手工拼写替代原文。

### 7.6 配置是植物人妻子但内容是实教

现象：`liyuan.config.json.card` 已指向 Novel Play 卡，但运行时复用了旧实教 Session Tree。

处理：检查 config card、runtime `memoryScope.card`、Session Tree `rp-card` 和 WS hello 四处绑定；通过正常切卡创建新会话，不只修改配置文件。旧会话没有删除，当前卡与当前会话重新对齐。

### 7.7 人物画像预览看起来“没反应”

现象：开场提取之后还有第二次人物画像模型调用，前端只有“正在提取开场”的模糊文案。

处理：画像阶段增加 3 次重试和具体 validation error 回喂；前端显示“提取开场并生成结构化人物画像（最长约 5 分钟）”。

### 7.8 全书人物资料任务空输出

现象：单个 chunk 模型空输出或非 JSON，整个人物资料库任务失败。

处理：单 chunk 最多重试 3 次；仍失败时保存空 profile 结果并继续后续 chunk；所有成功 chunk checkpoint 保留。这样必须在报告中标出“该 chunk 无画像资料”，不能静默当作完整证据。

## 8. 维护检查单

改 Novel Play 前先确认：

- 是否误把 Skill 规则写进 TS；
- 是否把全书文本或全量人物条目放进 writer prompt；
- 人物条目是否 `constant=false`、关键词是否准确；
- 条目内容是否有 source evidence；
- 新增人物资料是否会覆盖用户手工世界书；
- source-end 是否错误生成原著未来候选；
- existing-character 是否默认打开原著提示；
- 卡、配置、Session Tree、WS hello 是否绑定同一张卡；
- provider 是否支持 tools/streaming；
- 预览是否有阶段反馈和可恢复重试；
- 旧会话是否被误删或错误复用；
- 事件 package revision 是否保持不变。

## 9. 验收命令

```bash
/opt/node22/bin/node --test test/novel-play*.test.ts
/opt/node22/bin/node --test test/stage-engine.test.ts
npm --prefix web run typecheck
npm --prefix web run build
systemctl status liyuan --no-pager
```

真实回合验收必须同时确认：

- `hello.charName` 和 `hello.userName` 正确；
- Session Tree 的 `rp-card` 与配置卡一致；
- greeting 来自目标小说原文；
- 人物世界书条目是关键词触发而非常驻全量；
- `novelGuide` 模式和定位正确；
- `agent:start`、正文 delta、assistant 落树和 `agent:end` 全部出现。
