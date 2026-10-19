# DeepSeek Harness provider 实施计划

状态：待实施。目标分支：`codex-app-server`。调研日期：2026-10-19。

本次先记录功能范围、接入方案与合并约束，尚未实现 DSH provider。
项目基线为 `cbb55bf137324d49c36b1f815a881b2e98645d2b`；调研时该分支比 `main` 领先 4 个提交、落后 0 个提交。实际开发前重新比较，避免使用过期的差异判断。

## 1. 目标与接入选择

- 新增独立 provider，内部 id 建议为 `dsh`，界面显示名为 **DeepSeek Harness**。
- 这里接入的是能执行工具、维护会话的 Harness，不是只增加一个 DeepSeek 模型 API。
- 优先通过官方 `dsh --profile acp` 的常驻 stdio JSON-RPC 服务接入，复用项目现有会话、消息、权限和队列设施。
- Codex 保留自己的 app-server/SDK 路由；DSH 不经过 Codex 协议，也不复用 Codex 私有控制状态。
- 先交付可用的 provider，再单独补齐经过验证的高级交互。以实际安装版本的握手和运行结果决定能力。

## 2. 已确认的协议能力与边界

以下基于官方源码和文档；DSH 调研快照为 `687f282e8625c6b8d11ff58211a90524be2e4317`。源码中的 CLI 版本为 `0.2.1-rc.2`，**不代表已经验证了同版本 npm 发布包**。实施第一步必须锁定实际可安装版本并核对差异。

| 接入方式 | 已有能力 | 影响接入的限制 | 本计划的用途 |
| --- | --- | --- | --- |
| 官方 ACP：`dsh --profile acp` | 常驻 stdio；创建、列举、恢复、关闭会话；发送与取消；模型/effort 选择；工具审批；语义消息更新；stdio/HTTP MCP | 每个会话只允许一个在途 prompt；恢复不回放历史；不提供 modes、commands、plans、fork、elicitation 等交互扩展；消息更新以提交事件为主 | 首期主线 |
| 官方 SDK：`dsh --profile sdk` | 常驻 stdio；会话 prompt/resume/wait；原始持久化事件通知；TypeScript 客户端；prompt 返回入队凭据 | 当前 wire 没有专用的中途取消或 steer 方法；没有完整的服务端向客户端审批请求流；入队凭据不等于本轮已经采纳 | 对照验证，不在首期维护第二套 runtime |
| Headless：`dsh --profile headless --json` | 一次任务的 JSON 事件流；可用 session id 继续会话 | 每次运行结束即退出；无交互追加；不是完整的实时 UI 服务 | 仅用于排查或对照，不作为主线 |

必须区分：

- **队列追加**：当前任务完成后发送下一条，首期沿用应用的持久化消息队列。
- **原生 steer**：当前任务运行中接收并采纳新输入。官方 ACP 的单 prompt 约束不能被当作这项能力。
- **原生 plan 模式**：需要真实的模式/工具权限控制。给 prompt 加上“只做计划”不能视为等价实现。
- **语义流**与 **token 流**：首期可持续展示已提交消息、思考和工具状态，不承诺逐 token 输出。
- **恢复会话**与 **读取历史**：ACP resume 只恢复后续运行，不会把旧消息发回 UI，历史读取必须另做。

## 3. 首期必须实现的功能

### 3.1 Provider 注册与界面入口

- 增加 `DshProvider`，按现有合同提供 runtime、auth、models、mcp、skills、sessions、sessionSynchronizer 七个 facet。
- 补全服务端/前端 provider 类型、路由校验、能力矩阵、选择器、名称/图标、登录状态、设置页和中英文文案。
- 验证会话 provider 标记、模型选择、草稿和权限偏好的持久化，不让 DSH 回落到 Claude/Codex 默认值。
- 清查启动入口、定时消息和 API 中的 provider 白名单。通用聊天路径接入 DSH；仅限某 provider 的 workflow/任务功能继续按能力限制。

### 3.2 启动、配置与认证状态

- 支持配置 DSH 可执行文件路径、profile、patch 文件、`DSH_HOME` 和子进程环境。
- 应用侧拟用 `CLOUDCLI_DSH_BIN`、`CLOUDCLI_DSH_PROFILE`、`CLOUDCLI_DSH_PATCHES`；这些是拟定配置名，不是 DSH 原生参数。实现时在 `.env.example` 和 README 中说明格式与优先级。
- 路径与参数分开传递，patch 列表使用结构化数组；不经 shell 拼接启动命令。
- 检测未安装、启动失败、版本不兼容、凭据缺失/失效、握手超时等状态。
- ACP 的 `authenticate` 成功不代表上游模型凭据有效；auth facet 需检查实际 profile/凭据状态，并保留请求失败的准确原因。
- 使用 DSH 自身的凭据与配置，不使用 `CODEX_HOME`。不同 home、工作目录或凭据上下文不得误共享进程。
- 首期按应用会话持有并复用子进程，增加空闲回收和应用退出清理；先确保隔离与取消正确，再考虑跨会话进程池。

### 3.3 会话执行与实时展示

- 实现初始化、创建、恢复、发送、取消、关闭的完整生命周期。
- 保留应用 session id 与 DSH session id 的映射；恢复失败要报错，不静默创建新会话。
- 将文本、思考、工具开始/完成/失败、审批、用量与终止结果映射到现有 normalized message。
- 复用 runtime service、chat run registry、session writer 和现有 WebSocket 订阅/重放，不新增一套聊天传输协议。
- 同会话串行发送，运行中输入进持久化队列；取消和队列暂停/恢复有清楚的状态。
- 超时或连接断开时区分已失败与投递结果未知；未知请求不自动重发，避免重复执行。
- 浏览器刷新不应直接销毁后台任务；进程异常、应用重启和正常关闭都要释放审批、句柄与队列占用。
- 按官方 ACP 的完成语义处理后代任务和更新排空，避免根消息结束后过早标记整次任务完成。

### 3.4 历史、索引与重连

- 实现 DSH 会话的扫描、增量同步、分页历史、标题/时间/工作目录提取，以及与项目的关联。
- 历史优先通过 DSH 公开持久化读取接口或受支持的逻辑事件解码层读取；不从 TUI 文本推断。
- 官方持久化默认支持 Zstandard 压缩和版本化日志，不能只用 `.jsonl` 文本读取器或文件后缀假设。核对当前与受支持历史格式、尾部未完成写入以及格式升级行为。
- 若公开读取接口无法在当前架构独立使用，先验证独立 DSH bridge 或专用 profile 的可行性；这个问题是首期历史功能的交付门槛。
- 即使专用 profile 为新日志关闭压缩，也必须明确对现有压缩会话的读取支持范围，不能把它当作已有数据的通用解法。
- 为实时事件和历史事件建立稳定消息身份，重连、文件同步与主动历史加载后不重复显示。
- 区分 UI 归档/删除与 DSH 原生删除；当前 ACP 不提供原生删除，不伪造协议成功。
- 支持已有 DSH 会话的能力以兼容性验证为准，不自动迁移、改写或修复用户日志。

### 3.5 模型、effort 与用量

- 读取运行时公开的模型配置选项，将选择转换为 DSH 的真实 provider/model 路由。
- 将模型与 effort 选择保存到应用会话；变更按协议用于下一次 prompt，不误报当前任务已经切换。
- 增加 DSH 自定义模型的服务层验证与数据库支持。
- 当前 `provider_models` 表有仅允许四个 provider 的 CHECK 约束；新增 id 需要同步 fresh schema 与已有数据库的增量迁移，并保留既有模型及 effort 数据和索引。
- 只开放当前模型真正支持的 effort、图片与用量字段；缺失用量不按零用量展示，不混淆 context usage 和累计计费 token。

### 3.6 权限、附件、MCP 与 skills

- 将 ACP 权限请求接入现有审批 UI；首期提供实际支持的 allow/reject，不虚构“永久允许”。
- 复用断线重连的待审批恢复；取消或关闭时使旧审批失效，防止误应用到下一任务。
- 图片只在协议、存储与实际模型路由共同支持时启用；文件优先按受支持资源引用处理，校验工作区和上传路径。
- MCP 先支持官方 ACP 接受的 stdio/HTTP 声明，并在新建、恢复会话时传入；明确运行时挂载和 DSH 持久化配置的差别。
- 核对原生配置格式后实现 MCP/skills 的读取与管理；未实现写入的按钮按能力隐藏或返回明确的不支持结果。
- skills 发现使用实际 DSH profile 的工作区与用户作用域，不照搬 `.codex` 或 `.claude` 路径。

## 4. 高级交互的独立工作项

这些是完整体验的目标，不能只因为 Codex 已有对应按钮就标记为 DSH 已支持。

| 功能 | 实施要求 | 开放条件 |
| --- | --- | --- |
| 原生 steer | 调研 DSH 公开 Agent/会话控制插件接口；必要时提供独立、版本化的 DSH bridge/profile。验证消息接收、采纳时点、排序、幂等和不确定投递恢复 | 有真实运行中采纳的验证用例和能力声明；否则继续使用“排队” |
| `/plan` 与模式切换 | 验证 DSH 原生 plan 插件及其控制接口，明确只读约束、切换时点和执行恢复；不靠提示词模拟 | 当前 runtime 能可靠设置/读取模式并执行约束；否则隐藏或明确拒绝该模式 |
| 用户问题/elicitation | 评估插件接口与现有问答 UI 的映射；官方 ACP automation 接口当前不提供此能力 | 问题身份、答复关联、断线和取消流程验证通过 |
| 逐 token 流与丰富工具卡片 | 单独评估 DSH 公开 live/follow 接口或 bridge；保持既有消息身份和重连语义 | 不依赖未公开 Web 私有协议，且可在支持的版本上验证 |
| fork、历史消息编辑重跑 | 验证正式持久化/分支接口；当前 ACP 不提供 fork | 有可恢复的新会话与原始历史保护；不能仅复制 UI 消息 |

高级功能若确需共享控制合同，只做有实际消费者的增量扩展，保留现有 Codex 协议和字段兼容。不要为预计中的 DSH 功能先重命名全部 `CodexControlAction`、`CodexSessionState` 或重写整个 composer。

## 5. 预计涉及的代码位置

| 范围 | 位置与改动边界 |
| --- | --- |
| DSH 实现主体 | 新增 `server/modules/providers/list/dsh/` 内的 wrapper、runtime/ACP adapter、events、auth、models、sessions、synchronizer、MCP 与 skills 实现；使用 TypeScript |
| 公共注册与能力 | `server/modules/providers/provider.registry.ts`、`provider.routes.ts`、`services/provider-capabilities.service.ts`；主要增加 DSH 注册与真实能力 |
| 后端公共合同 | `server/shared/types.ts`、`interfaces.ts`、`index.ts`；尽量复用现有合同，必要扩展保持兼容 |
| 数据库 | `server/modules/database/schema.ts`、`migrations.ts` 和相关 repository；增量迁移并覆盖老库升级 |
| 历史索引 | providers 内的 `sessions-watcher.service.ts`、同步与历史缓存服务；增加 DSH 的真实根目录、文件过滤和身份映射 |
| 前端接入 | `src/shared/types.ts`、`constants.ts`、selectedProvider、userSettings；chat、provider-auth、settings、sidebar 的必要入口 |
| 现有 Codex 控制 | `codex-chat-control.service.ts`、`useCodexControls.ts`、`CodexControlPanel.tsx` 保持 Codex 专用；DSH 基础接入不借用这些控制 |
| 文档与依赖 | `.env.example`、README、providers README、本计划；只引入必要且匹配版本的 ACP/DSH 依赖和对应 lockfile 变化 |

路径以当前 tree 为准。现有 providers README 中仍有 `src/components/...`、`src/types/app.ts` 和新增 JS runtime 的旧例子；实施时按实际 `src/modules/...`、`src/shared/types.ts` 与项目模块规范落地，不复制过时路径。

## 6. 实施顺序与验收

### 阶段 A：协议与持久化验证

1. 锁定可安装 DSH 和 ACP SDK 版本，验证帮助、握手、配置选项及能力差异。
2. 用一个最小集成程序完成创建、发送、审批、取消、关闭、进程重启后恢复。
3. 验证历史读取与压缩/版本兼容方案，明确首次使用与已有会话的支持边界。
4. 把已验证能力和限制补回本计划；历史读取、进程回收或隔离方案未通过时先修正方案。

### 阶段 B：后端 provider

1. 完成独立 provider、进程生命周期、事件归一化、session 映射和历史同步。
2. 完成模型/认证/能力接入及数据库升级。
3. 接通权限、队列、附件与 MCP/skills 的受支持部分。
4. 通过 backend 的协议故障、取消/重连、消息去重和老库升级测试。

### 阶段 C：界面与端到端

1. 接入选择器、状态、模型、设置、会话列表和中英文文案。
2. 验证新会话、多轮、运行中排队、停止、刷新、重连及应用重启恢复。
3. 验证两个不同工作区和 home/凭据上下文，确保内容、审批和取消不串会话。
4. 验证未安装、凭据错误、不支持的图片/模式和传输断开均有准确提示。
5. 更新配置与部署文档，并对 Codex app-server、Codex SDK、Claude、Cursor、OpenCode 运行受影响回归。

### 阶段 D：高级交互

按第 4 节逐项验证并交付，分别提交。每个功能均要求明确能力声明、UI 状态、失败路径与有意义的回归用例。

功能实施时按仓库要求运行受影响测试，再执行适用的 `npm run test:client`、`npm run build`、`npm run typecheck`、`npm run lint`。真实 DSH smoke test 独立运行并明确版本、profile 与凭据要求，不让普通测试依赖外部模型调用。本次仅改文档，验证文档内容、链接和提交范围即可。

## 7. 持续合并 main 的约束

根目录 `AGENTS.md` 已记录长期要求：**把 `main` 的更新合并进 `codex-app-server`**，新增功能必须便于维护这个方向。

- 大部分新增代码和测试留在 DSH 自己的目录/所属模块。
- 共享文件只做必要且集中的注册、能力与兼容合同改动，不进行全仓格式化、搬目录或无关重构。
- 保留 main 的迁移历史、模块边界和公共接口；避免长期维护一套复制的聊天/权限/队列基础设施。
- provider 实现、必要公共接入、数据库迁移和无关修复保持可单独评审的提交边界。
- 以后合并 main 时，同时检查新变化在 Codex app-server 和 DSH 上的行为；不只处理文本冲突。

## 8. 调研依据

以下官方材料于 2026-10-19 检查；后续开发应以锁定的发布版本再验证：

- [DSH CLI 与 profiles](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cli-help.md)
- [官方 ACP 合同与限制](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/README.md)
- [官方 ACP 应用组合](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/acp-app/README.md)
- [TypeScript SDK 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/README.md)
- [SDK 请求与事件类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/protocol/src/types.ts)
- [持久化格式与压缩](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/README.md)
- [公开会话控制接口](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/README.md)
