# GPT Web provider 接入计划

- 日期：2026-10-20（实施时按最新要求改为 CODEX_GPTWEB_HOME）
- 目标分支：`codex-app-server`（开发分支：`codex-app-server-gpt-web`）
- 当前状态：已实现代码接入；真实桥接环境的端到端验证待部署后进行。

## 1. 目标与边界

在 claudecodeui 中新增独立 provider：`gptweb`，界面名称建议为 `GPT Web`。

- 执行链路复用现有 Codex app-server：`claudecodeui → codex app-server → codex-chatgpt-web → ChatGPT Web`。
- 启动 gptweb 对应的 Codex 子进程时，将 `CODEX_HOME` 设置为环境变量 `CODEX_GPTWEB_HOME` 指定的绝对路径。
- 由该目录中已有的 `config.toml` 决定模型路由；claudecodeui 读取配置，不生成或重写路由。
- 模型目录来自 codex-chatgpt-web 的接口，不复制普通 Codex 的静态模型列表。
- 用户负责部署 codex-chatgpt-web、网页登录、完整 harness/MCP/tunnel 配置，以及 `$CODEX_GPTWEB_HOME` 的全部初始化。
- 本次接入不实现 codex-chatgpt-web 启动器、浏览器自动化、安装向导或另一套 Responses 客户端。
- gptweb 首版以当前 app-server 主路径为实施目标，保留已有 Codex 能力的复用方式；SDK 模式同样复用现有实现，并注入相同的独立环境；失败时不自动切换模式。

需要区分两种 provider：claudecodeui 中的 `gptweb` 是本项目的 provider 标识，与 Codex 配置里的 `model_provider` 名称相互独立。

## 2. 已核实的上游前提

本计划参考 codex-chatgpt-web 提交 `cdfceafd51df9ab6f19818c145eac5a99c593a3d`。实际部署版本仍需在联调时确认。

当前分支的 app-server transport 使用项目依赖中的 `@openai/codex`，`package.json` 固定版本为 `0.156.1`。前置验证必须使用项目实际启动的这份 CLI，不能仅用系统 PATH 中的另一个 Codex 版本证明兼容；是否需要升级依赖应由联调结果决定。

### 2.1 自定义 model_provider 需要先验证

上游当前安装校验 `assertBuiltinModelProvider()` 明确要求内置 `openai` provider；选择其他 `model_provider` 时会拒绝安装/重连。其受支持的路由方式是通过 `openai_base_url` 指向本地桥接服务。

因此，“在 config.toml 配置自定义 provider”不能先作为已验证的前提。实施前应在用户准备好的环境验证该配置能否完成真实请求。若使用现行上游安装流程，应由用户按上游支持的路由方式配置。本项目不擅自调整 `model_provider`，也不为此增加上游改造范围。

来源：[路由与 provider 校验](https://github.com/miuuyy/codex-chatgpt-web/blob/cdfceafd51df9ab6f19818c145eac5a99c593a3d/src/codex-integration-route.ts)。

### 2.2 模型接口及鉴权

- 模型接口为 `GET /v1/models`；健康接口为 `GET /healthz`。
- 当前默认监听地址为 `127.0.0.1:17841`；实现从有效配置解析地址，不把该默认端口写死为唯一值。
- 返回格式是 Codex 模型目录 `{ models: [...] }`，不是标准 OpenAI `{ data: [...] }`。
- 模型目录会合并原生 Codex 模型和 Web 模型。Web 模型的 slug 以 `chatgpt-web/` 开头；旧版本兼容项可能标为 `visibility: "hide"`。
- `/v1/models` 会携带请求鉴权向原生 Codex 模型接口请求模板，要求有效的 Bearer 鉴权，并涉及 `client_version`。不能按“无需认证的本地 GET”设计。
- 模型提供 `display_name`、`description`、`default_reasoning_level`、`supported_reasoning_levels`、上下文窗口和输入模态等信息。Web 模型没有原生 Codex 的 Fast/service tier。

来源：[HTTP 路由](https://github.com/miuuyy/codex-chatgpt-web/blob/cdfceafd51df9ab6f19818c145eac5a99c593a3d/src/server.ts)、[模型目录](https://github.com/miuuyy/codex-chatgpt-web/blob/cdfceafd51df9ab6f19818c145eac5a99c593a3d/src/model-catalog.ts)、[请求转发及鉴权](https://github.com/miuuyy/codex-chatgpt-web/blob/cdfceafd51df9ab6f19818c145eac5a99c593a3d/src/native-passthrough.ts)。

### 2.3 完整工具能力与第二个 CODEX_HOME

文件修改和终端操作需要部署端启用 Full harness。Browser-only 模式不提供本地工具，不能以纯文本成功作为完整接入成功。

若桥接服务自身使用另一个 Codex home，需要在启动桥接服务/启动器的环境中注册 `CODEX_GPTWEB_HOME` 的绝对目录，使用上游的 `CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES`。仅给 claudecodeui 的 Codex 子进程设置 `CODEX_HOME` 不会完成这项注册。此步骤属于用户负责的部署前提。

来源：[架构及 home 注册边界](https://github.com/miuuyy/codex-chatgpt-web/blob/cdfceafd51df9ab6f19818c145eac5a99c593a3d/docs/architecture.md)、[第二个 CODEX_HOME 的说明](https://github.com/miuuyy/codex-chatgpt-web/blob/cdfceafd51df9ab6f19818c145eac5a99c593a3d/TROUBLESHOOTING.md)。

## 3. 复用设计与隔离边界

原则：复用 Codex 协议实现，分别创建实例。为现有组件增加少量必要的实例参数，不复制整套 Codex 代码，也不进行跨目录的大范围迁移。

| 对象 | 普通 Codex | GPT Web |
| --- | --- | --- |
| claudecodeui provider 标识 | `codex` | `gptweb` |
| Codex home | 普通 Codex 的有效 home | `$CODEX_GPTWEB_HOME` |
| app-server 传输连接与进程 | 原有实例 | 独立实例 |
| 运行中会话、RPC 订阅、审批请求 | Codex 实例内维护 | gptweb 实例内维护 |
| 模型目录 | 现有 Codex 目录 | 桥接服务 `/v1/models` 中可见的 Web 模型 |
| 会话和运行参数 | 按会话保存 | 按 gptweb 会话保存 |
| 进程停止、队列暂停 | 仅作用于 Codex | 仅作用于 gptweb |

具体改动：

1. 为 Codex transport、runtime、fork client、会话适配器提供 provider 标识、home 和必要依赖的注入点；由各 provider 组合实例。
2. 仅在创建 gptweb 子进程时构造环境覆盖，例如 `{ ...process.env, CODEX_HOME: absoluteGptwebHome }`，不修改父进程的全局 `process.env.CODEX_HOME`。
3. 固定使用 stdio app-server 连接，沿用现有请求、通知和退出恢复机制。停止、重启及关闭时释放各自的进程和订阅。
4. 将运行事件、历史消息、审批事件和通知中的 provider 标识参数化，确保 gptweb 消息不会以 `codex` 身份写入或广播。
5. 使停止进程前的队列暂停操作按实际 provider 筛选；当前 `holdCodexAppServerQueues()` 的 Codex 固定范围需要支持 gptweb。
6. 保持现有普通 Codex 的默认行为；gptweb 的失败独立报告，不自动切换到普通 Codex 执行。

## 4. 具体接入范围

### 4.1 新 provider 与共享契约

在 `server/modules/providers/list/gptweb/` 放置 gptweb 的组合入口、配置读取、模型和状态检查适配器。

为 backend/frontend 的 provider 类型、注册表、provider 校验、能力矩阵和必要的 provider 列表增加 `gptweb`。复用既有 provider API，不额外开一套聊天接口。

前后端遵循仓库 `backend-module-standards` 和 `frontend-module-standards`。共享文件只增加实际需要的类型或扩展参数，以便后续合并 main。

### 4.2 会话、历史与配置路径

现有代码多处直接使用 `~/.codex`，不能只修改启动环境。需要逐项适配：

- 会话扫描、`session_index.jsonl`、rollout 查找和目录监听。
- 历史分页、刷新后恢复、重命名、删除、搜索及 orphan 清理。
- 分叉和消息编辑所用的 app-server 连接与历史路径。
- Token 用量、上下文预算及相关 transcript 解析。
- 用户级 MCP、Skills 的读取路径和 provider 标签。
- 若保留终端启动入口，给其中的 Codex 命令应用同一 gptweb 环境。

项目内的 `.codex` 配置及 `.agents/skills` 仍遵循 Codex 本身的规则，不因用户级 home 变化机械改名。用户级可写操作必须明确归属 gptweb，初始化和路由设置仍由用户管理。

审计 session id 查找是否包含 provider 归属；防止扫描两个 home 时将同一外部线程错误关联到另一 provider。保持现有会话数据和索引。

### 4.3 动态模型目录

独立实现 `GptwebModelsProvider`，通过后端访问 `/v1/models`：

1. 从 `$CODEX_GPTWEB_HOME/config.toml` 的生效路由解析模型服务地址；兼容最终验证通过的配置方式，避免另设必须同步维护的地址。
2. 在服务端处理该 profile 的鉴权、所需请求头和 CLI 版本信息；令牌不发给浏览器。读取配置要求的环境密钥、请求头或该 home 中现有的 auth.json；凭据失效时明确返回认证错误，刷新/重新登录仍由外部 Codex 与启动器管理。
3. 使用 `slug` 作为实际 model id，映射名称、描述、默认 effort 和可选 effort。
4. 新建会话只列出 `chatgpt-web/` 前缀下可见的模型；隐藏兼容项不进入新建选择器，已有会话保留记录以便恢复。
5. 按每个模型实际 metadata 展示 effort；图片输入和上下文用量继续复用 Codex 的既有能力和事件；不把普通 Codex 的全部 effort 或 service tier 套给 Web 模型。
6. 优先使用已保存的会话模型；新建会话优先使用有效配置中可用的 Web 模型，否则选择目录中的首个有效模型。不默认选中混入目录的原生 Codex 模型。
7. 以 provider/profile、有效地址和凭据摘要为缓存范围，建议短缓存约 60 秒并合并并发请求。配置或身份变化时使缓存失效；刷新路径应能请求新目录。
8. 区分服务不可达、401/403、目录格式错误和没有可用 Web 模型。失败时不使用静态目录兜底；发送失败不触发换模型或跨 provider 重试。

现有模型服务会在读取时合并自定义模型，新增适配器应保持这条公共路径。需要对 gptweb 的自定义模型标识及实际可执行范围做校验，避免通过普通原生模型 id 绕开 Web provider 的含义。

联调时比较 HTTP 目录与该 app-server 实际接受的模型集合；特别验证自定义 model_provider 是否能识别这些模型，不能只证明 HTTP 接口返回了列表。

### 4.4 plan、steer 与运行控制

gptweb 使用同一 Codex app-server 协议实现，接入以下现有功能，并逐项联调：

- 普通发送、继续会话、流式输出、工具执行与审批。
- `/plan`、执行计划、运行中追加提示词/steer。
- 停止任务、排队消息、断线恢复和 steer 投递确认。
- 历史、会话命名、分叉及消息编辑。
- 已有 Goals 功能继续遵循实际能力和现有开关，不因新增 provider 自动开启。

当前 `ChatInterface`、`useCodexControls`、slash commands、`codex-chat-control.service` 和部分状态查询只接受 `codex`。应根据实际 nativeControls 能力和会话所属 provider 调度，复用控制逻辑，避免另写一份 gptweb 控制器。

协议复用不等于桥接模型已通过每项端到端验证。遇到上游模式不支持的功能应明确展示或隐藏能力，不能静默替换成提示词模拟。

### 4.5 页面、状态和数据库

- Provider 选择器、侧栏、消息标识、设置、模型库和必要的国际化文案增加 GPT Web。
- 连接状态区分：Codex 可执行程序、配置是否可读取、桥接服务是否可达，以及实际请求是否通过认证。配置存在不等于 ChatGPT 网页已登录。
- 用户继续在外部启动器管理网页登录；gptweb 不引导到普通 Codex 的默认 home 登录流程。
- 运行模式和 provider 专属 UI 由能力驱动，避免在共享 UI 四处增加独立条件分支。
- 为 `provider_models` 的 provider CHECK 约束增加兼容迁移，保留已有数据、列、索引、触发器和自增序列。核查其他 provider 枚举约束，不改写已有历史迁移。

## 5. 实施阶段

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| 0. 部署前置验证 | 验证用户准备的 home、实际 Codex 版本、路由方式、鉴权、Full harness 和 trusted-home 注册 | 使用相同 Codex 可执行程序和 `CODEX_HOME` 能完成目录查询及一次工具调用；自定义 provider 的兼容性有明确结论 |
| 1. Codex 实例复用 | 增加最小实例参数，拆开 transport/runtime/fork 和 home 路径依赖 | 普通 Codex 回归通过；两个 provider 的进程、事件和停止操作彼此独立 |
| 2. gptweb 后端 | 注册 provider，接入模型目录、状态检查、会话及相关迁移 | 后端能创建、恢复 gptweb 会话，模型和历史归属正确 |
| 3. 前端与控制 | Provider UI、动态模型、effort、plan/steer、队列、审批及错误提示 | 用户可从界面完成现有 Codex 工作流，控制请求发送到正确 provider |
| 4. 回归与部署说明 | 定向测试、构建检查、真实桥接联调，记录部署前提和排障说明 | 验收项通过；普通 Codex 与 DSH 行为保持兼容 |

建议将必要的 Codex 参数化、gptweb 适配器、共享 UI/契约集成分别组织为可审核提交，保持共享文件的改动集中。

## 6. 验收与测试

必须覆盖的行为：

1. 同时运行 Codex 与 GPT Web，分别使用各自的 home，消息与工具事件归属正确。
2. 停止/重启 GPT Web app-server 只影响 GPT Web 的任务与队列；反向同样成立。
3. 刷新页面和重启服务后，能恢复 GPT Web 历史、名称、模型与 effort；会话扫描不会重新标记为 Codex。
4. 模型列表来自真实接口，原生模型和隐藏项过滤正确，每个模型的 effort 与接口一致。
5. Full harness 下完成一次读取文件、一次文件修改和一次终端命令；图片能力按所选模型验证。
6. 完成 `/plan`、执行计划、运行中 steer、停止、审批和断线后投递状态恢复的联调。
7. 配置缺失、服务关闭、鉴权失败、列表为空、所选模型下线都有可理解的错误；不影响其他 provider。
8. 旧数据库迁移后，原有 Codex/DSH 会话与自定义模型仍然存在。

自动测试重点：环境覆盖与实例隔离、模型目录归一化及失败处理、provider 路由与目录归属、控制请求分发、迁移保留数据，以及前端 provider/model 切换。复用现有 Codex 回归测试验证协议能力，避免重复编写同一套协议测试。

实现后执行受影响的定向测试，再运行 `npm run test:client`、`npm run build`、`npm run typecheck`、`npm run lint`。真实 ChatGPT 网页与 Full harness 验证需要用户已部署并登录的环境；计划阶段不启动这些真实操作。


## 7. 已实现的环境变量约定

- `CODEX_GPTWEB_HOME` 必须显式设置，支持绝对路径及 `~/`；未设置或路径无效时 GPT Web 返回明确错误，普通 Codex 仍可使用。
- SDK 用 `new Codex({ env })`，app-server 用 `spawn(..., { env })`，传入完整继承环境并将该目录映射为子进程 `CODEX_HOME`。
- 当前服务不创建或重写 `config.toml`、登录凭据及桥接初始化配置。
- GPT Web 未配置时跳过其全局索引扫描，避免阻断其他 provider 的扫描游标。
- GPT Web 按绝对 home 路径持久化独立扫描进度；首次启用或切换到新的 home 时全量扫描已有历史，之后增量扫描。目录尚未创建或子目录扫描失败时不推进进度。
- 模型服务访问成功显示为“模型服务已连接”，不代表 ChatGPT 网页登录或 Full harness 工具调用已验证；这两项仍须在启动器验证。
- 自定义模型、会话选择和执行入口均校验 `chatgpt-web/` 范围；未指定模型时从 Web 目录选默认值，旧版隐藏 Web 模型仍可继续会话。
- 模型目录保留输入模态；文本模型的图片附件在界面和执行前校验，SDK、app-server 与 steer 共用同一后端校验契约。steer 校验返回后重新确认目标任务仍在运行，防止向已结束的任务发送请求或重启已停止的进程。
- 执行前的图片能力校验读取 provider 的完整模型目录，不受“仅显示自定义模型”过滤影响，避免旧会话的模型被隐藏后丢失输入限制。
- 沙箱与审批继续沿用界面选定的 Codex 权限模式；配置目录本身不形成操作系统沙箱。
