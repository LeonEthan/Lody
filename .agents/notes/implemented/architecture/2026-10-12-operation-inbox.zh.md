# 原生 Effect 结果收件箱

Status: implemented
Type: architecture
Translation: current

[English](2026-10-12-operation-inbox.md)

## 摘要

完成结果先保存，真实自然释放才按固定水位合批；Stop 后只随新用户输入处理。独立 Effect 内核管理 SQLite 意图、成员、准入和结算，主流程提供真实 prompt 启动及释放。旧逐条续跑已切断；任务 chat 与结果资料仍有不同启动权限。代码已接入，独立 review、完整验收和发布状态另列，不把先前 75 项反向 chat 测试当作 Inbox 已验收。

## 决策与边界

Stop 前未执行的旧用户输入取消资格、保留原文；新消息只携带结果，旧指令需重新发送。提交门覆盖栅栏及 transport 启动；持久执行输入绑定防止新消息解除暂停后复活旧执行。只有自动批次给新用户让位，正在准备的普通用户输入不被后来队列取消。应用用户 steer 更新输入所有权，实际执行 ID 保持不变。

`inbox/service.ts` 使用 Effect 4.0.2 原语；Scope 拥有连接、信号与 fibers。`operationInboxLegacy` 是唯一登记的 host runtime：协调器、用户/Stop/提交/释放入口尚是 Promise 消费者。Session、ACP 和历史总体迁移没有完成；临时 adapter 保留原始请求、失败及独立恢复入口，不能将包装称为完成迁移。静态守卫隔离内核与旧消费者。

POSIX 重开恢复以非空根进程身份及进程组不存在为释放证明，不向可能复用的 PID 发信号。Windows、空身份或无法证明的资源保持阻塞。未知提交只结算、不重放。大单项结果也可分片完整读取。兼容范围为 Inbox v1；旧逐条派发版本不支持降级。升级通过 host 退出屏障；同进程 legacy adapter 必须等待旧链及实际资源释放。

## 验证与交付状态

本次基于 `3ac76bad10f46720517a2ca6929f03de4ef5bb9b`，实现作为 PR 候选，尚未合入或发布。验证使用隔离源码副本和锁定依赖；最后检查确认改动的源码与副本字节一致。Effect 为 4.0.2，没有升级 catalog／lockfile。

下表保留最初 `40ef5c29c` 的作者验证证据；本次修订结果单独列在后面。

| 验证范围 | 结果 |
| --- | --- |
| 收件箱、当前／兼容模型、协调器、编辑重发、MCP、历史及本地平台专项 | 11 个 suite，201 项通过 |
| 执行、Watcher、Fleet、SessionManager、sandbox 和凭据所有权 | 6 个 suite，400 项通过 |
| 最后的暂停回执恢复及 Watcher 变更复跑 | 5 个 suite，396 项通过；包括失败暂停先补记、多个 Stop ID、共同 gate、原始请求与关闭恢复 |
| 原生 Roost 后端契约 | 31 项通过；新增批次状态定向更新、用户原文不变、重复幂等、关闭后重开 |
| Shared／RPC／组件／Electron 完整消费者回归 | 1428／124／5139／216 项通过；RPC 原有 3 项跳过 |
| 类型、lint、格式、原生 Inbox／进程／平台／public boundary、i18n | 通过；lint 无 error |
| root `pnpm check` | 未通过：CLI 4055 项通过、4 项跳过；未改动的 Git 传输 suite 一项失败，`context_unreadable`。之后的暂停／Watcher 小改由上述专项复跑覆盖，不沿用此前全仓结果冒充最终全绿 |
| 实际工作树 docs status／check | 均保留 82 项已有错误，无 Inbox 文件错误；不是文档批准 |

测试控制真实接收的完整输入、持久行、故障触发器、Deferred、注入时钟及 fake timers，不依赖网络或真实 sleep。独立 OS 子进程覆盖：固定八项意图无需新事件即恢复；迟到第九项留队；暂停和跨栅栏未知状态重开不运行。真实旧协调器 fixture 的主体与该 base 字节一致，仅迁移相对导入；分别停在栅栏前后，旧 stop 返回后新 owner 仍须等待旧链与实际释放。测试不调用真实模型。

手动 Stop 的 RPC 与持久兜底共用 cancelId；失败写盘保留每份请求身份，先补记再接受新用户输入，避免旧队列复活。内部取消只撤销执行资格，不持久暂停。已消费结果的完整副本随 Operation 保留期限清理，永久删除 Session 同时删除收件箱副本。重开只修复历史回执，不重放提交。

`40ef5c29cbe496f28f17ab10297cf37c3c48030f` 的 review 发现三个 adapter 交接缺口。本次修订持续登记 sandbox 的每次资源创建：spawn 前先落盘“不完整”，再合入后来的终端 roots；执行保留全部 Session 所有者以及发起它们的 host PID，不能仅凭最初 ACP roots 消失就认定集合已闭合。缺少完整性标记或登记中断时继续阻塞。renderer 和非委派 CLI 用户入口在激活／入队前持久写入独立的 `humanInputReceipts` 控制回执；历史兜底恢复匹配的授权，无需 RPC。Agent／普通历史写入、用户不匹配的回执、已取消／已结束的 ID 都不能解除暂停。协调器 `recoverStop` 接入独立的 `recoverClose`，保留原失败，只补写持久回执，绝不重发请求。

本次专项回归：7 个 CLI suite，676 项通过；4 个用户发送／配置 suite，117 项通过。覆盖真实独立进程组＋SQLite 重开（进程表使用注入快照）、并发创建的不完整栅栏、发起 host 仍存活、实际执行 adapter 登记、prompt 结束但创建未完成、释放回执写盘失败重试、已确认释放后的全新资源代际、CRDT 重开后的匹配／缺失／用户不符／已取消回执、RPC 丢失／大输入，以及协调器级结算写盘故障恢复且无重发。它们与上表有交集，不能累加。

本次 Shared／组件完整测试分别为 1428／5141 项通过。完整类型检查、最终 CLI 类型检查、lint（零 error）、格式、Inbox／进程／平台／public／i18n guard 均通过。复跑 root `pnpm check` 到 CLI 4065 项通过／4 项跳过，仍因未修改的 Git transport `context_unreadable` 失败；最后的创建／清理栅栏和 fixture 调整以 676 项交集、最终类型／lint／格式及源码字节核对验证，不宣称又一次完整 root 全绿。docs check 与 `40ef5c29c` 的 82 项错误数组完全一致，无 Inbox 错误。不宣称真实模型、完整系统进程表或桌面端到端验收。

`40ef5c29c` 的独立 review 有三个 P1；修订后的候选仍待独立复审。Spec 人工批准、真实模型和桌面端到端产品验收尚未完成。POSIX 身份缺失、Windows 或无法证明旧资源结束时继续阻塞，不能用用户新消息绕过它。整体 Session／ACP／历史原生迁移不在此次完成声明内。

[设计](../../proposed/architecture/2026-10-12-turn-scoped-operation-inbox.zh.md)、[实施计划](../../proposed/architecture/2026-10-12-operation-inbox-effect-implementation-plan.zh.md)、[Spec](../../../../specs/session-orchestration.zh.md)。
