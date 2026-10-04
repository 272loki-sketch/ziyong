# ziyong

个人自用修改版，不是上游官方发布。基于 [上游项目](https://github.com/weidu12123/Liyuan) 及其组件修改，保留原有许可证与来源说明；下方保留上游项目的功能介绍。公开源码仍可能被代码检索，仓库命名不构成隐私保护。

** AI Agent 为主体的角色扮演应用** 

![梨园主界面](docs/images/home.png)

当前发布基线：**v1.7.4**。目标公开仓库：[`272loki-sketch/ziyong`](https://github.com/272loki-sketch/ziyong)。

---

## 梨园是什么

梨园是一款以rp agent为主体的角色扮演应用， 以AI agent为主演，将agent的各种功能rp化，力求为用户提供良好的角色扮演体验。


##梨园的创新点

1.记忆优化——通过修改harness从源头拔高记忆的上限
上下文是rp（角色扮演）中最重要的资源没有之一，而传统ai角色扮演会将整个过程中的所有过程全部放在上下文，对于ai编程，这是正向提升，但对于rp，中间的各种冗余会严重占用上下文并降低模型智商，而引入harness后，我们能够在harness层面直接将中间的各种操作过滤，在架构层每轮重新剪裁上下文，让模型最后看到的只保留叙事正文于各种快照，数据库等等，过程性内容在代码层被确定性裁掉，实测每轮省 53%–63%。同样的窗口，有效剧情容量翻倍，直接从源头拔高上限。

完整的记忆大致是四层结构：纯净上下文（工作记忆）→ 结构化账本（旁侧模型每轮自动记账：物品、好感、时间、伏笔，快照随剧情走）→ 检索资产（世界书+知识库，用时才取，不占窗口）→ 剧情化压缩（按叙事逻辑生成前情提要，压缩也压得懂剧情）。


2.agent询问模式的引入——让用户深度参与并决定剧情走向
在coding agent 中大多数都有这样一种模式，agent在做出操作例如删文件前会停下来问你。而梨园把这套东西翻译进了 RP：重要新角色如何定型、关键设定定死、难以回头的重大转折（死亡、背叛、关系质变）等等的情况下，agent 会停笔，在上下文里弹出一张选择卡：它构思的几个方向、一个自由输入框（你自己写走向）。选完剧情按你定的走，卡片永久留痕，日后回看每个岔路口都清清楚楚。

这个功能主要解决的是传统 RP 里只能不停的拆盲盒，通过不停的重新roll来祈祷ai生成一个优质且满意的剧情。梨园直接让用户深度参与，决定走向。

3.面板——让ai自己生成各种面板来优化体验

梨园直接把前端操作权交给 agent，agent能够生成各种面板导入面板板块，并且随着后续的扮演而实时更新。玩rpg类型的卡时，让自己建一间装备库；地图复杂时，让ai画一张 SVG 地图，走一步更新一步，让扮演不再停留于想象，直接可视化。


4.扩展——agent的经典能力skill与mcp
既然是agent那就自然少不了经典的skill于mcp了，不同于传统ai扮演的各种复杂扩展，因为引入了agent，各种复杂的扩展能力都能够很简单的实现。
例如文生图，传统的插件很复杂，得想各种办法在上下文中抠出关键词，得调试各种接口。而引入了agent后，他可能变成了很简单的一句话，帮我调用哪个api根据上下文内容来生成哪个角色的图片，并打包为skill。


5.世界线——包括回档 分支各种能力，体验一张卡在不同选择下的不同结局
传统的ai扮演想要体会不同的结局的做法只有重开或翻旧楼层改写（状态全乱）。

梨园给的是游戏级存档：/store 钉存档，/back 回档，/line 看世界线全景。关键在于回档回的是整个世界——剧情正文、状态账本、agent 建的地图和装备库、知识库挂载，全部一致地回到那个时间点。桌上的信物从正文和账本里同步消失，地图回到你还没探开的样子。

而且存档零损耗：哪怕经历过上下文压缩，回到压缩前的存档，上下文自动恢复为未压缩的全量原文——压缩留在旧分支上，不跟过来。同一张卡，活出完全不同的结局。

6.知识库——自定义知识库，随时填充随时挂载
自定义知识库，由agent和用户共同创建，用户可以自行修改也可以在扮演过程中让agent随时将上下文中出现的新奇设定随时写入

7.素材库——储存你输入的和ai生成的各种文件 图片等素材
因为是agent，他具有后端的各种能力，那么在这个前提下，我们可以把上传文件和图片给改一下，让内容不进上下文，我们上传到vps的文件夹里面，而消息里只附一行路径，在让agent 知道素材库里有什么的同时不让图片和文件大幅度占用上下文，甚至后续你可以随时拖动素材库里面的图片到输入框发送给agent，你看到的的图片，但其实agent看到的是文件路径。进一步降低上下文占用

8.双 agent 分治——剧情归剧情模型，系统事务归「助手」
传统做法里一个 ai 既要扮演角色又要兼职客服，一句「帮我调下配置」就能把角色拽出戏。梨园把这两件事拆成两个独立 agent：中间的剧情模型只演戏，上下文纯净单一；输入框发送键右侧有一个「助手」按钮，点开在右栏展开独立对话——它运行在自己的会话里，拥有全局视角（能读剧情记录、配置、预设、世界状态账本，甚至能看到剧情模型自己都看不到的原始输出与被裁剪的历史），职责就是保障和优化这场扮演：诊断回复为什么变短/复读/换语言、调配置调预设、修记忆账本、回退重生成、探索外部服务并沉淀成 skill。它受你指挥但绝不代写剧情——你读到的每一个剧情字，永远只出自剧情模型。
助手的模型可以单独指定（默认跟随剧情模型）：剧情尺度较大时给助手换个宽容些的模型，诊断和维护就不会被拒答卡住。在主输入框用 // 开头（或整条括号包裹）说话，也会自动转给助手，不打扰剧情。


**兼容性：

1.角色卡：PNG 卡和 JSON 卡直接导入，卡内嵌的世界书一并读取；

2.世界书：JSON 直接导入，蓝灯 constant / 绿灯关键词激活语义保留，多本挂载。而且是双向的——梨园知识库可以导出回 ST 世界书格式，数据进出都自由，不搞单向锁定；

3.聊天记录：jsonl 旧档直接导入续玩。导入时自动清洗（剥离旧状态栏和思维链，避免带坏文风），旧剧情自动摘要、自动建账——几百楼的老婆可以无缝接到梨园继续过日子；
✅ 预设：直接导入，采样参数照常生效。v1.1.0 新增变量引擎，setvar/getvar 等变量宏、文风开关、思维链模板均生效；预设启用后扮演规则以预设为准。

✅ 正则脚本：显示美化类（状态栏皮肤）导入即生效，卡详情可关；清理修补类无需兼容——harness 层原生完成。
✅ 程序卡 HTML/JS：沙箱帧内直接运行，界面、表单、按钮交互可用，界面内生成已接入剧情总线。卡代码只在浏览器沙箱内运行，不落本机。
❌ 仍不兼容：完整 STscript、界面直接改写正文、依赖酒馆 DOM/主题的前端插件。

另外声明一句：梨园没有使用任何 SillyTavern 代码，全部格式解析按公开规范独立实现。兼容的是数据生态，不是搬运代码。

> 梨园未使用任何 SillyTavern 代码，全部格式解析按公开规范独立实现。

## 快速开始

前置：**Node.js ≥ 22.19.0**，任一 OpenAI 兼容 API Key（如 DeepSeek）。

```bash
cd ziyong   # 若仓库根即本目录则跳过

# 首次：从示例生成本地配置（勿把填了 Key 的文件提交 git / 发给别人）
cp liyuan.agent.example.json liyuan.agent.json
cp liyuan.config.example.json liyuan.config.json
# 编辑 liyuan.agent.json → 填入 apiKey 与模型 id

npm install
npm run web:build   # 首次或前端改动后（已有 web/dist 可跳过）
npm run web         # 起服务；npm run web:new 开新会话
```

- Windows：双击 `start.bat`
- Linux / macOS：`chmod +x start.sh && ./start.sh`
- 浏览器打开控制台打印的地址（默认 `http://127.0.0.1:7620`）；控制台同时打印局域网地址，手机连同一 Wi-Fi 直接访问
- 前端开发：`npm run web:dev`（Vite 热更新，`/ws` 自动代理到 7620）

### 服务器部署（Linux / VPS）

三种方式任选，细节见 [deploy/README.md](deploy/README.md)：

```bash
# 方式 A：一键安装脚本（装成 systemd 服务；需预装 Node.js >= 22.19.0）
curl -fsSL https://raw.githubusercontent.com/272loki-sketch/ziyong/main/deploy/install.sh | bash
# 装好后填 Key：nano /opt/liyuan/liyuan.agent.json，然后 systemctl restart liyuan

# 方式 B：Docker Compose（数据全在卷里，升级重建不丢档）
git clone --depth 1 --branch main https://github.com/272loki-sketch/ziyong.git && cd ziyong
docker compose up -d --build
# 首启会自动生成 ./data/config/liyuan.agent.json，填入 Key 后 docker compose restart
# （也可以直接在网页的连接面板里填，无需改文件）

# 方式 C：手动打包上传（Windows 本机执行，产出免 node_modules 的 zip）
powershell -File scripts/pack-for-linux.ps1
```

**请勿把 7620 端口裸暴露公网**——应用可设置访问密码；公网仍应配置 TLS、反向代理与访问控制。

配置文件分两份：**`liyuan.config.json`** 管角色卡 / 世界书 / 用户身份等（面板里也能改）；**`liyuan.agent.json`** 管模型与 Key（**勿提交仓库**）。旧版 `.rp-*` 目录与 `rp.config.json` 启动时自动迁移。

当前 fork 使用 `origin/main`（发布基线）与 `local`（实际运行分支，跟踪 `origin/local`）。`scripts/update-local.sh` 默认合并 `origin/main`，可用 `LIYUAN_UPSTREAM` 覆写；它只执行备份、拉取、合并、验证及受控重启，不自动推送。远端发布须另外明确授权。详见 [上游同步与发布规约](docs/LOCAL-UPSTREAM-UPDATES.md)。

## 进阶

- **斜杠命令**（Web 输入框直接敲，带补全）：`/state` 账本 · `/lore` 设定检索 · `/import` 导入旧档 · `/store` `/back` `/line` 存档与世界线 · `/rewind` `/branch` 回退与分支 · `/compact` 手动压缩 等；
- **MCP**：分**内置 / 外部**两栏。内置随梨园发布包走（见下条视觉识图）；外部启动时自动扫描 `~/.claude.json`、Cursor 配置、`~/.liyuan/mcp.json`、项目 `.mcp.json` / `.liyuan-mcp.json`。**默认全关**，在「扩展能力 → MCP」按对话开启；开关记为新对话默认；
- **视觉识图（内置 MCP）**：给无视觉能力的主模型补眼睛——把图片交给任意 OpenAI 兼容的视觉模型分析。在「扩展能力 → MCP → 内置 → 视觉识图 → 编辑」的 `env` 里填 `LIYUAN_VISION_BASE_URL` / `LIYUAN_VISION_API_KEY` / `LIYUAN_VISION_MODEL`（须支持图片输入）即可；
- **语音（TTS）**：配置环境变量 `LIYUAN_TTS_BASE_URL` + `LIYUAN_TTS_API_KEY`（或直接用 `OPENAI_API_KEY`）后，agent 可用语音工具朗读；模型与音色用 `LIYUAN_TTS_MODEL` / `LIYUAN_TTS_VOICE` 指定；
- **文学工作流 Skill**（扩展能力 → Skill）：拍前四件套——`文学连续性`、`Sogon角色深度`、`Sigon用户偏好`、`Stitches拍前导演`——加上 `主演分段演出`、`独立谢幕格式` 构成每拍「拍前分析 → 导演 → 分段演出 → 记账 → 独立谢幕」的完整编排；另有三件生态 Skill（`通用叙事原型池` / `角色卡生态池` / `人物与场所生态`）与写作参考类 Skill。正文由同一 agent 分段落笔；格式在封笔后由 agent 重新读取完整卡与预设自行判断生成（不同卡格式不同，白名单与固定标签识别一律不用）。内置 Skill 随 GitHub 更新；你在面板里编辑过的副本落在 `.liyuan-stage-skills/`（已 gitignore），拉取更新不会被覆盖，删掉副本即回到内置版；
- **后台世界引擎**（设置面板「后台世界」开关，默认关）：每张角色卡形成**独立长期适配**——首次分析生成卡级画像（`.liyuan/world/cards/<key>/profile.json`，含尺度、时间步长、活跃度、模块、长期要求、优化记录），draft 状态每 8 拍结合实弹复盘、可锁定 `stable` 停止自动重建；分支 `rp-world-manifest` 钉住当拍采用的版本，回档/变体各自恢复。拍后世界链为「拍后事实信封 → 模块化世界提案 → 独立审计 → 确定性门禁 → 原子提交」：只按本卡启用的模块（制度日历/社会关系/城市资源/规则系统/任务目标/悬疑证据/组织战略/生存压力/区域环境/通用）运行，校园、修仙、TRPG、都市、单角色各取所需，代码不硬编码题材规则；审计失败保留旧世界，`rp-world-audit` 全程留痕。主演只收到裁剪后的【后台世界动态】，黑盒/秘密不泄内容。完整设计见 `docs/PLAN-WORLD-ENGINE.md`；
- **鲜活世界生态**（设置面板「鲜活世界」开关，默认关）：让用户成为持续运行世界中的**探索者**而非主角。三层权威——全局叙事原型池（跨卡共享）、角色卡生态池（按卡复用）、`rp-ecology-state` 分支运行态（人物生活 / 地点活动 / 日程 / 可错过事件 / 幕后秘密）。每拍都联网搜索并更新双池，但双池备料在**后台**（running/ready + 串行写链）供后续拍消费，绝不阻塞当前正文；拍前 arrival 与连续性并行、拍后世界与人物生态并行计算后按固定顺序落树；aftermath 失败仍落降级快照。四个独立模型插头（`ecologySearch` / `ecologyGlobal` / `ecologyCard` / `ecologyRuntime`）可分别指定模型。DuckDuckGo 被反爬时自动熔断转 Bing。完整设计见 `docs/PLAN-LIVING-ECOLOGY.md`；
- **两级重 Roll**：消息操作区两个明确按钮——「重Roll正文」复用上一版拍前分析工件直接从 writer 阶段重写，随后重新记账、重推世界、重做状态栏，旧回复保留为可左右切换的变体；「重Roll状态栏」只重做状态栏等非正文格式，正文、账本、世界状态一律不动。失败不自动重试，是否再次消耗 token 由你手动点击决定；
- **故事导演（导演室）**：主输入框右侧「导演室」按钮打开独立工作台。支持七种讨论模式——综合编剧、下一拍、下一段对白、角色反应、节奏诊断、日常剧情，以及小说研究页签；导演结合当前正文、人物状态、世界、生态工件和按任务筛选的研究素材给出即时建议。讨论以 `rp-outline-chat` 存分支，不进入正文。真正要固化的长期方向进入建议箱，只有你确认后才写入动态大纲 `rp-outline`。导演室与系统助手（耳麦）职责分离。详见 [导演室](docs/DIRECTOR-ROOM.md)；
- **小说研究**：导演室可上传 `.txt/.epub` 或提交公开 Kakuyomu 作品 URL，后台生成梗概、人物弧线、套路、日常剧情卡和可调度素材。可在 `liyuan.config.json` 的 `novelDigest.autoSchedule` 显式开启每天本地时间 05:00 自动发现最多 3 部校园/日常/现代作品；文档级最多 3 部并行，全文只在服务器本地处理，不进入台上正文上下文。请仅使用你有权研究的文本；完整边界见 [小说长文消化计划](docs/PLAN-NOVEL-DIGEST.md)；
- **研究搜索**：导演室支持手动研究和“自动搜索主题”；可在 `liyuan.config.json` 的 `researchSearchSchedule` 配置每日本地时间、主题列表和每次最多主题数。任务会持久化最近运行状态、同日防重复并保留部分失败，不阻塞正文。 当前搜索源不可用或相关性不足时会安全返回 0 条，不会写入低相关网页；故障边界与实测记录见 [研究搜索结果污染复盘](docs/INCIDENT-20260901-RESEARCH-SEARCH.md)。
- **助手服务笔记**：`.liyuan-skills/` 下的 markdown 是右栏助手摸通外部服务后自写的能力笔记，与台上文学工作流 Skill 是两套，互不混淆。

## 已知边界（如实说）

- 显示向美化正则（一档皮肤）已兼容；清理向正则由 harness 原生替代；带 JS 的酒馆助手程序卡仍在规划中（见「搬家」一节）；
- 主模型无视觉时默认如实告知看不到、不假装看见；配好内置「视觉识图」MCP 后可代眼看图（见「进阶」）；
- 预设在 agent 架构下的效果需自行实测（原因见「搬家」一节）；
- 决策卡「问的分寸」、主动建面板与主动入库的积极性，都与所用模型的智能正相关——**模型越强，梨园越强**；
- 剧情正文永远是模型的原始输出：梨园的代码与辅助模型只做输入侧加工、结构化记账和元信息标注，绝不改写、补写正文。修音可以，假唱不行。

## 开发者

```
领域层  src/        card / lorebook / state / director / retention /
                    scribe / panels / codex / worldline / mcp …
                    stage/      台上引擎（assemble / engine / workspace / tools）
                    stage/literary-*.ts  拍前分析（连续性 / Sogon / Sigon / 导演）
                    stage/literary-world-profile.ts  卡级长期画像 + 分支 Manifest
                    stage/literary-world-modular.ts  模块化世界状态 v2（迁移/投影/wire）
                    stage/literary-world-transition.ts  事实信封 / 提案 / 审计 / 原子提交
                    stage/literary-world-signals.ts  世界⇄生态只读信号
                    stage/literary-ecology.ts  鲜活世界生态（双池/运行态/工作集/降级快照）
                    stage/skill-store.ts  文学工作流 Skill 装载（内置+用户覆盖）
接线层  .liyuan/extensions/roleplay.ts   会话钩子与全部工具的挂载点
Web 层  server/     WS + REST + 静态托管；web/  Vite + React 前端
内核    packages/   @liyuan/*（agent 运行时，pi fork 冻结，file: 本地依赖）
```

```bash
npm test                        # 领域层单元测试（需 Node ≥ 22.19.0）
node scripts/smoke-web.mjs        # Web 冒烟
```

产品数据目录：`.liyuan-state/`（账本）· `.liyuan-artifacts/`（面板）· `.liyuan-codex/`（知识库）· `.liyuan-uploads/`（素材）· `.liyuan-skills/`（助手能力笔记）· `.liyuan-stage-skills/`（文学工作流 Skill 的用户覆盖）· `.liyuan/world/cards/<key>/profile.json`（角色卡长期世界画像）· `.liyuan/ecology/`（鲜活世界双池）等，均为纯 JSON / 文件，随时可备份迁移。

## 许可证

- 主项目采用 **[PolyForm Noncommercial 1.0.0](LICENSE)**：源码开放，个人与非商业用途可自由使用、修改、分发；**任何商业用途——包括但不限于倒卖、收费分发、付费托管服务——均不在许可范围内**，商业授权请单独联系作者。
- `packages/` 下的 agent 内核 fork 自 [pi](https://github.com/earendil-works/pi)（MIT，Copyright Mario Zechner），保留其原协议与版权声明（各包目录内附 LICENSE）。

##友链
http://linux.do
