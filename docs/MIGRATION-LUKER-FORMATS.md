# Luker 格式迁移到梨园原生展示

## 原则

Luker/ST 世界书常把设定、EJS 程序、MVU 变量、JSON Patch、整月日历、每拍小剧场与 HTML 正则
混在同一文件。梨园不执行世界书 EJS/getvar/getMessageVar，也不让第二套变量系统与 `rp-state`、
`rp-world-state`、`rp-ecology-state` 争夺权威。

迁移后：

- 玩家状态由 `rp-state` 确定性投影；
- 日历由 `rp-state.time` + 世界制度模块 + 生态 occurrence 确定性合并；
- `UpdateVariable` / MVU JSON Patch 退场；
- 未来日期没有权威事件就保持空白，不由模型逐日随机补全；
- BBS/小剧场和选项是展示性创意，不是世界事实，走短旁路或原生数据源；
- 世界书保留正典设定、人物资料和视觉皮肤；脚本 iframe 不给同源权限。

## 日式中专大乱斗处理记录

已禁用：

- MVU/UpdateVariable：uid 8/9/14/15/17/175/233；
- 初始化/DLC JSON Patch：uid 4/114/116/124/127；
- 强制变量结构：uid 112；
- 旧动态控制器：uid 169/172/173/174/178/182；
- uid 280（BBS）和 uid 281（日历）的格式/内容资料保留启用，但不再承担变量权威；
- 四条 Luker 正则保留启用为视觉皮肤；运行时按规则指纹去重，贴吧模板 `\$1` 已迁为梨园
  替换器使用的 `$1`。脚本帧移除 `allow-same-origin`，不能读取父页或同源存储。

保留：普通世界设定/人物 lore，以及用户维护的 `世界线变动`（uid 282）。

## 梨园原生投影

`src/presentation.ts` 提供：

- `projectPlayerStatus`：只读 `rp-state`；
- `parseNarrativeDate`：只认明确年月日，解析不出不猜；
- `projectCalendar`：代码生成本月天数/星期，只合并世界与生态已提交、非 secret 的事件；
- `projectPresentation`：组成 wire 展示视图，不新增第四套状态权威。

谢幕格式也按当前卡生成确定性 `formatPlan`：模型只生成 `modelTags`；卡正则入口由代码补齐，
日历由上述原生投影生成；未被当前卡声明的已知标签进入 `forbiddenTags`，避免历史回复、通用
Skill 示例或其他卡的 `user_now_status` 等格式串入当前卡。

前端 `Messages.tsx` 默认用 React 折叠卡；检测到挂载的日历/BBS皮肤时，把结构化投影序列化为
旧标签输入，继续使用原作者 HTML/CSS 视觉。旧历史 `rpCurtain` 只读兼容；新展示投影不生成
`<UpdateVariable>`。
