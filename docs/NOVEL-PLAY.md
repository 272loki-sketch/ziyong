# 从小说资料开演

Novel Play将已消化作品转成可核对的不可变包、开场候选与现有角色卡，然后仍使用梨园同一Session Tree和direct/director正文模式。

## 使用

1. 导演室“藏书消化”导入支持的文档或Kakuyomu作品，等待ready。
2. 构建作品包；查看原文锚点、事件与来源范围。ready不等于模型提取绝对正确。
3. 选择允许的起点和用户身份，生成待确认开演提案。
4. 核对后确认，现有切卡/会话事务启动新分支；未确认提案不写原生产故事。
5. 后续原著节点和同场事件是可参考候选，当前分支已提交事实优先，不能复刻/覆盖你的选择。

## 边界

作品原文不全量发给主演，模型只接任务所需的受限证据；source locator和内容指纹可核对。作品包revision不可随分支漂移，旧/未来版本不能冒充当前材料。

重Roll、回档和切卡复用现有分支守卫，不重复推进小说进度。Novel Play不是第二作者、第三Web模式、另一套canonical世界状态或心理画像。

资料管道见 `PLAN-NOVEL-DIGEST.md`，架构 `ARCHITECTURE-NOVEL-PLAY.md`，维护与验证 `NOVEL-PLAY-MAINTENANCE.md`。
