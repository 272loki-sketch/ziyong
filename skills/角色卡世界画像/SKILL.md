---
name: 角色卡世界画像
description: 从角色卡、当前开场、世界书、预设与实际游玩中生成本卡长期复用、可持续优化的独立世界适配。
workflow: world-profile
resident: false
每轮: false
---

# 角色卡世界画像

你的任务不是给角色卡贴一个题材标签，而是确定这张卡在当前玩法下，哪些系统值得在玩家视野外持续运行。画像会按角色卡长期保存，并在后续会话中复用；因此必须保守、有证据，并允许以后根据实弹表现继续优化。

## 证据顺序

当前实际游玩与用户明确要求高于初始卡面；当前选中的开场高于其他备选开场；角色卡明确设定与启用世界书高于作者备注和标签。标签、文件名、作者说明只能作为弱证据。预设主要说明写法与玩法偏好，不能凭空建立世界事实。

## 适配原则

1. 不要为了显得丰富而启用无关模块。单角色或封闭关系卡允许没有宏观世界模块；校园日常不应默认拥有战争、宏观经济或天下大势。
2. 不要把人物此刻的位置、日常活动和具体可错过事件交给世界模块，这些属于人物与场所生态。世界模块只负责跨场景持续存在的制度、规则、组织项目、传播网络、资源约束与宏观后果。
3. 混合卡可以启用多个模块，但每个模块应有自己的触发频率。没有相关触发时，不需要每拍运行。
4. 高影响但证据不足的模块使用 observe，不要直接 active。严格骰点、自动关系推进、角色死亡、重大资源消耗等必须在 unresolvedQuestions 中提出确认问题。
5. 旧画像存在时，把它当作已经实弹积累的适配基础。保留仍然成立的用户要求与优化结论；只有新证据明确推翻时才调整。
6. userRequirements 是用户长期要求，不得擅自删改。optimizationNotes 记录本卡实弹后发现的适配问题、修正和仍需观察的现象。
7. 画像未标记 stable 时，引擎会周期性带着近期实弹再次调用你。比较 previous_profile 与 recent_play：删掉长期没有价值的模块，降低频率过高的模块，修正实际造成打断、泄密、题材误判或状态膨胀的适配；不要每次为了显得有优化而改动。确认已经稳定时仍保持 draft，是否锁定 stable 由用户决定。

## 推荐模块词汇

优先复用这些稳定 id，也允许为特殊卡提出新的简短英文 id：

- institution-calendar：校历、班表、轮班、预约、门禁、制度期限。
- public-information：公告、新闻、群聊、传闻、舆论与传播路径。
- organization-strategy：组织目标、项目、能力、资源、内部派系与行动。
- relationship-dynamics：NPC 侧信任、舒适、戒备、期待、边界与关系压力。
- household-routine：共同生活、家务、作息、私人空间与约定。
- infrastructure-city：交通、公共服务、区域运行与机构响应。
- economy-market：供需、价格、库存、运输与经济压力。
- cultivation-system：境界、功法、突破条件、灵气与修炼资源。
- magic-system：法术规则、代价、材料、反制与可知性。
- technology-system：设备、网络、监控、技术边界与扩散。
- mechanics-resolution：检定、骰点、难度、结果等级与规则资源。
- combat-tactical：先攻、距离、行动经济、伤害与战斗状态。
- quest-objective：任务目标、阶段、期限、失败条件与奖励承诺。
- mystery-evidence：真相、证据、假说、调查与揭露条件。
- war-front：战线、兵力、补给、士气、控制区与战略行动。
- survival-pressure：饥渴、庇护、疾病、环境和物资消耗。
- regional-environment：季节、天气、灵潮、灾害与区域环境。
- reputation-social：有传播依据的圈层评价。

## 输出

只返回一个 JSON 对象：

```json
{
  "digest": "这张卡需要怎样的世界运行，以及为什么",
  "labels": ["校园日常", "双人关系"],
  "primaryScale": "intimate|scene|local|institutional|regional|epic",
  "defaultTimeStep": "moment|scene|hour|day|week|strategic-turn",
  "worldActivity": "quiet|low|normal|active|epic",
  "modules": [{
    "id": "institution-calendar",
    "name": "校园制度与校历",
    "mode": "observe|active|suspended",
    "cadence": "every-beat|on-time-advance|on-trigger|per-day|per-arc|strategic-turn",
    "confidence": 0.9,
    "reason": "启用或观察的证据",
    "stateFocus": ["真正需要长期追踪的对象"],
    "writerProjection": "下一拍只应向主演提供什么，不应泄露什么"
    ,"kind": "institution|social|infrastructure|rules|objective|mystery|strategy|survival|environment|custom"
    ,"skillPack": "通常与 kind 同名；特殊卡可以选另一个已安装模块包"
  }],
  "disabledModules": ["明确不适合本卡的模块 id"],
  "userRequirements": ["完整保留 previous_profile 中已有的用户长期要求"],
  "optimizationNotes": ["本次分析发现的适配建议或仍需实弹观察的点"],
  "unresolvedQuestions": ["只有会显著改变玩法且必须由用户决定的问题"],
  "evidence": [{"source":"具体卡字段、世界书、预设或近期剧情位置","claim":"支持该适配结论的事实"}]
}
```

若证据不足，宁可使用 scene 尺度、normal 活跃度和少量 observe 模块，也不要补造一整套世界系统。
