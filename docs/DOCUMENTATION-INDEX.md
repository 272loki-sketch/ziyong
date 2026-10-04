# 文档导航与当前实现基线

## 阅读优先级

1. `AGENTS.md`：协作与维护边界。
2. `ARCHITECTURE-OVERVIEW.md`：当前代码地图、唯一权威与一拍运行关系。
3. 各 `PLAN-*` 顶部现存的校准段：当前协议与保证范围；文学工作流的 v1.7.3 校准机制仍有效。下方早期记录用于理解演进，不能把全部 PLAN 文档一概当成过期历史。
4. `RELEASE-v1.7.4.md`：本次公开仓库迁移与隐私隔离说明；`RELEASE-v1.7.3.md`、`ITERATION-20261003-STABILITY.md` 记录此前交付，不代替设计契约。
5. `deploy/README.md`、`deploy/VPS-OPERATIONS.md`、`LOCAL-UPSTREAM-UPDATES.md`：安装模板、运维、普通同步及明确授权发布。

## 当前重点

| 主题 | 当前说明 |
| --- | --- |
| 回合、提交、重演 | `PLAN-ROUND-FLOW.md` |
| 记忆与删除并发 | `PLAN-RP-MEMORY.md` |
| 生态与用户承诺 | `PLAN-LIVING-ECOLOGY.md` |
| 容量预检及未完成预算治理 | `PROMPT-BUDGETS.md` |
| 小说生命周期与实调预算 | `PLAN-NOVEL-DIGEST.md` |
| Skill/只读诊断治理 | `STANDALONE-INTEGRATION-BASELINE.md` |
| 用户查看工作流与研究任务 | `DIRECTOR-ROOM.md` |
| 发布数据排除与隐私清理 | `PRIVACY-AUDIT-v1.7.3.md` |
| 测试流程及边界 | `../TESTING.md` |
| 合成会话素材与重生成 | `../packages/coding-agent/test/fixtures/README.synthetic-fixtures.md` |

## 不能误读的历史材料

旧 `RELEASE-*`、`INCIDENT-*`、`REALWORLD-*`、带日期的分析和早期测试数字是历史证据，不是当前结果。当前 PLAN 顶部校准机制仍是维护入口，早期段落才是演进证据。个人标识和对话逐字材料可为隐私保护移除或改成匿名技术摘要；`REALWORLD-TEST-20260817.md` 不再保留原始聊天、正文、思考或真实画像摘录。

## 当前发布与隐私核验（2026-10-04）

当前发布文档为 v1.7.4。最终测试计数与结果由主线程在实际验证后补录；历史版本数字不作本次结果。SYNTHETIC fixture 的来源、确定性生成与字节级复核方式见 `../packages/coding-agent/test/fixtures/README.synthetic-fixtures.md`；公开数据门禁与限制见 `PRIVACY-AUDIT-v1.7.3.md`。这些合成数据和隐私隔离约束继续适用，不以文档迁移代替验证。

发布前核验流程：确认 `272loki-sketch/ziyong` 为 Public，并在未登录环境验证仓库克隆和 raw 安装入口可访问。目标仓库公开及匿名访问验证完成后，按已授权流程删除旧仓库；操作完成后再核验账户仓库列表及未登录访问结果。此类入口核验不证明全部旧 Git 对象、缓存或第三方副本均已物理消失。
