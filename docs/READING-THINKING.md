# 正确定位会话、流程和思考记录

先读本文件再读私人会话。旧文件mtime可能被model-change、重命名或设置更新触碰，不能用mtime排序断言“最新生成”。

## 定位

1. 先以当前WS hello/显式会话id确认目标，不把隔离实战记录当生产会话。
2. 找该session对应的真实JSONL，逐行检查timestamp（毫秒或ISO），按明确时区转换。
3. 依据user父节点、assistant正文id和当前祖先链区分输入、swipe/重Roll和兄弟分支。
4. 核对用户所说时刻后才查看正文/思考；不符则停止，不猜是哪一局。

## 当前模式字段

- `rpGenerationMode`：该输入/正文使用的direct或director。
- `rpGenerationWorkflow`、`rp-turn-performance`：阶段与安全观测，不是文学质量证明。
- `rpNarrative`：故事事实；`rpAuthorDraft`：主作者原交付；presentation工件只是绑定正文的布局。
- 最终message可含thinking块，但不能据此宣称已经拿到所有生成轮/专家思考。完整私有trace和安全Wire是不同层。
- `rpTimeline`是旧稿纸路径的重要记录，不是新模式全部工作流的可靠替代。

## 检查记忆

只需状态/次数时，不读原文或thinking。按session＋card scope、成功正文拍数、周期、sourceRefs/分支、存量向量模式/维度核对；当前空库不能用其他会话记录冒充成功。

## 报告纪律

记录具体会话角色、当地时间、源正文id的内部核对结果；公开报告只出脱敏状态/计数。工具记录字段以实际schema为准，不把“没显示”当“没调用”。原文、thinking、API Key和私人截图不得复制到公开文档或提交。
