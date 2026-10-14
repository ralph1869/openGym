# openGym Cloudflare 个人版

在原 openGym 1.4.1 前端旁新增 Workers + Static Assets + D1。原 `api/`、Docker、训练逻辑和数据导入导出保留。适用于一个人的浏览器/PWA、多设备使用同一个已同步的 Passkey。

## 提供的能力

- 一个账号、邀请码注册、要求用户验证的 Passkey 登录。
- D1 持久保存公开 Passkey 材料、限时挑战、哈希后的会话 token 和训练状态。Passkey 私钥始终在设备/密码管理器中。
- `GET/PUT /api/data`、`GET /api/data/rev` 兼容原前端的 `baseRev`、`baseWid`、`stamped`、同步戳、reset 和写入祖先记录。
- 原训练界面、计划、历史、统计、JSON 导入导出和设备间状态同步；正在进行的训练留在设备本地。
- 6554 张原始 180 px 动作图片和 6554 段动画，随静态资源部署。

本版暂不实现 AI 后台任务、服务器推送、媒体上传、多用户管理、Passkey 增删、设备配对和移动端 Bearer-token 配对。API 明确返回 `501 unsupported`；界面和设置搜索隐藏对应动作。服务端关闭后仍保留应用内计时器。没有密码登录或公开 guest 入口。

## 数据保护

状态上限为 5 MiB。UTF-8 安全地分块，每行最大约 786432 字节，低于 D1 的 2 MB 行限制；最多约 20 个数据写入语句，低于免费版每次请求的 50 查询上限。

一个 manifest 保存修订号、随机写入 id、分块数量、字节数和 SHA-256。读取使用一次 join 的一致快照，并验证分块顺序、数量、大小、摘要及 JSON 元数据。缺块、损坏或无法读取返回 `503 state-unreadable`；不能被当成新账号或空数据，写入也会被拒绝。

更新在 D1 `batch()` 事务内部按当前 rev/wid 比较更新 manifest。删除旧块和写入新块都要求新随机 wid 已取得 manifest；竞争失败的请求不会改动任何块，并返回带最新状态的 `409`。任何 SQL 失败会回滚整个事务。原 `api/sync-stamps.js` 负责同步戳，避免两套规则漂移。

注册受到数据库单账号约束，竞争注册最多成功一次。会话存随机 256-bit token 的 SHA-256，HTTPS 使用 `__Host-`、Secure、HttpOnly、SameSite=Lax cookie；注销会撤销会话，全部注销提升账号的会话版本。所有写请求要求 JSON，并检查 Origin / Sec-Fetch-Site；Passkey 的 challenge、origin、RP ID、用户验证和签名都验证。认证限流和一次性挑战持久化在 D1。日志不记录请求体、健康状态、凭据或 SQL 绑定。

## 本地构建与验证

需要 Node 24。所有依赖使用锁文件：

```sh
npm ci --prefix frontend
npm ci --prefix cloudflare
cd cloudflare
npm run build
npm test
npm run check
```

`npm test` 运行真实 Miniflare/workerd + D1 测试；静态测试要求先 build。覆盖认证、注册竞争、过期会话/挑战、重放、CSRF、限流、Unicode 分块、大状态、并发冲突、事务故障回滚、损坏拒绝、所有素材字节保真和真实静态路由。`npm run check` 是 Wrangler dry-run，不部署。

原前端完整测试：`cd frontend && TZ=UTC npm test -- --maxWorkers=4`。UTC 与原 Linux CI 一致，避免主机时区改变原固定日期测试的断言。

本地 D1 schema：`npx wrangler d1 migrations apply opengym-personal --local`。开发时用 `.dev.vars` 设置 `ORIGIN=http://localhost:8787`、`RP_ID=localhost`；仅本地测试需要设置一个测试用邀请码哈希。不要把这些值用作线上默认邀请码。

## 免费部署

1. 在自己的 Cloudflare 账户创建独立的 `opengym-personal` D1。把 UUID 填入 `wrangler.jsonc`；它不是密钥。只对这个新数据库应用 `migrations/0001_initial.sql`。
2. 配置 `ORIGIN` 为完整 HTTPS 地址，`RP_ID` 为同一 hostname。本实例使用 `https://gym.ralph.run` 和 `gym.ralph.run`。API 只接受配置的 origin；同一 Worker 的其他域名会返回 `403 wrong-origin`，避免混用账号、Cookie 和 Passkey。新实例也可在首次创建账号前选择默认 `workers.dev` 地址。
3. 在已连接 GitHub 的 Workers 构建流程使用本仓库适配分支，构建命令为 `npm ci --prefix frontend && npm ci --prefix cloudflare && npm --prefix cloudflare run build`；从仓库根目录执行部署命令 `npm --prefix cloudflare run deploy`。或在已有所需授权的 CLI 中执行 `cd cloudflare && npm run deploy`。
4. 使用既有权限即可部署时不新增授权。若需要新 token/OAuth，须由账户所有者批准：所需资源为该账户的 Worker 脚本/静态资源部署及 D1；不需要 R2、AI、付费服务或无关 DNS 权限。不要把 token 放进仓库、聊天或静态资源。

静态资源约 13200 个，单文件小于 2 MiB。无需 R2 或付费套餐。仍受免费版 CPU、请求数、D1 行读写和存储配额约束；本地运行不能替代真实免费平台的大状态性能验收。

## 首次账号初始化（由所有者完成）

未设置 `REGISTRATION_TOKEN_SHA256` 时注册关闭。实例不能公开无保护注册，也没有默认邀请码。

所有者在密码管理器中选择高熵邀请码（建议 32 个随机字母/数字；界面最多 40 字符），将去除首尾空白并转成大写后的 SHA-256 十六进制摘要设置为 Worker secret `REGISTRATION_TOKEN_SHA256`。原邀请码保留在自己的密码管理器，不发送给助手。创建账号时输入它，并在设备上确认 Passkey。账号创建成功后数据库约束会永久关闭第二个账号的注册；该哈希可以由所有者随后移除。

选择能跨设备同步的 Passkey（iCloud Keychain / Google Password Manager 等），手机登录同一个账号。需要本人验收手机生物识别/Passkey、PWA 离线重连和跨设备同步。若以后更换 hostname，原 Passkey 不能直接迁移到新 RP ID；不要随意改域名。

修改控制台中的域名变量时也应同步此配置文件，并更新 Workers 构建命令固定的 Git 提交。注册仍需既有 `REGISTRATION_TOKEN_SHA256` 密钥；部署不会生成或替换邀请码。

## 许可与源码

本改造继续使用 AGPL-3.0-or-later。`LICENSE`、根 `NOTICE.md` 及动作素材自己的 `NOTICE.md` 都随部署发布，登录页和设置中提供此 fork 的修改后源码链接。

动作媒体不属于 AGPL。这里只保留原 openGym 的未修改 180 px 媒体，供非商业个人 fork 使用；不能拆成独立素材包、移作其他产品、商业用途或 AI 输入。完整限制以根 `NOTICE.md` 和 `catalogue/media/NOTICE.md` 为准。

## 已知上游测试边界

基准 `e348fc17c42c7e9a211c5972e573ad3698190ee2` 的原 Node API 测试在本任务日期有 10 个失败（596 项中 586 项通过），涉及未迁移的 AI/coach fixture 和 payload。已经在独立、未修改的基准 worktree 重现同样的 10 个失败。不能把原 API 全套称为通过；本改造不修复或迁移这些模块。
