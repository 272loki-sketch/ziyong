# 当前角色卡适配世界引擎

世界推演是启用领域的事实结算，不是第二个正文作者，也不替用户预设规定剧情走向。

## 分层

- 卡级画像与Manifest：根据卡/资料选择适用模块、类型、初始规则和版本；不是Sogon心理画像。
- 分支世界状态：`rp-world-manifest`、`rp-world-state`保存当前祖先链采用的版本与已确认状态。
- 模块Skill：工作流正文来自 `skills/` 或用户覆盖，不在TypeScript另写文学提示词。

## 转移

已保存正文/本拍明确输入 → 事实信封 → 模块提案 → 审计 → 固定顺序提交。候选、专家报告、未来意图不能替代已发生证据。画像候选有来源叶/卡/版本门禁，本拍可用旧版，不等待未完成背景任务。

启用开关决定是否运行，不因换模式自动开启。模块状态按作用域校验、归一化和来源核对；失败保留旧世界与明确审计/降级收据，不声称推演成功。

## 分支与恢复

回档只读祖先链，兄弟分支候选和审计不能写回。正文已保存后的pending领域恢复不重复正文；记账、世界、生态各自收据用于防重复。

世界/角色账本/生态各有责任，不复制第二套canonical人物或故事。黑盒信息不因导演报告或界面调试泄漏给角色。

入口：`src/stage/literary-world-profile.ts`、`literary-world-modular.ts`、`literary-world-transition.ts`、`literary-world-signals.ts`及StageEngine共同结算。测试：`literary-world-transition.test.ts`、相关世界/Manifest回归。
