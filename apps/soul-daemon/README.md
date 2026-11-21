# `@soul-harness/soul-daemon` — 生命周期与装配层

- **地位**：SH-007A 建立的 Daemon 骨架。它是**应用层**，只做装配与生命周期，业务逻辑必须下沉到
  `packages/`（[MODULES](../../docs/architecture/MODULES.md) §4）。
- **状态**：**SH-007A 已完成**——配置、结构化日志、数据目录检查、单实例锁、打开 SQLite、
  执行 Migration、启动/关闭状态机与资源逆序释放。
  **Daemon 仍未装配 Runtime。** `packages/runtime` 里已有 ID 分配器（SH-008A）、进程内 Persona 生命周期（SH-008B）、进程内 P1 Ingress（SH-008C）和 P1 `recoverRuntime`（SH-008D D2，代码已提交）。本进程不调用它们。Scheduler（SH-008D D3）没有开始。把 Persona Recovery、Runtime Recovery、Event Bus、Scheduler 接到本进程属于 SH-008E，未开始。HTTP/WebSocket、健康检查属于 SH-009，未开始。
  SH-007B 不是下一批代码：它依赖 SH-008 与 SH-009 的真实组件接入，之后才验收 Daemon 的启动、就绪、关闭、资源释放与失败处理，自身不单独实施代码。
- **上位文档**：[RUNTIME-LIFECYCLE](../../docs/architecture/RUNTIME-LIFECYCLE.md) §2/§3/§4/§9、
  [PLAN](../../docs/PLAN.md) §6/§7、[MODULES](../../docs/architecture/MODULES.md) §1/§4。

## 1. 职责与非职责

| 负责 | 不负责 |
|---|---|
| 读取并校验配置（缺项即失败） | 解释配置之外的业务语义 |
| 结构化日志（禁正文/令牌） | 采集遥测或上传 |
| 数据目录与写权限探测 | 自动回退到临时目录 |
| 按数据目录获取单实例锁 | 进程级互斥之外的调度 |
| 打开 SQLite、跑 Migration、校验 Schema | 直接写表（必须经 `@soul-harness/persistence`） |
| 启动/关闭状态机与资源逆序释放 | Runtime 恢复、认知行为 |

**本批不伪造任何未实现的能力**：日志与启动报告把 `persona_recovery`、`runtime_recovery`、
`event_bus`、`scheduler`、`http_api`、`health_check` 明确标为 `not_implemented`，并给出后续归属阶段。
「数据库已打开」不等于「Runtime 已恢复」。

## 2. 生命周期状态

启动（RUNTIME-LIFECYCLE §2）：

```
BOOTING → MIGRATING → RECOVERING → READY → RUNNING
```

| 阶段 | 本批真实动作 | 未实现部分 |
|---|---|---|
| BOOTING | 配置校验、日志、数据目录探测、**单实例锁**、打开 Store | — |
| MIGRATING | `migrate()` + `verifySchema()` | — |
| RECOVERING | 仅记录阶段与跳过原因 | Persona 恢复、Runtime 恢复。包内已有对应函数，本进程不调用；装配是 SH-008E，未开始 |
| READY | 仅记录阶段与跳过原因 | Event Bus（包内 Ingress 存在，本进程不挂接；装配是 SH-008E）、Scheduler（D3 未开始）、API/WS、健康检查（SH-009） |
| RUNNING | 进程持有数据库与锁，等待停止信号 | 认知循环（SH-008 起） |

关闭（§3）：

```
RUNNING → DRAINING → CHECKPOINTING → CLOSING → STOPPED
```

| 步骤 | 本批行为 |
|---|---|
| DRAINING | 停止接收新的生命周期工作（当前没有调度派发，标记为 `not_implemented`） |
| CHECKPOINTING | **不写 Runtime checkpoint**（没有 Runtime 就没有合法的 `checkpoint_json`）；记录 `checkpoint_skipped`。这不是 SQLite WAL checkpoint |
| CLOSING | 按逆序释放资源：先 `Store.close()`（无显式 `PRAGMA wal_checkpoint`；SQLite 可能在关闭时做默认自动 checkpoint），再释放锁 |
| STOPPED | 完成；清理失败会使 `stop()` 拒绝并给出 `shutdown_failed` |

启动失败：已取得的资源按逆序释放，失败原因与清理失败计数一并报告；
锁在数据库之前获取，因此在锁竞争失败时**不会创建数据库文件**。

## 3. 配置

全部来自环境变量，缺关键项直接失败（不猜默认目录）：

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `SOUL_DATA_DIR` | ✅ | — | 数据目录；相对路径按进程 cwd 解析为绝对路径 |
| `SOUL_LOG_LEVEL` | ❌ | `info` | `debug` / `info` / `warn` / `error` |
| `SOUL_SHUTDOWN_TIMEOUT_MS` | ❌ | `10000` | 100–600000 的整数，优雅停止上界 |

## 4. 数据目录与单实例锁

```
<SOUL_DATA_DIR>/
├─ soul.lock     # 单实例锁（JSON：pid / bootToken / startedAt / dataDir）
└─ soul.db       # SQLite（WAL）
```

锁语义：

1. **原子创建**：`open(..., 'wx')`（O_CREAT\|O_EXCL）；不是"先检查再创建"。
2. **不假设持锁进程已死**：记录的 PID 仍存活（或 `EPERM` 无法判定）→ 拒绝启动，锁保持原样。
3. **陈旧锁按「快照」接管**（SH-007A.R1 修复）：
   - 读取锁文件并保留其**精确字节**（快照）；
   - 用 `soul.lock.claim.<sha256(快照)>` 的独占创建选出**唯一**认领者：
     所有看到同一份旧锁的竞争者会竞争同一个 claim 文件名，只有一个能创建成功；
   - 认领者**重新读取**锁文件，字节仍与快照一致才继续；不一致说明路径上已是别人的新锁 →
     抛 `lock_held` 且什么都不改；
   - 只有此时才 `unlink` 这份旧锁，最终仍由原子创建决定谁拿到锁。
   因此任何进程都不会删除自己没快照过的锁；「读 PID → rename 固定路径」的竞态不复存在。
4. **非法锁数据不接管**：PID 不是**正安全整数**（`0`、负数、小数、超出 2^53−1、字符串、null）
   一律 `lock_unreadable`，不 rename、不删除、不留 claim 文件。
5. **只有持有者释放**：释放前重新读取并比对 `bootToken`，不匹配则拒绝删除并报 `lock_release_failed`。
6. **残留锁**：崩溃（SIGKILL）后锁文件残留，下次启动按第 3 条接管；
   PID 被无关进程复用（无法证明已死）或残留 `soul.lock.claim.*`（认领窗口内崩溃）时，
   启动拒绝并给出 `claimPath`，需人工确认无 Daemon 在运行后删除。
   这两种情况下 `soul.db` 都不会被触碰。

跨平台（已在 Windows 11 / Node 24 实测；POSIX 语义一致）：

| 能力 | Windows | Linux / macOS |
|---|---|---|
| `O_EXCL` 原子创建 | ✅ | ✅ |
| `process.kill(pid, 0)` 探活 | ✅（`ESRCH` 表示不存在） | ✅ |
| 独占 claim 文件选主 | ✅ | ✅ |
| 从父进程投递 SIGINT/SIGTERM | ❌（Node 只能终止，不能投递） | ✅ |

> Windows 上优雅停止的测试改用同进程 `process.emit('SIGINT'/'SIGTERM')`——这正是 Node 内部
> 触发该事件的同一路径；POSIX 上真实信号到达的是同一个处理函数。
>
> 锁只使用 `open('wx')` / `read` / `unlink` 三种原语：Node 不提供可移植的 `flock`/`fcntl`，
> 因此不假设任何建议锁（advisory lock）语义；同目录内的文件系统原子性由 `O_EXCL` 与单文件
> 读/删操作承担。网络文件系统若不能保证 `O_EXCL` 原子性，本协议不适用。

## 5. 启动与关闭行为

```bash
pnpm --filter @soul-harness/soul-daemon build
SOUL_DATA_DIR=/var/lib/soul node apps/soul-daemon/dist/main.js     # 前台运行
```

- 正常启动：日志出现 `phase_entered: RUNNING`，进程常驻（内部持有 ref'd timer，避免空事件循环退出）。
- 停止：`SIGINT` / `SIGTERM` → 同一套受控停止流程；重复 `stop()` 幂等。
- 启动中收到停止请求 → 在下一个阶段边界中止，已取得资源逆序释放。
- 退出码：

| 码 | 含义 |
|---|---|
| 0 | 正常停止（含启动中被中止） |
| 2 | 配置缺失/非法 |
| 3 | 数据目录不可用/不可写 |
| 4 | 单实例锁竞争或锁文件不可读 |
| 5 | 启动失败（Migration、Store、Schema 等） |
| 6 | 关闭过程中清理失败 |

## 6. 当前真实支持的能力

- ✅ 环境配置校验、结构化 JSON 日志（键名含 `token`/`content`/`payload`/`memory` 等一律打码，
  错误只记录 `name/code/message`，不写堆栈）
- ✅ 数据目录创建 + 真实写入探测
- ✅ 按目录的单实例锁（原子、探活、陈旧接管、持有者校验）
- ✅ Store 打开、Migration、Schema 校验
- ✅ 启动/关闭状态机、逆序释放、幂等停止、信号接入

## 7. 尚未实现（不要当成已完成）

| 能力 | 归属 |
|---|---|
| 在本进程的 `RECOVERING` 调用 Persona 归一与 `recoverRuntime` | SH-008E（未开始）。包内函数已经存在，本表说的是 Daemon 没有接上。检查点、队列、活跃思维的恢复仍然没有 |
| 在本进程初始化 Event Bus | SH-008E（未开始）。进程内 Ingress 在 `packages/runtime`，本进程不挂接 |
| Scheduler | 包内实现是 SH-008D D3（未开始）；接到本进程还要等 SH-008E |
| HTTP / WebSocket API、健康检查端点 | SH-009 |
| Runtime checkpoint 写入（当前阶段无合法 checkpoint 可写） | 仍未实现。不在已提交的 `recoverRuntime` 里 |
| 显式 `PRAGMA wal_checkpoint` | 未实现。关闭只调用 `DatabaseSync.close()`，SQLite 可能自动 checkpoint，但应用层没有显式语句 |
| 进程级锁之外的并发控制 | 后续 |
| 结构化日志文件轮转/落盘 | 后续 |

SH-007A 已完成。上表归属不因 SH-007B 改变：Persona Recovery、Runtime Recovery、Event Bus、Scheduler 的 **Daemon 装配**仍是 SH-008E；Scheduler 本身是 SH-008D D3。二者都未开始。HTTP API、WebSocket、健康检查仍是 SH-009。SH-007B 不插在它们前面单独写代码。

## 8. 测试

```bash
pnpm --filter @soul-harness/soul-daemon test          # 37 项
pnpm test                                             # 全仓（含本应用）
```

| 文件 | 覆盖 |
|---|---|
| `test/config.test.ts` | 缺配置、空值、相对路径解析、非法日志级别/超时、默认值 |
| `test/logger.test.ts` | JSON 行格式、敏感键打码（含嵌套）、错误不带堆栈、级别过滤 |
| `test/lock.test.ts` | 原子创建、同目录拒绝、不同目录独立、幂等/持有者校验、损坏锁拒绝、活锁拒绝、死锁接管、抢占唯一性 |
| `test/daemon.test.ts` | 启动到 RUNNING、阶段顺序、未实现阶段如实报告、锁竞争不建库、数据目录失败、Migration 失败清理、启动中停止、关闭顺序、清理失败上报、重启幂等 |
| `test/process.test.ts` | 真实进程：退出码 2/3/4/5、信号优雅停止、双实例拒绝、不同目录并存、崩溃后残留锁接管与 SQLite 重开、活 PID 锁拒绝 |

进程测试在 `beforeAll` 中构建 `dist/`（Node 的类型剥离不能把 `.js` specifier 解析成 `.ts`），
随后以真实子进程运行构建产物——与部署路径一致。
