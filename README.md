# 梨园 Liyuan

以单主Agent创作正文、以分支保存故事的角色扮演/小说Web客户端。当前本地 **v1.8.6**；本次未创建公开Release。

## 当前功能

- **直出**：已有资料、记忆、世界/生态 → 正常文学导演 → 同一主Agent普通文本。
- **导演**：同一主Agent主持固定3证据、2角度、2审阅，自己起草/修改/定稿；专家不写正文。
- 两模式共用Session Tree、角色账本、启用世界/生态、记忆和原作者完整卡格式。剧情不进入旧询问停点或逐段稿纸门禁。
- `rpNarrative`保存故事，原交付和布局分别保留；格式/领域pending可恢复，不重写已保存故事。
- PNG/JSON卡内世界书自动加载，面板可管理全部启用/停用项；独立书多挂载、按卡补充，明确来源写回。
- SQLite剧情记忆：完整周期窗口、事件卡、原文证据和摘要；按会话/卡/当前分支隔离。云端或本地嵌入是独立设置。
- 导演室提供讨论、大纲提案、小说消化/研究和只读诊断；Novel Play复用现有正文引擎，不建立第二作者。
- 连接面板可逐模型勾选“支持工具调用”，新模型默认支持；不支持的手动取消，不改变生成模式和岗位。
- 主演、专家、世界、生态、记忆和研究按独立岗位选模型。Gemini 3.7/3.8 Flash保留；Luna只使用已核验的原生6入口，不统一替换全系统。

## 启动

Node.js ≥22.19.0，已安装依赖或发行包。源码首次安装：

```bash
npm ci
npm --prefix web ci
cp liyuan.agent.example.json liyuan.agent.json
cp liyuan.config.example.json liyuan.config.json
# 仅在本机私有配置中填API连接、卡与身份，不提交凭据
npm run web:build
npm run web
```

访问控制台打印的本机地址。发行包已有dist时不必重新构建；默认网络边界、鉴权和外部入口按部署者配置，不裸暴露私人服务。

## 使用顺序

1. 连接面板配置模型和Key；核对默认主演及每个岗位，不用保存的旧渠道代替当前可用连接。
2. 导入PNG/JSON角色卡，选择用户身份和预设。
3. 世界书先看“当前角色卡内嵌世界书”；不要为显示而复制挂载，原关闭模块不会自动开启。
4. 输入框选择直出/导演，提交后模式跟随该条输入。
5. 记忆面板配置嵌入和周期；未到周期/尚无成功正文时空库正常，切换向量空间需要明确重建。
6. 需要讨论方向/研究时打开导演室；实战记录只读，不切换生产会话或自动收费生图。

## 维护

```bash
npm run verify
npm run test:lorebook-panel
node web/src/generation-mode.test.mjs
```

浏览器/真实模型/三平台打包另有门禁。部署前核对空闲、备份现有dirty源码/dist和私人资料；不擅自reset、commit、push或Release。

入口文档：[导航](docs/DOCUMENTATION-INDEX.md)、[架构](docs/ARCHITECTURE-OVERVIEW.md)、[正文模式](docs/GENERATION-MODES.md)、[记忆](docs/PLAN-RP-MEMORY.md)、[模型](docs/MODEL-CONNECTIONS.md)、[验证](TESTING.md)、[运维](deploy/VPS-OPERATIONS.md)。

## 隐私与许可

私人card/preset/persona、会话/正文/thinking、API/OAuth/SSH凭据、用户Skill覆盖和截图不进公开提交/发行包。默认素材和合成fixture才是发布数据。

项目使用 PolyForm-Noncommercial-1.0.0，具体以LICENSE为准；第三方方法与素材说明保留于 [来源说明](docs/THIRD-PARTY-INSPIRATION.md)。

## 安装脚本来源

当前安装脚本在维护中的fork主分支。先下载并检查脚本再执行，公开源码不包含本机尚未发布的私有配置或候选部署。

```bash
curl -fsSL https://raw.githubusercontent.com/272loki-sketch/ziyong/main/deploy/install.sh -o install.sh
# 先审阅install.sh，再按其参数选择安装位置/端口
bash install.sh --no-start
```
