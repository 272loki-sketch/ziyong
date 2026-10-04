# AGENTS.md — 梨园项目助手须知

## 当前基线与文档使用

- 当前发布基线为 v1.7.4；维护时先读架构总览与各 PLAN 顶部现存的校准段。文学工作流仍以 PLAN 顶部的 v1.7.3 校准机制为有效基线；本次发布只迁移公开仓库来源并延续隐私隔离，不代表文学机制改动。
- 旧 RELEASE、INCIDENT、REALWORLD 与早期设计数字是历史证据，不代表当前测试结果或部署状态。
- 文档导航见 `docs/DOCUMENTATION-INDEX.md`；个人配置、人设、头像、会话和用户覆盖不得进入提交。发现疑似历史敏感数据必须先报告，不擅自强推或改旧标签。

本文件是任何 AI 助手（Claude Code / opencode / 其他）进入本仓库的**第一读**。

## 铁律

1. **禁止直接动手改代码**，除非用户明确说「开始/动手」。
   用户会说「先同步情况」「你来告诉我」「只读」——那期间只能读、不能改。
2. **读思考记录必须先读** `docs/READING-THINKING.md`——按文件 mtime 找最新会话
   会读错位置（旧会话被 model_change 碰过 mtime 会排到前面）。必须用行级
   timestamp 核对北京时间。
3. **流程与提示词的最终形态**定义在 `docs/PLAN-ROUND-FLOW.md`——任何提示词/
   引擎改动都要回答「离这个流程近了多少」。
4. 预设拆层规则见 `docs/PRESET-SPLIT-TAXONOMY.md`；RP agent 执行计划见
   `docs/PLAN-RP-AGENT-EXEC.md`。
5. **文学工作流的提示词全部在 Skill 里**（`skills/*/SKILL.md`，面板可编辑，
   用户覆盖在 `.liyuan-stage-skills/`）。`src/stage/literary-*.ts` 只负责编排与
   解析，不写提示词正文；改流程优先改 Skill 文件，不硬编码进 TS。

## 快速索引

- `docs/ARCHITECTURE-OVERVIEW.md` — **结构总览（AI/维护者第一读）**：权威边界、目录地图、一拍流程、关键机制现状、文档导航、测试与维护要点
- `docs/PLAN-ROUND-FLOW.md` — 分轮演出流程（最终形态 + 关键路径分级 + 落地记录）
- `docs/PLAN-WORLD-ENGINE.md` — 角色卡自适应模块化世界引擎（画像/Manifest/事实信封/审计/模块化状态）权威设计
- `docs/PLAN-LIVING-ECOLOGY.md` — 鲜活世界生态（三层权威 + 后台双池 running/ready）权威设计
- `docs/PLAN-NOVEL-DIGEST.md` — 小说长文消化与研究库扩容（上传→分块摘要→套路库，导演室后台管道）权威设计；**§17 含实现状态与未做事项（URL 抓取等），新会话先读这节**
- `docs/STANDALONE-INTEGRATION-BASELINE.md` — 文学工作流 Skill 化权威边界
- `docs/READING-THINKING.md` — 读思考记录的**正确方法**（先读这个再碰会话文件）
- `src/stage/` — 台上引擎（assemble 提示词 / engine 回合循环 / workspace 稿纸 /
  tools 工具 schema / literary-*.ts 拍前分析 / literary-world-profile.ts 卡级画像+Manifest /
  literary-world-modular.ts 模块化世界 v2 / literary-world-transition.ts 事实信封+提案+审计 /
  literary-world-signals.ts 跨域信号 / literary-ecology.ts 生态 / skill-store.ts Skill 装载）
- `src/outline/corpus.ts` — **小说长文消化管道**：解码/清洗/分章/分块 + 串行 CorpusEngine（断点续跑、暂停/恢复/删除、预算闸门）
- `skills/` — 内置工作流 Skill（随版本更新；含世界模块包 `世界模块-*`）
- `.liyuan-stage-skills/` — Skill 的用户覆盖（gitignore，不随版本覆盖；「世界推演」在此）
- 测试：`npm test`（需 Node ≥ 22.19.0；直接使用 Node 原生 TypeScript 支持，不临时下载 tsx）
