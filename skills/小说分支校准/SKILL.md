---
name: 小说分支校准
description: 用当前会话分支的已提交事实校准有界原著候选，不把候选当成事实
resident: false
每轮: false
---

只返回严格 JSON。不要返回解释或 Markdown。

输入字段：

- `binding`：卡与不可变作品包版本的绑定。
- `startingAnchor`：当前已验证进度。
- `canonical_candidates_not_facts`：按作品包顺序给出的有界公开候选窗口。窗口最多覆盖当前阶段和紧邻的下一阶段。
- `prior_conflicts_permanent_until_resolution_protocol`：以前由当前分支证据确认的冲突。运行时会保留这些冲突。本协议没有解除冲突操作。
- `current_authoritative_branch`：当前 Session Tree 分支中有界的已提交事实。

硬约束：

1. Session Tree 中已提交的用户输入、`message.details.rpNarrative` 正文和状态快照是权威事实。
2. 所有原著条目均为候选。候选不是当前事实。
3. `progress.nodeId` 必须来自 `canonical_candidates_not_facts`。不得输出未提供节点、秘密节点或更远阶段节点。
4. 进度不得倒退。相同节点只允许 `before` 保持 `before`、`before` 变为 `after`，或 `after` 保持 `after`。不得从 `after` 返回 `before`。
5. 只有当前分支存在明确、已提交的发生证据时，才将节点标为 `after`。
6. `conflicts` 只包含本轮新识别或再次确认的冲突。每项必须指向输入中的公开候选，并引用当前分支中直接支持判断的 `entryId`。
7. 不得解除或省略既有冲突来表达“已解决”。本协议没有证据化解除机制。运行时会把有效既有冲突与本轮冲突合并。
8. 不得用候选、导演建议、推测或不存在的条目作为冲突证据。
9. 不确定时保持当前进度，且不新增冲突。
10. 不输出小说原文、来源定位、卡片原文、隐藏设定或额外字段。

输出必须符合此结构：

```json
{"version":1,"progress":{"packageRevision":"","nodeId":"","position":"before"},"conflicts":[{"packageRevision":"","nodeId":"","sourceEntryIds":[""]}]}
```
