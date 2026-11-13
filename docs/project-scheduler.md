# 项目定时任务插件

基于 codex-app-server，实现于 codex-app-server-cron。插件随应用分发，默认不可用且不显示在插件列表。
在宿主环境中设置 `CLOUDCLI_ENABLE_PROJECT_SCHEDULER=true` 后，重启后端并刷新浏览器，
即可在设置 → 插件中看到并独立启停。只有精确值 `true` 才会开放；未设置或其他值均关闭，
已有的插件启用设置不能绕过此开关，关闭时不会启动调度器。
进入项目的「定时任务」页签；右上角「插件设置」提供告警渠道、执行环境、运行与日志。

## 配置与装载

右上角「编辑任务」是主入口，直接编辑项目的 .cloudcli/project-schedules.json：

- 当前项目作用域且有打开的项目时，编辑该项目；「全部项目」或无打开项目时先在入口选择唯一项目。
  编辑界面固定显示所选项目名，不随宿主切换悄悄改文件；宿主切换只提示，可继续编辑或放弃草稿。
- 左侧任务草稿列表支持新增、复制、删除，标出新增、已修改及基线缺少的待删除任务并可撤销。
  复制自动分配 1–128 字符的唯一 ID；修改任务 ID 视为删除旧 ID、新增新 ID。
- 右侧表单编辑名称、ID、配置中启用、类型、命令与 args 或 provider/model/effort 与 prompt、cwd、
  timeout、allowConcurrent、提示词任务的 reuseSession，以及项目默认时区、defaults.agent、timeoutSeconds、
  allowConcurrent、alerts.telegram。留空表示继承，不会写入写死的默认值。开启复用会自动关闭并发。
- 原始 JSON 文本是唯一草稿源，视觉表单与 JSON 视图共享同一份文本；未知字段、未修改的任务和
  省略的继承项原样保留。JSON 非法时保留原文并显示错误，可切到 JSON 修复，视觉表单与保存禁用。
- 计划模板覆盖每隔 N 秒/分钟（1–59）、每天、每周加星期、自定义 Cron，生成 5 或 6 段表达式并
  显示人类可读解释；非模板原 Cron 不会被自动改写。
- 预览由服务端按当前草稿 debounce 校验，返回最多 5 次未来运行时间及装载变化；过期响应不会
  授权保存。运行时间按任务/项目时区显示并标注时区，继承时也明确说明实际使用的时区。

「保存并装载」先校验，写文件成功后装载，随后回到列表并刷新。所有编辑、预览都在本地，不写文件、
不执行草稿。即使草稿相对文件没有变化也允许保存装载，用于恢复数据库中的临时关闭状态；需要当前
预览有效。保存期间编辑器整体锁定，避免把请求发出后的新输入静默丢掉。运行中的任务不受影响。
`saved: true, loaded: false` 表示文件已写入但装载失败：编辑器与新 revision 保留，可重试装载。
revision 冲突时保留草稿，并排显示最新文件原文，可明确选择「放弃草稿并读取最新文件」。
文件不存在时服务端返回空配置，首次保存才创建文件。
未保存离开时先内联确认；浏览器关闭由 beforeunload 阻止。

「从文件重新装载」是次级入口，用于直接读取已有文件。
按项目、任务 ID 新增或更新；勾选同步删除时删除配置中缺失的任务。重复装载不重复注册。
每个项目先整体校验再原子提交；配置损坏或不存在不修改旧任务。装载不会中断当前运行。
装载与保存后按已提交的完整任务 ID 同步会话绑定：只有真正删除的任务会解除绑定，
配置损坏、任务停用或关闭 reuseSession 都不算删除。
重启恢复已装载定义，不自动重读文件，不补跑停机期间的时间点。

任务列表的「临时自动调度」开关仅更新插件数据库，不修改项目 JSON，重启后仍保留。
关闭后停止后续自动运行，不中断正在执行的任务，仍可手动执行。它与编辑器中文件的
「配置中启用」字段是两套状态：前者是数据库临时开关，后者写入 JSON 的 `enabled`。
再次装载该任务时，以 JSON 中的 `enabled` 为准覆盖开关状态（省略时为 `true`）。

    {
      "version": 1,
      "timezone": "Asia/Shanghai",
      "defaults": {
        "allowConcurrent": false,
        "timeoutSeconds": 3600,
        "agent": { "provider": "codex", "model": "gpt-6-sol", "effort": "high" }
      },
      "tasks": [
        {
          "id": "health", "name": "健康检查", "type": "script",
          "cron": "*/30 * * * * *", "command": "bash", "args": ["scripts/health.sh"]
        },
        {
          "id": "review", "name": "每日检查", "type": "prompt",
          "cron": "0 0 9 * * *",
          "agent": {
            "provider": "dsh",
            "model": "deepseek-official/deepseek-v4-flash",
            "effort": "high"
          },
          "prompt": "检查项目状态，报告问题与建议。"
        }
      ]
    }

`agent` 字段为 `provider`（codex 或 dsh）、`model` 与可选的 `effort`：

- provider/model 下拉列表来自宿主的已认证模型目录（`GET /api/providers/:provider/models`），
  不写死模型清单；列表加载失败或宿主不提供该能力时保留文件已有值并明确提示，可重试。
- 任务省略 provider 时继承项目 `defaults.agent.provider`（再缺省为 codex）；省略 model 时
  只有 provider 相同才继承项目 model，否则使用 `default`。effort 仅在同一 provider 且同一
  生效 model 下才继承。
- `effort` 可选值来自当前生效 model 的目录声明；`"default"` 表示显式不传 effort 并覆盖继承，
  省略表示继承/未设置。未知的历史 effort 会原样保留，不会被自动改写。
- 切换 provider 会清空任务显式 model 并把 effort 置为 `default`；切换 model 同样把显式
  effort 置为 `default`，避免把上一个 provider/model 的参数带到新选择。
- DSH headless 的 effort 只在显式 provider/model 路由下生效，因此 DSH 配非 default effort
  却使用 `default` model 会在保存预览时被拒绝，而不是等运行才发现。
- Codex 以 `-c model_reasoning_effort="…"` 作为单个 argv 传入 `codex exec`；DSH 将
  `reasoningEffort` 写入临时 `agent-default-model` patch。`default` 与未设置都不传参数。

Cron 接受五或六段，六段首项为秒；时区使用 IANA 名称。cwd 默认为项目根目录，必须在项目内。
脚本以 command、args 直接启动；管道请显式使用 bash -lc。任务 env 不能覆盖插件内部执行控制变量。
同一项目、任务默认禁止重叠，忙碌时跳过至下个时间点；手动运行遵守同一规则，容量用完也跳过。

## 执行环境

「插件设置 → 执行环境」为所有项目的脚本任务和提示词任务配置额外环境变量，保存于插件设置。
变量名只能包含字母、数字与下划线，且不能以数字开头；值按原样传入，支持多行。
`AGENT_EXEC`、`CLOUDCLI_HOST_ROOT`、`CLOUDCLI_PROJECTS_FILE` 以及 `CLOUDCLI_PLUGIN_`、
`CLOUDCLI_SCHEDULER_` 前缀属于调度器内部变量，不能在此配置。
运行优先级为宿主进程环境 < 插件执行环境 < 任务 `env`，因此同名任务变量覆盖全局值。
保存后下一次执行直接读取最新设置，无需重新装载；正在运行的任务保持启动时的环境。
全局值只合入 worker 的环境，不写入项目 JSON、任务定义或运行快照，也不修改宿主进程本身。
脚本通过 AGENT_EXEC 发起的调用继承同一环境。
重复或非法变量名在保存前报错，不会静默合并；`env` 省略时保留旧值，提交 `{}` 清空。

## Agent

脚本获得可执行包装器 AGENT_EXEC，调用方式为 "$AGENT_EXEC" "提示词"。
脚本和提示词任务共用入口。Codex 从 claudecodeui 安装目录解析依赖的原生二进制；
macOS arm64 优先 node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex。
不依赖全局 Codex。提示词任务以 exec --json 启动（保留原生会话，不再传 --ephemeral），
通过 stdin 传递提示词；脚本中的 AGENT_EXEC 仍以 exec --ephemeral --json 启动，不保存会话。
DSH 使用宿主 CLOUDCLI_DSH_BIN（默认 dsh）、DSH_HOME 和 CLOUDCLI_DSH_PATCHES。提示词任务启用
session-persistence-jsonl（默认写入 $DSH_HOME/sessions；设置了 CLOUDCLI_DSH_SESSIONS_DIR 时
用临时 patch 把原生写入对齐到该目录）并保留 session-checkpoint-policy；脚本中的 AGENT_EXEC
沿用原来的禁用持久化与 checkpoint 策略，不产生 pending 告警。两种情况都不修改 profile。
DSH headless 文本在步骤提交时产生，不承诺逐 token 显示。

无人值守任务沿用 CLI 权限配置，需要审批时不自动授予额外权限。
脚本任务及脚本中的 AGENT_EXEC 以进程退出码为准：正常退出 0 即成功；非 0 或没有退出码则失败。
AGENT_EXEC 保留自由文本输出，不强制任务结果 JSON。spawn 失败、内部日志写入失败和超长事件
主动终止仍算失败，超时和手动停止由调度器状态单独记录。

提示词任务在每次运行时自动追加结果约定，不修改项目 JSON 或已保存的提示词。Agent 最终答复必须
只包含一个 JSON 对象，例如 `{"status":"success","summary":"日报已生成，日期和内容检查通过"}`。
`status` 只接受 `success` 或 `failed`，`summary` 必须为非空字符串；权限不足、部分完成、无法验证
或需要人工处理应报告 `failed` 并说明原因。建议在原提示词中写清验收条件。

提示词任务仅在退出码为 0、Agent 正常结束且最终任务结果为 `success` 时记为成功。Codex 从本轮
最后完成的 agent_message 读取结果并要求 turn.completed；DSH 从 final.text 读取结果，并要求
status/turn_end 事件的 reason.kind 为 completed。Agent 明确失败或任务结果为 failed，即使退出码为 0 也记为失败。
缺少结束事件、结果缺失或格式无效时记为失败，原因明确标注“结果未确认”。中间工具错误、临时
error 事件或其他无效 JSON 行只作为诊断；恢复后最终满足成功条件仍可成功。

运行记录保留真实退出码和已校验的任务报告；页面同时展示最终运行状态、报告摘要与失败原因。
历史记录无需迁移，不重新判定历史结果。结构化结果仍是 Agent 的自报：必须客观验收的任务应使用
脚本任务调用 AGENT_EXEC，再运行验收命令检查文件日期、内容或接口响应，以脚本退出码确定结果。
提示词任务的会话与日志分开保存：原生会话由宿主会话视图读取，调度日志仍按运行记录保存；
stderr 非空本身不代表失败。会话绑定与复用的行为见下一节。

## 会话与复用

每次提示词任务执行前，调度器先让宿主准备一个真实 app 会话，并把 sessionId 与 executionId
立即写入运行行，然后才启动 CLI；CLI 报告已核实的原生会话 ID 后，宿主把该 ID 和原生
transcript 关联到同一会话。脚本任务和脚本中的 AGENT_EXEC 不建立这种绑定，行为保持不变。

- `reuseSession`（仅提示词任务，缺省 false）：为 true 时，同一任务后续运行接着上次绑定的
  同一 app/原生会话；provider 或 cwd 变化后旧绑定不再被选中，但仍受保护。
  `reuseSession: true` 写在脚本任务上会校验失败；它也不能与 `allowConcurrent` 同时开启，
  复用的会话同一时间只服务一次运行。
- 未开启复用时每次运行创建新会话，历史运行仍可在运行详情中查看。
- 运行详情的「对话」标签通过宿主已有的会话视图展示该次运行的原生会话（只读，按轮询刷新）；
  stdout、stderr 与原始事件保留为诊断信息。旧运行没有绑定会话时按本次输出回退，不伪造回放。
- 只要任务仍在已提交的配置中，它绑定过的会话就受保护：停用任务、关闭 `reuseSession`、
  修改 provider/cwd、插件关闭或宿主重启都不解除保护。只有删除任务才解除绑定，解除绑定只
  解锁会话，不删除会话或其历史。
- 复用只支持现有两种 provider（Codex exec 与 DSH headless）且要求同一有效 cwd；宿主不可用时
  提示词任务明确失败，不会退回无会话模式。运行中关闭插件会先停止 CLI，再释放宿主占用。

## 生命周期与日志

数据按宿主数据库完整路径的散列隔离，保存于其 plugins/project-scheduler 子目录，不在项目内保存日志或凭据。
同一目录下不同数据库文件对应独立调度数据，避免多个宿主实例互相影响。
宿主提供可信项目目录快照，不接受浏览器指定任意目录。loopback 内部 RPC 使用随机令牌。
数据目录有独占锁。宿主/插件退出通过 IPC 通知 worker，由其终止命令进程组。
重启记录意外中断，不自动重试有副作用的任务。

完整运行记录与 stdout、stderr、原始事件从运行结束起默认保留 30 天；0 永久保留。
运行中不清理；最近一次结果摘要单独保留。缩短天数影响已有数据，清理后不可恢复。
每个日志流最多 16 MiB，超过后继续排空管道并明确提示截断。

## 常驻任务

常驻任务复用正在运行的前台会话，不新建 Agent 进程、不写入项目 JSON，也不提供提示词或权限编辑。
唯一创建入口是会话右上角「三点 → 设为常驻」：只有正在运行的前台 Codex 或 DSH 会话可创建，
空闲置灰、其他 provider 或插件不可用时不可选；重复绑定由宿主拒绝而不是新建。
转换不打断、不向会话输入，保留同一 app 原生会话、上下文、model/runtime 与权限；默认仍在
前台可见，插件只是额外提供列表。插件任务 ID 在创建时由插件生成；任务名称跟随原会话当前
名称，原会话改名后常驻列表随既有刷新显示新名称，已有任务无需重建。告警沿用插件全局 Telegram
设置（与定时任务共用），常驻任务在停止时告警；当前没有逐任务的
告警偏好开关，创建时记录的 `notify` 固定为开启且没有界面或 PATCH 字段可改。

Codex 常驻复用 CloudCLI Codex Provider 与原会话已经选择的 runtime：app-server 会话复用 CloudCLI
管理的对应 app-server 连接，exec 会话沿用既有的 codex exec Provider 适配器，不另选独立的 task
engine，也不改写原会话配置。模型、effort、权限与原生上下文都沿用原会话；宿主恢复或显式继续时
按同一 provider 模式的同一原生会话发一次 continue。DSH 常驻同样沿用原会话已有配置。

常驻状态与运行记录都由宿主持有：插件只保存任务元数据、固定为开启的 `notify`、以及已处理终态
的光标；运行态一律通过 `cloudcli-scheduler-resident` IPC 向宿主查询和执行，宿主不可用时接口
明确失败，不会模拟成功。插件自己的 `resident_tasks` 表与项目 JSON、`tasks` 表、`removeMissing` 和 cron
装载互不影响。每次终态只写一条 `source: resident` 的运行记录（含 trigger、sessionId、
executionId），终态插入与光标在同一事务中；重复投递不会新增记录，也不会重置告警重试次数。
普通运行历史默认排除常驻记录，只写终态、不写 running，因此不参与意外中断恢复，也不更新普通
任务的最近结果。

列表页展示宿主状态与启用、前台可见、停止、继续、删除操作；点击任务名直接进入对应原会话的聊天框，
历史消息、实时输出和后续输入都在原会话中查看与进行，不再另开只读详情页。停止、禁用、删除是不同
语义：

- 正常结束或报错会告警并保持停止；前台人工停止、插件停止、禁用或删除是明确的用户动作，静默停止。
- 「启用」或「继续」只在已停止时对原原生会话精确发一次 continue；活跃时只返回当前状态，不中断
  正在进行的轮次。后续输入仍从原前台会话发出，既有队列照常工作。
- 「前台可见」是独立开关，默认开启，不借用会话 source/archive；隐藏的常驻会话仍可通过会话 ID
  查找打开，显式显示时按现有恢复语义还原。
- 删除任务必须先成功停止（若仍在运行）再解绑，最后才删除插件元数据；停止失败时任务、解绑和
  保护状态都保持不变。删除只解绑任务，保留原会话。

只要绑定存在，该会话就受保护：禁用、隐藏、插件关闭都不取消保护，强制删除、归档、保留期清理、
孤立会话清理、DSH 旧代际解绑、项目或 worktree 删除都不会物理删除它；已归档会话的原有语义不变。
打开中的任务禁用或隐藏会刷新界面。

宿主重启（优雅退出或崩溃）只恢复当时确实在运行且启用的绑定，并保持同一原生会话与同一
provider 模式；已结束、报错、
人工停止或禁用的任务不复活，恢复失败会明确失败并告警，不换新会话。插件进程重启只与宿主对账
（补齐元数据和未处理的终态），不会打断宿主运行、也不会自动发 continue；宿主自身的启动恢复只做一次。
常驻执行不受定时任务并发上限约束：`maxConcurrentRuns` 及 worker 并发只约束脚本与提示词任务。
每个常驻任务始终关联一个原会话，多个任务按各自会话运行；这里不额外承诺并发额度。

### 阶段日志

常驻会话的 Agent 可以通过 `stage_log` 工具记录简短的阶段（例如「部署到 staging 完成」
「测试套件失败」）。注入前提是定时任务插件已启用且宿主日志记录器就绪，与同会话中 Worker 是否
启用无关。Codex 在 app-server 线程实际创建（thread/start）或恢复（thread/resume）时注入；会话
已经加载时，不保证下一轮就带上该工具。Codex exec 每次运行单独注入，DSH 在 ACP 与 headless 下
通过临时 patch 注入，不修改用户配置。工具的 description 自带记录规则，用户提示词可按业务补充
要记的阶段；遗漏记录不影响对话。

每条阶段包含两个时间：事件发生时间（可自己提供，缺省取记录时刻，用于展示）和记录入库时间
（由宿主发放，仅用于 7 天保留与翻页）；状态是自由文本，另含阶段名、来源（Agent 上报或宿主
生命周期）和可选结构化数据。宿主生命周期条目只说明任务状态变化，不改变任务的运行结果，也不会
为阶段自动发送告警。任务尚未成为常驻时，工具返回 `not_resident`：本条不重试，成为常驻后的后续
阶段仍可正常记录。阶段日志不是终态运行记录，与运行历史分开保存与展示。

常驻列表中的任务名仍直接进入原会话聊天；另有独立的「阶段日志」表格，按时间、阶段、状态、内容、
来源、添加时间与详情各列展示，每条一行。表格默认看最近 50 条，每 5 秒刷新最新一页，查看更早的
页为静态内容，可随时回到最新。服务端每页默认 50 条、最多 100 条，用不透明 cursor 翻页；阶段
日志只有 7 天保留期，从记录入库时间起算。旧版节点日志记录继续保留并可在同一表格查看，无需手动
迁移。

HTTP 接口供插件界面使用：`GET/POST /resident-tasks`、`GET/PATCH/DELETE /resident-tasks/:id`、
`POST /resident-tasks/:id/stop`、`POST /resident-tasks/:id/continue`，以及
`GET /resident-tasks/:id/logs?cursor&limit` 返回 `{logs, nextCursor}`（阶段日志，与任务详情的
`runs` 相互独立）。创建只接受 `sessionId`；
PATCH 只接受布尔 `enabled`/`visible`；创建返回 `{task}`，列表返回 `{tasks}`，`GET /resident-tasks/:id`
（程序接口，供脚本或工具读取）返回任务字段加 `runs`，继续返回 `{task, result}`，其他控制返回同一
任务行，删除返回 `{removed: true, sessionId}`。
宿主错误以 `{error, code}` 返回：`not_found` 为 404，`invalid_request` 为 400，通道不可用或超时为 503，
其余状态冲突为 409。

## 告警与构建

设置 Telegram bot token、chat ID、可选 HTTP 代理。失败、启动失败、超时及意外中断告警。
项目的“编辑任务 → 项目默认配置 → Telegram 失败告警”可选择“跟随全局设置”或“关闭本项目告警”，
作用于该项目全部定时任务。“跟随全局设置”仍需全局渠道开启。项目关闭告警时，任务列表、任务详情和
全局告警设置显示醒目提示并提供项目配置入口；编辑器在折叠区域外提示关闭状态。
提示词任务的业务失败及“结果未确认”同样告警，消息保留退出码 0 和实际失败原因。
手动停止、并发跳过不告警。发送结果单独记录，有限退避重试不重新执行任务。
常驻任务复用同一 Telegram 渠道与待发重试：自然结束与失败都会告警，人工停止、禁用和删除不告警；
没有逐任务告警偏好设置，是否投递只看全局渠道开关与固定开启的 `notify`；文案按「已结束/
异常停止」区分并给出原会话，不使用定时任务的退出码措辞。
测试按钮会实际发送消息。Token 不返回浏览器、不注入任务进程、不写项目文件。

npm run build:plugins 构建插件；普通 dev/build 包含插件构建。npm run test:cron 验证核心行为；
plugins/project-scheduler/tests/resident.test.ts 覆盖常驻元数据隔离、IPC 关联与终态去重，
resident-http.test.ts 用真实插件进程与脚本化宿主验证 HTTP、IPC 与删除顺序；
plugins/project-scheduler/tests/configuration-editor-ui.test.ts 用 jsdom 挂载真实打包产物，
覆盖草稿 helper 与编辑器交互（先构建插件再运行）。
