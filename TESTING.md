# 当前验证与测试边界

本地v1.8.7，结果与未覆盖项见 [本次验收](docs/VALIDATION-20261007.md)。不要把旧版本测试数字、部署或失败恢复当成本次结果。

## 离线门禁

```bash
npm run verify               # test/*.test.ts + 前端版本 + 连接配置回归 + web typecheck
npm run test:connect-config  # 默认/覆盖/未知字段保护（离线）
node test/model-tool-support.test.ts  # runtime/引擎/本机合成HTTP（不调外部模型）
npm run test:lorebook-panel  # 内嵌书、来源/修订/行键、PNG、批量与缓存
npm run test:database-plugin
# 原脚本浏览器验收必须显式提供已校验的缓存和合成宿主，不下载/写生产：
LIYUAN_DATABASE_PLUGIN_TEST_SOURCE=/tmp/index.js LIYUAN_DATABASE_PLUGIN_TEST_VENDOR=/tmp/vendor npm run test:database-plugin-browser
node test/memory-narrative-window.test.ts
node test/memory.test.ts
node test/rp-memory.test.ts
node test/rp-memory-longrun.test.ts
node test/stage-compact.test.ts
node web/src/generation-mode.test.mjs
npm run test:release
```

Node≥22.19.0，使用已安装依赖，不临时下载tsx。测试HOME/TMPDIR/Agent/素材全部隔离；部分测试会启本机监听，权限失败不能当业务失败。

## 浏览器和构建

候选dist构建至临时目录，支持 `LIYUAN_LORE_DIST` / `LIYUAN_READER_DIST` / `LIYUAN_CONNECT_DIST`；`test:lorebook-browser`、`test:record-reader`使用合成数据，无剧情模型调用。截图/日志留临时目录。桌面与手机检查来源入口、全文、过期请求、只读Portal、溢出和页面错误。

`npm run test:connect-browser`使用隔离合成配置核验逐模型工具开关、保存/刷新/重新开启、失败不假成功、多渠道/未知字段/默认模型保护及手机布局；截图可指定 `LIYUAN_CONNECT_ARTIFACTS`，不会试写生产API配置或调用收费模型。

## 记忆真实检查

生产只读查看当前scope、成功正文拍数、库/游标/来源和向量空间；不读或公开原文。云端连通与“写→查→兄弟分支不可见”使用独立临时库及合成文本，不人工写生产剧情，不调用聊天模型重演。

## 真实模型与发布

少量真实连接/工具请求只验证该端点，不证明全部长剧情、reasoning参数或供应商配额。长静默网络回归优先用合成上游，保留真实链路和时长。

`verify`不等于全后端tsc、fork src/dist重编、三平台实际打包或公开Release。新检查若有旧错误要和基线区别，不能伪称全量清零。真实模型/备份私有产物不能放入提交。

## 保护

默认模型、Gemini 3.7/3.8配置与岗位单独作前后比对；只处理Luna自身新名。升级前保存会话身份/模式、私人素材/配置/用户Skill与记忆数据摘要，空闲后部署；正文及既有记忆不因修复清空或重生成。
