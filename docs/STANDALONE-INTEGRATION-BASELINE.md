# 当前独立Agent与Skill整合边界

梨园独立使用自己的Session Tree、StageEngine和资料/状态服务；方法借鉴不等于运行另一个框架或第二个正文作者。

- direct/director是当前两种Web正文模式；流程见 `GENERATION-MODES.md` 和 `PLAN-ROUND-FLOW.md`。
- 主Agent普通文本交稿，专家只提供固定岗位报告，系统维护事实、取消、恢复、权限和记录。
- workflow提示词位于 `skills/*/SKILL.md`；用户覆盖位于 `.liyuan-stage-skills/`，不以升级覆盖用户修改。
- 模型岗位与工作流分离；主演、专家、摘要、记忆、世界、生态、研究分别按配置取模型。不得把Gemini Flash全部换成Luna。
- 内置Skill更新与用户覆盖的“已读基线”分离；普通保存不冒称已经审阅新内置版本。
- 预设写法是用户权威，不把系统工作流或显示皮肤变成新的写作规则。

方法来源、复用范围和未继承的旧停点/心理画像/每段稿纸门禁见 `PROMPT-SOURCES.md`；第三方信用和许可保留于 `THIRD-PARTY-INSPIRATION.md`。旧架构日记已退出活动文档，代码中的SDK兼容分支不因此删除。
