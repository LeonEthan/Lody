# Operation 结果收件箱与反向 chat 限制

Status: implemented
Type: architecture
Translation: current

[English](2026-10-12-operation-inbox.md)

## 摘要

逐条结果续跑和反向创建 chat 会让对话反复恢复执行。现在结果只保存，不唤醒空闲会话；确认自然结束且真实释放后，把固定水位内的非空结果合批一次，Stop 后等新的用户消息。原生 Effect 内核负责持久调度与准入，Session／ACP 仍是明确登记的临时 adapter。当前 PR 候选已实现，独立复审、Spec 批准和真实模型／桌面验收仍未完成。

## 决定与理由

[会话编排 Spec](../../../../specs/session-orchestration.zh.md)维护行为，[编排 README](../../../../apps/cli/src/orchestration/README.md#completion-consumption)维护实现与事务契约。本文合并原调查、反向 chat 修复记录、设计和实施计划；早期版本保留在 Git 历史中。

- 结果到达不获得执行许可。真实自然释放只记录一次固定水位，空边界也保留；只有非空且可处理的成员才产生自动意图。重开无需新事件即可恢复该意图；迟到结果和重复释放不能扩大水位。
- 支持 Inbox 的 Stop 先持久暂停，再取消执行。Stop 前排队的输入保留历史，但失去执行资格；新的用户消息携带结果资料，不携带已取消的旧指令。用户原文、配置和因果深度保持不变，Agent 任务不能解除暂停。
- Stop、可信用户接受和真实 transport 启动共用准入。未知提交不重发，包括携带 batch 的用户输入的 stale-ACP 恢复；只重试结算。Scope 关闭或等待者取消不代表资源真实释放。
- B 当前准确输入由 Agent A 发起时，不能向 A 发新 chat。单条、批量和旧入口在接受新工作前返回 `REVERSE_CHAT_FORBIDDEN`；后续独立输入替换此限制。这样不需要任务图或 task/note 新工具，但不保证消除更长的环或重复向外委派。

历史调查没有定位到“模型更频繁反向发信”的单一改动。[PR #1262](https://github.com/LodyAI/Lody/pull/1262)改变的是 Agent 作者展示，不是普通执行提示；没有证据支持通过回滚头像修复。已有放大路径是反向创建任务和逐 Delivery 续跑。源码核对不是受控模型重放。

2026-10-12 的调研借鉴了 [Codex 完成通知](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/agent/control/completion.rs)与 [OpenCode 调度器](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/run-coordinator.ts)的持久入队、独立准入和批量消费；没有照搬它们的 Stop 语义，也没有独立运行它们的测试。

## 所有权、恢复与兼容

Effect 保持锁定 4.0.2。`inbox/service.ts`拥有存储、信号和 scoped fiber；`operationInboxLegacy` 桥接 Session 输入；`operation-coordinator.ts` 与 `workspace-cleanup-legacy.ts` 是登记的应用入口，platform 资源观察器同步桥接创建前的登记回调。整个 Session／ACP／历史迁移尚未完成，边界见 [Effect 台账](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md#单元台账)。

`40ef5c29cbe496f28f17ab10297cf37c3c48030f` 的审核发现三个 adapter 缺口，修订落实以下契约：

1. 每次资源创建前持久登记“不完整”，持续合入后来的终端／进程 roots，保留全部 Session 所有者和发起 host PID。重开必须证明资源集合完整且全部消失。身份缺失、Windows 或释放无法确认时保持阻塞，不能向可能被复用的 PID 发信号。
2. 可信 renderer／非委派 CLI 在激活或入队前持久保存 `humanInputReceipts`。RPC 丢失或输入过大时，历史兜底恢复匹配授权；普通历史、用户不符的回执、已取消／已结束输入不能解除暂停。
3. 协调器 `recoverStop()` 调用独立的 `recoverClose()`，只补写结算／释放／暂停回执。保留原失败回执和恢复所有者，不重发 transport，也不把再次关闭 Scope 当成恢复。

手动 Stop 的 RPC 与持久兜底共用请求 ID，防止迟到重复请求再次暂停新输入。写盘失败保留请求身份以便补写。已消费结果副本随 Operation 保留期清理；永久删除 Session 同时删除 Inbox 副本。最终存储边界是 schema／Inbox protocol v2、host launch v3。升级保留已经发布的 Operation 表、作者／输入快照、恢复状态和退役 ID，只删除旧 Delivery 表及未使用的兼容结果副本，旧通知积压不重放、不导入；当前 Inbox 的暂停、未知提交和资源所有权保留。完成结果直接入 Inbox，删除旧表、逐条认领／续跑接口、旧模型和旧协调器 fixture；结果序号持久递增，保留期清理不能重用旧水位。忙闲判断不再把被动结果算作执行。`inbox/legacy.ts` 只桥接仍未迁移的当前 Session／ACP，batch 成员的展示格式仍保留。Inbox 尚未发布，但 Operation 表已有发布版本，不能把二者的兼容性混为一谈。

作者来源与展示快照分开：保留下来的当前 Operation 即使没有作者快照，只要保存了 `sourceTurnId`，读取时也以冻结的 `requesterSessionId/sourceTurnId` 保留最小 Agent 来源，通用名称为 `Agent`，不补 Role、模型或目录信息。create/chat 在任何发布前拒绝缺少来源身份的委派；普通用户入口仍署名 human。反向检查直接读取准确输入的 Agent `sessionId`，不依赖父子关系。此修复保留已有 Operation，不重写既有历史。

Stop 请求详情改为 Session 控制文档内一个可覆盖的 `cancelRequest` 槽位，不再增加 metadata ID 字段。renderer 先持久保存详情，再写 `lastCanceledTurn = cancel-request:<id>`；RPC 保持立即发送，并使用同一 ID。Watcher 等待匹配的控制数据，通过独立取消链处理控制数据到达；旧版直接写 turn ID 的请求仍兼容。SQLite 负责持久去重，因此重开及迟到 RPC／兜底不会再次暂停新输入，新的点击仍有独立 ID。资源所有权、真实释放移交及暂停写盘失败恢复保持不变；本次 adapter 调整不扩展原生迁移。

与主分支 `09407b3b7` 合并后，保留原始 ACP 排空 → presence 清除 → turn／Inbox 移交的顺序。presence 清理失败仍保留旧执行所有者；daemon 关闭同时取消历史所属任务，并排空／恢复关闭 Inbox。依赖维持合并后的锁定版本，包括 Streams 0.17.0、Effect 4.0.2。能力注册同时保留 Inbox v2 和主分支新增的 Magpie／DSH 能力，不互相覆盖。

## 原生编排单元的落实

Coordinator 的协调、合并唤醒和重试已经迁到原生 Effect workflow；应用入口只负责组合与交接。纯规则与 platform 实现分离，边界检查禁止内核直接访问 SQL、Session、进程、Promise workflow 和运行时。SQLite Service 统一持有连接；Operation 与 Inbox 在同一连接中同步完成语义事务，事务回调禁止返回 Effect／Promise。内存 Layer 使用相同实现，仍属于副作用，不称为纯函数。Session 行无消费者的配置读写已删除，schema 不变。

ExecutionOwner 收拢输入、batch、资源和原始请求，负责提交、结算、真实释放与独立恢复；Session 不再直接访问 Inbox SQL。关闭所有者保留共享失败回执和完整 Cause，恢复只重试结算。Fleet 启动失败与正常停止共用阶段所有者，生产自动重试会先恢复旧所有者。Session／ACP／历史能力仍为登记的临时 adapter，不能据此声称依赖链全部迁移。

Agent 发起的 turn 结束后不发送用户完成通知。收尾读取本轮准确输入的作者（包括 steer 后的来源），不读取父子关系或旧输入；历史中的 Agent 输入不会影响后续用户 turn。Operation 回执、结果入队、收尾和资源释放保持原行为。作者读取后再检查 Stop。执行服务 256 项测试通过，包含 Agent 不通知、后续 human 正常通知及两者均完成历史／释放的边界。

升级审核指出三个发布边界：原迁移误删仍在运行的 Operation 和退役 ID、新客户端 Stop 向旧 CLI 发送不支持的字段、旧客户端 Stop 触发无法恢复的 Inbox 暂停。修订保留 Operation 与去重／作者／恢复记录，只移除旧 Delivery；界面与 CLI 按目标 Inbox v2 能力选择 Stop 格式；无协议身份的 legacy Stop 只取消当前执行，不持久暂停。选择这一兼容行为避免从缺失回执或 role／author 猜测 human 授权，升级客户端的持久暂停仍保持原契约。新用例运行真实 SQLite 升级与任务完成、React Stop 写入和 Session／Inbox 的 Stop 后新消息执行。

升级修订验证：CLI 4 suites／487 项、组件 79 项通过；三个定向用例在审核版本 `552c349` 分别失败，恢复修复后均通过。CLI Stop 另验证 released strict 解析拒绝新字段的边界及 Inbox v2 的显式暂停／Operation 取消行为。没有真实升级整机或旧桌面二进制端到端验收。

原生编排进一步简化：普通步骤直接 yield*，删除 Effect.exit→抛异常→恢复 Cause 的中间转换；只有 deadline、materialization 重试和进度降级边界处理失败，中断继续传播。删除只读 store 别名与恒定身份比较，保留实际运行／epoch 检查。Legacy 不再暴露 begin／prepare／submit／settle／adopt；提交回执进入 ExecutionOwner.submit，Session 不再手动结算 submitted。查询使用普通 Effect port 接口，删除无消费者的 Context.Service／Layer。没有合并或削弱共享关闭回执、真实释放、独立恢复和持久准入。

本次交集 4 suites／339 项通过，包含七个原生 Cause＋真实 SQLite 状态用例；覆盖组合失败、deadline 结算、进度降级与中断传播。共享关闭失败／独立恢复测试改为走生产执行 owner，仍验证原失败回执和不重发。此交集与前述结果重叠，不能累加；不扩大上游 Session／ACP／历史迁移完成声明。

合并 base `0b46cc2d8e33c6feafd08c00f51089456ab1e732`，不改写 PR 历史。冲突解决同时保留主分支可复用 Effect 函数转换及 lint 安装／检查脚本，以及 Inbox 准入与不重发、准确输入通知归属、sandbox 恢复 roots。解决后执行、sandbox、Coordinator 与 Inbox 六个 suite 共 391 项通过。全仓类型、lint（含 Effect lint）、format、quick 边界及文档检查通过；完整 CLI 测试 4137 通过、4 跳过，仍有合并前已观察到的同一 Git transport 失败，全仓检查未完整通过。

## 验证与剩余边界

本次已在作者工作树实际安装和检查：Node 24.21.0、pnpm 10.20.0、锁定 Effect 4.0.2。`pnpm install --frozen-lockfile` 成功，锁文件未变。安装 guard 允许此 checkout，之前把它当成嵌套工作区是不准确的。先前隔离副本结果只保留为历史证据，不是独立 base/head 审核；重叠范围不能累加。

| 范围 | 当前实现证据 |
| --- | --- |
| 作者工作树相关交集 | 7 suites，569 项通过：Coordinator、进度回传、Inbox、执行服务、Operation 存储、Session 命令与 dispatch watcher |
| 准入反证 | 此前隔离副本的两个确定性竞争位置：移除提交锁均失败，恢复后均通过；保留未知提交禁止重发断言 |
| SQLite／所有权 | 内存共享连接的完成事务、失败回滚、异步事务拒绝；磁盘重开、资源释放和共享关闭恢复沿用行为覆盖 |
| 类型／静态／格式 | 作者工作树全仓类型检查、lint、format、check:quick 通过，原生内核边界检查通过 |
| pnpm check | 作者工作树实跑未全绿：类型与 lint 通过；CLI 4137 通过、4 跳过、1 项 Git transport 失败（context_unreadable／remote helper aborted）。transport 源码和测试均未相对 main 改动；未独立复现基线，递归检查终止，不能宣称全仓测试通过 |
| 文档 | 作者环境 docs check 通过；此前 82 项缺失链接为历史结果，原先缺失的子模块源码现已存在 |

CLI 默认编辑器项目现已收录源码与测试，让两者共享 `@/*` 别名；生产类型检查明确使用 `tsconfig.typecheck.json`，保留原排除范围。实际 TypeScript language server 探针确认 src 内测试和 tests 目录文件都进入配置项目并正确解析 timeout-utils，不宣称修复其他测试类型错误。两个测试清理入口补齐等待 Coordinator 关闭后再关闭 SQLite，相关 144 项通过。全仓类型、lint、format、quick 边界及文档检查通过；全仓检查仍被下述同一 Git transport 失败终止。

测试通过 Deferred、注入时钟、fake timers 和故障触发器检查完整模型输入、持久行与真实释放。覆盖八项合批、空边界、迟到第九项、无新事件重开、暂停／未知不重发，以及当前调度所有权与资源释放。旧协调器 fixture 的早期移交测试随被退役的契约删除，不能充当新版验收。资源测试使用真实独立进程组，进程表为注入快照。不宣称真实模型、完整系统进程表、桌面端到端、合入或发布验收。

修订候选仍待独立复审，Spec 保持 draft。未来 Lody 各落地端和 Agent adapter 都完整支持 ACP steer 后，再评估执行中合批交付，并验证实际应用、暂停、取消和未知交付。这是维护条件，不是当前行为或定时提醒。

[PR #1523](https://github.com/LodyAI/Lody/pull/1523)。
