# 当前正文生成与结算流程

本文件是现行执行契约，不是旧稿纸工作流的演进日记。适用本地 v1.8.7；公开发布版本另行核验。

## 一拍的共同骨架

1. 提交绑定 `generationMode`、session、当前卡和客户端消息id；输入flush后ACK。ACK不表示整拍完成。
2. 必要时恢复上一拍pending结算，然后捕获当前分支、资料、预设、账本、记忆、世界/生态和导演室快照。
3. 根据输入绑定模式执行作者流程。正文只有同一个主Agent可写，专家、工具回执和生态候选不写故事。
4. 以 `rpNarrative` 保存故事事实；`rpAuthorDraft`保留原交付，布局由绑定正文id的 `rp-presentation-delivery` 表达。
5. 共用角色账本、启用的世界/生态转移、格式交付与记忆维护；保存结算收据，成功/失败/降级分别记录。
6. 必要结算完成或明确pending后释放锁。取消、切支、切会话拒绝迟到结果；已保存正文不被旁路重写。

## 直出 direct

原始启用资料＋当前分支＋已有记忆/世界/生态 → 正常文学导演（`literaryDirector`，原职责与Skill保留）→ 单主Agent普通文本 → 共用结算。

不额外生成拍前生态，不跑心理画像、多角度团队审稿。直出不是“一次API调用”，启用领域和格式交付仍有自己的调用。

## 导演 director

主Agent主持固定顺序：

```text
evidence：连续性、设定/知情、生活生态三份报告
→ ideas：两个独立角度
→ writing：主Agent起草
→ review：事实、原始预设两份审阅
→ decision：主Agent选择保留或修改
→ revision（如需）：仍由主Agent改稿
→ finalize → 共用结算与格式交付
```

日常和关键回合同流程；报告可没有意见，不要求制造冲突或强制改稿。专家不互相读取同阶段报告、不接收完整主Agent思考，没有正文/定稿工具。失败报告不能显示“审阅通过”。

## 权限、格式与事实

- 新Web不使用 `ask`剧情停点、Sogon/Sigon自动画像或逐段`draft_append`门禁。旧SDK稿纸实现仍存在于代码，但不是第三种Web模式。
- 原始预设决定写法；角色卡/启用世界书决定格式需求。系统负责执行协议，不擅自删预设、加通用文风规则或冻结主角行为。
- 未提交草稿、候选、报告、图片提示词、布局与工具回执不是已发生事实。世界/生态提交需要本拍输入或已保存正文的来源锚点。
- 延迟交付恢复绑定原正文id，不重复世界、生态、账本或故事。
- 文学质量不等同于“流程状态全部成功”。

## 预算与模型

默认整拍 direct 30分钟、director 60分钟，可由配置覆盖；普通作者最多8/24轮，单流硬上限15分钟。触限保留未完成收据，不自动冒称定稿；专家按固定岗位并行，岗位失败与不支持工具分别处理。

模型按各岗位配置解析，不把所有岗位换成同一个模型。Gemini 3.7/3.8 Flash和Luna独立管理，详见 `MODEL-CONNECTIONS.md`。

## 记忆边界

原插件启用时，拍前走上游记忆准备与派生世界书投送，拍后只以已保存正文id执行原插件填表/持久化；失败留下 `rp-database-memory:pending`，下一拍先恢复，不重复正文。旧周期入库、事件提取和旧压缩关闭，原库保留；插件关闭时沿用旧路径。记忆不覆盖分支正文或账本，详见 `DATABASE-PLUGIN.md`。

代码入口：`src/stage/engine.ts`、`agent-turn.ts`、`agent-director.ts`、`agent-presentation.ts`。验证：`test/generation-mode-engine.test.ts`、`generation-format-parity.test.ts`、`memory-narrative-window.test.ts`。
