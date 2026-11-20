# `@soul-harness/runtime` — 认知运行时

- **地位**：L3 编排层。业务逻辑在这里，不在 Daemon（[MODULES](../../docs/architecture/MODULES.md) §2–§4）。
- **状态**：**SH-008A 已完成：ID 分配器。SH-008B 已完成：进程内 Persona 生命周期。SH-008C 已完成：进程内 P1 Ingress。** 调度器、扫描 A/B、检查点装载/写出、Daemon 装配都还没有，对应 SH-008D–E。本目录没有这些能力的空类。
- **上位文档**：[RUNTIME-LIFECYCLE](../../docs/architecture/RUNTIME-LIFECYCLE.md) §4–§5、§7、§9，[IDENTITY-PROTOCOL](../../docs/architecture/IDENTITY-PROTOCOL.md) §3、§4.2、§4.5、§4.5.1，[DATA-MODEL](../../docs/architecture/DATA-MODEL.md) §3、§3.1、§6，[PLAN](../../docs/PLAN.md) §6.3，[MODULES](../../docs/architecture/MODULES.md) §2–§3。

## 1. 负责什么

### 1.1 标识分配（SH-008A）

按身份协议 §3 的冻结算法分配标识：

| 前缀 | 函数 | 身份 |
|---|---|---|
| `psn` `ses` `thr` `run` `evt` `act` | `allocatePersonaId` 等 | 六类核心身份 |
| `tsk` | `allocateTaskId` | 逻辑任务（辅助，§4.4） |
| `cnf` | `allocateConflictRecordId` | 归档冲突记录（辅助，§3.1） |

算法（不得改）：

1. Unix 毫秒取 48 bit，大端，**高位补零到 50 bit**，编成 10 个 Crockford Base32 字符。因此时间前缀的首字符只能是 `0-7`。
2. `crypto.randomBytes(10)`（80 bit）编成 16 个字符。
3. 加前缀。总长 30。字母表与 `contracts` 的 `ID_ALPHABET` 是同一份，排除 `I L O U`，只输出大写。

碰撞：调用方用 `isOccupied` 告诉分配器「这个 ID 已经被占」。分配器换一对新的时间戳和熵再试。默认最多 **8** 次（`ID_ALLOCATION_MAX_ATTEMPTS`）；显式预算是 `1..128`。耗尽抛 `id_collision`，**不返回已占用的 ID，也不写库**。数据库主键 / 唯一索引仍是最终防线（§3.3）。创建人格时，占用谓词就是 `personas.getById`；插入若仍撞上唯一约束，创建失败为 `id_collision`，不覆盖已有行。

时钟默认 `Date.now`，熵默认 `node:crypto`。两者都可以注入，供测试锁住时间前缀。没有 `isOccupied` 时只取一次，不空转。

### 1.2 Persona 生命周期（SH-008B）

`createPersonaLifecycle({ store, logger, bootId, now?, randomBytes?, beforeCommit? })` 返回进程内生命周期。`bootId` 由调用方提供（协议 §3.4：Daemon 每进程一个），本包不另造一个。

| 操作 | 行为 |
|---|---|
| `createPersona({ displayName })` | 分配 `personaId`，插入 `CREATED`，并在同一事务写入 `runtime_state`（epoch 为表默认值 1，version 为 0）。不接受调用方传入的 id |
| `getPersona` / `listPersonas` / `queryPersonas({ state? })` | 读取。列表按主键升序走 `listPage`，把每一页拼起来，避免 500 行上限把后面的人格截掉 |
| `startPersona` | 仅 `CREATED` 或 `STOPPED`。先提交 `STARTING`（写入当前 `bootId`），再提交 `RUNNING`。中间态会落库 |
| `suspendPersona` / `resumePersona` | 仅 `RUNNING` → `SUSPENDED`，以及 `SUSPENDED` → `RUNNING`。恢复时盖上当前 `bootId` |
| `stopPersona` | **任意状态**都可以调用。除下面两种之外，先 `STOPPING` 再 `STOPPED`。已是 `STOPPING` 则直接收成 `STOPPED`。已是 `STOPPED` 则成功返回，version 不变 |
| `restorePersona` | 按已有 id 读回。不分配、不插入。没有这行则 `not_found` |
| `normalizeCrashedPersonas` | 把**其它 boot**（含尚未盖 `bootId`）留下的 `STARTING` / `STOPPING` 直接收成 `STOPPED`。`bootId` 已经是本生命周期的行视为本进程正在进行的启停，不归一。不自动 start。其它状态不动 |

写路径：

- 合法与否在本包判断。persistence 的 `commitLifecycle` 只做条件写，不懂状态机。
- 每次成功提交 `version + 1`。期望 version 或状态已经变了 → `version_conflict`，不覆盖。
- **不提升 epoch。** 提交时 persistence 从人格行抄出现有 epoch。
- `runtime_state` 在同一次写事务里镜像 `state` / `boot_id` / `epoch` / `updated_at`。`checkpoint_json` 不在这条语句里，已有检查点不会被生命周期写掉，本批也不装载、也不新写检查点。
- 同一 `personaId` 的写操作进一条内存队列，按调用顺序一个接一个执行。不同人格各用各的队列，不共用缓冲。SQLite 仍是全库单写入者。
- 日志只有 id、状态、version、epoch、bootId、操作名。不写 `displayName`。诊断日志走 `safeLog`：日志实现抛错时吞掉，不改变已提交的结果，也不把 `illegal_transition` 换成日志异常。
- `get` / `list` / `query` / `restore` 在同一次 `withRead` 里读 `personas` 和 `runtime_state`。另一次连接在这两次读取之间提交，本连接仍返回进入读事务时的那一对。
- 返回 Promise 的方法（创建、start / suspend / resume / stop、归一）在参数不合法时**拒绝这个 Promise**，不在调用当场抛出。读操作和 `restorePersona` 仍是同步的。

归一的进程级前提（SH-008E 才由 Daemon 强制，本批只写明并在 boot 边界上守住）：Supervisor 在独占的 `RECOVERING` 阶段调用 `normalizeCrashedPersonas`，并且发生在本 boot 对任何人格 `start` / `stop` 之前。bootId 检查避免把本进程已经盖上章的启停收成 `STOPPED`；它不能代替「只有一个 Supervisor」这条约定。条件写仍是 version CAS，扫描之后被别人改过的行不会被覆盖。

`FAILED` 可以被 `stop`（任意状态都允许停），但不能 `start` / `suspend` / `resume`。本批没有「进入 FAILED」的操作：启动路径上没有认知装载可以失败。其它 boot 留下的 `STARTING` 靠归一收到 `STOPPED`，再显式 `start`。

### 1.3 进程内事件总线（SH-008C）

`createStimulusIngress({ store, logger, config, now?, randomBytes?, timers?, beforePersist?, duringRead?, beforeExpire? })` 返回进程内 Ingress。没有适配器注册表，也没有鉴权。**只能被同一进程和测试调用。** SH-009 才把它挂到 loopback HTTP。

配置是必填的。`queueCapacity`、`bufferTtlMs` 与 `personaAdmissionCapacity` 都必须是大于等于 1 的安全整数。`channels` 按 `source` 覆盖前两项，覆盖项自己也必须两项都合法。`personaAdmissionCapacity` 不按 source 拆。缺配置、0、负数、小数、非法 source，构造时抛 `invalid_argument`。没有「不填就无限」的默认值。

在途受理有两级上限，都在进入人格队列**之前**检查。超出则 `outcome: 'backpressure'`、`reason: 'queue_overflow'`，不落库、不分配 `eventId`、不保留正文：

1. **每个 source。** 同一 `personaId` 同一 `source` 上，已经通过入口、还没跑完的任务最多 `queueCapacity` 个。
2. **整个人格。** 同一 `personaId` 上，所有 source 加在一起的在途受理最多 `personaAdmissionCapacity` 个。底层队列按人格串行，只限制单个 source 挡不住换一个合法 source 再投。

另外，内存里还没过期的正文，每个 source 最多 `queueCapacity` 份。任务真正执行时若缓冲已满，信封会落成 `expired` + `queue_overflow`，结果是 `refused`。这是已经拿到队列之后的事，和上面的 `backpressure` 不是同一条路径。

`acceptStimulus({ stimulus, externalSessionRef? })` 返回 Promise。参数不合法时拒绝这个 Promise，不在调用当场抛出。校验通过后会立刻深拷贝并冻结信封，再用当时的时钟写入 `receivedAt`。之后调用方改原对象，不会改排队键、去重键、落库字段或缓冲正文。`receivedAt` 是入口时间，不是任务开始执行的时间。

| 步骤 | 行为 |
|---|---|
| 校验 | 用 contracts 的 `soul.stimulus.input.v1` 校验 `stimulus`。带 `receivedAt` 或未知顶层字段 → `schema_invalid`，不落库。通过后立刻快照 |
| 时钟 | 入队前用可注入时钟写入 `receivedAt`，再校验 `soul.stimulus.v1`。`occurredAt` 原样保留，包括它远早于 `receivedAt` 的情况 |
| 背压 | 该 source 的在途数达到 `queueCapacity`，或该人格全部 source 的在途数达到 `personaAdmissionCapacity` → `backpressure`，不入队 |
| 去重 | 键是 `(personaId, adapterId, source, adapterEventRef)`，在同一次 `withRead` 里和人格行一起读。命中则返回既有 `eventId` 与 `status`，`bodyVerified` 恒为 `false`，指标 `dedupe.body_unverifiable` +1。不读正文、不写正文、不调用 `archive.compare`。`expired` / `rejected` 保持终态 |
| 会话 | 有 `externalSessionRef` 时，复用 `(personaId, adapterId, externalSessionRef)` 上仍开着的 `sessionId`。已关闭的不复活，另分配新 id。没有这个字段则 `sessionId` 为 null |
| 落库 | 未命中时分配 `eventId`（占用则重试；唯一约束冲突再读去重键，命中则按上面的幂等返回）。短事务里先写 `received`，同一提交进入 `accepted`（`archive_state='none'`、`disposition` 与 `archive_ref` 皆 NULL）。缓冲已满则同一提交进入 `expired` + `queue_overflow`，结果是 `refused` |
| ACK | 事务提交之后才返回，而且返回值跟库里的行一致。提交之后的时钟或登记异常不会把这次调用变成 rejected Promise。若提交前 TTL 已经过了，正文不进缓冲，行收成 `expired` + `ttl_expired`，结果是 `outcome: 'expired'`。定时器登记或重注册失败同样不留正文，并收成 `rejected` + `processing_failed`。`buffer_lost` 仍只属于崩溃恢复，本批不用。收口写库或时钟失败时，行保持库里的 `accepted`，事件 id 进入不含正文的重试名单，返回值也是 `accepted` |
| TTL | `readBuffered` 自己看时钟。`expiresAt <= now` 时先从内存删掉正文并返回 `null`，然后再尝试把活跃行收成 `ttl_expired`。数据库写失败不会把正文放回去；失败记 `ingress.ttl_persist_failed`，事件 id 留在不含正文的重试名单里，之后的 `evictExpired` 或同人格的下一次受理会再写元数据。已经是终态的行不改。`close()` 取消定时器并丢掉缓冲 |

`accepted` 只表示信封已经落库。`audited` 恒为 `false`。本批不会把事件推进到 `noticed` / `understood` / `response_committed` / `acted`。

同一 `personaId` 的受理和 TTL 收口进同一条内存队列。别的人格不用这条队列，缓冲也不交叉。`readBuffered(personaId, eventId)` 用错人格，或正文已经过了 `expiresAt`，得到 `null`。

诊断日志走 `safeLog`。日志实现抛错不会改掉已提交的受理、幂等命中或校验错误。日志字段只有 id、adapter、source、状态和指标名，没有正文。幂等命中的日志写 `bodyVerified: false`，不把它说成内容已经核对过。

`externalSessionRef` 会写入 `sessions.external_id`。它是适配器自己的会话键，长度 1..256，不能含空白或控制字符。不要把消息正文放进去。

## 2. 不负责什么

1. **不接受外部指定的内部 ID。** 没有把调用方字符串收成 `PersonaId` 的函数。`createPersona` 的多余字段会被忽略。
2. **不在本包写 SQL，不做 snake_case 映射，不读环境变量。** 权威写入只经过 `@soul-harness/persistence`。
3. **不创建会话、思维、动作或冲突记录。** `allocateThreadId` / `allocateActionId` / `allocateConflictRecordId` 只产生符合格式的字符串。
4. **不实现** 调度器、扫描 A/B、检查点装载/写出、Daemon 生命周期、HTTP。入口不导出 `createRuntime`、`enqueueTask`、`recover`、`checkpointAll`。`acceptStimulus` 不是自由函数，只在 `createStimulusIngress` 返回的对象上。
5. **不提升 epoch，不分配 `bootId`。**
6. **不保存历史 run。** OPEN-1 已决定：P1 不建 `runs` 表。
7. **不声称 H12 整条通过。** 本批只保证人格级写队列和状态行互不覆盖。记忆、激活、授权不在这里。

## 3. 与生命周期文档的差异

这些是本批的实现选择，不是把 [RUNTIME-LIFECYCLE](../../docs/architecture/RUNTIME-LIFECYCLE.md) 改写成另一套状态机。

| 点 | 本批做法 |
|---|---|
| 图上只画了 `CREATED → STARTING` | `start` 也接受 `STOPPED`。§4 要求崩溃归一之后显式重启，重启的落点就是 `STOPPED` |
| `stop` 从任意状态进入 `STOPPING` | 已经是 `STOPPED` 时不再绕一圈（version 不变）。已经是 `STOPPING` 时收成 `STOPPED`，只 +1 |
| 启动要装载检查点，停止要先写检查点 | **不做。** 那是 SH-008E。本批的 `STARTING` / `STOPPING` 只提交状态行 |
| 崩溃归一由 Daemon 在 RECOVERING 调用 | 函数在本包，且只收其它 boot 留下的 `STARTING` / `STOPPING`。`phases.ts` 仍是 `not_implemented`。独占 RECOVERING、且先于本 boot 启停，由 SH-008E 接线 |
| 图上有「任意失败 → FAILED」 | 没有 `failPersona`。`FAILED` 只作为已存在的状态被识别 |

`displayName` 长度 1..128（`PERSONA_DISPLAY_NAME_MAX_LENGTH`）、拒绝首尾空白和控制字符，是本批的入口限制。表本身没有这个 CHECK。

`beforeCommit` 是测试缝，生产调用省略。它在判定合法之后、条件写之前运行；返回的 Promise 会在队列里被等待，用来观察 `version_conflict`。

`duringRead` 也是测试缝。它在同一次读事务里、人格行已经读出、`runtime_state` 尚未读出时运行，用来让另一个连接在中间提交。

## 4. 目录

```
packages/runtime/
├─ src/
│  ├─ index.ts                      # 唯一公共入口
│  ├─ errors.ts                     # RuntimeError
│  ├─ ids/{encode,allocate}.ts      # 冻结编码与分配
│  ├─ persona/{lifecycle,queue}.ts  # 状态机与人格级写队列
│  └─ events/{schema,buffer,bus}.ts # P1 校验、TTL 缓冲、进程内 Ingress
└─ test/                            # 85 项
   ├─ allocator.test.ts             # 29 项。向量、时钟、碰撞、SQLite 主键
   ├─ allocator-sample.test.ts      # 2 项。OPEN-7 大样本
   ├─ persona-lifecycle.test.ts     # 21 项。真实 SQLite 上的生命周期
   └─ ingress.test.ts               # 33 项。真实 SQLite 上的 P1 Ingress
```

## 5. 依赖

| 方向 | 包 | 本批实际情况 |
|---|---|---|
| 允许依赖 | `contracts` | **已依赖**。格式校验、字母表和两份 Stimulus Schema 只引用 contracts，不在这里复制正则 |
| 允许依赖 | `persistence` | **已依赖**。只调用仓储与 `withRead`。`src/` 不导入 `node:sqlite`，也不拼 SQL |
| 校验器 | `ajv` | **已依赖**。只用来执行 contracts 导出的两份 Schema。校验失败对象会立刻丢掉，避免留住正文 |
| 被谁依赖 | 仅 apps | **还没有。** `soul-daemon` 未装配本包 |

`contracts` / `persistence` 不得依赖本包。

## 6. 对外接口

分配器：

```ts
allocateId(prefix, options?): HarnessId
allocatePersonaId(options?): PersonaId
allocateSessionId(options?): SessionId
allocateThreadId(options?): ThreadId
allocateRunId(options?): RunId
allocateEventId(options?): EventId
allocateActionId(options?): ActionId
allocateTaskId(options?): TaskId
allocateConflictRecordId(options?): ConflictRecordId
```

`AllocateOptions` 见 SH-008A：`now` / `randomBytes` / `isOccupied` / `maxAttempts`。

生命周期（写操作返回 Promise，因为要排队；参数错误也拒绝该 Promise。读操作是同步的）：

```ts
createPersonaLifecycle(options): PersonaLifecycle

createPersona({ displayName }): Promise<PersonaSnapshot>
getPersona(personaId): PersonaSnapshot | null
listPersonas(): readonly PersonaSnapshot[]
queryPersonas({ state? }): readonly PersonaSnapshot[]
startPersona(personaId): Promise<PersonaSnapshot>
suspendPersona(personaId): Promise<PersonaSnapshot>
resumePersona(personaId): Promise<PersonaSnapshot>
stopPersona(personaId): Promise<PersonaSnapshot>
restorePersona(personaId): PersonaSnapshot
normalizeCrashedPersonas(): Promise<readonly PersonaSnapshot[]>
```

Ingress（写操作和 `evictExpired` 返回 Promise；参数错误拒绝该 Promise。`readBuffered` / `listQueued` / `metrics` / `close` 是同步的）：

```ts
createStimulusIngress(options): StimulusIngress

acceptStimulus({ stimulus, externalSessionRef? }): Promise<IngressResult>
readBuffered(personaId, eventId): BufferedStimulus | null
listQueued(personaId): readonly QueuedStimulus[]
evictExpired(): Promise<readonly TtlClose[]>
close(): void
metrics(): { 'dedupe.body_unverifiable': number }
```

`IngressResult` 是 `accepted`（`audited: false`）、`duplicate`（`bodyVerified: false`，状态可以是终态）、`expired`（提交后、ACK 前已经收成 `ttl_expired`）、`rejected`（缓冲没能留下，收成 `processing_failed`）、`refused`（缓冲已满，已落成 `expired` + `queue_overflow`）或 `backpressure`（在途受理已满，未入队、未落库）。没有 HTTP 状态码。`buffer_lost` 的定义仍以 DATA-MODEL 为准，只用于崩溃或重启后的恢复扫描。

错误码：`invalid_argument` / `invalid_clock` / `invalid_entropy` / `id_collision` / `id_encoding` / `not_found` / `illegal_transition` / `version_conflict` / `schema_invalid` / `closed`。消息不回显时钟、熵、候选 ID、display name 或刺激正文。存储层的 `store_closed` 等错误原样抛出，不包装成 RuntimeError（创建人格时的唯一约束除外，包装成 `id_collision`；Ingress 在去重键冲突时改走幂等返回）。

## 7. 测试

| 文件 | 覆盖 |
|---|---|
| `test/allocator.test.ts` | 29 项。已知向量、前缀不可混用、时钟进退、碰撞重试、真实 SQLite 主键冲突不覆盖、`src/` 无 SQL / 无环境读取，且只依赖 contracts 与 persistence |
| `test/allocator-sample.test.ts` | 2 项。每个前缀 10000 个 ID，另加同毫秒突发 10000 个；全部通过 contracts 的 `is*` / `parse*`，样本内唯一 |
| `test/persona-lifecycle.test.ts` | 21 项。真实迁移后的 SQLite：合法与非法转移、任意状态 stop、按 boot 区分的崩溃归一、按 ID 恢复且不新建、多人格隔离、同人格并发、过期 version 不覆盖、epoch 不变、检查点不被生命周期写掉、分页列表、日志失败不掩盖提交、双连接读快照、非法参数拒绝 Promise |
| `test/ingress.test.ts` | 33 项。真实 SQLite：信封正反例与注入时钟、去重不插第二行且不声称正文一致、终态不重开、唯一约束冲突后的幂等收敛、会话复用与关闭后新建、金丝雀正文只活在 TTL 缓冲里、source 与人格两级在途上限、入队前背压、过期正文不可读、受理期间 TTL 到期时返回值与库一致、提交后时钟抛错仍返回已提交状态并进入无正文收口队列、TTL 元数据失败后的重试且时钟抛错不产生未处理 rejection、定时器登记失败与提前触发后重注册失败都收成 `processing_failed`、快照不被事后篡改、`receivedAt` 取入口时间、人格与 source 隔离、同人格串行、日志失败不掩盖结果、非法配置与非法参数拒绝 Promise |

OPEN-7 的样本量就是那两个 **10000**。不把「统计上永不碰撞」写成验收。

`tools/consumer-check` 以包名导入 `createPersonaLifecycle` 与 `createStimulusIngress`，在构建产物上跑通人格生命周期和一次受理 / 去重，并确认 `createRuntime`、`enqueueTask`、`recover`、`checkpointAll` 尚未导出。

## 8. 已知限制

1. 分配 `runId` 不会把历史尝试写入 `runs` 表——P1 没有这张表（OPEN-1，2026-11-20）。
2. 占用检测在创建人格时接的是 `getById`。分配器自己看不到唯一索引；索引冲突变成 `id_collision`。
3. 重试上限 8 是 SH-008A 的实现选择，不是协议里的新常数。
4. 本包被构建、被测试，**不表示** Daemon 已经在恢复人格或受理事件。`normalizeCrashedPersonas` 不会自己在进程启动时跑。调用它的独占 `RECOVERING` 顺序属于 SH-008E。
5. 读操作不进写队列，因此可能看见 `STARTING` / `STOPPING` 这两个已经提交的中间态。
6. 已经 `STOPPED` 的 `stop` 不会顺便修理一张和人格行不一致的 `runtime_state`。正常路径的写入是一起提交的。
7. 没有任务调度、扫描 A/B、检查点编排，也没有 HTTP。P1 的 `accepted` 不是审计，也不是已经理解。进程重启后内存缓冲不在；把因此丢失的活跃事件收成 `buffer_lost` 属于 SH-008E。
8. 在途上限和正文缓冲都记在本 Ingress 实例的内存里。两个 Ingress 共用一个库时，容量不会加总；生产部署是一个 Daemon、一个 Ingress。入队前的 `backpressure` 不会写成事件行。`personaAdmissionCapacity` 管的是在途受理，不管已经落库的正文份数。
9. 正文过期或缓冲登记失败都不依赖「先把库写成功」。元数据写失败时，正文已经不可读；只把 `eventId` 和原因码留在重试名单里，自动定时重试最多 3 次，之后靠 `evictExpired` 或同人格的下一次受理补写。重试回调里的异常会被接住，不会变成未处理的 rejection。提交已经成功之后，时钟再抛错也不会把这次调用变成失败。`close()` 会再试一次然后丢掉这份名单。进程退出后仍是 `accepted` 的行，要等 SH-008E 按 `buffer_lost` 收口。本批运行期不用 `buffer_lost`；缓冲没能留下时用 `rejected` + `processing_failed`。
10. `externalSessionRef` 会进 `sessions.external_id`。金丝雀测试覆盖的是刺激正文，不是这个适配器会话键。
11. 跨多个 source 的已受理缓冲总条数、总字节数和单条载荷上限留到 SH-010 做插件接入安全验收。本批不引入插件注册表。
