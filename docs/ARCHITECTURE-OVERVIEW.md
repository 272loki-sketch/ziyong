# 梨园当前架构

本地 v1.8.6。当前应用以两个普通文本主Agent模式运行，不以旧稿纸/询问/画像架构为正文流程。部署和测试结果单列 `VALIDATION-20261007.md`，不声明公开Release。

## 1. 唯一事实与派生工件

| 工件 | 责任 |
| --- | --- |
| Session Tree / `rpNarrative` | 当前分支已提交的故事与输入 |
| `rpAuthorDraft` / `rp-presentation-delivery` | 主作者原交付与引用冻结正文/原图片的显示布局，不是另一份故事 |
| `rp-state` | 镜头内角色账本 |
| `rp-world-manifest/state/audit` | 世界适配版本、状态与转移审计 |
| `rp-ecology-state` | 镜头外生活、事件、认知与传播 |
| `rp-summary` / 事件卡 / 归档 | 接力摘要、来源定位与原文细节，不覆盖正文/已确认状态 |
| `rp-outline` / 提案 / 讨论 | 长期方向及候选，不等同已发生事实 |
| `rp-turn-settlement` / performance | 提交收据与观测，成功状态不证明文学质量 |

候选、报告、图片提示词和工具回执不成为故事事实。用户明确输入与已保存分支正文高于派生资料。

## 2. 一拍

提交绑定mode/session/card/clientMessageId → 必要pending恢复 → 原始资料/分支快照/记忆与领域状态 → 根据模式生成正文 → 保存事实 → 角色账本、启用世界/生态、同原作者完整格式 → 摘要/周期记忆/导演室旁路 → 结算收据。

- **direct**：已有资料和生态只读投影 → 正常文学导演 `literaryDirector` → 同一主Agent普通文本。没有拍前生态生成、心理画像或团队审稿。
- **director**：主Agent固定3证据→2角度→主稿→2审阅→自行keep/revise→定稿。专家不写正文、同阶段不互看，不接完整主Agent思考。

两种模式共用原始启用预设/卡格式、事实和结算，不按日常/关键回合换一套机制。流程细节见 `PLAN-ROUND-FLOW.md`、`GENERATION-MODES.md`。

## 3. 模块地图

| 路径 | 责任 |
| --- | --- |
| `src/stage/engine.ts` | 捕获输入、排队、模式、作者、分支守卫、保存和共用结算 |
| `agent-turn.ts` / `agent-director.ts` | 单作者普通文本、固定阶段、专家报告与实际来源校验 |
| `agent-presentation.ts` | 原文格式要求、冻结正文引用、自由布局和交付收据 |
| `assemble.ts` / `materials.ts` | 原始资料、预设和分支历史/摘要装配 |
| `literary-director.ts` | 正常直出导演；职责/岗位不缩水 |
| `literary-world-*.ts` / `literary-ecology.ts` | 世界转移与生态背景池/分支运行态 |
| `src/memory/` / `stage/compact.ts` | SQLite剧情库、完整周期窗口、事件、证据、长局摘要 |
| `src/outline/` / `src/novel-play/` | 研究/大纲/消化与原著开演，非第二作者 |
| `src/tools/` | 统一领域契约与按能力投影 |
| `skills/` / 用户Skill覆盖 | 工作流提示词与用户覆盖，不混入用户预设写法 |
| `server/` / `web/src/` | 会话宿主、REST/WS、提交、显示与安全诊断 |
| `packages/` | 冻结runtime/API fork；源码与dist重编另有门禁 |

`.liyuan/extensions/roleplay.ts`仍是工具和资料热刷新接线；其中旧SDK兼容分支不代表第三种Web正文模式。

## 4. 关键边界

### 资料与格式

卡内世界书自动加载，独立挂载与按卡补充分开；管理API带source/cardIdentity/entryKey。关闭模块不被皮肤正则复活。显式启停写原生状态，JSON/PNG和未知字段受保护，见 `LOREBOOKS.md`。

原始预设决定写法。主作者完整交付可穿插正文、附属格式、图与选项；正文事实只读 `rpNarrative`，布局工件引用原文不重写故事。格式失败留pending并恢复，不重复世界/生态/账本，见 `FORMAT-DELIVERY.md`。

### 记忆

会话＋卡作用域、祖先来源过滤；周期正文取完整N拍和规范文本，源偏移带基准。事件/证据召回与剧情线投影有限等待，不捏造无命中事实。长局压缩留最近6拍，归档先于摘要落树，见 `PLAN-RP-MEMORY.md`。

### 权限、取消和恢复

提交ACK只表示输入持久化。真实分支/会话变化拒绝旧结果；设置元数据不伪装成切支。已保存正文的pending领域按收据恢复，半稿不能假定定稿。故事行为不是现实付款/删除/发帖授权，见 `RECOVERY-AND-DIAGNOSTICS.md`。

### 模型

每岗独立配置，不统一换为GPT。Gemini 3.7/3.8 Flash保留，Luna原生6独立渠道；嵌入独立于聊天模型。未知参数与tools支持保守处理，网络错误和工具拒绝分开，见 `MODEL-CONNECTIONS.md`。

## 5. 验证与维护

`npm run verify`是离线后端＋前端版本＋web typecheck；不等于全后端tsc、真实模型调用、fork重编或三平台打包。浏览器使用隔离HOME/Agent/素材；生产只读核对真实身份/版本和私有资料哈希。

升级先验证候选构建、服务空闲、源码/旧dist/私有资料备份，再部署。不得reset继承dirty工作区、自动推送Release或放宽私有配置权限。当前导航 `DOCUMENTATION-INDEX.md`，测试 `../TESTING.md`，运维 `../deploy/VPS-OPERATIONS.md`。
