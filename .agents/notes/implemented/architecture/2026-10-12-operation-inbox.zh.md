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
- Stop 先持久暂停，再取消执行。Stop 前排队的输入保留历史，但失去执行资格；新的用户消息携带结果资料，不携带已取消的旧指令。用户原文、配置和因果深度保持不变，Agent 任务不能解除暂停。
- Stop、可信用户接受和真实 transport 启动共用准入。未知提交不重发，包括携带 batch 的用户输入的 stale-ACP 恢复；只重试结算。Scope 关闭或等待者取消不代表资源真实释放。
- B 当前准确输入由 Agent A 发起时，不能向 A 发新 chat。单条、批量和旧入口在接受新工作前返回 `REVERSE_CHAT_FORBIDDEN`；后续独立输入替换此限制。这样不需要任务图或 task/note 新工具，但不保证消除更长的环或重复向外委派。

历史调查没有定位到“模型更频繁反向发信”的单一改动。[PR #1262](https://github.com/LodyAI/Lody/pull/1262)改变的是 Agent 作者展示，不是普通执行提示；没有证据支持通过回滚头像修复。已有放大路径是反向创建任务和逐 Delivery 续跑。源码核对不是受控模型重放。

2026-10-12 的调研借鉴了 [Codex 完成通知](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/agent/control/completion.rs)与 [OpenCode 调度器](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/run-coordinator.ts)的持久入队、独立准入和批量消费；没有照搬它们的 Stop 语义，也没有独立运行它们的测试。

## 所有权、恢复与兼容

Effect 保持锁定 4.0.2。`inbox/service.ts`拥有存储、信号和 scoped fiber；`operationInboxLegacy` 是唯一登记的主流程桥接。整个 Session／ACP／历史迁移尚未完成，边界见 [Effect 台账](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md#单元台账)。

`40ef5c29cbe496f28f17ab10297cf37c3c48030f` 的审核发现三个 adapter 缺口，修订落实以下契约：

1. 每次资源创建前持久登记“不完整”，持续合入后来的终端／进程 roots，保留全部 Session 所有者和发起 host PID。重开必须证明资源集合完整且全部消失。身份缺失、Windows 或释放无法确认时保持阻塞，不能向可能被复用的 PID 发信号。
2. 可信 renderer／非委派 CLI 在激活或入队前持久保存 `humanInputReceipts`。RPC 丢失或输入过大时，历史兜底恢复匹配授权；普通历史、用户不符的回执、已取消／已结束输入不能解除暂停。
3. 协调器 `recoverStop()` 调用独立的 `recoverClose()`，只补写结算／释放／暂停回执。保留原失败回执和恢复所有者，不重发 transport，也不把再次关闭 Scope 当成恢复。

手动 Stop 的 RPC 与持久兜底共用请求 ID，防止迟到重复请求再次暂停新输入。写盘失败保留请求身份以便补写。已消费结果副本随 Operation 保留期清理；永久删除 Session 同时删除 Inbox 副本。最终存储边界是 schema／Inbox protocol v2、host launch v3。此次明确放弃旧编排数据兼容：旧版专用库和未使用的兼容结果副本在首次打开时删除，不重放、不导入；当前 Inbox 的暂停、未知提交和资源所有权保留。完成结果直接入 Inbox，删除旧表、逐条认领／续跑接口、旧模型和旧协调器 fixture；结果序号持久递增，保留期清理不能重用旧水位。忙闲判断不再把被动结果算作执行。`inbox/legacy.ts` 只桥接仍未迁移的当前 Session／ACP，batch 成员的展示格式仍保留。目前没有已发布的兼容 SHA。

Stop 请求详情改为 Session 控制文档内一个可覆盖的 `cancelRequest` 槽位，不再增加 metadata ID 字段。renderer 先持久保存详情，再写 `lastCanceledTurn = cancel-request:<id>`；RPC 保持立即发送，并使用同一 ID。Watcher 等待匹配的控制数据，通过独立取消链处理控制数据到达；旧版直接写 turn ID 的请求仍兼容。SQLite 负责持久去重，因此重开及迟到 RPC／兜底不会再次暂停新输入，新的点击仍有独立 ID。资源所有权、真实释放移交及暂停写盘失败恢复保持不变；本次 adapter 调整不扩展原生迁移。

与主分支 `7b540b10f` 合并后，保留原始 ACP 排空 → presence 清除 → turn／Inbox 移交的顺序。presence 清理失败仍保留旧执行所有者；daemon 关闭同时取消历史所属任务，并排空／恢复关闭 Inbox。依赖维持合并后的锁定版本，包括 Streams 0.17.0、Effect 4.0.2。

## 验证与剩余边界

作者验证使用锁定依赖的隔离源码副本，并核对改动源码字节一致；不是独立 base/head 审核。以下范围有交集，不能累加；以前的完整测试记录保留在 Git 历史中。

| 范围 | 本次清理的证据 |
| --- | --- |
| Store／Coordinator／Inbox／执行／进度投影 | 最终 5 个 suite，387 项通过；删除旧库、事务回滚、保留当前未知／暂停／资源状态、消费保留期与序号不重用 |
| 执行入口／Watcher／supervisor／注册／命令／MCP | 7 个 suite，509 项通过；旧宿主拒绝、batch 准入与反向 chat |
| Shared 消息／组件关系展示 | 各 3／2 个 suite，28／28 项通过 |
| 类型、lint、格式与 `check:quick` | 通过；保留现有边界检查，并禁止旧 API、逐条派发来源和结算回调回流 |
| 完整 `pnpm check` | CLI 4076 项通过、4 项跳过；未修改的 Git transport 一项 `context_unreadable`／remote helper aborted，未独立复现基线；最终删减由所属测试和静态检查覆盖，不能宣称全仓全绿 |
| 文档检查 | 82 项已有错误，无 Inbox 错误 |

测试通过 Deferred、注入时钟、fake timers 和故障触发器检查完整模型输入、持久行与真实释放。覆盖八项合批、空边界、迟到第九项、无新事件重开、暂停／未知不重发，以及当前调度所有权与资源释放。旧协调器 fixture 的早期移交测试随被退役的契约删除，不能充当新版验收。资源测试使用真实独立进程组，进程表为注入快照。不宣称真实模型、完整系统进程表、桌面端到端、合入或发布验收。

修订候选仍待独立复审，Spec 保持 draft。未来 Lody 各落地端和 Agent adapter 都完整支持 ACP steer 后，再评估执行中合批交付，并验证实际应用、暂停、取消和未知交付。这是维护条件，不是当前行为或定时提醒。

[PR #1523](https://github.com/LodyAI/Lody/pull/1523)。
