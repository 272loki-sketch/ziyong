# 双模式提示词来源与适配记录

## 来源

七份 `skills/导演*/SKILL.md` 由本轮主助手亲自对照并翻译、裁定、适配 Luker Team 的 v2.8.0 提示词与方法 Skill，不由协作模型定稿。参考版本 commit：`e25115a572b9c3a85af5a3a29b9098f9b46d80c7`。

来源仓库：`github.com/funnycups/Luker`。主要来源文件：

| 梨园 Skill | Luker 来源 |
| --- | --- |
| 导演证据整理 | `default/skills/global/chat-scout-method-zh/SKILL.md` |
| 导演设定核对 | `intent-scout-method-zh`、`lorebook-scout-method-zh`、`epistemic-scout-method-zh` |
| 导演生态参考 | `notes-pickup-scout-method-zh` 的相关性筛选方法，结合梨园现有生态与世界材料 |
| 导演角度构思 | `plot-brainstormer-method-zh` |
| 导演事实审阅 | `continuity-critic-method-zh` |
| 导演预设审阅 | `voice-critic-method-zh` 的具体用法判断、人物表达及创作框架泄漏检查方法；尺度改为用户原始预设与明确人设 |
| 导演主Agent | `director-turn-workflow-zh`、`notes-curator-method-zh`；`public/scripts/extensions/orchestrator/director-default-prompt.js` |

上表未展开的原始方法均位于 `default/skills/global/<名称>/SKILL.md`；角色边界另对照 `public/scripts/extensions/orchestrator/director-defaults.js`。这些改编提示词保留上游 Luker Team 署名及 AGPL-3.0 来源许可，许可原文在 `prompt-attribution/Luker-AGPL-3.0.txt`。这一说明不是对项目其他文件许可的重新声明。

## 适配而非整套搬运

- 保留阶段隔离、同阶段并行、角度型简报、唯一正文作者、默认信任草稿、无问题无需修改、未采用候选不记入事实。
- 将 Luker 动态专家集合收敛为梨园固定的三证据、双角度、双审阅；不区分日常/爆发的流程长度。
- 使用梨园现有记忆、原始卡、人设、原著资料、世界画像/Manifest、生态、导演室与研究库；不另开心理画像。
- 普通文本写作而非继承上游 `write_message`；工具名适配梨园阶段收据、定点改稿及 `finalize`。
- 报告采用梨园带来源 ID 的 JSON 协议；来源 ID 可核对不等于语义已经证明。
- 传短的已完成报告与实际检索回执，不传主 Agent 完整 reasoning；专家报告不是新的事实源。
- 不继承通用禁词表、强制人物温热内心、固定转折/事件/关系进度、必须读额外文风 Skill 等要求。审阅依据仍为用户原始预设及明确人设。

`主演文本直出` 是梨园普通文本通道协议，不另造小说写法；直出的正常 Stitches 文学导演仍使用原来的模型插头、结果字段和职责，将旧画像引用换成原始资料，去掉旧系统层默认时间冻结；新模式的资料标题也不再把写作者指定为某个 NPC 的扮演者。

## v1.8.3 主助手新增/适配的交付协议

保留已注明的Luker分工来源；本轮主助手直接编写 `卡格式需求识别`、`卡格式完整交付`、`主作者正文边界`、`原生工具协议修复` Skill，适配梨园单一事实权威、可编辑原卡格式、引用布局及校验恢复。六专家Skill的source_scope/校验回执说明及主演直出/导演主Agent的原卡格式接线也由主助手修改；未把提示词写作委托给Luna，私人Skill覆盖保持。Luna只做有界测试和专家报告解析/职责数据过滤，不代写原卡或文风。

这些协议描述数据/职责/错误处理，不新增文学尺度、主角选择权限或固定结尾。原始卡与预设仍是内容与文风来源；启用状态与皮肤显示能力严格区分，详见 `FORMAT-DELIVERY.md`。

## 关键事件与主要人物经历的记忆合同（2026-10-07，完整代码接线待重启核验）

主助手根据用户本次明确要求亲自修改 `剧情记忆摘要`、`主演文本直出`、`导演主Agent`、`导演证据整理` 中的记忆筛选、历史核对与查询合同，及 `src/scribe.ts` 的十节摘要初建/增量规则。协作Luna仅核查协议、来源限制与测试缺口，没有代写或提交提示词。

新增内容限定为主要人物的重要经历、已解决重要事件保留、具体查询锚点、证据/概括及角色知情边界；不增加固定剧情走向、文风尺度或人物行为权限，不改变director固定3/2/2、原卡格式或原始预设。相关接线提供真实来源映射并沿用现行用户Skill覆盖；未覆盖私人 `.liyuan-stage-skills/`，未修改正文模型、岗位、嵌入配置或生产数据库。导演Skill原有Luker署名和许可说明保留。本次没有新增上游材料搬运。
