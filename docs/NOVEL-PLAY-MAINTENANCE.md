# 当前小说开演维护

Novel Play复用Corpus、既有卡/Session/StageEngine，不是第三种正文模式。模块关系见 `ARCHITECTURE-NOVEL-PLAY.md`。

## 核验链

1. Corpus文档ready与原文证据有效。
2. 不可变作品包revision、内容指纹和依赖可复核，模型事件引句须逐字匹配源块。
3. 开演候选只使用锚点允许的资料；待确认提案不改生产卡或当前分支。
4. 确认后使用现有角色卡与switchToCard事务，Session Tree仍是唯一故事树。
5. 分支进度/原著候选按版本、当前祖先链、冲突来源门禁；重Roll不重复推进元数据。

## 当前正文接线

直出保留正常导演，导演模式由同一主Agent固定3/2/2分工；候选和原著背景不是已发生事实。主Agent普通文本，事实/原作者交付/格式布局分离；不要沿用旧稿纸拒收、HTML清空或逐角色排演方案诊断新模式。

## 失败和回滚

坏引句、版本漂移、路径穿越、过期提案和源不可用均拒绝提交。后台失败保留检查点，不把空结果标ready。删除/重新构建包不覆盖当前已发生剧情；恢复制品需原版本门禁。

## 验证

`npm run test:novel-play`涵盖合成来源、提取/原文、包/版本、开演确认/事务、运行候选/分支和UI。真实原著、私人卡、开演会话及thinking不进入fixture或提交。

入口：`src/novel-play/`、`server/novel-play-api.ts`、`web/src/planning/novel-play.tsx`。运行记录应报告source/版本/候选/提交分开状态，不只看“有返回”。
