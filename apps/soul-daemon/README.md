# `@soul-harness/soul-daemon` — 生命周期、装配与本地管理接口

- **地位**：应用层。只做装配、生命周期与本地管理传输，业务逻辑在 `packages/`（[MODULES](../../docs/architecture/MODULES.md) §4）。
- **状态**：已装配配置、结构化日志、数据目录、单实例锁、API Token、SQLite、Migration、Schema 校验、Persona 归一、`recoverRuntime`、无传输层的进程内 Ingress、空 Handler Map 的 Scheduler，以及本地 HTTP / WebSocket / Health。启动可进入 `RUNNING`；这不表示认知循环或任务派发已经实现。
- **上位文档**：[RUNTIME-LIFECYCLE](../../docs/architecture/RUNTIME-LIFECYCLE.md) §2/§3/§10、[PLAN](../../docs/PLAN.md) §6/§7、[MODULES](../../docs/architecture/MODULES.md) §1/§4、[TRUST-BOUNDARIES](../../docs/architecture/TRUST-BOUNDARIES.md) §5.1。

## 1. 职责与非职责

| 负责 | 不负责 |
|---|---|
| 读取并校验配置（缺项即失败） | 解释配置之外的业务语义 |
| 结构化日志（禁正文/令牌/路径） | 采集遥测或上传 |
| 数据目录、单实例锁、API Token 文件 | 自动回退临时目录、自动 chmod 或迁移目录 |
| 打开 SQLite、Migration、Schema 校验 | 直接写表（必须经 `@soul-harness/persistence`） |
| Persona 归一 + `recoverRuntime` | 自动 start Persona、生成主观记忆或执行扫描 A/B |
| 创建无传输层 Ingress、空 Handler Scheduler、本地 API | 受理外部 Stimulus、派发任务、执行认知循环 |
| 按固定顺序关闭；失败不报成干净成功 | 有界关闭、Handler 取消、Runtime checkpoint |

**本进程不伪造未实现的能力。** 进入 `RUNNING` 后，实际能力面是：

- Persona 生命周期：`assembled`，不自动启动；
- Runtime Recovery：`assembled`；
- Event Bus：`assembled_no_transport`；
- Ingress：`unavailable_no_transport`，`acceptsInput=false`；
- Scheduler：`running`，Handler Map 为空；
- `taskDispatch=unavailable_no_handlers`；
- HTTP / WebSocket / Health：running；
- 认知循环：未实现。

「数据库已打开」「Scheduler 在跑」「HTTP 已监听」都不等于「可以派发任务」或「认知循环已运行」。

## 2. 启动与关闭

### 2.1 启动顺序

```text
BOOTING → MIGRATING → RECOVERING → READY → RUNNING
```

实际顺序（源码与已验收测试）：

1. 配置校验、日志、数据目录检查；
2. 获取数据目录单实例锁；
3. 加载或首次创建 `<SOUL_DATA_DIR>/api.token`；
4. 打开 SQLite；
5. Migration + Schema 校验；
6. Persona 归一（`runPersonaRecovery`）；
7. `recoverRuntime`；
8. 创建进程内 Ingress（`transport: none`）；
9. 创建并启动空 Handler Map Scheduler；
10. 创建 API facade、组装 HTTP/WebSocket 服务器并 `listen`；
11. Health 随同一 API 服务器可用；
12. 进入 `RUNNING`。

失败即停止装配。Recovery incomplete、Ingress/Scheduler/API 启动失败都不会被报告成 `RUNNING`。Token 创建失败发生在 SQLite 打开之前。

### 2.2 关闭顺序

```text
RUNNING/READY → DRAINING → CLOSING → STOPPED
```

实际顺序：

1. `API.beginDrain()`：拒绝新管理请求与 Upgrade，向已鉴权 WS 尽力发送 `shutting_down` 并关闭；
2. `Ingress.close()`；
3. `await Scheduler.stop()`；
4. `API.close()`；
5. `Store.close()`；
6. `Lock.release()`。

实际实现**不进入 `CHECKPOINTING`**；只记录 `checkpoint_skipped`。Runtime checkpoint 未实现，也不写 `runtime_state.checkpoint_json`。

失败保护：

- `Scheduler.stop()` reject 或一直 pending：不关 Store、不释放 Lock。
- `API.close()` 失败：保留 API 对象与 sticky failure；不关 Store、不释放 Lock；后续 `stop()` 不能绕过。
- `Store.close()` 失败：不调用 `lock.release()`，锁文件留下；`shutdown_failed` / 退出码 6。
- `Ingress.close()` 失败：记录失败，但继续停止 Scheduler、关闭 API/Store、释放 Lock，最终仍为 `shutdown_failed`。
- 没有强制 shutdown 超时；没有用 `process.exit()` 绕过资源保护。

## 3. 配置

全部来自环境变量。必填项缺失/空白直接失败；数值项必须是范围内安全整数，**不做静默夹值**。

| 变量 | 必填 | 默认 | 范围与用途 |
|---|---|---|---|
| `SOUL_DATA_DIR` | ✅ | — | 非空数据目录；相对路径按 cwd 解析。无临时目录回退 |
| `SOUL_LOG_LEVEL` | ❌ | `info` | `debug` / `info` / `warn` / `error` |
| `SOUL_SHUTDOWN_TIMEOUT_MS` | ❌ | `10000` | 100–600000；只校验并记录，不是截止时间 |
| `SOUL_TASK_MAX_ATTEMPTS` | ✅ | — | 1–100；Recovery 与 Scheduler 共用 |
| `SOUL_TASK_RETRY_BACKOFF_MS` | ✅ | — | 0–86400000；Scheduler 固定退避 |
| `SOUL_RECOVERY_BATCH_SIZE` | ❌ | `200` | 1–500 |
| `SOUL_RECOVERY_MAX_ROWS` | ❌ | `10000` | 1–1000000；包含 Persona 枚举行 |
| `SOUL_RECOVERY_MAX_PERSONAS` | ❌ | `200` | 1–10000 |
| `SOUL_SCHEDULER_MAX_TOTAL` | ❌ | `8` | 1–1024 |
| `SOUL_SCHEDULER_PER_UNIT` | ❌ | `1` | 1–64 |
| `SOUL_INGRESS_QUEUE_CAPACITY` | ❌ | `256` | 1–1000000 |
| `SOUL_INGRESS_BUFFER_TTL_MS` | ❌ | `300000` | 1–86400000 |
| `SOUL_INGRESS_PERSONA_CAPACITY` | ❌ | `8` | 1–1024 |

Ingress 配置存在不代表外部输入已接入；Scheduler 并发参数存在不代表有 Handler。

## 4. 数据目录、锁与 Token

```text
<SOUL_DATA_DIR>/
├─ soul.lock     # 单实例锁：pid / bootToken / startedAt / dataDir
├─ api.token     # 32 随机字节 base64url（43 字符 + 换行）
└─ soul.db       # SQLite（WAL）
```

单实例锁要点：

1. `open(..., 'wx')` 原子创建；
2. PID 仍存活或无法证明已死 → 拒绝启动；
3. 陈旧锁以快照 + `soul.lock.claim.<sha256>` 唯一认领后删除；
4. 非法锁数据不接管；
5. 释放前比对 `bootToken`；
6. 崩溃残留锁由下次启动按陈旧锁协议处理。

API Token 语义：

- 路径固定为 `<SOUL_DATA_DIR>/api.token`；
- 32 个随机字节，base64url 编码，43 字符，文件带换行（44 字节）；
- POSIX 要求普通文件、当前用户所有、完整 mode 精确 `0600`（含 setuid/setgid/sticky 检查）；dataDir 必须无 group/other 权限且归当前用户；
- 首次创建完成 fd 关闭后再次检查 dataDir 安全条件；
- 不自动 chmod、迁移目录或重生成非法 Token；
- 不通过 HTTP、WebSocket、Status、日志、URL query 或 Cookie 暴露 Token；
- 没有 Token bootstrap endpoint，也没有热轮换；
- Windows 上 Node 的 mode 不等于 ACL；安全边界依赖 dataDir ACL 与同用户信任。
- 当前没有 Studio 应用；未来 Studio 客户端只应在内存中保存手工复制的 Token，不写 localStorage/sessionStorage。

## 5. 本地 HTTP API

监听固定地址：`http://127.0.0.1:18700`。HTTP 与 WebSocket 共用端口；不自动换端口。

所有请求：

- 只监听 IPv4 loopback；
- Host 必须是精确的 `127.0.0.1:18700`；
- Origin 只能是 `http://127.0.0.1:18701`（Studio 预留开发源）或 `http://127.0.0.1:18700`，无 Origin 的 CLI 请求允许；
- 管理路由必须带 `Authorization: Bearer <token>`；
- 全局 Token Bucket 为 20 个令牌、每秒补充 2 个（含 Health）；
- JSON body 上限 64 KiB；
- 错误使用固定信封：

```json
{"error":{"code":"invalid_request","message":"invalid request"}}
```

当前路由：

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/v1/health/live` | 匿名 | 最小存活检查，`{"status":"ok"}` |
| GET | `/v1/health/ready` | 匿名 | 最小就绪检查，`{"status":"ready"}` 或 503 `not_ready` |
| GET | `/v1/status` | Bearer | StatusView 状态查询 |
| GET | `/v1/personas` | Bearer | Persona 列表 |
| GET | `/v1/personas/:personaId` | Bearer | Persona 单查 |
| POST | `/v1/personas` | Bearer | 创建 Persona |
| POST | `/v1/personas/:personaId/start` | Bearer | 启动 |
| POST | `/v1/personas/:personaId/suspend` | Bearer | 挂起 |
| POST | `/v1/personas/:personaId/resume` | Bearer | 恢复 |
| POST | `/v1/personas/:personaId/stop` | Bearer | 停止（STOPPED 为合法 no-op） |
| GET | `/v1/personas/:personaId/events` | Bearer | Event 列表 |
| GET | `/v1/personas/:personaId/events/:eventId` | Bearer | Persona 范围内 Event 单查 |
| GET | `/v1/personas/:personaId/tasks` | Bearer | Task 列表 |
| GET | `/v1/personas/:personaId/sessions` | Bearer | Session 列表 |

补充事实：

- 非法 Persona ID 在进入 Store/Runtime 前返回 400；合法但不存在的单查保持 404。
- 不存在 `POST /v1/stimuli`、Task 写接口、Archive/Action 接口、远程 shutdown 或配置修改接口。
- 管理 API **不是**外部 Stimulus transport；不接受 Adapter 事件。
- Health 只有最小 live/ready；没有完整健康指标、队列深度、最近提交时间或 health loop/supervisor。
- 没有 Cookie Token、URL query Token 或 Token bootstrap endpoint。
- 没有 HTTP/WS 管理写命令扩展现有 Persona 写接口之外的能力。

错误状态：

| 状态 | 典型 code |
|---|---|
| 400 | `invalid_request` |
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `conflict` |
| 413 | `too_large` |
| 429 | `rate_limited` |
| 500 | `internal_error` |
| 503 | `unavailable`（draining 或依赖不可用） |

## 6. WebSocket

端点：`ws://127.0.0.1:18700/v1/ws`

子协议：`soul.ws.v1`

行为：

- Upgrade 前校验 Host/Origin/全局 Token Bucket/子协议；
- 首帧必须是：

```json
{"type":"auth","token":"<token>"}
```

- 5 秒内未认证关闭 1008 `auth_timeout`；
- 认证成功后发送 `hello`，再发送一次权威 `snapshot`；
- 客户端只可发送 `{"type":"pull"}`，返回新 `snapshot`；
- drain 时尽力发送 `{"type":"shutting_down","reason":"daemon_stop"}`，随后 close 1001；
- 无 URL query Token、Cookie Token、周期性推送、事件流或 replay。

资源限制（源码核对）：

- 未认证连接最多 16；
- 已认证连接最多 32；
- 未认证名额满时 Upgrade 前 HTTP 503；
- 已认证名额满时 1013 `server_busy`；
- 所有入站帧最大 4096 字节（transport `maxPayload`），应用层二次检查；
- 超大帧 transport 以 1009 关闭；
- 每连接出站队列最多 64 条或 1 MiB，超出 1013 `slow_client`；
- 连接关闭、认证失败、超时和 terminate 都释放名额；
- beginDrain/API close 主动清理连接，不等待客户端 close handshake。

其它 close code：非法 JSON 1003、未知消息 1003、错误/缺失 Token 1008、非法 auth 1008。

## 7. 真实测试

| 文件 | 覆盖 |
|---|---|
| `test/api-http.test.ts` | Host/Origin/CORS、Bearer、固定错误信封、body limit、Status/列表/单查、draining |
| `test/api-token.test.ts` | Token 格式/权限、特殊位拒绝、目录复查、符号链接、fd 读取、无效文件 |
| `test/api-personas.test.ts` | Persona 创建与状态动作、鉴权、合法 ID、真实 Daemon 集成 |
| `test/api-ws.test.ts` | 真实 TCP Upgrade、首帧认证、hello/snapshot/pull、关闭码、名额、帧限制、慢客户端、drain |
| `test/api-lifecycle.test.ts` | 真实 Daemon 的 HTTP/WS 生命周期与 Store/Lock 释放 |
| `test/process.test.ts` | 构建产物真实进程：HTTP/WS、Token 创建、非法 Token 启动、marker SIGTERM、SIGKILL/重启、锁与数据库 |
| `test/logger.test.ts` | 结构化日志、敏感字段打码、API Token 错误码 |

进程测试在 `beforeAll` 构建 `dist/` 后运行 `apps/soul-daemon/dist/main.js`，不是 Fastify `inject`。Windows 不能向子进程投递 POSIX SIGTERM，测试使用同进程 `process.emit('SIGTERM')` 路径；这不声称验证了 Windows OS 信号投递。Linux CI 执行同一路径及 POSIX 权限测试。

## 8. 运行与退出码

```bash
SOUL_DATA_DIR=/var/lib/soul \
SOUL_TASK_MAX_ATTEMPTS=3 \
SOUL_TASK_RETRY_BACKOFF_MS=1000 \
node apps/soul-daemon/dist/main.js
```

| 码 | 含义 |
|---|---|
| 0 | 正常停止（含启动中被中止） |
| 2 | 配置缺失/非法 |
| 3 | 数据目录不可用/不可写 |
| 4 | 单实例锁竞争或锁文件不可读 |
| 5 | 启动失败（Token、Migration、Store、Schema、API 等） |
| 6 | 关闭过程中清理失败 |

## 9. 未实现 / 不要误读

| 能力 | 事实 |
|---|---|
| 真实任务派发 | Handler Map 固定为空；Scheduler 在跑但不执行任务 |
| 外部 Stimulus transport | Ingress 无 transport；HTTP/WS 仅管理 |
| 认知循环 | 无主观记忆生成、思维循环、扫描 A/B、检查点编排 |
| 完整健康指标 | 只有最小 live/ready |
| Studio / CLI | 目录不存在；Studio dev port 仅为预留 |
| Token 热轮换 / bootstrap | 未实现 |
| 强制 shutdown timeout | 不存在 |
| Runtime checkpoint | 不写；只记录跳过 |
| 显式 WAL checkpoint | 应用层未实现 |
| 物理隔离 | P1 单 SQLite、同进程；不具备物理隔离 |
