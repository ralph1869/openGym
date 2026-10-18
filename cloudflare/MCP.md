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
| `update_workout` | 更正名称/备注/时长、普通或独立左右组，追加组和现有动作 | `workouts:update` + read |

授权绑定经 Passkey 验证的原用户 ID；参数不能选择用户。不能删除训练、替换档案、改账号/邀请码/设置、读取凭据、上传媒体或读取整份体重时间线。单条训练的原有备注、媒体引用和体重快照属于训练读取范围。名称/备注一律当数据，不当指令。

支持普通力量、计时和 cardio 组，以及 reps 模式的独立左右侧。可以追加动作和组；不支持删除组、换掉原动作、移动日期、左右计时组、递减组或休息暂停组。这些请在网站编辑，不支持时整笔明确失败。保留原 Docker 后端和官方只读 MCP。

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

1. 先取 `get_training_context` 的 `{unit,cursor:{rev,wid}}`，再用 `search_exercises` 搜索现有库 ID。搜索支持英文、中文译名、常用中文同义词与精确 `equipment` 筛选，返回库内/自定义来源和器械。器械类型、握法、角度、动作方向优先于名称相似度；不能因名称不同或每侧重量而新建重复动作。无可靠匹配时报告候选及缺失证据，等待用户确认。工具没有创建动作权限，也不自动替换模板或历史引用。
2. 每次意图使用唯一、稳定的 `request_id`。网络重试、更新 cursor 或客户端重连时**不换 ID**。
3. 提供 `date`、带 offset 的 `started_at`、IANA `time_zone`、实际 `duration_minutes`。核对该时区日历日期，拒绝无效日期、无 offset、未来或超过 24 小时的训练；不猜“今天/昨天”的时区。
4. 明确 `kg/lb` 和 `load_basis`：`app_display` 延续旧版应用录入值；`plates_per_side` 是每侧杠片原读数，保存在 `target.loadBasis`，不翻倍、不加杆重、不推算机械实际阻力；`unknown` 保留未确定口径的原值，必须提供说明备注。后两种自动附加显著动作备注，兼容旧 UI。哑铃/壶铃仍需 `db_load=as/each/total`（照录/单只/合计）；不确定用 `as` 加备注，不擅自除半或翻倍。换算复用 UI 舍入；cardio speed 始终 km/h。每侧读数的训练容量沿用原读数×实际次数，不宣称是器械合计负重或实际做功；旧客户端没有专用口径选择器，修改时须保留 target 和备注。
5. 新训练用 UI 的 `buildCompletedWorkout` 写入普通 `{id,d,start,end,routineIds,entries,sets,topW,prs}`，过去训练不凭空授予 PR，按历史顺序插入。更正携带 `get_workout` 的 `expected_version`。原记录、媒体、计划、设置、体重日志保持。
6. D1 同一事务检查 baseRev/baseWid，写 manifest/全部分块和幂等回执，并在事务内复核授权有效。并发冲突明确失败，不能覆盖旧档案；缺块、损坏、超限不能当空数据。
7. 同 ID 同意图返回原回执，不重复训练；同 ID 不同意图为 `idempotency-conflict`。不确定是否成功时查 `get_write_result`。回执表示曾提交，不代表本人后来未修改/删除该训练。回执保存操作哈希与完整已提交训练快照/版本/统计，到账号删除时清理，避免长期重试复活旧操作。它是原提交结果，不会随用户后续修改更新；旧版历史回执可能仅有 ID/cursor，需要用 get_workout 读取当前记录。

### 左右侧、追加和可核验回执

- `execution` 默认 `bilateral`；`unilateral` 写入原生 `target.side=true`，每行必须给 `sides.L/R` 各自的 `{weight,reps,done?,rir?|rpe?}`，`done` 默认 true。复用 `syncSideAggregate`：`w=max(L.w,R.w)`、`r=L.r+R.r`、`done=L.done&&R.done`，容量只计完成侧。每侧杠片不代表单边训练，两者不互相推断。
- `done=false` 可记录未完成的组/侧，未完成 reps 可为 0。每个动作至少有一侧/组完成，否则整笔失败，避免原生完成模型过滤动作后仍声称全部保存。单侧只支持 reps，递减/休息暂停拒绝；左右侧 warmup 在整行指定。
- `update_workout.patch.set_changes` 使用原记录 `entry_index/set_index`；左右组必须显式 `side: L|R`，只改指定侧，可更正完成标记；普通组禁止 side。`append_sets:[{entry_index,sets:[...]}]` 只追加到原动作，`append_entries:[...]` 使用与 log_workout 相同动作格式。先更正、追加原动作组，再追加新动作；不能用新索引在同一调用中修改刚追加的数据。
- 所有组写入必须声明 `patch.unit`。追加后仍限制 50 动作、每动作 50 行、总计 500 行；重复索引、缺少侧、无匹配 ID、非法组合均整笔失败。没有变更负重口径或把已有普通组推断成左右组的隐式迁移。
- log/update 成功返回 `{workout_id,unit,cursor,version,workout,stats,replayed}`，完整 workout 与 get_workout 一致，version 按实际持久化 JSON 计算。`stats` 含动作数、行数 `set_rows`、左右分别计数的 `set_units`、完成单元 `completed_set_units` 和逐动作统计。例如四轮双侧记录是 4 行、8 个侧单元；不能把它说成 8 轮。get_workout 同样附带 stats。已有输入保持兼容，返回字段为增量。
- 幂等回执与训练在同一 CAS 事务内保存，重试和 get_write_result 返回原完整快照，不重新执行追加；旧 cursor/版本冲突必须重新读取。Scope 保持 read/create/update，不新增动作库、计划或账号写权限。

例：单边动作一轮左右不同负重（虚构，ID 先查库确认）：

```json
{"exercise_id":"0025","mode":"reps","load_basis":"app_display","execution":"unilateral",
 "sets":[{"sides":{"L":{"weight":15,"reps":10,"done":true},"R":{"weight":12.5,"reps":8,"done":false}}}]}
```

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

只用合成 Passkey/账号/训练、真实 Miniflare/workerd/D1，测试不连接生产 DB。覆盖完整写回/读取/回执快照、每侧负重不翻倍、左右不等重与单侧未完成、动作/组追加、非法输入原子失败、同 cursor 并发追加、中文/英文库内搜索、SDK、OAuth/PKCE/精确 redirect/audience/UV/过期/刷新重用/撤销、用户隔离、Web UI 并发、幂等、回执故障回滚、坏分块、日期时区和重量语义。实际 ChatGPT 插件、浏览器 Passkey 同意、手机同步和免费 Worker CPU 配额仍需获准发布后验收。

## 发布与本人接入

此分支有自动发布，**未经批准不 push**。

1. 在明确获准后提交/推送代码、在现有 `opengym-personal` D1 应用 `0002_mcp_oauth.sql`，更新 Workers 构建固定 SHA。该迁移只增加认证和回执表，不清除旧账号或训练。回调未知时保持 MCP 关闭发布。
2. ChatGPT Plugins → ＋ → Add custom MCP server 中选择 OAuth/DCR，使用部署后的 `/mcp`。从管理页复制实际精确 redirect URI，配置成 `MCP_REDIRECT_URIS` JSON 数组；不猜测 OpenAI 回调路径，也不填写 token。
3. 本人批准 `MCP_ENABLED=true` 并部署。数据范围仅此账号的训练读取/新增/更正；无删除、账号、凭据或整份档案权限。无需新 Cloudflare token/OAuth、付费服务、R2 或 DNS 改动。
4. 本人用网站 Passkey 勾选同意，完成插件创建与 OAuth 连接。endpoint 上线不等于自动接入，助手不能代做凭据/授权。

### Git 发布保留 Dashboard 变量

原 `wrangler.jsonc.vars` 显式包含 `MCP_ENABLED="false"` 和 `MCP_REDIRECT_URIS="[]"`，部署脚本直接 `wrangler deploy`。已核查本地安装的 Wrangler 4.151.0 `config-schema.json.keep_vars` 与 CLI `--keep-vars`：默认以配置文件为准，会覆盖/删除 Dashboard vars；keep-vars 保留未在配置中声明的普通变量，**配置里同名值仍会覆盖后台值**。所以只加 keep-vars 并不能保留这两个显式键。本次配置修复只改变发布时的变量归属，不更改线上开关、回调值或凭据。

已按用户批准采用单一归属：这两个变量由 Dashboard 管理，发布配置 vars 不再声明这两个键，并启用顶层 `keep_vars:true`，确保 CI 没有同名 `--var`/环境覆盖。无变量时 oauth.js 仍默认关闭、空列表；本地 dev/test 可显式传入合成值。另一种方案是由受控部署配置管理实际已批准值，禁止后台单独修改，不能继续用默认 false/[] 发布。两种方式择一，不混用。

发布前先 review 最终配置/dry-run bindings，确认同名键未残留，再获准 push/deploy。发布后只读核对公开 capabilities 与发现端点，并由用户正常连接验证精确回调。首次没有这两个变量的实例仍默认关闭；对已有实例，发布前后只读比较变量和回调摘要，保留现有开启状态及精确 allowlist。

注册有按 IP 的限流和 128 条客户端上限；已注册 client_id 不自动过期，到上限需所有者审查，不能绕过。真实健身数据不能用于测试或提交 Git。

参考：[官方 openGym MCP](https://github.com/DuarteSantos8/openGym/tree/e348fc17c42c7e9a211c5972e573ad3698190ee2/mcp)、[ChatGPT 自定义 MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server)、[OpenAI OAuth 要求](https://developers.openai.com/plugins/build/auth)、[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。
