# AGENTS.md — 梨园项目维护约束

进入项目先读本文件，再读 `docs/DOCUMENTATION-INDEX.md`、`ARCHITECTURE-OVERVIEW.md`、`GENERATION-MODES.md` 与 `PLAN-ROUND-FLOW.md`。本地v1.8.10，发布状态/实际门禁单列，不据工作区版本冒称公开Release。

## 必守边界

1. 用户只让同步/只读时不改代码；明确更新/修复任务才动手。不要reset/覆盖继承dirty改动，不擅自commit/push/Release。
2. 新Web只有direct/director，普通文本单主Agent；专家只报告，固定3/2/2分工。旧SDK稿纸兼容代码不是当前正文流程，不恢复ask/心理画像/每段门禁。
3. 原始预设与启用卡材料决定写法/格式；系统Skill负责职责和执行协议。提示词在 `skills/*/SKILL.md`，用户覆盖 `.liyuan-stage-skills/` 不随版本被替换；本任务不偷改生成提示词。
4. Session Tree/`rpNarrative`是故事权威，布局、原交付、摘要、报告、候选和工具回执分工清楚。修改引擎必须说明如何符合现行流程，取消/切支/恢复不能重复事实。
5. 读会话/思考先读 `docs/READING-THINKING.md`，按真实id/条目timestamp和时区，不用mtime猜最新。只需状态时不读原文；私人文本/Key/OAuth/SSH/会话/截图/用户素材不进提交。
6. 工具能力开关按模型保存，默认支持；修改须保留当前启用渠道、默认模型、岗位与其它兼容字段，不能用旧仓库子集覆盖运行配置。模型独立分工，禁止把Gemini 3.7/3.8 Flash全部换为Luna。仅Luna旧名迁移为原生gpt-6-luna，连接需真实端点验证，嵌入另有配置。
7. 内嵌世界书自动随卡加载，不复制挂载；管理写操作带source/cardIdentity/entryKey，原关闭模块不自动开启。生产PNG不拿来试写。
8. 记忆按session/card/祖先来源：完整周期窗口、规范正文及偏移基准；生产原记忆只读保留，插件实测只用临时库合成故事，不重生成故事来凑测试成功。
9. 升级先临时build、离线/浏览器、空闲与备份，再验证health/hello/bundle/SW/会话和私有数据。不要为方便放宽私有资料权限或默默启用旧渠道。

## 当前代码入口

- `src/stage/engine.ts` / `agent-turn.ts` / `agent-director.ts`：模式、作者、阶段、保存与共用结算。
- `agent-presentation.ts` / `materials.ts` / `assemble.ts`：原文资料、事实/格式边界。
- `literary-world-*.ts` / `literary-ecology.ts`：世界与生态，另见相关现行PLAN。
- `server/database-plugin-*.ts` / `web/public/database-plugin-host.*`：原上游数据库的私有缓存、宿主适配、作用域与浏览器运行时；源码不fork，升级先验哈希与原插件回归。原生剧情任务包含召回，不强制关闭plotEnabledGlobal；输入写回模板与世界书位置由上游决定，不自行读禁用索引、改写/前置记忆或截断条目。安装文件一致不证明宿主行为百分之百原生等价；宿主API/事件、配置迁移及世界书投送是兼容实现，文档不得混淆。
- `src/memory/` / `stage/compact.ts`：旧SQLite库保留回退；插件启用后不再自动剧情双写。
- `src/outline/` / `src/novel-play/`：导演室、大纲、研究、小说消化和开演。
- `src/tools/` / `.liyuan/extensions/roleplay.ts`：能力投影和旧SDK/热刷新接线。
- `server/` / `web/src/`：会话宿主、REST/WS、两模式UI和只读诊断。

测试使用 `/opt/node22/bin/node` 或符合manifest最低版本的Node；`npm run verify`仅声明其实际覆盖范围。老架构日记、废弃计划和过期测试数字已退出活动文档，备份留受限运维产物；不要把它们重新粘回现行指南。
