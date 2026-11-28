# IDENTITY-PROTOCOL — 六类核心身份协议

- **地位**：身份语义的唯一权威描述。与 `OVERVIEW.md` §5 的概览表冲突时，以本文为准。
- **状态**：**协议已冻结。** 格式校验已在 SH-004（`packages/contracts`）落地。ID 分配器已在 SH-008A（`packages/runtime`）实现并通过该批测试。进程内 P1 Ingress 的代码已在 SH-008C 合并，并已由 SH-008E 装配到 Daemon；SH-008E 整批仍等待最终独立验收签署。Scheduler 已在 SH-008D D3 实现，D3.R1 已通过独立复审；SH-008D 已完成并通过独立复审与整批验收（D4 `8c10f39`，D4.R1 `4f290e8`）。Daemon 已装配 Persona Recovery、Runtime Recovery、Ingress、Scheduler 与本地 HTTP/WebSocket/Health；SH-009 的相应批次已实现本地 HTTP/WebSocket/Health 与 Token，E5B 文档同步已提交并等待独立复审，SH-009 整批尚未验收。Scheduler Handler Map 为空，不派发任务；认知循环尚未运行。Ingress 仍无外部 Stimulus transport；本地 HTTP API 是管理与状态查询接口，不是外部 Stimulus transport。动作身份的运行时路径未实现。§12 里没有写明进度的验收项仍然未实现。
- **上位决策**：`ADR-001`（独立运行时 / camelCase 线协议 / snake_case 数据库 / persistence 负责映射）
- **配套**：`DATA-MODEL.md`（列与约束）、`RUNTIME-LIFECYCLE.md`（状态机）、`TRUST-BOUNDARIES.md`（权限域）

---

## 1. 总则

1. **六类 ID 全部由 Harness 内部生成**，任何外部调用方（Adapter / CLI / Studio / 模型）**都不得指定**。
2. ID 是**身份**，不是**凭据**：拿到 ID 不代表有权限（见 §8）。
3. ID **不含语义**：不得从 ID 反推时间以外的信息（序号、用户、内容、权限）。
4. 一个 ID 一旦分配，**永不复用**，也永不改指向。
5. **人格数据必须带 `personaId` 作用域**，包括审计表（`archive_decisions`、`archive_conflict_records`）。
   作用域不是可选的过滤条件，而是隔离边界：任何按 ID 查询都必须同时带 `personaId`，
   否则视为跨人格访问。表分三类，**不得为字面统一而给所有表都加 `persona_id`**：

   | 类别 | 是否带 `persona_id` | 例 |
   |---|---|---|
   | **人格数据表**（持有或指向主观内容、审计、人格状态） | **必须 `NOT NULL`** | `sessions` / `events` / `tasks` / `thought_threads` / `memory_nodes` / `memory_fragments` / `memory_edges` / `dream_sessions` / `action_records` / `archive_records` / `archive_decisions` / `archive_conflict_records` |
   | **全局系统表**（部署级，不属任何人格） | **不带** | `schema_migrations`；`personas` 以自身 `id` 为主键 |
   | **派生索引 / 易失缓存**（可从权威表重建） | 可带可不带；**不带时任何查询必须限定到单一人格** | `memory_fts`（经 `node_id` 限定）、`activation_states`（本身带 `persona_id`） |

## 2. 六类 ID 总表

| ID | 语义 | 生成者 | 生成时机 | 唯一性范围 | 可外部指定 |
|---|---|---|---|---|---|
| `personaId` | 长期人格身份 | **Daemon（supervisor）** | 建档时（CLI / Studio 管理动作） | 部署内全局 | **否** |
| `sessionId` | 某适配器的交互窗口 | **Runtime（Ingress）** | 首次见到该 `(personaId, adapterId, externalSessionRef)` 时 | 部署内全局 | **否** |
| `threadId` | 内部思维进程 | **Runtime（cognition）** | ThoughtProcess 诞生时 | 部署内全局 | **否** |
| `runId` | **一次**模型调用或作业执行 | **Runtime（model gateway / scheduler）** | **每次尝试**（含重试） | 部署内全局 | **否** |
| `eventId` | 一个已发生的观察 | **Runtime（Ingress）** | 刺激通过鉴权与 Schema 校验后 | 部署内全局（主键） | **否** |
| `actionId` | 一次真实外部动作的意图 | **Runtime（cognition）** | 动作意图建立时 | 部署内全局 | **否** |

## 3. 格式与生成算法

### 3.1 格式

```
<prefix>_<26 字符 Crockford Base32>
       └─ 10 字符毫秒时间戳 + 16 字符密码学随机
```

| 前缀 | ID |
|---|---|
| `psn` | personaId |
| `ses` | sessionId |
| `thr` | threadId |
| `run` | runId |
| `evt` | eventId |
| `act` | actionId |

**辅助前缀**（不属于六类核心身份，但使用同一算法以避免歧义）：

| 前缀 | 标识 | 何时必须定稿 |
|---|---|---|
| `tsk` | taskId（逻辑任务，见 §4.4） | **P1 建 `tasks` 表前**（已定） |
| `cnf` | 归档冲突记录 ID（`archive_conflict_records.id`，见 `DATA-MODEL.md` §5.3） | P8 建表前（已定） |

- 总长度固定 **30 字符**。
- 字母表：`0123456789ABCDEFGHJKMNPQRSTVWXYZ`（Crockford Base32，排除 `I L O U`，大小写不敏感编码为**大写**）。
- **六类核心 ID 正则**（SH-003.2 未修改）：`^(psn|ses|thr|run|evt|act)_[0-9A-HJKMNP-TV-Z]{26}$`
- **辅助标识正则**：`^(tsk|cnf)_[0-9A-HJKMNP-TV-Z]{26}$`
- 两者**分开校验**：核心正则**不得**被放宽去吞辅助前缀，否则"六类身份"契约就失去约束力。

### 3.2 算法

1. 取当前 Unix 毫秒（48 bit，大端补零到 50 bit 高位）→ 10 个字符。
2. 取 `crypto.randomBytes(10)`（80 bit）→ 16 个字符。
3. 拼接后加前缀。

**理由**：时间前缀让 ID 近似有序（便于索引与排查），随机段保证不可猜。**不引入任何第三方依赖**（`node:crypto` 足够）。
**不采用**自增整数：会泄露规模、跨表冲突、迁移困难。

### 3.3 唯一性

- 唯一性范围 = **单个 Harness 部署**（单 SQLite 实例）内全局。
- **跨部署不保证**：导出/合并两个部署的数据需要重新映射，视为迁移问题（OPEN-3）。
- 数据库主键/唯一索引是最终防线；生成器碰撞时**重试生成**（仍冲突则报错，不得静默覆盖）。

### 3.4 非身份标识符（不加前缀，不参与权限）

以下标识符**不是身份 ID**，不适用 §3.1 的算法，也**不得**用于任何授权判断：

| 标识符 | 生成者 | 形态 | 何时必须定稿 |
|---|---|---|---|
| `bootId`（`personas.boot_id`、`runtime_state.boot_id`） | Daemon，**每次进程启动**一个 | 部署内唯一的不透明字符串（建议 UUIDv4），只回答"这是哪个实例" | **P1 建表前**（已定） |
| `archiveRef`（`events.archive_ref`） | Archive Writer，`append` 成功时 | `^[A-Za-z0-9._:-]{1,128}$` 不透明 token，**不保证等于 `eventId`**，消费者不得解析其内部结构 | P1 恒为 `NULL`；生成算法属 P8（OPEN-8） |

- 两者都**不得**参与去重、幂等键或权限判定；`bootId` 尤其不能当"实例凭据"。
- `archiveRef` 只回答"这条事件归档过没有、能不能对账"，**不是**读取凭据。
- 归档冲突记录 ID 使用辅助前缀 `cnf`（见 §3.1），**不得**复用 `eventId`（`events.id` 是主键，冒充即冲突）。

## 4. 逐类决议

### 4.1 personaId

- **语义**：一切主观状态的主体。跨进程、跨会话、跨模型、跨场景、跨睡眠周期恒定。
- **生成**：仅 Daemon 的管理路径（CLI `persona create` 或 Studio）。生成后写入 `personas.id`，**不可变**。
- **不得**：由 Adapter 提供；由模型提议；由配置字符串直接当 ID。
- **终止**：人格不"结束"，只会 `STOPPED`。ID 永久保留（墓碑仅供审计，不复用）。
- **恢复**：重启后按 ID 恢复，绝不新建第二个。

```json
{ "personaId": "psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC" }
```

### 4.2 sessionId

- **语义**：某个适配器上的一段交互窗口。**不代表人格身份**。
- **生成**：Ingress 首次见到该 `(personaId, adapterId, externalSessionRef)` 时分配；之后同一组合复用同一 `sessionId`。
  - 映射**以 `personaId` 为作用域**：同一适配器、同一 `externalSessionRef` 在不同人格下是**不同的会话**。
  - 唯一索引：`(persona_id, adapter_id, external_id) WHERE external_id IS NOT NULL AND closed_at IS NULL`。
    `external_id` 为 NULL 或该行**已关闭**时都不参与唯一性，因此旧窗口关闭后可以建新会话。
- **外部可见性**：Adapter 提供 `externalSessionRef`（它自己的会话标识），**不是** `sessionId`。
- **关闭**：`sessions.closed_at` 置位；关闭后不再接受新事件，但历史事件仍引用它。
- **重开**：同一 `externalSessionRef` 重新出现 → **新** `sessionId`（视为新窗口），不复活旧会话。
- **不得**：用 `sessionId` 当人格主键；用 `externalSessionRef` 直接当 `sessionId`。

```json
{ "sessionId": "ses_01JQ8Z4A6N8Q0S3V5W7Y9B1CDE", "externalSessionRef": "dsh:abc123" }
```

### 4.3 threadId

- **语义**：一个内部思维进程（ThoughtProcess）。可跨会话、跨重启继续。
- **生成**：cognition 创建线程时。`inner` / `external` / `sleep` / `dream` / `audit` 通道都用同一格式。
- **终止**：`COMPLETED` / `ABANDONED` 为终态；**终止后不得复用**该 ID 开新线程。
- **恢复**：重启后按 ID + 检查点恢复；不得凭"最近线程"猜测。
- **不得**：由模型创建或指定；用 `sessionId` 顶替。

```json
{
  "threadId": "thr_01JQ8Z5B7P9R1T3V5X7Z9A2BDF",
  "personaId": "psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC",
  "channel": "inner",
  "state": "RUNNING"
}
```

### 4.4 runId

**三层必须分清：逻辑任务（task） / 一次运行（run） / 重试次数（attempt）。**

| 概念 | 标识 | 何时变 | 用途 |
|---|---|---|---|
| 逻辑任务 | `taskId`（`tasks.id`） | 创建时分配，**整个任务生命周期不变** | 表达"要做的这件事" |
| 一次运行 | **`runId`** | **领取并开始一次实际执行时新分配**（含失败后的下一次重试领取）。运行期间不变。崩溃恢复不分配新 `runId` | 计费、日志、时延、失败归因 |
| 尝试序号 | `attemptNo`（`tasks.attempt`） | **领取时 +1**。运行期间不变。失败后的重试在下一次重新领取时再 +1。崩溃恢复不加，恢复后仍沿用原 attempt | 表达"第几次尝试" |

- **重试 = 下一次领取时的新 run + 同 task**。把重试当作同一次模型调用会导致：计费与用量统计错误、时延分布失真、
  失败重试掩盖首次失败、缓存/幂等判断误用同一个键。
- 生成者：调度器派发任务时 / Model Gateway 实际发起调用时。**生成时机精确到"开始执行"**，不是"计划执行"。崩溃恢复不是这两个时机。
- **attempt 的加减以已批准的 D-RT1 为准，此处不另立决议。** Scheduler 领取任务时 `attempt` 加 1，并写入新的 `runId`。任务运行期间 `attempt` 不变。运行失败后的重试，在下一次重新领取时加 `attempt`。崩溃恢复不增加 `attempt`，恢复后仍沿用原 `attempt`，也不写新 `runId`。对应代码：persistence 的 `claimNext`（领取时 +1 并写新 `runId`）；D3 的 `claimOne` 调用它。`failTask` 在未达上限时退回 `queued`，不改 `attempt`。`recoverRunningTask` 在未达上限时退回 `queued`，不改 `attempt`，不改 `run_id`。Daemon 已装配 Runtime Recovery 与 Scheduler；启动时执行恢复并接入 Scheduler。当前 Scheduler Handler Map 为空，不派发任务；认知循环尚未运行。SH-008E 整批仍等待最终独立验收签署。
- **终止（架构目标）**：单次运行应当终止（成功 / 失败 / 取消 / 超时）。终态后该 `runId` 不再使用。
- **当前 Scheduler 尚未提供其中两条保障。** `cancelTask` 只接受 `queued` / `paused`；running 任务不能取消，`signal.aborted` 恒为 `false`（源码标明 D-SCH3）。没有 Handler 硬超时。Handler 不返回时 `stop()` 会一直等待（源码 P5：stop may wait forever）。这是 D3 的当前限制，不是把「应当终止」改写成已经实现。
- **不得**：把 `runId` 当记忆主体；把 `taskId` 当 `runId`；复用旧 `runId` 表达重试。

```json
{
  "runId": "run_01JQ8Z6C8Q0S2T4W6Y8A0B2CEG",
  "taskId": "tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF",
  "attemptNo": 2,
  "kind": "memory.encode",
  "state": "RUNNING"
}
```

> `taskId` 不在六类核心 ID 内，但为避免歧义在此明确：它同样是 Harness 内部生成的不透明标识。

### 4.5 eventId

**决议：`eventId` 由 Runtime 的 Ingress 生成，Adapter 不再分配 `eventId`，只提供 `adapterEventRef`。**

- 原因：`events.id` 是**全局主键**。若允许 Adapter 自行分配，两个 Adapter 各自用 `"1"` 就会主键冲突。
  让 Adapter 决定我们的主键，也违反"外部不得冒充内部身份"。
- **去重键**：`(personaId, adapterId, source, adapterEventRef)` 建**唯一索引**。
  - 同一 Adapter 对同一刺激重试 → 同一 `adapterEventRef` → **映射到同一 `eventId`**，返回既有状态，不新建事件行。
  - 不同 Adapter 用相同字符串 → `adapterId` 不同 → 不冲突。
  - **不同人格用相同字符串 → `personaId` 不同 → 视为两条不同的事件**（人格之间不共享事件身份）。
- **顺序**：Schema 校验通过 → 计算去重键 → 命中则进入 §4.5.1 的正文核对 → 未命中则**分配新 `eventId`** 并写 pending/事件行。
- **返回**：`eventId` 通过 ACK 响应回给 Adapter；Adapter 后续以 `adapterEventRef` 重试，不需要也不应该保存我们的 `eventId`。
- **不得**：把 `requestNonce` 当 `eventId`（前者是"这次投递"，后者是"这个观察"）；
  把 `adapterEventRef` 直接塞进 `events.id`。

### 4.5.1 去重命中后的正文核对（及保证边界）

命中去重键只说明"这是同一个观察"，**不说明正文一致**。必须单独核对，且**不是所有形态都能核对**。

**核对路径（按事件形态分）**

| 原事件形态 | 能否核对正文 | 路径 | 结果 |
|---|---|---|---|
| `required` 且 `archive_state='archived'` | **能** | 调 Archive Writer 的 `archive.compare(eventId, 新正文)`：在其内部用 HMAC 指纹比对，**只回** `match` / `conflict` / `not_found`，**不回传任何内容** | `match` → 幂等命中，返回既有 `eventId` 与状态；`conflict` → **409** + 冲突审计（`RUNTIME-LIFECYCLE.md` §7.3），原事件不改 |
| `required` 且 `archive_state='pending'` | **视情况** | 原正文若仍在感知缓冲内 → 与缓冲比对（进程内，不外泄）；缓冲已丢 → **无法核对** | 可比：`match` 幂等 / `conflict` 409。不可比：按幂等命中处理，只累加指标 `dedupe.body_unverifiable`（**不含内容**） |
| `excluded` | **不能** | 从未归档，无任何持久副本 | **只能幂等命中**：返回既有 `eventId` 与状态，新正文被丢弃。**无法发现差异，也不得声称发现了** |
| P1（Archive 关闭） | **不能** | 无 Archive 能力，正文只在缓冲 | 同 `excluded`：只能幂等命中 |

**保证边界（必须写进 API 文档与 Adapter SDK）**

| 保证 | 范围 |
|---|---|
| "同一去重键只产生一条事件行" | **所有形态都保证** |
| "能发现同一去重键下的正文不一致" | **仅** `required` 且 Archive 可用且已归档（或缓冲仍在）时保证 |
| `excluded` / P1 | **不保证**发现正文差异；系统不提供"内容级去重"能力 |
| 归档能力故障期间 | 降级为"只能幂等命中"，并在健康指标中标记 |

**四条禁止**

1. **不得**为了在 P1 / `excluded` 下也能比对正文而保存正文、摘要、哈希或指纹 —— 那会直接破坏原文旁路禁令。
2. **不得**把"幂等命中"描述成"已确认是同一内容"。
3. **不得**在 `conflict` 时改写原事件（见 `RUNTIME-LIFECYCLE.md` §7.3.2 的并发安全条件）。
4. **不得**把 `compare` 用成一般查询：它只允许在 [1D] 去重命中路径被调用一次，
   判定结果**不得**进入模型上下文、主观记忆、`events` 任何列或日志正文（见 `TRUST-BOUNDARIES.md` §5.5）。

**"无法核对"只是一个计数，不是状态**

`body_unverifiable` **不进入** `events.status_reason` 枚举、**不建表**、**不改变事件状态**。
它描述的是"这次投递我们没能核对"，而事件本身仍停在原来的状态；把它做成状态或审计行，
等于为一个不产生任何决策的观测制造终态与保留期负担。

- 形态：**指标** `dedupe.body_unverifiable`（计数）+ 结构化日志中的事件 ID 与 `adapterId` 字段。
- **不得**携带正文、摘要、长度、指纹或判定值。
- 需要人工排查时按 `eventId` 回溯，而不是靠这个计数本身携带内容。

```json
{
  "eventId": "evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH",
  "adapterId": "minecraft",
  "source": "minecraft.chat",
  "adapterEventRef": "mc-7f3a9c21",
  "status": "accepted"
}
```

### 4.6 actionId

必须同时支撑：崩溃恢复、执行核对、回执关联、**防止重复真实执行**。

| 规则 | 内容 |
|---|---|
| 生成者 | Runtime（意图建立时），**不是** Action Gateway、不是模型 |
| 不可变 | 同一意图的所有重试**复用同一 `actionId`**；绝不重新生成 |
| 幂等身份 | Gateway 以 `actionId` 作为幂等身份（`action_records.action_id` 主键） |
| 回执关联 | 任何 `ActionReceipt` **必须**带 `actionId`；无匹配 `actionId` 的回执**拒绝** |
| 崩溃恢复 | 启动时凡 `state='executing'` 的动作，一律以 `actionId` 向适配器核对；**无回执不得标成功** |
| 重新意图 | 若意图内容实质改变（`intentVersion` 递增），分配**新** `actionId`；旧 `actionId` 保留其结局 |
| 模型边界 | 模型只能在提案里表达"想做什么"，**不得**提供或预测 `actionId` |
| 禁止 | 用"最近一次动作"推断 `actionId`；用内容哈希当 `actionId`；重试时新建 `actionId` |

```json
{
  "actionId": "act_01JQ8Z8E0S2T4W6Y8A0B2C4EGJ",
  "personaId": "psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC",
  "actorId": "persona:psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC",
  "adapterId": "minecraft",
  "intentVersion": 3,
  "idempotencyKey": "act_01JQ8Z8E0S2T4W6Y8A0B2C4EGJ",
  "state": "executing"
}
```

## 5. 关联与基数

```
persona (psn)
 ├─1:N─ session (ses) ──1:N── event (evt)
 ├─1:N─ thread (thr)  ──1:N── run (run)
 ├─1:N─ task (tsk)    ──1:N── run (run)      ← 每次 attempt 一个新 run
 └─1:N─ action (act)  ──1:0..1── receipt
```

| 关系 | 基数 | 说明 |
|---|---|---|
| persona → session | 1:N | 一个会话只属一个人格 |
| persona → thread | 1:N | 线程跨会话存在 |
| session → event | 1:N | `event.sessionId` 可空（系统事件无会话） |
| thread → run | 1:N | 一次思维步可能多次调用模型 |
| task → run | 1:N | **N = 尝试次数**，每次新 `runId` |
| action → receipt | 1:0..1 | 没有回执即未成功 |
| event → thread | N:0..1 | 线程可由某事件触发（`triggerEventId`） |
| persona → 全部 | 1:N | 所有表都带 `persona_id` 作用域 |

## 6. 生命周期规则

| 阶段 | personaId | sessionId | threadId | runId | eventId | actionId |
|---|---|---|---|---|---|---|
| 创建 | 建档时，一次性 | 首次见 `(persona, adapter, ref)` | 线程诞生 | **每次执行** | 校验通过后 | 意图建立时 |
| 使用 | 永不变 | 会话期内有效 | 运行/挂起期间有效 | 单次执行内有效 | 永久 | 直到动作终结 |
| 关闭 | 不关闭（只停止） | `closed_at` 置位 | `COMPLETED`/`ABANDONED` | 必然终止 | 终态后只读 | 见下 |
| 终止 | `STOPPED` | 关闭即终止 | 终态不可复活 | 终态不可复用 | `expired`/`rejected` 终态 | `succeeded`/`failed`/`revoked`/`expired` |
| 恢复 | 按 ID 恢复，绝不新建 | 重开用新 `ses` | 按 ID + 检查点 | **不恢复**：放弃的 run 记为失败 | 按 `adapterEventRef` 查回同一 `eventId` | 按 ID 对账，无回执不标成功 |
| 重试 | — | — | 同 `threadId` | **新 `runId`** | 同 `eventId`（同 `adapterEventRef`） | **同 `actionId`** |

**关键不对称**（有意设计）：

- 重试时 `runId` **变**（因为是新的一次执行）。
- 重试时 `eventId` / `actionId` **不变**（因为是同一个观察 / 同一个意图）。

## 7. 生成与使用权限

| ID | Adapter | Runtime | Daemon/supervisor | Action GW | Studio | 模型 |
|---|---|---|---|---|---|---|
| personaId | 仅读取 | 读取 | **创建** | 读取 | 发起创建 | 读取 |
| sessionId | 仅读取 | **创建 / 关闭** | 读取 | 读取 | 读取 | 读取 |
| threadId | ✗ 不可见 | **创建 / 更新** | 读取 | ✗ | 受限视图 | **不提供** |
| runId | ✗ 不可见 | **创建 / 终结** | 读取 | ✗ | 受限视图 | ✗ |
| eventId | 仅读取（ACK 返回） | **创建 / 推进** | 读取 | 读取 | 受限视图 | 不提供 |
| actionId | 仅读取（动作请求内） | **创建** | 读取 | 读取 / 校验 | 受限视图 | ✗ |

**硬约束**

- 外部 Adapter **不得**提交、猜测或伪造任何内部 ID。
- 模型**不得**创建或指定任何具有权限意义的身份（`personaId` / `actionId` 尤其）。
- Studio 只能**发起**创建（如新建 persona），实际 ID 仍由 Daemon 生成。

## 8. 与鉴权、幂等键、requestNonce 的区别

| 概念 | 回答的问题 | 例子 | 能否当凭据 |
|---|---|---|---|
| **身份 ID** | 这是谁 / 这是什么 | `evt_…`、`act_…` | **不能** |
| **鉴权（capability / token）** | 你有权做什么 | adapter token、scope | 是 |
| **幂等键** | 同一操作如何只生效一次 | `actionId`、`(personaId, adapterId, source, adapterEventRef)`、`(eventId, adapterId, source, requestNonce)` | 否（只是去重） |
| **requestNonce** | 这是**同一次投递**吗 | `^[A-Za-z0-9_-]{16,64}$` | 否 |

**三条禁止**

1. **不得**把 `requestNonce` 当 `eventId`：一个事件可以有多条投递（重试），但只有一个身份。
2. **不得**用 ID 代替鉴权：拿到 `personaId` 不等于有权操作该人格。
3. **不得**用内容哈希充当任何上述标识（会变相留存原文特征，见 `DATA-MODEL.md` §5.3）。

**区别小结**：`eventId` 标识**观察**，`requestNonce` 标识**投递**，`actionId` 标识**意图**，
`runId` 标识**一次执行**。四者不可互换。

## 9. 与现有数据库 / 生命周期的兼容性

### 9.1 已有列对照

| 表 | 列 | 对应 ID | 状态 |
|---|---|---|---|
| `personas` | `id` | personaId | 兼容 |
| `sessions` | `id` / `external_id` | sessionId / adapter 侧会话引用 | 兼容（`external_id` 即 `externalSessionRef`） |
| `thought_threads` | `id` | threadId | 兼容 |
| `tasks` | `id` / `run_id` / `attempt` | taskId / runId / attemptNo | 列已在 `0001`。D-RT1：`claimNext` 领取时 `attempt+1` 并写入新 `runId`；失败重试在下一次领取时再加；崩溃恢复不加 `attempt`、不换 `runId`。D3 的 `claimOne` 已走这条领取路径。Daemon 已装配 Runtime Recovery 与 Scheduler；Scheduler Handler Map 为空，不派发任务；SH-008E 整批仍等待最终独立验收签署 |
| `events` | `id` / `adapter_id` / `adapter_event_ref` | eventId / 适配器引用 | 列与 `ux_events_dedupe` 已在 `0001`（见 §9.2）。这不表示 Ingress 已具备外部 Stimulus transport |
| `action_records` | `action_id` | actionId | 兼容 |

### 9.2 必须的数据模型修正

（a）（b）的列和索引已经在 `packages/persistence/migrations/0001_init_core.sql`。下面保留协议要求的形状，不是待办迁移。（c）的审计表不在 P1：`0001` 不创建 Archive 表。

**(a) `events` 主键冲突消解**

`events.id` 是全局主键，而 Adapter 只提供 `adapterEventRef`。为此 `events` 增加两列并建**带 persona 作用域**的唯一索引：

```sql
adapter_id        TEXT NOT NULL,   -- 来源适配器（内部来源用 system.* 正式 ID）
adapter_event_ref TEXT NOT NULL,   -- 适配器侧的刺激标识，重试复用
CREATE UNIQUE INDEX ux_events_dedupe
  ON events (persona_id, adapter_id, source, adapter_event_ref);
```

- `events.id` **只由 Ingress 生成**（`evt_` 前缀）。
- 去重键命中 → 进入 §4.5.1 的正文核对；核对为 `match` 或无法核对时返回既有 `eventId`，**不新增事件行**。
- 去重键**必须含 `persona_id`**：两个 persona 各自收到 `adapterEventRef='mc-1'` 是两条独立事件。
- `adapter_event_ref` 是**外部引用**，允许适配器自定义格式（仍受长度/字符集约束），
  但它**不是**内部身份，不参与任何权限判断。

**(b) `sessions` 映射的作用域**

```sql
CREATE UNIQUE INDEX ux_sessions_external
  ON sessions (persona_id, adapter_id, external_id)
  WHERE external_id IS NOT NULL AND closed_at IS NULL;
```

- 同一适配器、同一 `externalSessionRef` 在不同 persona 下是**不同会话**（键含 `persona_id`）。
- 同一 persona 下，旧会话 `closed_at` 置位后，同一 `externalSessionRef` 可以再建**新** `sessionId`；
  索引的 `closed_at IS NULL` 谓词保证"同时有效的映射"唯一，而历史会话行仍然保留。
- `external_id` 为 NULL 时不参与唯一性（内部来源可不带外部引用）。

**(c) 审计表补 `persona_id`**

`archive_decisions` 与 `archive_conflict_records` 增加 `persona_id TEXT NOT NULL`；
`archive_records.persona_id` 由可空改为 `NOT NULL`。

- 理由：§1 总则要求所有记录带 persona 作用域，审计表也不能例外 ——
  否则"按人格隔离审计"只能靠 `event_id` 反查，跨人格排查会被牵连。
- 审计表仍**不存任何内容**，`persona_id` 只是一个不透明标识。
- 冲突审计的唯一索引保持不变（`event_id` 已隐含 persona），`persona_id` 用于查询与隔离。

### 9.3 对现有文档的同步

**SH-003 阶段**

| # | 文档 | 变更 | 状态 |
|---|---|---|---|
| 1 | `RUNTIME-LIFECYCLE.md` §7.1 | 信封字段表：`eventId` 改为 `adapterEventRef`；`eventId` 改为 ACK 返回值 | 已同步 |
| 2 | `RUNTIME-LIFECYCLE.md` §7.3 | 去重入口改为 `adapterEventRef`，并写明"命中后需正文核对"与 excluded/P1 的边界 | 已同步 |
| 3 | `DATA-MODEL.md` §3 | `events` 增 `adapter_id` / `adapter_event_ref`；去重索引改为 `(persona_id, adapter_id, source, adapter_event_ref)` | 已同步 |
| 4 | `DATA-MODEL.md` §3 | `sessions` 增 `ux_sessions_external (persona_id, adapter_id, external_id)` | 已同步 |
| 5 | `DATA-MODEL.md` §3.1 | 新增 `adapter_event_ref` 字段白名单行 | 已同步 |
| 6 | `DATA-MODEL.md` §5 | `archive_decisions` / `archive_conflict_records` 增 `persona_id NOT NULL`；`archive_records.persona_id` 改 NOT NULL | 已同步 |
| 7 | `MODULES.md` | `runtime` 增"六类 ID 分配"；`contracts` 增"ID 格式与生成契约"；`archive-writer` 增 `compare` 接口 | 已同步 |
| 8 | `PLAN.md` §4 / `README.md` | 文档入口指向本文 | 已同步 |

**SH-003.2 阶段（收口）**

| # | 文档 | 变更 | 状态 |
|---|---|---|---|
| 9 | `PLAN.md` §6.3 决议十 | Archive Writer 由"只有两个接口"改为三接口（`append` / `status` / `compare`） | 已同步 |
| 10 | `TRUST-BOUNDARIES.md` R1 / §5.4 | 三接口枚举与返回约束统一；`compare` 的等值判定性质与不解密性质写明 | 已同步 |
| 11 | `TRUST-BOUNDARIES.md` §5.5（新增） | `compare` 的唯一调用者、绑定字段、返回值禁令、传输约束、滥用防护、真实/理论风险分层 | 已同步 |
| 12 | `TRUST-BOUNDARIES.md` §6.1 / §6.2 / §10 | IPC 在途明文列为允许形态；金丝雀判据覆盖 IPC 日志与转储；自检清单新增 `compare` 项 | 已同步 |
| 13 | `MODULES.md` §2 / §3 | 总表、依赖表、能力描述统一为三接口；`runtime` 标注为 `compare` 唯一调用方 | 已同步 |
| 14 | `RUNTIME-LIFECYCLE.md` §7.1 | 流转图新增 [1D] 去重节点，明确先于缓冲与 disposition；新增不变式 12 / 13 | 已同步 |
| 15 | `RUNTIME-LIFECYCLE.md` §7.3–§7.5 | 适配器重试口径统一为 `adapterEventRef`；补终态重投规则（情形 6）；`body_unverifiable` 改为指标 | 已同步 |
| 16 | `DATA-MODEL.md` §1 / §3.1 / §4 | persona 作用域三分法；`archive_ref` 格式与生成者；`memory_fragments.persona_id`；派生索引规则 | 已同步 |
| 17 | `DATA-MODEL.md` §3 | `sessions.external_id` 注释改为 `externalSessionRef`，消除 SH-003 遗留的措辞差异 | 已同步 |
| 18 | `DATA-MODEL.md` §3 / 本文 §4.2 / §9.2 | `ux_sessions_external` 增 `closed_at IS NULL`：只约束当前有效映射，旧会话关闭后可建新 `sessionId`；并发由 persona 级单写入协调器保证 | 已同步 |
| 19 | 本文 §2 / §6 | `sessionId` 的生成条件与生命周期表统一为 `(personaId, adapterId, externalSessionRef)`，与 §4.2 一致 | 已同步 |
| 20 | `TRUST-BOUNDARIES.md` §5.4 / `PLAN.md` §6.3 | Archive 三接口改为"请求 / 响应"分列：**请求可含必要正文**，**响应不含任何内容**；三套请求与响应必须分别定义 | 已同步 |

**遗留：无。** SH-003 阶段记录的 `sessions.external_id` 措辞差异已在 SH-003.2 一并修正；
`archiveRef` 的具体生成算法作为 OPEN-8 保留到 P8，不影响本阶段契约。

## 10. 正例 / 反例 / 边界

### 正例

```json
// 1. Adapter 首次投递 → 拿到 eventId
{ "adapterId": "minecraft", "adapterEventRef": "mc-7f3a9c21", "requestNonce": "NQ7xK2mR9tVb4Wc8" }
→ 201 { "eventId": "evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH", "status": "accepted" }

// 2. 同一刺激重投（网络超时）→ 复用原 eventId
{ "adapterId": "minecraft", "adapterEventRef": "mc-7f3a9c21", "requestNonce": "SAME-nonce-reused" }
→ 200 { "eventId": "evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH", "status": "accepted" }

// 3. 重试一次模型调用 → 新 runId，同 taskId
{ "taskId": "tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF", "attemptNo": 2, "runId": "run_01JQ8Z6C8Q0S2T4W6Y8A0B2CEG" }
```

### 反例

| 反例 | 为什么错 |
|---|---|
| Adapter 提交 `eventId: "1"` | 主键会被外部控制；两个适配器必然冲突 |
| 两个 Adapter 都发 `adapterEventRef: "1"` | 合法：由 `adapterId` 隔离，不冲突 |
| 用 `requestNonce` 当去重键判断"是否同一事件" | nonce 标识**投递**，同一事件重试时 nonce 应当复用，但不同投递也可能换 nonce |
| 重试时分配新 `actionId` | 会导致同一意图被执行两次（重复真实动作） |
| 重试时复用旧 `runId` | 计费/时延/失败归因全部失真 |
| 用 `sessionId` 作为记忆主键 | 会话是窗口不是人格，换窗口记忆就断 |
| 模型在提案里写 `actionId` | 越权：意图身份必须由确定性代码分配 |
| 由 ID 反推权限 | ID 不含权限信息；权限由 capability 决定 |

### 边界

| 边界情况 | 处理 |
|---|---|
| 同一 `adapterEventRef`、不同正文 | `required` 且已归档 → `archive.compare` 得 `conflict` → 409 + 冲突审计，**不改写原事件**（`RUNTIME-LIFECYCLE.md` §7.3.2）；`excluded`/P1 → **无法发现**，只能幂等命中 |
| 同一 `externalSessionRef` 断开后重连 | **新 `sessionId`**，不复活旧窗口 |
| 同一 `adapterEventRef` 发往**不同 persona** | 视为两条独立事件（去重键含 `personaId`），互不影响 |
| 线程恢复后又中断 | 同 `threadId`；每次模型调用仍产生新 `runId` |
| 动作执行中进程崩溃 | 按 `actionId` 向适配器对账；无回执不标成功 |
| 动作超时但适配器实际成功 | 以真实回执为准；`actionId` 不变，状态由回执更新 |
| `adapterEventRef` 被适配器**错误复用**（不同内容） | 与归档冲突同路：拒绝并报冲突，不静默接受 |
| 迁移旧库 | 旧 `events.id`（旧格式）→ 需重新生成 `evt_` 并建立 `adapter_event_ref` 映射（P9） |

## 11. OPEN

### 11.1 已决定

| # | 原问题 | 决定 | 日期 |
|---|---|---|---|
| OPEN-1 | `runId` 是否需要独立 `runs` 表保存全部历史尝试。当时只存 `tasks.run_id`（当前尝试），历史尝试会丢，影响计费与复盘。最迟决策点曾写成「P1 建表前」；`0001_init_core.sql` 落地时没有 `runs` 表，本项补记该决定 | **P1 不新增 `runs` 表，也不做 `0002` 迁移。** 权威状态只保留 `tasks.run_id` 上的当前尝试。被放弃的 run 不恢复（§6）；历史尝试用结构化日志中的 `runId` 追溯。计费与复盘若以后需要运行史，以追加表加 ADR 引入，不改变 `tasks.id` 的语义 | **2026-11-20（UTC+8）** |
| OPEN-7 | ID 生成器是否需要在 CI 做碰撞与大样本格式测试。属测试设计，非协议本身。最迟决策点是 P1 实现分配器时 | **要做**，作为 SH-008A 的验收，随 `pnpm test` 进入 CI。样本量：**每个可分配前缀 10000 个 ID**，另加**同毫秒突发 10000 个**。测试：`packages/runtime/test/allocator-sample.test.ts`（格式与样本内唯一）、`packages/runtime/test/allocator.test.ts`（时间前缀、碰撞重试、真实 SQLite 主键不覆盖）。不把统计意义上的全局永不碰撞当作验收；唯一性仍是单部署内，外加冲突重试（§3.3） | **2026-11-20（UTC+8）** |

### 11.2 尚未决定（含最迟决策阶段）

| # | 问题 | 原因 | 最迟决策阶段 |
|---|---|---|---|
| OPEN-2 | 会话空闲多久自动关闭（`closed_at` 置位阈值） | §4.2 已定"首事件自动创建"，但自动关闭阈值未定；影响空会话治理与会话数膨胀 | **P2 事件接入前** |
| OPEN-3 | 跨部署导入时的 ID 重映射规则 | 唯一性只在单部署内保证 | **P9 迁移前** |
| OPEN-4 | `adapterEventRef` 的保留期（适配器多久内可重试） | 与事件保留策略耦合 | **P8 前** |
| OPEN-5 | 模型是否可见 `threadId` / `actionId` | 影响可解释性与越权风险（当前定为不可见） | **P5 自主认知前** |
| OPEN-6 | 旧库 `sessions`/`events` 的 ID 迁移映射细则 | 旧 ID 非 `evt_` 格式 | **P9 迁移前** |
| OPEN-8 | `archiveRef` 的具体生成算法，以及是否直接复用 `eventId` | P1 恒为 NULL、`archive_records` 未创建；只影响 P8 的归档实现，不影响契约形状（已定为 1–128 不透明 token） | **P8 建表前** |

## 12. 验收表

> 下表区分协议验收与当前实现。未写明完成的项仍然**未实现**。写成「部分」或「分配器已测」的，只覆盖注明的那一层。

| ID | 验收项 | 状态 |
|---|---|---|
| I01 | 六类 ID 格式符合 §3.1 正则，长度恒为 30 | **分配器已测（SH-008A）**：`packages/runtime` 生成的六类 ID 在 CI 中每前缀 10000 个全部通过 contracts 的 `is*` / `parse*`，长度恒为 30。格式正则本身在 SH-004 已有测试 |
| I02 | 所有 ID 由 Harness 生成；Adapter 提交内部 ID 一律拒绝 | 未实现 |
| I03 | 相同 `(personaId, adapterId, source, adapterEventRef)` 重投返回同一 `eventId` | **部分（SH-008C 进程内 Ingress）**：同键再次 `acceptStimulus` 返回既有 `eventId`，不插入第二行（`packages/runtime/test/ingress.test.ts`）。`bodyVerified` 恒为 `false`。Daemon 已装配 Ingress；Ingress 仍无外部 Stimulus transport；本地 HTTP API 是管理与状态查询接口，不是外部 Stimulus transport。整条验收未通过 |
| I04 | 不同 Adapter 或不同 persona 使用相同 `adapterEventRef` 不冲突 | **索引已落地，事件用例未测完**：`ux_events_dedupe` 是 `(persona_id, adapter_id, source, adapter_event_ref)`。`ingress.test.ts` 没有用同一 `adapterEventRef` 对两个 persona 或两个 adapter 断言两条事件行。不写成通过 |
| I05 | 每次重试产生新 `runId`，`taskId` 不变，`attemptNo` 递增 | **部分（D1 原语与 D3 派发路径，整条验收未通过）**：`claimNext` 在领取时 `attempt+1` 并写入新 `runId`，`taskId` 不变。失败退回 `queued` 时不加 `attempt`，下一次领取再加。崩溃恢复不加 `attempt`、不换 `runId`。Scheduler 的 `claimOne` 调用 `claimNext`，`scheduler.test.ts` 覆盖 attempt / runId。D4 已随 SH-008D 整批验收通过；Daemon 已装配 Runtime Recovery 与 Scheduler，SH-008E 整批仍等待最终独立验收签署；身份协议这一整条仍未验收通过 |
| I06 | 同一意图的所有重试复用同一 `actionId` | 未实现 |
| I07 | 无 `actionId` 或 `actionId` 不匹配的回执被拒绝 | 未实现 |
| I08 | 崩溃恢复后 `executing` 动作不因重启被标记成功 | 未实现 |
| I09 | 任何记录都可凭 `personaId` 隔离查询，不串人格 | 未实现 |
| I10 | `requestNonce` 与 `eventId` 在任何路径上不可互换 | 未实现 |
| I11 | ID 中不含可推断内容的信息（仅时间前缀） | **分配器已满足（SH-008A）**：分配函数不接收内容参数；主体只有 10 字符时间前缀和 16 字符随机段 |
| I12 | 数据库唯一索引能捕获生成器碰撞并报错而非覆盖 | **部分（SH-008A，以及已接上分配器的写入）**：占用时重试，预算耗尽报 `id_collision`，不返回已占用 ID。`packages/runtime/test/allocator.test.ts` 用真实 SQLite 主键证明冲突行不被覆盖。人格创建、Ingress 的 `eventId` / `sessionId` 已走该分配器。`allocateThreadId` / `allocateActionId` / `allocateConflictRecordId` 只产生字符串，没有对应业务插入。整条验收未通过 |
| I13 | `required` 事件同键异内容能被 `archive.compare` 判为 `conflict` | 未实现 |
| I14 | `excluded` / P1 下同键异内容**不被谎报为已识别**（只幂等命中） | **部分（仅 P1 的进程内 Ingress）**：去重命中时 `bodyVerified` 为 `false`，日志不声称正文一致，第二份正文不进缓冲（`ingress.test.ts`）。`excluded` 策略与 `archive.compare` 都没有。整条验收未通过 |
| I15 | 审计表（`archive_decisions` / `archive_conflict_records`）均带 `persona_id`，可按人格隔离查询 | 未实现 |
| I16 | `archive.compare` 只由 Ingress 去重路径调用；未命中去重键时**零**调用 | 未实现 |
| I17 | `compare` 的判定结果不出现在模型上下文、主观记忆、`events` 任何列与日志正文中 | 未实现 |
| I18 | 适配器只凭 `adapterEventRef` + `requestNonce` 即可完成重试，**无需**持有内部 `eventId` | 未实现 |
| I19 | 已终态（`expired` / `rejected`）的事件不被同键重投重开或改写 | **部分（SH-008C 进程内 Ingress）**：同键再投不改写 `expired` / `rejected`（`ingress.test.ts`，`does not reopen an expired or rejected event`）。没有适配器传输层。整条验收未通过 |

---

**除文中写成已实现或「部分」的那一层以外，本文档不表示身份协议的运行时行为已经完成。** 进程内 Ingress、任务领取 / 恢复原语已由 SH-008E 装配到 Daemon；但 Ingress 仍无外部 Stimulus transport，SH-008E 整批仍等待最终独立验收签署，身份协议整条仍未验收通过。
