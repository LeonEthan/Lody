# 拒绝向当前 turn 的发信人反向发送 chat

Status: implemented
Type: bug-fix
Translation: current

[English](2026-10-12-turn-scoped-reverse-chat.md)

## 摘要

两个独立对话互相创建 chat 任务、自动收到结果时，可能形成反馈循环。本次只拒绝 B 在准确的当前输入由 Agent A 发起期间，向 A 创建新的 chat。保留现有工具、自动结果和派发时机，不新增留言工具或任务图。限制已实现并完成本地测试；缺少发信人信息的旧输入，以及更长的多方循环，不属于本次修复范围。

## 决定与边界

执行运行时确定准确的驱动输入 id，历史 backend 只读取这条输入；其 Agent 作者提供本次调度限制所需的发信人来源。人类授权仍来自运行时，不来自作者元数据。限制不依据父子关系、最新历史扫描或助手作者。后来由用户或 C 发起的输入会替换这个范围，因此 A 仍可接收后续独立工作。

单条和旧兼容 chat 在创建目标输入或新 Operation 前，返回不可重试的 `REVERSE_CHAT_FORBIDDEN`。混合批量记录反向项失败，其他目标继续执行；全部是反向目标的批量不创建 Operation。已接受 Operation 的准确重试保留原回执，不追加提示。准确输入历史不可用时阻止新 chat；旧输入存在但缺少 Agent 作者时保留兼容行为，因为无法安全推断发信人。

这比维护上游任务链或新增被动留言协议更小。它阻止直接反向派任务，不保证阻止所有多方循环或重复向外派任务。不撤销已接受的工作，也不改结果合批、Stop、队列消费或现有投递唤醒行为。更完整的[收件箱提案](../../proposed/architecture/2026-10-12-turn-scoped-operation-inbox.zh.md)和[循环诊断](../../proposed/bug-fix/2026-10-12-agent-message-loop-origin.zh.md)仍是独立工作。

Effect feature/fix 评估保留现有接受工作流中的限制。原生迁移会牵涉尚未迁移的命令／历史依赖，扩大本次范围；不声称改变了生命周期、所有权或完成了 Effect 迁移。

收件箱、批量派发和持久 Stop 后续已独立实施，当前状态见[收件箱实现记录](../architecture/2026-10-12-operation-inbox.zh.md)。本文的范围与下面的 75 项证据仅指反向 chat 修复。

## 验证

现有 MCP 两个 suite 共 75 项测试通过。新增测试使用真实 HistoryWriter／SessionData 和 SQLite，覆盖单条、旧兼容及 defaults 展开的批量拒绝、混合批量持久化和重试、后续用户／其他 Agent 输入，以及准确来源缺失。检查实际持久 Operation 和交付输入，不只数 mock 调用。使用隔离源码快照与已有本地测试依赖，没有调用真实模型或网络。

反向 chat 单独验收时的仓库完整检查与 CLI 类型检查独立报告：当时工作树未安装依赖、ACP 子模块未初始化。临时环境中修改版与基线 CLI 类型检查输出相同的 47 行诊断；docs check 保留相同的 82 项基线错误，没有新增错误。改动文件的格式和空白检查通过。本地实现证据不等于部署或产品验收。行为由[会话编排 Spec](../../../../specs/session-orchestration.zh.md)和[MCP 规则](../../../../apps/cli/src/mcp/AGENTS.md)维护。

## 未来 ACP steer 的复查备注

异步任务输入、留言和 Operation 结果按已讨论的消费边界处理：上一轮自然结束后，或下一条输入开始时；用户暂停仍禁止自动继续。本次不实施这套完整收件箱策略。等 Lody 各落地端及 Agent adapter 都完整支持 ACP steer 后，提醒维护者重新评估通过 steer 向当前执行交付这些消息。仅协议存在不足以启用：还需验证模型实际应用、所有权、取消、暂停及交付未知的处理。这是未来复查条件，不是定时提醒，也不授权现在启用 steer。
