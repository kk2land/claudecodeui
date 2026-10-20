# DeepSeek Harness provider

目标分支：`codex-app-server`。范围于 2026-10-19 按用户要求调整。

## 已确定范围

- provider id：`dsh`；界面名称：DeepSeek Harness。
- 仅支持 `acp` 和 `headless` 两种执行方式。
- ACP 默认使用 `dsh --profile acp`，headless 使用 `dsh --profile headless --json`。
- 运行中追加输入沿用应用的持久化消息队列，当前任务结束后再发送。
- 不实现 DSH SDK、原生 steer、原生 plan 模式。
- Codex 原有 app-server、SDK 与原生控制独立保留。

## 实现位置与职责

实现集中在 `server/modules/providers/list/dsh/`，包括 provider wrapper、配置、进程生命周期、事件转换、认证状态、模型、历史、同步、MCP 和 skills。复用现有 provider/runtime service、chat run registry、WebSocket/SSE writer、会话索引、消息队列及审批 UI。

共享文件只增加 provider 注册、能力、类型、设置与 UI 入口；数据库使用增量迁移扩展 `provider_models` 的 CHECK 约束，保留已有记录、effort、额外列、索引和自增序号。

## 执行与生命周期

ACP 按应用会话持有进程，连续任务复用同一连接；空闲后回收。实现 initialize、session/new、session/resume、session/prompt、session/cancel、session/close 和会话配置选项。历史索引与进程清理完成前仍保持运行中状态；清理完成并解除运行占用后再发送 complete，使持久化队列能安全派发下一条消息。遇到正在进行的空闲回收时，等待旧进程退出后再恢复，取消期间不启动替代 prompt。传输断开或恢复失败不自动新建会话，也不自动重发可能已经执行的 prompt。

headless 将完整多行 prompt 写入 stdin，避免 shell 转义和命令行参数误解析；使用 `--session-id` 继续已知会话，非零退出码或协议损坏始终作为失败，即使已经收到 final。stdout JSON 的 text 投影可能有截断，终态 final 的完整文本按同一消息身份更新。

应用关闭、用户取消、启动失败和协议错误都经过有界的 stdin EOF、SIGTERM、SIGKILL 清理。不同应用会话、home、工作目录与配置不共享进程。

## 历史与同步

使用锁定版本 `0.2.1-rc.2` 的官方 `@deepseek-ai/dsh-session-format-catalog` 和 `@deepseek-ai/dsh-session` 读取持久化逻辑事件。支持未压缩日志、Zstandard 多帧日志、最新版本化 generation、未完成的末尾追加和分页；不修改、修复或迁移原生日志。聊天历史按日志顺序展示 append-origin 消息，保留压缩前的用户发言、回答与工具调用，不展示仅供模型使用的替换摘要。保留 assistant 消息块里的工具调用并关联工具结果，不将 DSH 的 runtime-context 注入显示为用户发言。未知版本明确报错。读取采用 256 MiB 上限。

会话扫描只索引有工作目录的普通根会话，不把子 agent 加进侧边栏。应用 session id 与 DSH session id 仅根据运行器公布的真实身份建立映射，不按工作目录猜测绑定。尚未匹配的原生日志独立入库，运行器确认身份后由现有合并逻辑归并到对应的应用会话。实时消息与历史分别通过同一归一化组件转换。

## 配置

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `CLOUDCLI_DSH_RUNTIME` | `acp` | 选择 `acp` 或 `headless` |
| `CLOUDCLI_DSH_BIN` | `dsh` | 可执行文件路径，作为独立 argv 启动 |
| `DSH_HOME` | `~/.dsh` | DSH 的配置、凭据和会话 home |
| `CLOUDCLI_DSH_PATCHES` | `[]` | JSON 格式的 patch 文件路径数组，依次传入 `--patch` |
| `CLOUDCLI_DSH_SESSIONS_DIR` | `$DSH_HOME/sessions` | 自定义持久化根目录的只读索引路径；须与 DSH profile 的实际配置一致 |
| `CLOUDCLI_DSH_TIMEOUT_MS` | `30000` | ACP 控制请求与取消的等待上限；普通 prompt 不受此短时限约束 |
| `CLOUDCLI_DSH_IDLE_MS` | `300000` | ACP 空闲进程的回收时间 |
| `CLOUDCLI_DSH_AUTH_ENV` | `DEEPSEEK_API_KEY` | 配置状态检查使用的凭据变量名 |
| `CLOUDCLI_DSH_PROVIDER` | `deepseek-official` | headless 自定义模型未写 provider 前缀时的路由 |

认证状态检查仅检查 CLI 可用性和本地凭据配置；不会发起模型调用验证密钥。headless 默认忽略 DSH managed credential store，应使用启动环境或 `.env`。ACP 也检查原生存储的 API key/账户 grant。导出的空字符串阻止 `.env` 对同名变量的回退。

## 模型、审批、MCP 与 skills

- 默认模型使用 DSH 会话/profile 的选择；自定义模型优先写为 `provider/model` 或 ACP 公布的完整 selector value，实际执行时验证该选择。ACP 中同名模型分属多个 provider 时，拒绝含糊的裸模型名。
- ACP 按运行时公布的选项设置 model/effort。headless 对显式模型生成仅本次运行使用的临时 patch，不改写用户 profile。
- ACP 工具审批复用应用 UI，支持 allow-once、reject-once 和取消。不会把允许一次扩大为永久允许；任务结束后旧审批失效。
- CloudCLI 管理的 MCP 声明保存到 `$DSH_HOME/cloudcli-mcp.json` 和 `<workspace>/.dsh/cloudcli-mcp.json`。同一服务进程按配置文件串行执行完整的读取、增删和写入，并以原子重命名发布结果；失败的更新不阻塞后续保存。ACP 将声明转换为标准配置；headless 通过临时 patch 挂载 MCP client。原生 profile 文件保持独立，已有原生 MCP 配置仍由 DSH 加载。
- MCP 支持 stdio/HTTP；启动前将 stdio 命令从 PATH 或工作目录解析为 ACP 要求的绝对路径。
- skills UI 管理默认 DSH/共享 agent 目录中的目录式 SKILL.md；选择 skill 插入普通指令，不模拟 ACP 原生 slash command。自定义 profile 的额外 skill roots、flat markdown 与特殊插件目录不在当前 UI 发现范围。

## 能力边界

DSH 当前集成不开放图片上传、原生 plan/steer、goal、elicitation、会话 fork、历史消息编辑重跑和累计 token 用量统计。普通文件以路径引用传入。ACP/headless 展示已提交的消息与工具事件，不承诺逐 token 展示。headless 没有交互审批通道，权限由 DSH profile 决定，需人工确认的工具可能被拒绝。

支持应用内归档。永久删除原生 DSH 日志明确返回不支持，避免只删除最新 generation 而重新暴露旧历史；不会假装调用 ACP 原生删除。未知格式或恢复失败保留原始日志，返回可定位的错误。

## 验证与后续维护

专项测试覆盖 ACP 复用、会话身份、模型选择、审批、取消、恢复拒绝、损坏 stdout、headless 多行输入与退出结果、日志压缩与原始历史保留、路径边界、凭据优先级、MCP 存储与老库升级。回归覆盖旧日志与并发新会话不串绑、任务完成瞬间的持久化队列派发，以及 MCP 并发增删和保存失败后的继续更新。前端测试覆盖 DSH setup 和 allow-once 审批。

实施检查：相关后端回归、前端测试、build、typecheck、lint。真实上游模型调用需要部署环境中的凭据另行验证。

`dsh-cli.smoke.test.ts` 另外使用实际发布的 `@deepseek-ai/dsh@0.2.1-rc.2` 进程与本地 HTTP 模型服务联调，不需要真实账户或付费推理。覆盖 ACP/headless 原生文件工具、stdio MCP 与环境传递、长文本 final、连续对话、重启恢复、原生压缩历史及清理。CLI 独立安装，不加入应用运行依赖；提供路径后运行：

```sh
CLOUDCLI_DSH_SMOKE_BIN=/absolute/path/to/dsh \
TSX_TSCONFIG_PATH=server/tsconfig.json \
node --import tsx --test server/modules/providers/tests/dsh-cli.smoke.test.ts
```

未提供该变量时仅跳过需要外部 CLI 的 smoke 测试，其余 DSH 回归继续运行。

根目录 AGENTS.md 继续约束 **main → codex-app-server** 的合并方向。后续改动保持 DSH 自有实现、必要共享注册及独立提交，合并 main 后验证 Codex app-server 和 DSH 两条执行链路。
