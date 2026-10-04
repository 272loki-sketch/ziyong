# 小说开演

## 当前状态

Novel Play 已接入导演室、藏书消化、REST、WebSocket 和 StageEngine。当前实现支持：

- 新角色进入原著节点；
- 接管原著角色进行游玩；
- 从公开节点之前/之后开演；
- 从导入文本真实 EOF 之后继续原创剧情；
- 原文开场白与叙述/对白语料提取；
- 按角色卡世界书方法生成结构化人物资料；
- 全书人物资料库的分块断点提取；
- 人物画像以关键词世界书条目写入卡，不常驻全量注入；完整人物资料任务可以读取整部小说中该人物的剧情弧，用于归纳稳定性格、行为模式、说话方式、能力边界和长期关系模式。它是角色塑形参考，不是当前分支事实，不应把后文事件、身份揭示或结局直接写进正文。
- 原著角色模式下的悬浮“原著走向提示”。
- 旧小说完整新版的 append-only 追加版本、追加事件作品包和当前分支升级。
- 当前原著节点的同场事件召回：同一 stage 的公开事件会以候选事件组交给导演、场面编排和主演，并携带受限原文证据。
- 小说卡生成后会创建并挂载独立人物世界书：`assets/lorebooks/novel-play-<docId>.json`；卡内 `character_book` 仍保留同一份资料作为兼容来源。

当前真实目标作品已验证：

- 文档：`20260919-180837-植物人妻子别偷听我的心声了`
- 文档 ID：`doc-fc86e980f74f1a15`
- 作品包 revision：`2ab57f6fb6f7c77ebf390213bbfc48253bc7413c69f14b0052262831c09a6540`
- 事件节点：717 个，原文分块：84 个
- 当前玩家模式：接管原著角色
- 当前玩家：维斯
- 当前节点：`阿黛尔给维斯艾露涅房间钥匙安排同住`
- 当前定位：节点之前
- 当前卡：`assets/cards/novel-play-e60eda06-06cb-4b8f-b065-64a4cf438481.json`

最近回归：Novel Play `87/87`，StageEngine `68/68`，前端 typecheck/build 通过。真实模型回合已经验证出现 `hello`、`agent:start`、正文 delta、正文收稿、记账和 `agent:end`。

## 使用流程

1. 在导演室“藏书消化”导入小说，等待 `ready`。
2. 打开“小说开演”，构建作品包。作品包构建按 chunk checkpoint，可取消、重试、续跑。
3. 选择玩家模式：创建新角色，或接管原著角色。
4. 选择开演位置：公开节点之前/之后，或导入原文真实终点之后。
5. 生成有界预览。预览包含原文开场、时间地点、公开资料、短语料和人物世界书画像。
6. 确认一次性预览令牌，服务创建独立内部卡并切换新会话。
7. 接管原著角色且使用节点模式时，主对话右上角显示“原著走向提示”。该提示只给玩家看，不当作角色已知事实。

### 两种主要玩法

#### 接管原著角色

适用于玩家知道原著剧情、希望边看原著走向边修改剧情的玩法。原著提示默认开启，显示当前节点附近的公开候选；用户可以按原著推进，也可以把修改意见写入下一条用户输入。

#### 断更续写

选择“导入原文终点之后”。服务使用原文真实 EOF，不使用最后一个事件节点冒充结尾。此模式没有原著未来候选，面板只显示“后续为原创续写”。

### 会话切换注意

Novel Play 每次创建独立卡和独立会话。切换卡时服务必须同时刷新配置卡、运行时卡和 Session Tree；否则可能出现“配置显示植物人妻子、实际会话仍显示实教”的错绑现象。历史会话文件不会因切卡自动删除，但会按当前卡过滤显示。

## 权威边界

- `src/novel-play/source.ts`：复用 CorpusEngine 的清洗分块与 UTF-16 证据坐标。
- `src/novel-play/extract.ts`：只负责事件节点提取、顺序、依赖、quote 校验。
- `src/novel-play/store.ts`：保存不可变原文版本包；作品包不因人物资料更新而改变。
- `src/novel-play/opening.ts`：按节点 cutoff 或 source-end 提取开场资料、原文语料，并校验人物画像证据。
- `src/novel-play/profile-service.ts`：全书人物资料库分块提取、重试和 checkpoint。
- `src/novel-play/profile-store.ts`：人物资料库独立持久化，不污染 immutable event package。
- `src/novel-play/card.ts`：生成内部 V2 卡与关键词世界书条目。
- `src/novel-play/runtime.ts`：节点模式的原著候选、source-end bypass、确定性开演上下文。
- `server/novel-play-api.ts`：构建、人物资料任务、预览、启动和恢复锁。
- `server/main.ts` / `server/wire.ts`：WS hello 中的原著提示投影。
- `web/src/components/NovelGuidePanel.tsx`：玩家侧原著走向悬浮栏。

剧情唯一事实仍是 Session Tree、`rp-state`、世界状态和生态状态。人物资料和原著候选是写作参考，不是第二套事实库。原著提示也不代表角色在故事内知道后续。

## 人物资料库

人物资料库的正确模型不是“隐藏后期资料”，而是“全书提前生成、世界书按关键词触发”：

```text
全书原文 chunk
  -> gemini-3.7-flash 按小说人物画像 Skill 提取
  -> 原子人物结论 + evidence quote
  -> 一个人物一个 character_book 条目
  -> constant=false、selective=true、keys=姓名/别名
  -> 正文命中人物关键词时注入
```

当前目标作品的资料库已完成 84/84 chunk、79 个人物条目。资料库路径位于 `.liyuan/novel-play/profiles/`，是运行数据，不应提交或手工覆盖。

画像 Skill 参考 TavernWeave 的角色卡工程方法：来源片段 -> 原子结论 -> 世界书条目 -> 可回查证据；参考实教卡的结构化分层，但按小说题材自适应。画像正文不写知情边界、系统规则、CoT、运行时指令或未来剧情命令。

## 原著提示栏

原著提示栏由 WS `hello.novelGuide` 投影：

- `existing-character + node`：默认显示当前节点及附近公开候选；
- `new-character + node`：默认不显示，可后续增加手动开关；
- `source-end`：不显示候选，只说明后续为原创；
- “按此方向推进”只是给用户填入一条明确的本拍意图；不会直接写入事实；
- “我要修改这一节点”把修改意图交还用户编辑；
- 提示内容不进入角色历史，不伪装成角色知识。

## API

- `POST /api/novel-play/build`
- `POST /api/novel-play/profiles`
- `POST /api/novel-play/profiles/apply`
- `GET /api/novel-play/status`
- `GET /api/novel-play/status/:jobId`
- `DELETE /api/novel-play/status/:jobId`
- `GET /api/novel-play/start?docId=...&revision=...`
- `POST /api/novel-play/preview`
- `POST /api/novel-play/start`
- `POST /api/novel-play/extend`：基于旧作品包构建逐字追加版作品包；旧包不可变
- `POST /api/novel-play/upgrade/preview`：预览当前分支采用追加版
- `POST /api/novel-play/upgrade/commit`：只在当前 Session Tree 追加升级条目，不切卡、不新建会话
- `GET /api/novel-play/packages`：读取持久化作品包版本索引

## 作品更新与续玩

后续小说更新时，不要覆盖旧文件，也不要删除旧小说卡或旧会话。请上传**包含旧全文和新增章节的完整新版文件**，在藏书消化页选择旧文档的“上传追加版”。系统会先验证新版清洗正文是否以旧正文逐字开头；验证通过后创建新的 Corpus 文档和不可变作品包，旧文档、旧作品包、旧卡和旧游玩记录都保留。

追加版只在旧分块边界保持不变时自动构建。若旧分块边界发生变化，系统会拒绝增量构建，而不会猜测迁移证据；此时应保留旧版本，另行人工处理。作品包索引持久化在 `.liyuan/novel-play/package-index.json`，服务重启后会从已有不可变 package 文件回填索引。

构建新作品包后，旧小说会话默认仍使用旧版。需要让当前分支采用新版时，调用升级预览并确认升级。升级预览返回一次性 token，绑定当前 session、角色卡、leaf 和来源 revision；提交时任一绑定变化都会拒绝。升级写入 `rp-novel-play-upgrade` Session Tree 条目：卡路径、Session ID、正文、`rp-state`、世界状态和记忆 scope 都不变；回档到升级条目前会自动回到旧版。原文终点后的原创线默认不自动吸收新原著；用户明确执行升级时，系统才从新版第一个公开新增节点之前开始提供候选，并保留已经发生的原创剧情，不强行回轨。

### 场景与人物边界

- 用户本拍明确输入优先。如果用户说“几个人在窗外偷窥”，系统保留“几个人、窗外、偷窥”的粒度；没有身份证据时不得擅自命名。
- 如果原著同场事件或角色卡资料明确给出人物身份，导演和主演应优先使用已确认身份，不得把妮菲尔等已知人物泛化成陌生人或改写成未经证实的职业。
- 同场事件组全部是候选，不是事实；是否被玩家发现、如何反应，仍由当前正文和用户选择决定。
- 旧分支已经写入的错误 `rp-state` 不会被服务重启自动删除。修复代码只阻止后续继续扩大错误；纠正旧历史必须回档或追加明确状态纠正。

## 限额与恢复

- 构建和人物资料均按 chunk 串行，最多两个后台任务；每 chunk 完成后落 checkpoint。
- 作品包构建总期限 4 小时；预览期限 5 分钟；模型单次旁路期限 120 秒。
- 人物资料每 chunk 最多 3 次模型尝试；空输出或坏 JSON 不应拖死后续 chunk，会作为无资料 chunk checkpoint 后继续。
- 预览令牌 10 分钟有效且单次使用；切卡启动最多等待 30 秒。
- 服务重启后，进程内任务/令牌消失，但作品包、事件 checkpoint 和人物资料 checkpoint 保留。
- 写卡更新必须原子替换；失败不得删除当前卡或覆盖外部配置。
- 当前卡与当前会话不一致时，先切普通卡再重新开演；不要手改配置绕过启动锁。

## 常见故障

### 点击预览没有反应

预览现在至少包含两次模型调用：开场证据提取、人物画像提取。前端按钮会显示“正在提取开场并生成结构化人物画像（最长约 5 分钟）”。若返回错误，先看具体 evidence quote 校验错误，不要连续重复点击触发限流。

### 内容显示成另一张卡

检查三处是否一致：`liyuan.config.json.card`、WS `hello.charName`、当前会话的 `rp-card`。如果配置卡与运行时会话卡不一致，必须通过 `/api/card/switch` 或 UI 正常切卡；不能只改配置文件。

### 原文开场变成一句摘要

`first_mes` 必须是作品包 source 的连续原文子串。若模型只选出“订婚仪式即将开幕”这种短句，应重新修正开场，不要把模型概括当作原文。可以用作品包 source 做 `includes(first_mes)` 校验。

### 人物资料全量污染上下文

检查人物条目必须满足 `constant=false`、`selective=true`，并有姓名/别名 keys。不要把人物画像放进常驻 system 或把所有画像拼到 `description`。

## 验证命令

```bash
/opt/node22/bin/node --test test/novel-play*.test.ts
/opt/node22/bin/node --test test/stage-engine.test.ts
npm --prefix web run typecheck
npm --prefix web run build
systemctl status liyuan --no-pager
```

真实验收必须同时看到：

- `hello` 角色名和玩家名正确；
- `novelGuide` 模式/定位正确；
- 原文 greeting 正确；
- 人物世界书条目命中方式正确；
- `agent:start`；
- 正文 delta；
- assistant 正文落树；
- `agent:end`。
