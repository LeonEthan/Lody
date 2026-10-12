# 区分消息身份变化与协作循环

Status: proposed
Translation: current

[English](2026-10-12-agent-message-loop-origin.md)

## 摘要

Agent 头像出现的时间接近反向发消息、会话不断恢复执行的问题。Git 历史能精确定位头像变化，但不能证明它引入了循环：此前消息已经使用用户输入行，正常执行提示也没有因此增加发送者指令。编排边界仍允许反向创建任务，并在请求者空闲后为每个完成的 Operation 单独启动续跑。修复应处理这些语义；目前没有证据证明撤回作者展示会改变模型执行。

## 范围与证据

源码基线：`3ac76bad10f46720517a2ca6929f03de4ef5bb9b`；历史范围：2026-09-20 至 2026-10-12。本文仅包含公开源码证据，不保存采集的对话或内部任务记录。没有修改生产代码，也没有通过模型重放实验验证行为。

| 候选 | 已验证的变化 | 因果限制 |
| --- | --- | --- |
| [#1262](https://github.com/LodyAI/Lody/pull/1262)，`0c10ae2b7`，Leon Zhao，10 月 5 日北京时间 21:43 | 冻结 Agent 作者身份，用 Role 头像替代人类发送者展示；结构化历史开始输出 `author`。 | 父版本已经写入 `role: 'user'`、渲染用户消息行。普通 ACP 输入不读取 author；完成通知仍为 system。 |
| [#1334](https://github.com/LodyAI/Lody/pull/1334)，`811b57332`，10 月 8 日 | continue、steer、restore 统一执行接受时冻结的 Config／Role／任务文本。 | 合成文本与原文不同时，确实可能改变指令；必须比较实际输入，不能仅凭 Role 前缀为空排除它。 |
| `8305406d6`，9 月 30 日 | Codex runtime 从 0.156.0 升至 0.159.2。 | 运行时／模型行为可能变化；版本升级本身不能证明新增了反向发信指令。 |
| [#1422](https://github.com/LodyAI/Lody/pull/1422)，`45753fe61`，10 月 11 日 | 连接中断后不再重复提交完成通知输入；保留已退役的 Operation 身份。 | 防止同一身份重复提交，不能阻止不同的新 Operation。 |
| [#1428](https://github.com/LodyAI/Lody/pull/1428)，`9d9963d49`，10 月 11 日 | 增加协作提示、更小的深度上限与整树停止屏障。 | 历史运行时看到的工具定义需要单独核实；合入状态不等于当时生效，提示也不是反向目标准入规则。 |

核对 #1262 的父提交中 `apps/cli/src/commands/session.ts` 的 `appendUserPromptHistory`，以及 `packages/components/src/components/ai-gui/view.tsx` 的 `UserMessageRowView`。该提交对 coordinator 仅新增 system author。新增 Role snapshot 只有 id、revision、name、emoji，没有 prompt。历史工具新增 author 确实可能被模型看到，但前提是模型读取历史；它不会自动进入执行文本。

另从公开子模块检查 Codex adapter 的 `51a07eeb9..b67f2eaab63247159c8cbdbd4075334f69729daf`：变化包括诊断、显式 `/plan` 输入、启动时模型选择和标题处理，没有增加普通委派的 sender／parent 指令或反向发信策略。启动模型选择修复仍可能影响行为，需要实际前后模型证据，不能直接归因。

## 已有的放大路径

- [`session_chat`](../../../../apps/cli/src/mcp/lody-mcp-server.ts) 创建持久任务。目标差异检查禁止给自己发送，但不拒绝向当前任务的发送者发信。同一 turn 的重复调用共用其深度，因此深度上限不能限制调用数量。
- [`deliverIfRunnable`](../../../../apps/cli/src/orchestration/operation-coordinator.ts) 等待没有活跃 turn、没有待派发用户输入，再为每个符合条件的 Delivery 单独调用 `continueSession`；不要求原始来源 turn 仍未结束。这两个空闲条件早于本次历史范围。
- 投递过期使用 `deadlineAt + 8h`，不是 `finishedAt + 8h`。默认任务期限为 24 小时，所以很早完成的结果仍可能在接受后接近 32 小时时具备唤醒资格。
- Operation 身份去重不合并不同 id 的语义重复消息。人类授权、界面作者、模型输入和续跑资格是不同契约。

因此，反向新任务和后来的自动结果都可能恢复执行。这里解释的是反馈机制，不能据此确定某个模型从哪一天开始频繁使用它。

## 证据解读与后续

不能把 `consumed_at` 当成模型成功执行：Delivery 可以未提交就结算。应分别检查执行阶段、尝试次数、终态原因、provider 提交与真实原生输入。provider prompt-start 日志也不证明模型成功消费。

[消息作者决策](../../implemented/architecture/2026-10-05-message-author-identity.zh.md)仍成立，本次调查不推翻其展示选择。[冻结输入决策](../../implemented/architecture/2026-10-08-frozen-turn-execution-input.zh.md)解释了为何必须比较实际文本。修复需要明确反向请求、被动进度、结果批量投递和请求者续跑许可的有效期；这些行为变化应审查现有 [Session 编排 Spec](../../../../specs/session-orchestration.zh.md)，而不是凭猜测回滚头像。

尚未定位“模型更频繁反向发信”的单个引入提交。历史 diff 和输入核对不能代替受控模型行为实验。
