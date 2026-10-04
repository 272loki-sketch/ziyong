# v1.6.0（2026-08-17）：角色卡自适应模块化世界引擎

本版把「后台世界」从单套固定宏观快照升级为按卡自适应的模块化引擎，并完成关键路径分级提速。

## 新增

- **卡级长期画像**：每张真实卡生成独立世界适配（`.liyuan/world/cards/<key>/profile.json`），
  保存尺度、时间步长、活跃度、所需模块、用户长期要求与实弹优化记录；`draft` 每 8 拍结合
  实弹复盘，可锁定 `stable` 停止自动重建。
- **分支 Manifest**：`rp-world-manifest` 钉住当前分支采用的画像版本；同一卡不同开场/世界书/
  预设由 `playKey` 区分；回档/变体各自恢复，不被卡级最新画像静默覆盖。
- **模块化世界状态 v2**：`rp-world-state` 按卡只建需要的模块（制度日历/社会关系/城市资源/
  规则系统/任务目标/悬疑证据/组织战略/生存压力/区域环境/通用）；旧 v1 快照内存迁移为 legacy
  模块，`LiteraryWorldState v1` 保留为兼容投影。
- **带证据的世界转移**：拍后世界链 = 事实信封（world-facts）→ 模块提案（world）→ 独立审计
  （world-audit）→ TS 确定性门禁 → 原子提交；`rp-world-audit` 全程留痕，失败保留旧世界。
- **关键路径分级**：Sogon/Sigon 画像、卡级世界画像、生态双池备料全部移出正文关键路径
  （后台生成、下一拍生效）；writer 固定叶守卫；生态双池 running/ready + 串行写链。
- **世界/生态跨域信号**：只交换上一份已提交快照派生的只读信号，跨域因果用 originRefs/links
  引用，不复制人物/地点/occurrence/制度/宏观状态。
- **动态前端世界卡**：按 Manifest 列出活跃模块，公开记录直接显示、可探索折叠、秘密只计数；
  设置面板新增「角色卡世界适配」管理（分析/稳定/活跃度/模块启停/清空运行态/长期要求）。
- **模型插头新增**：`worldProfile` / `literaryWorldFacts` / `literaryWorldAudit`，可分别指定模型。

## 说明

- 世界引擎开关 `literaryWorldEnabled` 默认关闭，避免默认增费；开启后按当前卡画像运行。
- 实教卡实弹已跑通全链路并沉淀于 `docs/REALWORLD-TEST-20260817.md`；结构化旁路建议给
  facts/audit/画像插头配置 JSON 输出稳定的模型。
- 完整设计：`docs/PLAN-WORLD-ENGINE.md`。
