# 第三方能力参考

梨园的鲜活世界与日历能力参考过以下开源项目的产品思路，并按梨园权威边界独立实现：

- [ST-SevenDaysCal](https://github.com/atonal519/ST-SevenDaysCal)：自定义历法、月历、多日日期、周期追踪与显式时间跳转交互。
- [world-backstage](https://github.com/h675786161-prog/world-backstage)：人物冻结认知、通讯送达、公开传播面、后台人物饥饿保护与事件终态。
- [蚀心入魔·数据库](https://github.com/AlbusKen/shujuku)：酒馆的“表 + 世界书”记忆插件——逐轮时间线纪要、稳定编码 AM 索引、自动合并阈值、概览列常驻。梨园吸收其“账本纪律”（逐轮时间线、编码稳定 id、概要索引常驻、合并折叠）与列式元数据过滤思想，转为 agent 原生的事件卡 `arc`/`links`/滚动提取/弧线聚合召回，不引入填表 DSL 或世界书 keyword 注入。
- [OpenViking](https://github.com/volcengine/OpenViking)：agent 上下文数据库——L0/L1/L2 三层预算（摘要 ≤256 字 / 概览 ≤4000 字 / 详情按需）、意图分析 TypedQuery 分档、向量预筛 + LLM 语义去重、memory_diff 审计。梨园吸收其分层预算、召回分档、去重 decision 链（skip/create/merge/delete）和审计思想，不引入 AGFS/VLM/Python 服务端或 PPR 图遍历。

没有引入 SillyTavern/Luker 的存储、DOM、prompt depth、独立世界钟或大一统状态仓。梨园继续坚持：

- 当前时间与镜头账本进入 `rp-state`；
- 宏观制度和历法进入 `rp-world-state`；
- 人物生活、通讯和具体事件进入 `rp-ecology-state`；
- 日历、舆情和认知展示为只读投影；
- 所有状态随 Session Tree 分支、回档和变体恢复。

`world-backstage` 仓库使用 MIT License；若后续直接复制其实质代码，应保留原版权与许可证。当前整合为依据公开行为重新实现。

能力合并的最终权威边界、一拍流程与维护要点以 `docs/ARCHITECTURE-OVERVIEW.md`、`docs/PLAN-WORLD-ENGINE.md`、`docs/PLAN-LIVING-ECOLOGY.md` 为准。
