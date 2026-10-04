# 梨园 · 内测说明（群内测试用）

感谢试玩。这是 **Agent 向角色扮演 Web 客户端**（ST 数据可导入，不接 ST 卡自带前端引擎）。

## 环境

- **Node.js ≥ 22.19.0**（与根 manifest、fork packages 和 CI 最低版本一致）
- 任意 OpenAI 兼容 API Key（如 DeepSeek）

## 安装

```bash
git clone <本仓库 URL>
cd Liyuan   # 或仓库根目录若只有这一层
cp liyuan.agent.example.json liyuan.agent.json
cp liyuan.config.example.json liyuan.config.json
# 编辑 liyuan.agent.json，填入 apiKey / 模型 id
npm ci
npm --prefix web ci   # 仅首次需要前端构建时；发行包已有 web/dist 可跳过
npm run web:build   # 若已有 web/dist 可跳过
npm run web
# Windows 也可双击 start.bat
```

浏览器打开控制台打印的地址（默认 `http://127.0.0.1:7620`）。

**请勿把带 Key 的 `liyuan.agent.json` 提交或发群文件。**

## 离线验证 gate（已安装依赖）

```bash
npm test                     # 明确只选 test/*.test.ts，不递归执行 fork 的供应商/e2e 测试
npm run test:frontend-version # hello/重连/前后端版本快照 fixture
npm run test:novel-play       # 小说演出专项，复用相同 Node runner
npm run test:release         # 发布数据策略：仅 /tmp fixture，不运行真打包
npm run test:rest-lifecycle   # REST 接线生命周期：仅临时 fixture，无 HTTP 监听
npm run verify               # 全量后端测试 + web typecheck（不 build、不临时下载 runner）
```

- 不依赖未声明的 `npx tsx` 或临时下载 `node@22`；运行前确认 PATH 中的 Node 满足最低版本。
- 本地审查/自动化应使用隔离的 HOME/TMPDIR，防止 MCP 发现测试读取真实用户配置。测试 fixture 不应指向现有用户数据。
- 部分离线集成测试会创建 loopback 服务；sandbox 禁止 listen 时应标记权限/环境失败，不能绕过 sandbox 或当成供应商/业务故障。
- 区分输出中的“测试文件级 subtest”与文件内 `test()` 用例数。若 runner 只显示文件项，可对一个专项文件直接执行 `node test/<file>.test.ts`，核对内部用例与退出码；不需要全量跑两遍。
- 发布策略测试提取并执行打包脚本内的 Python archive/checker 代码，覆盖目录排除与产品扩展保留。它不执行 PowerShell/robocopy staging；未安装 PowerShell 的主机不能宣称完成真实三平台打包验收。
- 后端 TS 全量检查、fork `src/dist` 重编与真实发布产物验收仍是独立门禁；当前 `verify` 不宣称覆盖它们。

## 建议试用

1. 连接面板：配好模型，确认「已连接」
2. 角色卡：导入自己的 ST 卡（PNG/JSON），点卡进对话
3. 世界书：可多本勾选挂载；点书名只浏览该本
4. 用户身份：切换应接近即时（热更新）
5. 对话：正常 RP。正文分段落笔（`beat_plan` 路标 → `draft_append` 演出 → `draft_seal` 收笔）；封笔、记账后进入独立谢幕轮，agent 按这张卡自行生成状态栏、日历、选项、图片等格式
6. 扩展能力 → Skill：查看/编辑内置工作流 Skill（连续性/Sogon/Sigon/导演/主演/谢幕 + 世界引擎四件：角色卡世界画像/世界推演/拍后事实信封/世界转移审计 + 世界模块包）；编辑保存为用户覆盖（`.liyuan-stage-skills/`），拉取更新不被覆盖
6a. 设置面板 → 后台世界：开启后首拍会自动为当前卡生成**角色卡世界画像**，消息下方显示「世界模块」折叠卡与审计状态；可在「角色卡世界适配」里锁定稳定、调活跃度、启停模块、维护长期要求与优化记录
7. 侧栏面板 / 存档 / 世界线：按需点点
8. 助手：输入框发送键右侧的耳麦按钮（或主输入框 `//` 开头说话）——诊断回复质量、改配置、开关预设块、修世界状态、接外部服务；可为它单独选模型（默认跟随对话模型）

## 已知边界（预期内）

- 不运行完整的 SillyTavern 卡端运行时；卡内显示正则、交互 HTML 与宿主桥接按梨园现有实现处理。v1.7.3 未改变用户认可的可信卡脚本/同源行为，不能把 iframe 设置宣传为不可信脚本的权限隔离。卡要求的输出格式仍由独立谢幕轮按当前卡材料生成。
- 卡内 `extensions` 大段脚本默认不进 prompt；文件仍完整在磁盘
- 公网裸奔有风险：内测建议本机或内网；VPS 请自行反代+鉴权
- 无完整账号体系 / 多用户

## 反馈请带

- 系统：Windows / macOS / Linux + Node 版本  
- 复现步骤  
- 控制台 / `_web-err.log` 相关片段（**打码 Key**）  
- 期望 vs 实际  

## 版本

内测版，接口与配置可能变动。请从本仓库拉取更新，勿依赖未备份的会话数据当唯一存档。
