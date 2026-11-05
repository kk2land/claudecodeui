# CloudCLI Worker 插件

支持 Codex app-server 与 DSH ACP 父会话，插件在现有「插件」页签中运行，把父会话拆出的任务交给 DSH、Pi 或 Codex 子任务执行，
并在独立进程中记录运行、原始事件与结果。插件负责执行与记录；任务拆分、review 和 Git 集成仍由父会话
与用户授权的主代理负责。插件保存主会话维护的计划与依赖记录，不提供自动依赖调度或 Git 集成。

## 启用与 skill 部署

插件随 CloudCLI 分发，在插件列表中启用后出现在项目的 Worker 页签。Worker 的自带 skill 位于：

    plugins/worker/skills/cloudcli-workers/SKILL.md

需要让 Codex 发现该 skill 时，由用户把整个目录软链到自己的 Codex skill 目录：

    mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
    ln -s /absolute/path/to/cloudcli/plugins/worker/skills/cloudcli-workers \
      "${CODEX_HOME:-$HOME/.codex}/skills/cloudcli-workers"

DSH 可将同一个 skill 软链到 `${DSH_HOME:-$HOME/.dsh}/skills/cloudcli-workers`，或项目的
`.agents/skills/cloudcli-workers`；已有目录或链接也应先核对，避免覆盖。

宿主不会自动注入、复制或安装这个 skill。目标已存在时保留它，部署时核对并手动处理旧链接或目录。
Worker 的通用规则、计划与合并后清理要求位于 `plugins/worker/CLOUDCLI-WORKERS.md`；运行
对应脚本安装全局引用块：

- Codex：`plugins/worker/install-codex-instructions.sh`，写入 `${CODEX_HOME:-$HOME/.codex}/AGENTS.md`。
- DSH：`plugins/worker/install-dsh-instructions.sh`，写入 `${DSH_HOME:-$HOME/.dsh}/AGENTS.md`。

脚本只维护 `<!-- cloudcli-workers:start -->` 与 `<!-- cloudcli-workers:end -->` 之间的内容，保留块外原文，
重复运行不重复添加；目录或文件缺失时创建，脚本或文档搬移后重新运行会更新引用路径。脚本仅依赖 POSIX sh，
不部署 skill，也不改动其他配置。

使用 skill 前还须让主代理读取通用规则；仅软链 skill 不会自动引入该文档。DSH 默认加载全局及项目
`AGENTS.md`，如需仅对某个项目生效，也可在项目 `AGENTS.md` 中添加对上述文档的引用。

MCP 连接由运行时临时注入，不在用户配置中预置：Codex app-server 通过 CLI `-c` 临时声明 Worker MCP URL
并设 `enabled=false`，无需在 `config.toml` 预置；`thread/start` 与 `resume` 注入专属 owner 凭证，预测线程
不启用 Worker MCP。DSH 仅在 ACP 启动时由临时 patch 挂载 HTTP Worker MCP，headless 不注入。
Codex 原生预测 fork 会继承父线程 MCP 且拒绝配置覆盖；启用 Worker 工具的会话明确显示预测暂不可用，
避免预测线程获得父会话的 Worker 凭证。未启用 Worker 的会话继续使用原生预测。
当前服务的 Codex 配置中显式禁用 `cloudcli-workers` 后，宿主不再为该项目会话接入 Worker MCP；
已打开会话的 MCP 请求也会读取当前技能状态并拒绝调用，避免旧工具列表或全局指令继续创建任务。
同名技能存在多个副本时，任一可见副本被显式禁用都阻止接入；重新启用后恢复。该设置不取消已接受的任务，
已有任务仍可在 Worker 页签查看和管理。
决定委派前，若 skill 未启用，或当前会话的 Worker MCP 未启用、未连接、缺少所需工具，主代理应跳过
该 skill 并用普通工具直接完成原任务，不要以「请连接 MCP 后重试」为前提报告阻塞。只有已进入 Worker
委派流程后的持续调用失败才报告具体阻塞；任何情况下都不要绕到 shell、`dsh`/`pi` 或复制 runner
启动/管理 worker。

## 使用

以整个用户任务判断是否采用 Worker：未明确要求 Worker 时，简单问答、代码定位、少量明确的文案、配置或
代码修改由主代理直接处理，无需调用 `worker_context`。较大任务在预期整体收益超过启动、交接与 review
成本时采用 Worker，不按文件数或代码行数机械决定。用户明确要求 Worker 执行时遵从其选择；讨论或修改
skill 本身不算要求派发。查看、续接或取消已有 Worker 仍使用对应 MCP 流程。

一旦选用 Worker，本次任务的调研、实现、测试、修复等执行性子任务全部交给 Worker；主代理负责需求与
方案决策、拆分调度、review、集成和最终验收。分工覆盖共享接口、串行步骤和收尾修复，依赖就绪后再派发，
不能因为子任务较小、共享文件或正在等待结果而改由主会话执行。集成或验收发现需要改代码时，也交给原
Worker 或后续 Worker。用户明确要求只委派部分工作时，按指定范围执行。

派发前先按可独立实现和验收的交付物识别实现线：各线工作量足够、读写范围可隔离且共享契约可明确时，优先
拆给不同 Worker 并行（如不同 provider 或组件），不默认把整个任务交给一个 Worker；强耦合或拆分协调成本
更高时保留单 Worker，不设机械的 Worker 数量或文件数门槛。共享接口指定唯一负责人，先明确或落地最小契约
再放行依赖，避免少量共享接口把其余独立实现串行化。

决定委派且满足 skill/MCP 启用条件后，先调用一次 `worker_context` 确认真实父会话、项目和可用状态；
同一轮内复用，仅范围变化或需要恢复上下文时再查；返回的 `plan` 可用于恢复计划，并须结合实际 Worker 状态核对。
`worker_context` 只返回协调元数据，`settings` 中不包含 `codex.env` 与 `codex.legacyExtraArgs`，Codex 配置仅
保留 `codex.modelProvider`；完整 Codex 配置仅保留在受保护 UI `GET /state`、持久化与原生执行路径中，
避免把可能含凭证或代理配置的环境值送入父模型上下文。
每次 `worker_start` 都必须显式选择工作区：

- `worktree`：插件创建隔离 worktree，并在接受请求时解析 Git 基线（默认 `HEAD`）。源目录脏默认拒绝；
  只有明确传 `allowDirtySource: true` 才放行。
- `existing`：在已存在目录（默认项目根目录）中运行；共享目录允许并行，但插件不加文件写锁，调用方必须在
  `writePaths` 中声明互不重叠的修改范围。

`writePaths` 是相对 cwd 的已声明范围，`[]` 表示只读任务；它约束任务与 review 范围，不是额外的文件系统
权限。`worker_start`/`worker_resume` 是异步派发：接受请求（包括进入排队）后立即返回，Worker 在后台继续，
父会话可以接收新的用户提示词。父会话只剩等待 Worker 时，应报告「已派发/后台进行」并结束当前派发回合、
交还输入权，不要用重复 `worker_list`/`worker_get`/`worker_wait` 让回合保持 Processing，也不要把已派发
说成验收完成；运行预算提醒与终态由 outbox 自动通知，届时再检查实际进展或验收。`worker_wait` 仍保留给用户明确要求
等待或必要的短检查；`worker_cancel` 取消，`worker_resume` 用原 worker 继续并保留 cwd、home 与原生会话
身份，但创建新的 runId，可显式覆盖模型/effort。

查询或验收时，按需用 `worker_list` 定位、`worker_get` 读取目标结果；已有响应足够就复用，通知 ID 批量
`worker_ack`。证据不足时再增量读取相关日志；局部检查通过后，仅有新改动、失败或未决问题时重跑。

主会话为每次新任务按其主要交付物标注单一 `taskRole`，不根据提示词关键词猜测：`testing`（测试）、
`development`（开发）、`ui_design`（UI 设计）、`plan_review`（方案审核）、`code_review`（代码审核）。
角色只用于倾向匹配，不是硬限制：显式 `configId` 或 `type` 可覆盖，未匹配时回退默认配置。省略 `configId`
时，只在已启用且 `roles` 包含该角色的配置中选择，取配置列表中的第一个匹配项；默认配置不覆盖排在前面的
匹配项。无匹配或未提供 `taskRole` 时仍用默认配置（若在类型候选中），否则取首个已启用配置。显式
`configId`/`type` 优先，但必须已启用且类型一致。满载
仍按原有 FIFO 排队；`worker_resume` 保持原配置，不用角色重新匹配；同一 `requestId` 的幂等重放保持原结果。
`ui_design` 只负责界面布局、视觉样式和交互设计；技术方案、架构设计、任务拆分和实施计划由主会话完成。
`plan_review` 只审核主会话已有产物，方案决策与修订仍由主会话负责。方案审核只用于计划阶段形成的整体
方案，不是每次实施改动的前置：进入实施后，修复、需求或契约调整、集成问题由主代理直接协调开发、测试与
代码审核，不自动启动 `plan_review` 做例行补审；只有明确重新进入计划阶段、制定新的整体方案时才再次安排
方案审核。审核交付发现问题时必须给出具体、可执行的调整建议。

每个 run 首次达到软预算（默认 600 秒或 20 步）时生成运行提醒，以 `status: running` 写入 outbox；
此后每隔 `softReminderSeconds`（默认 600 秒）继续提醒，即使 Worker 正在等待没有新事件的长命令。
此前提醒已投递后才能生成下一条，避免忙碌、暂停或投递不确定时堆积通知；运行记录中的 `softReminderSentAt`
表示最近一次提醒时间。父会话空闲且用户队列处理完后，Codex 或 DSH 主代理会收到提醒，提醒本身不会取消任务。
主代理先核对当前 run，再对比上次的交付物、diff 和验证结果；有新有效产出则等待下一次自动提醒。持续无进展、重复检查或方向偏离时，
可在原授权范围内 `worker_cancel` 指定该 Worker、`pause: false`，确认停止后用明确的新提示词 `worker_resume`
同一个 `workerId`，保留原会话、cwd 与已有修改。取消未确认或状态为 `unknown` 时不能续接；反复纠偏无进展时
报告阻塞，不机械重复提示词。运行结束后，尚未投递的提醒转为 `held`，只自动投递终态结果，已投递的提醒保留记录。

派发时按本轮交付设置 `timeoutSeconds`，长工作按可验收阶段续接；确需不限时则说明原因和停止条件。
交接提示词须约定命令预算：长命令后台执行，单次同步等待不超过 60 秒；测试已报超时但进程未退出时，
停止该任务自己的进程并保留日志。同一失败已在未修改基线上复现后，记录限制并继续剩余交付，不再重复完整测试。

父会话页面提供「当前会话 / 当前项目 / 全部」三种视图，显示 DSH/Pi/Codex 占额与排队数、阶段、耗时、软提醒、
模型、cwd/worktree、真实原生 ID、结果和分页事件/stderr 日志。列表与详情显示任务记录的角色，历史记录缺少
角色时详情显示未指定，列表不额外展示。设置页按每个 Worker 配置管理启用开关、并发和倾向任务；配置
停用后保留模型、角色等内容，重新启用后继续使用。页面只读状态并执行取消、暂停、恢复、清理和
通知重试；不展示宿主认证令牌或 MCP 控制令牌。用户自行配置的 Codex 环境变量可在设置页编辑。
没有会话时禁用会话视图，没有项目时仅保留全部视图。

## 计划与验收记录

每个父会话与项目维护一份 Markdown 计划。插件在现有 `worker.db` 中独立保存内容和更新时间，
不在项目工作区写入计划文件。`worker_context` 的 `plan` 首次为 `null`，保存后返回：

    {
      "content": "# 当前目标\n\n- W1：接口待验收\n- W2：依赖 W1，等待产物交接\n",
      "updatedAt": "2026-11-02T00:00:00.000Z"
    }

`worker_plan_save({ content })` 接收非空白字符串，保留 Markdown 原文，替换当前完整计划并返回
`{ content, updatedAt }`。会话与项目身份取自已认证的 owner，调用方不填写；同一父会话重新连接或
更换运行时 owner 后仍可读取原计划，不同父会话或项目相互隔离。

计划记录任务编号与目标、依赖、工作区和修改范围、验收条件、Worker/Run 关联、进度与验收证据及产物交接。
新目标按章节追加，已完成部分保留简短结论。仅在计划调整、派发、验收、阻塞或返工时保存，
无需随每次查询写入。主会话确认前置任务已验收，并确认所需产物实际进入下游 cwd 或基线后，才调用现有
`worker_start` 或 `worker_resume`；请求接受后把实际 Worker/Run 标识写回计划。

计划只是主会话维护的记录，不是运行状态来源：保存不启动或取消任务、不改变排队、不产生运行通知，
也不自动判断依赖或验收。`completed` 和 `worker_ack` 均不代表验收通过，主会话检查实际 diff 和验证
证据后更新结论。保存与派发均遵守当前模式和授权。

计划随插件实例数据保留，不参与运行日志的到期清理；计划中的历史标识不保证对应 Worker 或日志仍可访问。
保存前须保留仍需跟踪的任务与验收结论。恢复工作流、拆分案例及提示词模板见
[Worker skill](../plugins/worker/skills/cloudcli-workers/SKILL.md) 和
[协作案例与模板](../plugins/worker/skills/cloudcli-workers/references/workflows.md)。

## Worker 配置：引擎、启用、角色、并发、模型与 Codex 服务

执行引擎固定为 `dsh`、`pi`、`codex` 三种。用户可以管理多个具名 Worker 配置；新安装直接使用三个初始配置
`dsh-default`（dsh#1）、`pi-default`（pi#1）、`codex-default`（codex#1），
`defaultConfigId` 为 `dsh-default`。从旧设置迁移时保留原 `defaultWorkerType`，映射为对应初始配置的
`defaultConfigId`；只有旧值缺失或无效时才回退 `dsh-default`，迁移结果不会一律改成 DSH。每个配置包含
`id`、`name`、`type`、`enabled`、`roles`、`concurrency`、`model`、
`effort`；Codex 配置另有 `codex.modelProvider`、`codex.env` 和保留的 `codex.legacyExtraArgs`。`id` 在创建时
生成，重命名保持不变；只要该配置已被任何 worker 或 run 历史引用，就不能修改其 `type`。模型的真实能力以
执行器配置为准，插件不虚构未支持的参数。

设置页按实际能力提供新增、复制、拖动排序、删除、设为默认、启停和并发编辑，并以整份 `configs`/
`defaultConfigId` 文档原子保存。`configs` 数组顺序就是持久化的路由顺序（`taskRole` 取首个匹配项），拖动
排序只是重新保存整份数组，无需额外字段或接口，且不改变 `defaultConfigId`。默认配置必须已启用，且至少有
一个配置启用；停用当前默认配置时界面自动改选配置列表中首个
已启用配置，没有已启用配置时提示并阻止保存；服务端仍校验 `defaultConfigId` 指向已启用配置。删除只移除
配置，历史任务与日志保留，但之后无法再用该配置续接；
仍有排队或运行中任务的配置不能删除。停用只阻止之后的新建和续接，已接受（包括已排队）的运行继续；配置
内容保留，重新启用后继续使用。角色、模型和 reasoning 的修改只影响之后新建的任务；并发修改立即参与排队。

### 设置结构与兼容投影

`GET /state` 的 `settings` 以 schema 2 的 `configs` 与 `defaultConfigId` 为唯一持久化来源，另含保留天数及
由服务端管理的软提醒/硬超时值（`PUT /settings` 不接受后者）。`concurrency`、`enabled`、`roles`、
`defaults`、`defaultWorkerType`、`codex` 是只读兼容投影：按引擎取 `defaultConfigId` 属于该引擎时的默认
配置，否则取列表中该引擎的第一个配置；某引擎没有配置时 `enabled` 为 `false`、`roles` 为 `[]`、
`concurrency` 为 1、`defaults` 为 null model/effort、`codex` 为空 env/args。`defaultWorkerType` 投影
`defaultConfigId` 的类型。旧客户端仍可提交旧版映射更新，但它只能编辑三个初始固定配置；任一初始配置已被
删除时整次更新失败。

`GET /state` 的 `settings` 形状示例（软提醒 600 秒 / 20 步、硬超时默认关闭）：

    {
      "schemaVersion": 2,
      "configs": [
        { "id": "dsh-default", "name": "dsh#1", "type": "dsh", "enabled": true,
          "roles": [], "concurrency": 3, "model": null, "effort": null },
        { "id": "pi-default", "name": "pi#1", "type": "pi", "enabled": true,
          "roles": [], "concurrency": 3, "model": null, "effort": null },
        { "id": "codex-default", "name": "codex#1", "type": "codex", "enabled": true,
          "roles": [], "concurrency": 3, "model": null, "effort": null,
          "codex": { "modelProvider": "magpie", "env": { "CODEX_PROXY_BYPASS": "1" },
                     "legacyExtraArgs": [] } }
      ],
      "defaultConfigId": "dsh-default",
      "concurrency": { "dsh": 3, "pi": 3, "codex": 3 },
      "defaultWorkerType": "dsh",
      "enabled": { "dsh": true, "pi": true, "codex": true },
      "roles": { "dsh": [], "pi": [], "codex": [] },
      "defaults": {
        "dsh": { "model": null, "effort": null },
        "pi": { "model": null, "effort": null },
        "codex": { "model": null, "effort": null }
      },
      "codex": { "env": { "CODEX_PROXY_BYPASS": "1" },
                 "extraArgs": ["-c", "model_provider=magpie"] },
      "retentionDays": 1,
      "softReminderSeconds": 600,
      "softReminderSteps": 20,
      "hardTimeoutSeconds": null
    }

规范的 `PUT /settings` 整份替换 `configs`，并在保存前原子校验：`id` 唯一且非空、`name` 非空、`type` 合法、
`enabled` 为布尔值、`roles` 只含任务角色目录中的值、`concurrency` 为正整数、`defaultConfigId` 引用已启用
配置；Pi 的 effort 必须是受支持的 thinking 级别，DSH 的 effort 必须同时配置模型；Codex 配置必须带 `codex`
对象，`env` 为字符串到字符串映射，`legacyExtraArgs` 为字符串数组，含 `-C`/`--cd` 的项被拒绝。任一项非法
都会让整次更新失败且不保存任何字段。`retentionDays` 为正整数，省略时保留原值；`schemaVersion` 由服务端
管理，客户端不提供。

旧版映射更新仍兼容：`concurrency.dsh`、`concurrency.pi` 必填且为正整数，`concurrency.codex` 可省略并保留
原值；`defaultWorkerType` 选择对应初始配置为默认；`enabled` 与 `roles` 若提供必须同时包含 `dsh`、`pi`、
`codex`，省略则保留；`defaults` 若提供必须含 `dsh` 与 `pi`，可含 `codex`，空白字符串按清除处理；`codex`
对象若提供必须同时含 `env` 与 `extraArgs`。旧版 `extraArgs` 中的 `-c model_provider=<id>`（或
`--config=model_provider=<id>`）会被提取为 `modelProvider`，不再留在 `legacyExtraArgs` 中。

旧设置 JSON 在读取时一次性迁移为 schema 2：由旧 `concurrency`、`enabled`、`roles`、`defaults` 生成三个
初始配置；旧 `codex.env` 与 `extraArgs` 生成 `codex-default` 的 env、`modelProvider` 与
`legacyExtraArgs`；旧 `defaultWorkerType` 映射为对应初始配置的 `defaultConfigId`，并补齐提醒、保留天数与
硬超时默认值。迁移同时为旧 worker 回填 `configId`/`configName`，并按 run 自己记录的 `spec.json` argv
补齐缺失的 model/provider/effort；没有证据时保留原 null 而不从当前设置猜测。旧 Codex run 没有可靠
provider 证据时标记 `legacyCodexProvider`，续接时可回退到当前配置的 `modelProvider`。迁移只执行一次，
之后不会重建已被删除的配置，也不会重写历史 run 记录。

### 模型选择界面

模型与 reasoning 全部使用下拉选择，按引擎读取真实目录：DSH 与 Codex 使用宿主模型目录；Codex 先从宿主读取
模型服务目录，再按服务读取模型列表；Pi 通过插件 `GET /catalog/pi` 直接读取 `PI_CODING_AGENT_DIR`
（或 `~/.pi/agent`）下 `models.json` 中 providers 配置的完整 provider/model 与 reasoning 布尔值；不启动 Pi，
不使用凭据，也不执行 `!command`。文件缺失时目录为空。Codex 卡片顺序为
先模型服务、再模型、再 reasoning：切换模型服务会清空该配置已选模型与 reasoning；切换模型会丢弃新模型
不支持的 reasoning。目录接口不可用时卡片显示本地错误与重试，并保留当前配置值；模型或 reasoning 不在
目录中时以“（当前已保存）”选项保留，普通保存不会清掉它们。留空表示沿用执行器自身默认。Codex 模型服务
目录与模型列表由宿主全局 Codex home（`CODEX_HOME` 或 `~/.codex`）和环境读取，不随单个配置的 `codex.env`
或运行 home 变化，这是已知范围限制。

Codex `env` 在每次原生 start/resume 时合并到继承环境之上，同名键以设置值覆盖继承值；`{}` 显式清除预填
的 `CODEX_PROXY_BYPASS`。`legacyExtraArgs` 的每个元素是一个独立 argv，不拼接成 shell 字符串，不做引号或
空格解析；空数组表示没有额外参数。`modelProvider` 是独立的模型服务选择，启动时以
`-c model_provider=<id>` 传入。设置页按首个 `=` 分割每行 KEY=VALUE，保留值中的空格和后续 `=`；空 env
文本保存为 `{}`，非法 env 会提示并禁止保存。界面回填以服务端返回的设置对象为准；迁移保留的额外命令行
参数仍用于启动，但界面不再提供额外参数编辑入口。

### 新任务选择与续接

新 worker 的配置选择：显式 `configId` 优先，必须存在、已启用且与显式 `type` 一致；未提供 `configId` 时
只在已启用的配置中路由，显式 `type` 先收窄候选，提供了 `taskRole` 时取候选中第一个 `roles` 包含该角色的
配置（按 `configs` 列表顺序，默认配置不覆盖前面的匹配项）。无角色匹配或未提供 `taskRole` 时回退到类型
候选中的默认配置，不在候选中则取首个配置。`worker_start`
在接受请求时把最终 `configId`、`type`、model、provider、effort 快照到 worker/run；之后修改设置不会改变已
排队 run 已接受的值，原生 argv 与 DSH 模型 patch 都使用该快照。

新任务的 model/effort 优先级为：请求显式值 > 所选配置的 `model`/`effort` > 执行器原生默认。provider 只有
Codex 支持：请求显式 provider > 所选配置的 `codex.modelProvider` > Codex 原生默认；非 Codex 类型若显式
传入非空 provider，会在幂等重放检查之后以 `PROVIDER_UNSUPPORTED` 拒绝，旧请求的幂等重放仍返回原结果。
Pi 把完整模型 ID 直接传给 `--model`，不再接受 `--provider`；DSH 的 provider/model 由运行模型 patch 表达。

`worker_resume` 保持原 worker 类型与 `configId`、cwd、home 和原生会话身份，默认沿用上一次 run 记录的
model/provider/effort，不套用当前配置；显式 model/effort（Codex 还包括 provider）仍可覆盖。旧 Pi 的独立
provider 会折叠进完整模型 ID，并按大小写不敏感的前缀去重；旧 DSH 的独立 provider 与原始 model 直接拼接为
provider/model；旧 DSH 裸 model 只从该 run 自己生成的 `model.patch.yml` 恢复路由证据，完整 ID 不依赖旧
patch；没有证据时续接要求显式提供完整 model（`MODEL_REQUIRED`）。历史记录不重写，续接创建新的 runId。
原类型或配置已停用时，续接请求保留原配置但按启用规则拒绝。Codex 续接使用记录的 `thread_id` 执行
`codex exec resume --json`，每次仍读取当前配置的 Codex env 与保留的启动参数。

## 原生会话保留与清理

原生 DSH/Pi 会话文件独立保留 3 天，按文件修改时间计算；插件启动时清理一次，之后每 24 小时清理一次。
范围包括 `CODEX_DSH_SESSIONS_ROOT`（默认 `$HOME/tmp/codex-dsh-sessions`）、`$HOME/.pi/agent/sessions`，
以及插件数据目录下的 `sessions/dsh`、`sessions/pi`。DSH 的历史 generation 和 `.zstd` 文件也参与清理。
Codex 原生 session 目录不纳入这一 DSH/Pi 批量 retention 删除，不会按上述 3 天规则被清扫；其保留由固定
home 下的 Codex 自身行为与配置决定。恰好达到 3 天的文件仍保留；排队、启动、运行、停止中或状态未知的
Worker 引用的原生会话会跳过。DSH 即使尚无文件路径也按已记录的原生 ID 保护会话目录，Pi 在启动前记录
文件路径；恢复记录仍无法确定会话身份时，保留该运行所属会话根，待确认停止后再参与清理。
`HOME` 缺失时依次使用 `USERPROFILE` 和系统用户目录定位共享会话目录。
清理保留锁文件和其他非会话文件，失败项记录到插件日志并在下次清理时重试。插件停用期间不执行清理。

## 并发、排队与去重

并发键为 `(parentSessionId, projectId, configId)`，每个配置默认 3，各自独立计数。应用会话 ID 已隐含
provider 隔离，父会话、项目与各个配置的额度仍相互独立。`starting`、
`running`、`stopping`、`unknown` 都占用额度；超额请求按 FIFO 排队。同一原生会话只允许一个调用。
start/resume 都要求调用方提供 `requestId` 作为幂等键；相同操作与载荷的重复键返回原 worker/run，不会再次
启动 CLI。同一 `requestId` 用于不同操作或不同载荷时直接拒绝（ID 冲突），不会覆盖原记录。配置的并发
只接受正整数，保存后立即生效；默认配置与模型/reasoning 默认是独立的设置，不改变该并发键。

## 原生 CLI 参数与成功判定

执行器在 PATH 中解析绝对路径后才切换 cwd；以 argv 数组、`shell=false` 启动，不拼接 shell 字符串。
认证沿用现有 CLI 配置，不写入日志、不持久化密钥。

DSH：

    dsh --profile headless --patch <运行目录>/dsh-session.patch.yml \
      [--patch <运行模型 patch>] --json [--session-id <真实会话 ID>] -

- stdin 传 UTF-8 提示词，末尾参数 `-` 表示从 stdin 读取。
- 必需的会话 patch 由插件从打包文件原样复制到每次运行的目录，并以绝对路径传入；原生执行器读取运行副本，
  续接也为新 run 准备独立副本。运行 patch 与 Worker 持久化的 home/session 隔离继续保留。
- `DSH_HOME` 使用原环境值或 `~/.dsh`；会话根由插件显式设为实例数据目录下的 `sessions/dsh`。
- 模型与 effort 通过运行级 `agent-default-model` patch 注入，不伪造 CLI flags：完整 model ID 按第一个 `/`
  解析为 provider/model；裸 model 的 provider 固定为 `deepseek-official`；effort 必须同时有模型。
- 用户没有独立的 DSH provider 或环境配置；`CLOUDCLI_DSH_PROVIDER`、`CLOUDCLI_DSH_PATCHES`、
  `CLOUDCLI_DSH_BIN` 不再作为 Worker 运行配置。`CLOUDCLI_DSH_SMOKE_BIN` 仅是测试入口。
- 成功要求：exit 0、事件完整合法、`session.cwd` 与 ID 匹配、出现 final，且最后一个 turn_end 的
  `reason.kind=completed`。已确认 CLI 退出但事件协议非法（例如缺少或错误的原生会话身份）是 `failed`，
  不会据此猜测原生身份，也不能续接；只有进程存活/退出证据本身缺失时才是 `unknown`。

Pi：

    pi --print --mode json --session-dir <实例数据目录>/sessions/pi \
      --session <首次 runId>.jsonl [--model <完整模型 ID>] [--thinking X]

- 通过 stdin 输入提示词，不追加 `-`。
- `PI_CODING_AGENT_DIR` 使用原环境值或 `~/.pi/agent`，认证与 PATH 按原方式继承。新请求参数优先级：
  显式请求 > 所选配置的默认值 > Pi 原生配置；续接时显式参数 > 旧记录。完整模型 ID 直接传给 `--model`，
  不再接受 `--provider`，也没有 `CODEX_PI_MODEL`/`CODEX_PI_PROVIDER`/`CODEX_PI_THINKING` 环境回退。
- `thinking` 仅接受 `off/minimal/low/medium/high/xhigh/max`；留空沿用 Pi 自身配置。
- 续接前核实会话文件存在且非空、header 的 ID 与 cwd 匹配，否则不续接。
- 成功要求：exit 0、会话身份匹配、最终 assistant 的 `stopReason=stop`、最终 `agent_end` 的
  `willRetry=false`、`agent_settled` 的 `aborted=false`。原生重试后最终成功可以接受。

Codex：

- 新启动使用 `codex exec`，续接使用 `codex exec resume --json` 和已记录的原生 `thread_id`。
- 本机 Codex `0.165.0` 的 argv 形状为
  `codex exec --json [额外参数] [显式 model/provider/effort] [resume <thread_id>] -`，通过 stdin 输入提示词。
  `--sandbox`、`--profile`、`--add-dir` 等受支持的 exec 级参数必须放在 `resume` 子命令之前；
  `-C`/`--cd` 不受支持，工作目录由任务工作区控制。
- 每次启动或续接都合并当前所选配置的 `codex.env`，并追加其 `codex.legacyExtraArgs`；`{}`/`[]` 表示没有
  额外环境或参数。每个额外参数单独传入，不拼接 shell 字符串。
- 显式 model/provider/effort 选择优先于 `legacyExtraArgs` 中的同名配置；provider/effort 的 `-c` 以最后值
  为准。provider 未显式给出时使用 run 记录值，迁移来的旧 Codex run 可回退到当前配置的 `modelProvider`。
  已有明确 model 时，插件会从额外参数中移除 `--model <v>`、`-m <v>`、`--model=<v>`、`-m<v>`，再追加唯一
  `--model`；没有明确 model 时保留原参数，避免 Codex `0.165.0` 拒绝重复 `--model`。
- 成功要求：exit 0、原生 `thread_id` 与预期一致、收到 `turn.completed`。流中断出现 `Reconnecting error`
  后仍收到 `turn.completed` 可判定成功；协议无效、ID 不一致或 `turn.failed` 仍失败。
- `turn.completed.usage` 与 rollout 是原生会话累计口径。插件在启动前记录测量基线（新线程为已知全零，
  续接读取可用的 `total_token_usage` 快照与 rollout EOF），成功后按同一口径差分出本次 run 的输入、输出、
  缓存读写与合计。优先使用可信的原生 total；没有可信 native total 时使用同一 run 已确认的 I/O 增量和。
  证据不足时标记 `partial` 或 `scope: "session"`，不把会话累计冒充本次用量。
- 沙箱和审批继承 Codex 原生配置，插件不默认添加危险 bypass 参数。需要时可在保留的启动参数中配置
  `--sandbox workspace-write` 等 exec 级参数。
- 固定首次 run 记录的 home 与 worker cwd；续接不更换 cwd/home，并使用记录的 `thread_id`。当前原生实现用
  `CODEX_HOME` 注入固定 home。
- Codex 原生 session 目录不参与上述 DSH/Pi 3 天批量 retention 删除。

真实的模型与 effort 能力以执行器配置为准；插件不虚构未支持参数。原始事件与 stderr 落盘保存，日志按页
读取。

每个 run 单独保存用量字段 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、
`totalTokens` 以及 `scope`/`partial`。DSH/Pi 按原生样本累加并标记本次运行范围；Codex 按上述基线差分。
未知或未上报的字段保持 `null`，真实 0 仍显示 0，不估算也不裁剪。失败、取消或超时的 run 对已收集用量标记
`partial`，插件重启后无法确认停止的 `unknown` run 同样标记 `partial`，成功结果按已确认的原生数据保存。
UI 对 Codex 显示“输入（含缓存）”，对 DSH/Pi 显示“未缓存输入”，并显示缓存读取/写入、合计、统计范围与
部分统计标记；历史记录缺少范围时显示为未标注。

## 自动唤醒、Stop 与恢复

主会话同一时间只处理一个回合：已开始的回合会先完成，随后用户排队消息按 FIFO 优先，最后才由 Worker outbox
提醒或结果唤醒。用户输入入队或回合完成时立即触发调度，另有约 15 秒的用户队列补充检查。Worker outbox 在父会话
空闲时约 500ms 合并一次通知，忙碌时约每 2 秒重试；这些重试不会抢占或中断用户回合。独立的新用户任务不会
自动 steer 或取消已派发的 Worker。active goal、原生后台任务、queueHeld、stopping、stopFailed 等情况均等候；
其他 worker 仍在运行时可以处理已完成结果。普通 busy 只是延后领取，通知保持 `pending`。用户队列上限仍为 3
条，与 Worker outbox 相互独立，outbox 不占用户队列额度；`chat.send` 与忙碌状态竞态时，消息进入现有持久
队列并返回 `chat_queued`。显式暂停、Stop 或丢失 authority 时，待发通知转为 `held`，必须等用户明确继续
或手工重试，不会被自动唤醒改回 `pending`。MCP 的 `ack` 只表示已收到，不是验收；已通过 MCP 确认的结果会
取消待发通知，领取批次与回执避免重复投递。通知投递失败可在 UI 手工重试。

Codex app-server 在队列没有任何待发消息、且接受新的显式用户回合时，会清除之前 Stop 留下的 `queueHeld`，
让新一轮 Worker 的结果恢复自动回传。有旧排队消息时仍须显式恢复队列；自动回合和查看状态不会解除暂停，
之前已转为 `held` 的 Worker 通知也不会被自动重放。

主会话 Stop 会先封住新任务与自动唤醒，再取消该父会话的排队与运行任务；用户主动停止 app-server 或关闭
Codex 运行时会清理所属 worker，CloudCLI 退出清理全部。关闭浏览器或切换页面不取消任务。主停止或退出
触发的取消不会自动唤醒父会话。
CloudCLI 的 Codex runtime 在所属父会话仍有活动 Worker 时，每 30 秒向现存 app-server/proxy 发送一次
thread/loaded/list RPC 保持其活跃，不因空闲超时退出；没有活动 Worker 时才按原阈值正常空闲回收。DSH ACP 的
所属 owner 仍有活动 Worker 时同样延后空闲回收并重新计时，Worker 结束后的下一次检查恢复回收，其它 owner 的
Worker 不影响本 owner。

只有正常空闲退出/回收保留 Worker owner 与临时凭证，结果到达后按原生会话 ID 恢复父会话；用户 Stop、切换
headless 或宿主关闭仍立即释放传输与计时器，并沿用前述规则取消相应 Worker。原生回合中途异常退出仍报告失败
并暂停其队列，不重发该回合。
代理已退出但仍有 Worker 时，停止 app-server 入口仍可取消任务。
Codex 与 DSH 的设置按钮都提示当前会话的 Worker 活动，切到其他工作区页签时暂停活动轮询，回到聊天时立即刷新。
DSH 停止未获确认时，即使 ACP 已退出，停止入口仍可重试；普通进程状态轮询不会清除 Worker 清理错误，重试成功后清除。
Codex 的进程停止同样等待 Worker 清理确认；失败时保留暂停的 owner 并回报错误，代理已退出或活动查询失败时仍可重试。
停止也会取消尚在解析模型或注册 Worker 的旧回合初始化，避免空闲代理退出后，旧初始化在停止操作之后重新启动它。

2026-10-31 长时验收使用真实 codex-proxy 调度与回收代码、Codex `0.165.0`、DSH `0.2.1-rc.2` 和构建后的 Worker 插件，模型响应由本地 HTTP 服务提供。proxy 仅通过其测试入口 `Options.AccountHome` 隔离账户目录，保留默认 10 分钟空闲阈值。未发送保活 RPC，约 600.12 秒后日志确认 `idle_timeout` 正常退出，此时原生 Worker 仍在运行。该次验收早于活动 Worker 空闲豁免；当前行为以上一节为准。完成结果随后启动新的代理并恢复同一父线程，MCP 凭证保持有效；再经 MCP 取消并续接，Worker ID 与 DSH 原生会话 ID 均保持不变，原始对话上下文仍在。该验收覆盖进程、插件与宿主桥接，不依赖真实模型账户。

重启后恢复运行记录，旧任务不自动重跑。无法确认停止的 run 标记 `unknown` 并继续占额；必须由人工核实原生
CLI 与进程组已停止，再通过 UI 或 `worker_recover` 提交说明与 `confirmedStopped: true`。恢复只写入核实
记录，不重跑任务。

## 进程与清理

每次运行有独立 Node 监护进程，CLI 置于新的进程组。IPC 断开、SIGTERM、SIGINT 都触发 stop；先 TERM，
2 秒后 KILL，确认进程组退出后才进入终态并释放额度。正常完成也会清理遗留子进程；不使用历史 PID 发信号。
插件自身退出时由独立监护进程清理。

`worker_cleanup` 只清理插件创建、工作区干净且已经停止的 worktree；保留分支、会话与日志，不清理 `existing`
目录或用户手工创建的 worktree。主代理 review 并完成必要验证后，才在授权范围内合并；合并后必须执行
`worker_cleanup`，且仅在没有其他任务占用时进行。清理后不能再用 `worker_resume` 续接，新任务应
`worker_start` 新建。

Worker 设置中的“日志和运行记录保留天数”同时控制日志和运行记录，默认 1 天，按每次运行的结束时间计算，
1 天为 24 小时。插件启动恢复完成后、保存设置后立即检查，运行期间每分钟检查一次。仅删除到期的
`completed`、`failed`、`cancelled`、`interrupted` 运行及其日志、退出证据、关联通知和请求去重记录；
排队、启动、运行、停止中及状态未知的运行不会被删除。同一 worker 仍有运行记录时保留 worker，否则删除
worker 记录。原生会话、分支和工作目录不会被自动删除；记录到期删除后无法再通过该 worker ID 续接或清理 worktree。
已经入队的续接使用该 run 在接受时保存的原生会话信息，旧运行记录到期不会改变其会话身份。

## 数据与边界

插件数据位于宿主分配的插件数据目录（通常为 `CLOUDCLI_PLUGIN_DATA_DIR`，按宿主数据库路径隔离），包含
运行记录、计划、outbox 与实例会话目录 `sessions/dsh`、`sessions/pi`。日志与结果可能含敏感内容，只能通过
受保护的 UI REST 与 MCP 读取；计划仅通过所属父会话的 MCP 读取与保存。MCP token 不进入 CLI 环境，
host UI token 不能调用 MCP 或 IPC 控制操作。宿主运行时不会自动改写用户全局配置与认证
数据；安装脚本仅在用户主动运行时维护上述引用块。执行器按既有方式读取配置和认证，Worker 原生会话使用独立存储。

`plugins/worker/shared/contracts.ts` 是插件、宿主桥接与 UI 共用的纯类型契约；宿主从
`server/shared/index.ts` 重导出实际使用部分，插件模块直接从该文件导入，禁止重复定义。跨进程使用：

- MCP 工具：`worker_context`、`worker_plan_save`、`worker_list`、`worker_start`、`worker_resume`、`worker_get`、
  `worker_logs`、`worker_wait`、`worker_ack`、`worker_cancel`、`worker_recover`、`worker_cleanup`。
- UI 只通过宿主现有 RPC 代理访问插件受保护 REST，不接触 IPC。

## 验收限制

自动化回归使用模拟 CLI 和临时会话，覆盖原生参数、状态与进程清理；另有真实 Codex app-server 与 DSH ACP
连接本地 HTTP MCP、模型夹具的测试，不需要调用真实模型。DSH 测试通过 `CLOUDCLI_DSH_SMOKE_BIN` 指定真实 CLI 后启用；它只是测试入口，不是 Worker 运行配置。
Codex CLI 与 SDK 固定为 `0.165.0`。本地启动器被代理替换时，可用 `CLOUDCLI_CODEX_TEST_BINARY` 指向同版本官方二进制，
验证原生预测、模型服务切换与 SDK 会话交接，避免代理改写本地测试请求。
实际部署中的执行器、认证和模型联通仍需环境验收。浏览器验收先完成构建，
再按 AGENTS.md 的本地手工测试流程由 Codex 直接启动或重启测试进程并检查日志，不要要求用户代为启动。
