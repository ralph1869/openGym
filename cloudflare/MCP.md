# dot / ChatGPT 可写 MCP（默认关闭）

官方上游 `e348fc17` 的 `mcp/` 是 9 个只读 stdio 工具，读取 Docker 的本机 `data/` 文件。本实现保留它，另提供 Workers 原生 Streamable HTTP：`https://gym.ralph.run/mcp`。通过同一 `DB` 绑定读写现有 D1 分块状态，不使用副本、演示库或另建账号。

`MCP_ENABLED=false`、`MCP_REDIRECT_URIS=[]` 是有意的默认关闭。部署代码和新增表不会生成授权或开放训练访问；回调地址确认、功能启用和本人同意后才能接入。发布验证只使用公开接口、表结构及计数，不读取真实训练内容或创建真实授权。

## 工具和最小权限

| 工具 | 作用 | scope |
|---|---|---|
| `get_training_context` | 单位和修订号/write-id | `workouts:read` |
| `search_exercises` | 目录/本账号自定义动作的规范 ID 和重量语义 | `workouts:read` |
| `list_workouts` | 日期筛选、限量分页的训练摘要 | `workouts:read` |
| `get_workout` | 单条训练及其版本哈希 | `workouts:read` |
| `get_write_result` | 查询稳定 request_id 的提交回执 | `workouts:read` |
| `log_workout` | 向原档案新增一条已完成训练 | `workouts:create` + read |
| `update_workout` | 更正名称/备注/时长或指定普通已完成组的数值 | `workouts:update` + read |

授权绑定经 Passkey 验证的原用户 ID；参数不能选择用户。不能删除训练、替换档案、改账号/邀请码/设置、读取凭据、上传媒体或读取整份体重时间线。单条训练的原有备注、媒体引用和体重快照属于训练读取范围。名称/备注一律当数据，不当指令。

支持普通力量、计时和 cardio 组；修改不支持删除组、换动作、移动日期、左右侧/递减组/休息暂停等复杂组。这些请在网站编辑，不支持时明确失败。保留原 Docker 后端和官方只读 MCP。

## OAuth 2.1 / PKCE

实现 authorization-code + PKCE S256、RFC 8414 服务器发现、RFC 9728 资源发现、RFC 7591 公共客户端注册和 RFC 7009 撤销。使用 ChatGPT 自定义 MCP 的 DCR 模式，不宣称支持 CIMD、client secret、client credentials 或 OIDC。

- 发现：`/.well-known/oauth-authorization-server`、`/.well-known/oauth-protected-resource/mcp`，另支持资源发现根路径。
- `/oauth/register` 仅接受所有者预设的**精确 HTTPS 回调 URI**；无通配/前缀匹配、userinfo、fragment 或规范化替换，也不联网获取客户端 URL。
- `/oauth/authorize` 要求网站登录。未登录时本人另开网站用现有 Passkey 登录，返回授权页刷新。页面显示客户端名、完整回调和独立权限框；默认只读取，新增和更正都需本人勾选。
- 同意时再次验证 Passkey UV，挑战绑定账号、会话版本和所选权限，5 分钟一次性有效；不能超出客户端请求的 scope。
- 授权码 60 秒、一次使用，绑定 client/redirect/resource/PKCE/用户。回调带原始 state 和 `iss`。
- 不透明 access token 15 分钟；授权和 refresh 固定最多 7 天，不无限续期。D1 只存 SHA-256。refresh 每次轮换，旧 refresh 重用会撤销整次连接，客户端应串行刷新。
- 设置 → 账号 → 已连接的 AI 助手，或 `/oauth/connections`，可撤销授权，训练保留。撤销、过期和退出所有设备都会使连接失效。
- Bearer 不能用于 `/api/data` 或账号管理；网站 Cookie 不能代替 MCP 授权。所有入口限定配置的 `ORIGIN`，旧 workers.dev 不能混用。
- 不转发第三方 token，不使用共享管理员凭据，不记录授权响应/token/训练负载。OAuth token 由客户端保存，模型只看工具结果。

公共 initialize/ping/tools-list 仅返回协议和工具定义；所有数据和写入调用逐次验证 token、audience、expiry、scope。认证失败有 WWW-Authenticate 和 `mcp/www_authenticate`。每个工具有 securitySchemes 与准确的 readOnly/destructive/idempotent annotations。

传输是无会话的 Streamable HTTP JSON：POST 返回 JSON、通知返回 202、GET/DELETE 返回 405。不提供 SSE 或批量 JSON-RPC。已加入官方 MCP SDK 的兼容性测试。

## 真实模型、日期、重量和重试

1. 先取 `get_training_context` 的 `{unit,cursor:{rev,wid}}`，查清动作 ID；含糊时询问本人。
2. 每次意图使用唯一、稳定的 `request_id`。网络重试、更新 cursor 或客户端重连时**不换 ID**。
3. 提供 `date`、带 offset 的 `started_at`、IANA `time_zone`、实际 `duration_minutes`。核对该时区日历日期，拒绝无效日期、无 offset、未来或超过 24 小时的训练；不猜“今天/昨天”的时区。
4. 明确 `kg/lb`、`load_basis=app_display`：重量是应用显示/录入数值，不是杠铃单侧杠片。哑铃/壶铃另需 `db_load=as/each/total`（照录/单只/合计），不偷偷乘二。换算复用 UI 的装片和体重舍入；cardio speed 始终 km/h。
5. 新训练用 UI 的 `buildCompletedWorkout` 写入普通 `{id,d,start,end,routineIds,entries,sets,topW,prs}`，过去训练不凭空授予 PR，按历史顺序插入。更正携带 `get_workout` 的 `expected_version`。原记录、媒体、计划、设置、体重日志保持。
6. D1 同一事务检查 baseRev/baseWid，写 manifest/全部分块和幂等回执，并在事务内复核授权有效。并发冲突明确失败，不能覆盖旧档案；缺块、损坏、超限不能当空数据。
7. 同 ID 同意图返回原回执，不重复训练；同 ID 不同意图为 `idempotency-conflict`。不确定是否成功时查 `get_write_result`。回执表示曾提交，不代表本人后来未修改/删除该训练。只保留操作哈希和结果元数据，到账号删除时清理，避免长期重试复活旧操作。

每个授权每分钟最多 30 次新写入尝试，已提交的幂等重试不重复计数。达到上限时等待后以原 request_id 重试；单次请求体最多 64 KiB。

虚构示例（使用实时 cursor，时间也须本人确认且已结束）：

```json
{
  "request_id": "dot-example-20261015-session01",
  "cursor": {"rev": 12, "wid": "<get_training_context 的 wid>"},
  "workout": {
    "name": "上肢训练", "date": "2026-10-15",
    "started_at": "2026-10-15T18:00:00+08:00", "time_zone": "Asia/Shanghai",
    "duration_minutes": 45, "unit": "kg",
    "entries": [{"exercise_id": "0025", "mode": "reps", "load_basis": "app_display",
      "sets": [{"weight": 60, "reps": 8}, {"weight": 60, "reps": 8, "rir": 2}]}]
  }
}
```

## 本地验证

```sh
cd cloudflare
npm ci
npm test
npm run build
npm run check
cd ../frontend
TZ=UTC npm test -- --maxWorkers=4
```

只用合成 Passkey/账号/训练、真实 Miniflare/workerd/D1，测试不连接生产 DB。覆盖 SDK、OAuth/PKCE/精确 redirect/audience/UV/过期/刷新重用/撤销、用户隔离、Web UI 并发、幂等、回执故障回滚、坏分块、日期时区和重量语义。实际 ChatGPT 插件、浏览器 Passkey 同意、手机同步和免费 Worker CPU 配额仍需获准发布后验收。

## 发布与本人接入

此分支有自动发布，**未经批准不 push**。

1. 在明确获准后提交/推送代码、在现有 `opengym-personal` D1 应用 `0002_mcp_oauth.sql`，更新 Workers 构建固定 SHA。该迁移只增加认证和回执表，不清除旧账号或训练。回调未知时保持 MCP 关闭发布。
2. ChatGPT Plugins → ＋ → Add custom MCP server 中选择 OAuth/DCR，使用部署后的 `/mcp`。从管理页复制实际精确 redirect URI，配置成 `MCP_REDIRECT_URIS` JSON 数组；不猜测 OpenAI 回调路径，也不填写 token。
3. 本人批准 `MCP_ENABLED=true` 并部署。数据范围仅此账号的训练读取/新增/更正；无删除、账号、凭据或整份档案权限。无需新 Cloudflare token/OAuth、付费服务、R2 或 DNS 改动。
4. 本人用网站 Passkey 勾选同意，完成插件创建与 OAuth 连接。endpoint 上线不等于自动接入，助手不能代做凭据/授权。

注册有按 IP 的限流和 128 条客户端上限；已注册 client_id 不自动过期，到上限需所有者审查，不能绕过。真实健身数据不能用于测试或提交 Git。

参考：[官方 openGym MCP](https://github.com/DuarteSantos8/openGym/tree/e348fc17c42c7e9a211c5972e573ad3698190ee2/mcp)、[ChatGPT 自定义 MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server)、[OpenAI OAuth 要求](https://developers.openai.com/plugins/build/auth)、[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。
