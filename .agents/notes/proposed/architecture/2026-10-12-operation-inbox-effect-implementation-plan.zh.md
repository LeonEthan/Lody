# 异步对话：收件箱实施计划

Status: proposed
Type: architecture
Translation: current

[English](2026-10-12-operation-inbox-effect-implementation-plan.md)

## 摘要

用户已授权落实完整计划。此次施工包括反向 chat 限制、持久结果收件箱、合批、Stop、真实提交与释放、历史展示和只读分页；不新增 task/note 工具或任务图。核心及主流程已接入；专项验收已通过，全仓检查的未通过项和独立 review 状态见实现记录。尚未合入或发布。设计意图、实现证据和产品验收分开记录。

## 0. 当前实施范围

| 部分 | 代码与验收入口 |
| --- | --- |
| 反向 chat | 保留既有 `REVERSE_CHAT_FORBIDDEN` 及真实 MCP suite |
| 持久状态 | `inbox/sqlite.ts`；完成事务内索引，固定意图、水位、成员、输入和释放回执 |
| Effect 内核 | `inbox/service.ts`；Service / Layer / Scope、合并信号、每会话准入及结算恢复 |
| 真实执行 | `session-execution-service.ts`；实际 prompt 启动、不可变执行 ID、取消及未释放资源恢复 |
| 主流程 | 协调器删除逐 Delivery 续跑；可信 UI/CLI 输入登记、Stop 与队列历史保留 |
| 展示与读取 | 单条 `operation_completion_batch`、稳定历史回执、64 KiB 预览和 128 KiB 分页 |
| 验收 | 现有所属 suites、真实旧协调器移交 fixture、SQLite 重开与故障注入、静态边界检查 |

## 1. 确定行为

结果到达只保存。忙时排队；自然结束且真实释放时，按首次边界的固定水位合批一次。空边界、重复释放和边界后才到的结果都不能启动额外执行。手动 Stop 先持久暂停再取消；下一条真实用户消息携带已保存结果。失败退出没有自动意图；未释放状态还会阻止新的用户执行。

**Stop 前已接受但未执行的旧用户消息：取消其执行资格，保留原文与历史；不在恢复时拼回新指令。重新执行需要用户重新发送并获得新输入 ID。** 新用户只自动携带 Operation 结果。忙时后来排队的普通用户消息不取消已经准备中的用户输入；让位规则针对自动批次。新输入解除暂停也不能复活 Stop 取消的旧执行。

普通任务 chat 仍可启动空闲会话，但不能解除持久暂停；不凭 role、userId 或 author 推断恢复授权。整树 Stop、归档、删除和身份隔离仍有否决权。不新增登记等待或继续按钮。

## 2. 独立 Effect 单元

模块位置：`apps/cli/src/orchestration/inbox/`。使用消费 CLI 锁定的 Effect `4.0.2`，不升级依赖，不替换现有 SQLite／Zod／HistoryWriter 框架。

| 部分 | 职责／允许依赖 |
| --- | --- |
| 纯规则 | 退出原因、暂停、输入优先级、资格与稳定批次；普通函数，无时钟和 I/O |
| `OperationInbox` | 原生 Effects 组合事件、存储事务、唤醒合并、认领、取消与结算；依赖抽象能力 |
| `InboxRepository` | SQLite 事务、暂停版本、结果索引、批次和恢复；同步驱动用 Effect.try 接入 |
| `InboxExecution` | 会话互斥准入、提交一份输入、精确取消和释放回执；不把完整 SessionManager 暴露给内核 |
| 历史投影 adapter | 经绑定的 Session backend／HistoryWriter 展示批次；支持现有 Loro／Roost |

服务采用 `Context.Service`、`Layer.effect` 和命名 Effect 方法。host-lease Scope 拥有一条存储连接、订阅、合并信号和 scoped fiber；每 Session 的调度互斥拥有派发准入。信号只表示“重读持久状态”，结果不存放在易丢失的内存事件队列。

SQLite 驱动属于真实外部 I/O。旧 Session／history／ACP 编排属于未完成的 Lody 依赖：使用一个明确命名的临时执行 adapter，保留真实提交和清理所有权，不把其内部 Promise 包装当成已完成迁移。内核不得导入旧 coordinator／SessionManager，也不得内部执行 `Effect.run*` 或创建脱离 Scope 的 Promise／fiber。

现有 Promise 入口共用一个 host-lease 运行时，通过一个登记的 `operationInboxLegacy` facade 进入原生服务。登记消费者为协调器完成事件、会话退出／Stop／用户输入钩子和 daemon 生命周期；删除条件是这些入口能原生组合 Effect。不为每次调用创建 runtime。

### 最小内部接口与资源所有者

- `completeAndIndex(tx, operationKey)`：在现有 Operation 完成事务内写结果索引；提交后的通知只触发重读，不能负责补写索引。
- `acceptHumanInput(receipt)`：由经过认证的 UI／CLI 用户入口登记不可伪造的来源回执，包含输入 ID、接受序号、用户、冻结配置及原始因果身份。Agent chat、Operation 结果和系统事件不能调用这个恢复入口；`role: user`、人类 `userId`、历史 author 或模型参数均不足以证明新用户授权。
- `pause(sessionId, expectedExecutionId)`：针对实际运行的执行，而非最新已接受输入；与接受用户输入、最终提交共用下述准入协议。
- `executionReleased(executionId, receipt)`：报告真实释放及 `normal | user_stop | failed`；不确定是否释放只能报告未释放恢复句柄，不能生成自然结束意图。
- `prepareInput(sessionId)`：选择等待、用户输入加结果或自动批次；不绕过用户队列。
- `settleBatch(batchId, receipt)`：持久结算，只重试结算，不重试已提交输入。

执行 adapter 必须把三件事分开返回，不能用单个 Promise 的结束代表全部结束：

| 回执／句柄 | 含义与所有者 |
| --- | --- |
| 提交结果 `not_submitted`／`submitted`／`unknown` | 是否实际交给 transport；没有输出不能证明未提交。批次存储保存结果及完整 Cause |
| 真实释放回执 | 原请求、steer/config 请求及关联进程／资源均已结束，执行槽位可以移交；`InboxExecution` 核实后才发布 |
| 未释放资源恢复句柄 | 执行 ID、owner epoch、原请求句柄、清理状态与完整 Cause；daemon 级恢复服务继续拥有资源，Session 的关闭不能丢弃它 |

资源在请求启动前登记所有者。取消只发出取消请求；外层 Effect 被中断、AbortSignal 已取消、Scope 已关闭，都不能证明底层请求已结束。adapter 的 `shutdownOnce` 保存同一关闭任务与完成回执；并发关闭等待这份回执，不能分别依赖 `Scope.close` 的返回。关闭等待有界：超时／清理失败返回“未释放＋恢复句柄”，保持执行槽位阻塞，不能无限卡住全局关闭或放行继任执行。

恢复服务使用独立的 `recover(handle)` 重试实际清理，保留完整失败 Cause；重复关闭 Scope 不是重试入口。它属于 daemon 根生命周期，在 Inbox／Session Scope 退出后仍拥有未释放资源，并持久保存恢复身份。重开后核实旧进程与外部请求的真实结束；无法证明则阻塞该 Session。新用户消息可解除消息暂停，但不能绕过未释放资源。临时 adapter 的这些义务未实现前，不宣称内核已拥有完整取消与恢复。

## 3. 持久状态、数据流与主流程集成

### 身份、暂停与自然结束意图

按 workspace／machine／Session／请求用户隔离状态。分别保存 `ownerEpoch`、`activeExecutionId`、`acceptedHumanSeq`、`pauseEpoch` 与 `active | paused | recovery_required`，不将“正在执行”和“已接受但排队”混成一个 turn。新的排队输入增加接受序号，却不改变仍在运行的执行身份；因此针对旧执行的有效 Stop 仍然有效。

手动 Stop 记录当时的用户接受序号，RPC 与持久兜底共用 cancelId；重复回执不能再次暂停后来的输入。编辑重发、权限撤销和 Operation 取消使用同一准入，但只取消执行，不写入用户消息暂停。写盘失败时保留每个暂停请求及其 ID；接受新用户输入或退出 Scope 前先补记，不能丢掉较早请求的去重身份。只有此后通过可信入口接受的新用户输入可以开启新轮次；Stop 前已排队的消息不能冒充恢复授权。归档、删除、整树 Stop 和身份失配另行否决；用户消息不能解除整树 Stop。忙与释放由实际执行所有者报告，不能由界面 idle 或 `finished/endedAt` 推断。

每个执行最多记录一次自然释放边界：唯一键为隔离身份＋`executionId`，首次事务固定释放回执与队列 sequence 水位；只有该水位内存在 eligible 结果时才同时生成 pending 派发意图，否则只保留边界记录。重复释放事件返回原记录，绝不重取水位；即使水位为零也保留边界记录。重复事件身份／回执矛盾时阻塞恢复。结果到达只保存。这样 T 释放时水位为 8，后来第 9 项到达，再重投 T 的释放事件，也不能让第 9 项获得唤醒资格。

### Stop、用户接受与实际提交的共同准入

1. 每个 Session 由一个有效 host-lease owner 持有短期准入 gate。Stop、可信用户接受、调度切换及最终提交都经过它；所有 Worker 的命令路由到这个所有者，不能各自只加本地 mutex。owner epoch 失效时禁止提交，执行所有权未确认移交时不启用新 owner。
2. 准备批次、写历史、异步权限检查都在最终提交之前完成。进入 gate 后，事务条件更新同时核对 owner epoch、实际执行槽位、用户接受序号、暂停版本、输入绑定及 batch claim；任一变化均不得写入提交栅栏。涉及提交许可的策略撤销也经过同一 gate。
3. 栅栏事务提交后，仍持有 gate，**不再 await 其他检查，立即调用实际 transport 启动原语**，取得拥有的请求句柄，然后释放 gate。SQLite 事务不跨网络等待。adapter 不能把异步排队、`onTurnStarted` 或一个稍后才调用 provider 的 Promise 当作实际启动；若无法提供这个边界，暂不启用 Inbox。
4. Stop／新用户输入若先完成准入，自动批次的条件更新失败；新用户输入按下面的事务表接管结果。若提交先获得准入，随后 Stop 取消已发起执行，用户输入排队；不能撤回或重发已提交结果。“收到点击”和“暂停已持久接受”要区分：等待 gate 时不能提前确认暂停成功。
5. 栅栏落盘后、实际调用前崩溃属于未知提交，不能凭没有输出自动重试。只有 adapter 证明 transport 未调用才可记录 `not_submitted`。暂停落盘失败时，本进程立即禁止后续自动准入、尝试取消并向用户报告 Stop 未持久成功；不继续执行、不确认成功。存储恢复后先补记暂停。未成功落盘的暂停不能声称具有断电恢复保证。

测试在最后检查后、栅栏落盘后、transport 接收前设置屏障。栅栏后的屏障仍持有 gate：竞争 Stop／用户输入不得先被确认接受再让旧输入提交。provider 接收前的异步 transport 若已发起，属于提交方先赢，Stop 必须传递取消并保留提交状态。现有 `onTurnStarted` 后还有异步检查，必须移动或改造该边界；只再加一次检查不足以完成此契约。

### 批次事务转换

批次成员不可变；历史投影在事务外以稳定 ID 幂等写入，不具有派发授权。存储设置：释放事件唯一键、意图到自动批次的唯一绑定、用户输入到可提交批次的唯一绑定，以及每个结果最多一个 live claim。旧批次保留成员历史；只有当前 claim／输入绑定可以获得提交资格。自动批次必须满足 `memberCount > 0`，并与实际成员数一致；建批与写提交栅栏都验证此条件。

| 转换 | 同一事务的写集合与条件 |
| --- | --- |
| Operation 完成 → queued | 现有完成行＋幂等结果索引；不能依赖事务后的通知补写 |
| 首次自然释放 → 边界记录／pending intent | 要求真实正常释放且尚未记录，原子保存唯一释放记录与固定水位；仅水位内有 eligible 结果才创建 pending intent，否则到此终止，重复不重取水位 |
| pending intent → prepared／settled_empty | 条件认领意图并查询水位内全部 eligible 结果；非空才原子创建固定 batch／members、live claims 和输入绑定；为空则原子结清意图为 settled_empty，不创建 batch／执行，不能重新激活。用户输入存在则不走自动分支 |
| 用户输入 → prepared／原无 batch 路径 | 有结果时绑定可信输入回执与非空批次；无结果时不创建 batch，走原普通用户输入路径；冻结原文／附件／配置 |
| 未提交自动批次 → 让位用户 | 条件验证旧 batch 仍 prepared；将旧意图／批次置 superseded，在同一事务转移全部 live claims、创建新固定成员及用户输入绑定；失败整体回滚，不能先释放再另行绑定 |
| prepared → submitting | 共同 gate 内按 owner、暂停、接受序号、执行身份、claim 与绑定做条件更新，同时验证自动 batch 的 memberCount > 0，写唯一提交 token；随后立即实际启动 |
| prepared → 暂停／失效 | 条件验证尚未跨提交栅栏；使意图／绑定失效并释放 claims 为被动 queued，暂停状态同事务落盘；不恢复自动资格 |
| submitting → submitted／unknown | 写提交回执，成员保留不可重提交状态；未知永远不能回到 prepared／queued。证明未调用时写 not_submitted 并交恢复入口，不能自行重放 |
| submitted／unknown → settled | 仅补结算／消费记录与 Cause；重复结算幂等，无新 provider 调用。未知结算不等于确认模型处理成功 |

一次认领用 `BEGIN IMMEDIATE`。自动批次只能使用意图保存的水位；用户批次准备时取当前水位。让位的新批次可以包含新水位结果，旧批次的成员历史不变。认领之后到达的结果留给下一次。写历史失败属于未提交状态；跨过栅栏后状态不明保持 unknown，不能通过重建历史恢复提交资格。

### 因果深度与完整输入

- **自动结果续跑**：沿用当前轮次和成员的最大因果深度，再按既有链规则推进；不能用合批重置上限。到达上限仍可读，但不自动启动。
- **真实新用户输入**：保留它自己的因果身份与原始深度；旧结果深度仅存于成员来源，不能覆盖新任务。深度 0 的新任务携带深度 15 的旧结果，仍按深度 0 进行新委派。若另行重发旧任务，应继续使用原任务的因果身份，不能借资料包装规避上限。

成员保留各自原身份和时间，不混合不同请求用户。原用户 prompt、附件、MCP／Role 配置冻结；结果是独立资料块。自动输入使用当前有效轮次的配置，不套用旧 Operation 的 continuation prompt/config。

用户输入只要携带 batch，整份“用户输入＋结果”都禁止 stale-ACP 自动重发；模拟 provider 接收后断线时，持久为 unknown，重开也不能重发。不携带 batch 的普通用户输入保持原恢复行为。

### 消息与大小边界

共享历史增加 `operation_completion_batch` 类型；自动派发是一条 system 结果消息，而非 N 条用户消息。用户合并派发保持原用户条目，另记录 batch 引用／消费回执，不生成额外模型轮次或修改用户原文。

模型预览总预算沿用 64 KiB，保存完整成员清单和省略元数据。成员清单过大时，首份输入提供 batch ID、总数及有界索引，完整清单／正文分页读取；逻辑上仍是一个完整批次，不截掉未展示成员、不拆成多次自动运行。

新增只读 `lody_operation_batch_get({ batchId, cursor?, limit? })`，默认 20、最多 50 项，响应不超过现有 128 KiB 读取上限。身份由当前会话上下文派生；batch ID／cursor 必须绑定请求方，外部身份查询与不存在不可区分。

### 旧协调器移交、版本与重启

在 `operation-coordinator.ts` 保留 Operation 接受／物化、目标观察和 UI 进度，删除逐 Delivery 的 `continueSession` 投递责任；完成索引进入原完成事务。在 `session-execution-service.ts` 改造上述实际启动、取消与真实释放边界，保留 backend 与历史写入所有者。

切换必须按顺序执行：

1. 共同准入中进入 quiescing，关闭旧派发入口，持久使旧 Worker epoch 失效；新调度器尚不启用。
2. 收集旧 Worker 的全部在途链、已跨栅栏请求和资源句柄。原 `coordinator.stop()` 的返回不是排空回执；需要可等待的适配移交入口，排空旧链或确认终止，并取得真实释放回执。已通过旧栅栏的请求不能靠新 SQL 条件撤回。
3. 任一旧请求未知／未释放，转入恢复服务并阻止该 Session 的新执行；移交失败不启用半套调度，不回退逐条续跑。
4. 只有旧执行所有权已确认释放，才提交新 owner epoch／Inbox mode 并启用新调度器。无有效新 token 的 legacy Delivery 准入也要拒绝，作为排空之外的防线。

附加表保存状态／意图／成员／回执，不给严格旧行直接加列。已消费／退役记录不重放；未消费升级积压标记被动，随新用户输入读取。旧提交未知记录不变成新批次。

**兼容范围**按实际协议固定，不能把候选实现当成已发布版本：

| 版本／来源 | Inbox schema／能力 | host launch contract | 可移交／降级 |
| --- | --- | --- | --- |
| 本次工作树，基于 `3ac76bad10f46720517a2ca6929f03de4ef5bb9b` | 附加 schema v1，`operationInbox: 1` | v2 | 当前候选；同协议 owner 之间先真实排空再移交 |
| 该 base 的逐 Delivery 协调器 | 无 Inbox 准入 | v1 | 不支持降级；受支持 supervisor 在获取写权前拒绝 |
| 后续版本 | 必须同时兼容 schema v1 与 Inbox v1 | 必须兼容 v2 | 仍需 host 退出／排空；其他协议版本拒绝 |

当前没有发布后的兼容 SHA；首个合入／发布版本产生后再填入，不编造版本号。真实旧协调器测试分别停在栅栏前、栅栏后和原请求内；新 owner 等旧链退出及实际释放证明。SQL 拒绝是附加防线，不能替代排空。绕过受支持启动入口的任意旧二进制不在兼容保证内。

重启必须主动恢复已有的 pending 派发检查，不依赖新完成事件或用户消息。只有原自然释放回执可验证、意图未失效且可证明未提交时，恢复固定水位，再核对暂停、身份、owner 与用户优先。仅有队列不生成新意图；重复释放不扩水位。submitting 无可靠回执视为 unknown；submitted／unknown 仅结算，不重发。暂停及未释放资源继续阻塞。崩溃时持久 intent／claim／绑定保留并由合法 owner 条件认领，不能靠删除 claim 强行恢复。

## 4. 实施顺序与验收

| 阶段 | 交付 | 放行条件 | 状态 |
| --- | --- | --- | --- |
| A | 双语现有 Spec、纯规则、事务表、adapter 契约及版本矩阵 | 本文契约可实现并经审核；固定兼容 SHA／schema；无额外恢复操作 | 已实现；独立 review 待完成 |
| B | SQLite 状态／批次及 Effect 内核，独立测试 Layers | 暂停、版本、合批、竞争和重开得到实际状态证据 | 已实现；验证范围见实现记录 |
| C | 主流程、真实启动／释放 adapter、输入／历史类型、旧协调器排空 | gate 竞争、未释放资源与真实旧执行移交验收通过；8 项一份输入 | 已实现；验证范围见实现记录 |
| D | 升级／降级、真实释放、完整检查及迁移记录 | 没有双调度者、未知重放或虚假的 Effect 完成声明 | 已实现；验证范围见实现记录 |

阶段可按依赖逐步审核，但不将未集成的内核启用到生产。实施前固定当前 base/head，保护其他工作树改动；此计划不授权自动合入或发布。

独立验收必须覆盖下表；“未收到新输入”要观察执行 adapter 的实际接收记录，而不只是 mock 次数。

| 组别 | 确定性场景与验收结果 |
| --- | --- |
| 合批边界 | 忙时 8 项零输入；自然释放后恰好一份包含 8 项身份／状态的输入；只有 3／8 完成就合并 3 项；认领后第 9 项留队 |
| 空批次终止 | 普通 turn 空队列自然结束；8 项消费完后再次自然结束；空边界后迟到结果＋重复释放＋重开：三者均为零次额外提交。保留唯一边界，无空自动 batch；认领时结果已为空则意图终结为 settled_empty，无 batch 用户输入走原路径 |
| 重启／事件幂等 | 释放水位 8 → 派发前退出 → 重开且不注入任何新事件，恢复一次；第 9 项迟到＋重复释放＋重开仍不扩水位；仅有队列不运行 |
| 暂停与可信恢复 | 暂停后迟到／重开不运行；新的真实用户消息一次携带结果，后续正常结束可合批；Agent chat 即使 role 为 user、带人类 userId 也不能解除暂停；暂停落盘失败不确认成功并阻塞自动准入 |
| 准入竞争 | 最后检查后、栅栏后、transport 接收前分别设置屏障；Stop／用户接受先完成则旧自动提交被拒；栅栏后仍持有 gate，不允许先确认 Stop 再提交；先启动后 Stop 取消且不重放。旧执行运行、新用户已排队时，针对旧执行的 Stop 仍有效 |
| 用户因果与配置 | 原 prompt／附件／MCP／Role／身份不变；用户深度 0 携带成员深度 15 仍可接受新委派；自动续跑遵守最大深度限制；伪造 batch ID／cursor 拒绝 |
| 原子转换与故障 | 真 SQLite 双 Worker；让位事务在各写入点失败／Worker 中断，重开后旧绑定或新绑定完整存在，成员无双 live claim、无孤立 claim；完成事务成功但通知丢失仍有索引；结算重复不重发 |
| 提交未知 | provider 记录完整“用户输入＋batch”，接收后断线；持久 unknown，子进程重开无重发；submitting 崩溃无证明也不重发。无 batch 普通输入保持原恢复行为 |
| 原始资源生命周期 | 请求忽略取消，等待者退出后不放行继任执行；两个关闭调用共享回执；第一次清理失败保留 Cause／所有者，重复 Scope.close 不视为恢复；独立 recover 成功后才放行，超时不堵住全局退出 |
| 切换与兼容 | 运行真实旧协调器，分别停在检查前、已过栅栏和实际请求中；旧 stop 返回后仍不启用新执行，排空／确认终止后才移交；未知旧请求阻塞；不兼容降级在写权前拒绝 |
| 读取与现有禁止 | 超预算仍保留全部成员并可分页，不拆模型轮次；归档／删除／整树 Stop／身份失配均阻止派发 |

测试使用原生 Effect 测试 Layers、Deferred、注入时钟和 fake timers；真实 SQLite 测试检查行、回执、重开和同 handle 行为。执行 adapter 测试记录真实接收的输入及释放状态，不仅数 mock 调用。不依赖网络、墙钟 sleep 或调度运气。

完成消费 CLI 的类型／所属测试、root `pnpm check`／`pnpm format`、docs 与必要 public-boundary 检查。未安装依赖按仓库规则准备隔离验证环境，不升级锁定版本。核、消费者、所有权三项分别更新[Effect 台账](2026-09-27-effect-lifecycle-migration-roadmap.zh.md#单元台账)；Session／ACP／历史仍未原生迁移的部分保持明确限制。

## 5. 审核重点与当前证据

Effect 专家重点审核：这个单元是否真正拥有其等待／取消／恢复；Session adapter 是否藏入未完成的编排；持久 Stop 与提交是否有共同线性化点；旧请求未结束时是否错误释放所有权；批次是否保持至多一次提交而不声称恰好成功一次。

存储与执行专家重点审核：双 Worker、历史与 SQL 非同一事务、半完成迁移、旧 writer 栅栏、用户输入与自动批次竞争，以及跨身份／配置合批的实际风险。发现计划不能安全落地时先给最小反例与具体修订，不降低用户的两条规则来简化实现。

最新实现与验证范围见[实现记录](../../implemented/architecture/2026-10-12-operation-inbox.zh.md)。库语义探针和旧反向 chat 测试不替代 Inbox 验收。
