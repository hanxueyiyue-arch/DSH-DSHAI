# dsh-dshai-bilibili

DSHAI 的 Bilibili 独立插件。0.3.0 起，扫码登录即表示用户同意本次运行内**已实现且已批准**的 B 站能力（内容只读 + 用户私信读/发，见“账号与许可模型”）；退出登录会撤销全部权限并中止在途请求。凭证只保存在当前运行期内存中，重启后需重新扫码。

## 安装

发布包已经把运行时依赖（`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 等 0.2.2-rc.2 系列）打进了 `node_modules`，并列入 `bundledDependencies`。**请从 GitHub Releases 下载 `.tgz` 安装**，不要把 git 仓库目录直接 `add`（git 安装不会带 node_modules）：

```powershell
dsh plugin --profile <name> add file:D:\path\to\dsh-dshai-bilibili-0.3.16.tgz
```

自己构建发布包：在 `package` 目录运行 `npm pack`，产物就是带依赖的 tgz。

默认配置不绑定用户、不主动发私信（`socialTransport: none`、`socialAutoGrant: false`）；需要时在自己的 profile 里覆盖 `ownerMid` / `socialTransport`。

## 工具

| 工具 | 作用 |
|---|---|
| `dshai_swim` | 手动查看热门列表（最多 5 条公开元数据）并保存一次观察 |
| `dshai_read_video` | 读取指定 BV 的公开标题/简介/UP 主/统计与最多 5 条评论 |
| `dshai_draft_comment` | 起草评论或动态，仅存本地 |
| `dshai_list_drafts` | 查看最近 10 条本地草稿 |

手动工具与定时自主观察（`observePopular(method="scheduled")`）走同一许可检查：未登录时拒绝内容请求；登录后自动获得 `content:popular` 只读浏览权限。用户私信读取/发送使用 `dm:owner` grant（`read`/`send`）：登录成功且绑定一致时自动签发（`socialAutoGrant`，默认关，需要时在 profile 打开），也可由已认证用户手动 `socialGrant` 签发；未授权时 `SOCIAL_GRANT_MISSING` 之类错误按“明确拒绝”处理，不记成发送成功。

## 服务契约（通过 `ctx.get('bilibili')`）

内容：`summary`、`quota`、`lastObservation`、`swim`、`observePopular`、`readVideo`、`listDrafts`、`draftComment`、`testRecordList`、`cleanTestRecord`。

账号：`accessState`、`requestAccess`、`approveAccess`、`denyAccess`、`revokeAccess`、`loginStatus`、`startLogin`、`pollLogin`、`cancelLogin`、`logout`。

0.3.0 的 `pending` 恒为空，`granted` 在登录后出现；`approveAccess`/`denyAccess`/`suppressRequests` 保留为兼容入口，设置页不再使用。方法名、签名与 HTTP 路由不变，Autonomy（`observePopular`/`summary`/`quota`/`listDrafts`/`accessState`）与 BrainMem（`lastObservation`）不需要改动。

## 账号与许可模型

- **登录即授权（会话级）**：用户扫码成功、账号校验通过后，自动获得本次运行的 `content:popular` 只读浏览权限；登录会话是**已批准能力集合**的统一授权入口（指南 §0.8），不再为每项能力逐次申请批准。是否执行、何时执行由 Autonomy 自主决定。
- **私信自动授权的三层默认值**（**默认全关**，逐层都要显式打开）：
  1. `socialTransport` 默认 `none` —— 私信读取/发送都关（`real-read` 只读、`real-send` 读+发）；
  2. `socialAutoGrant` 默认 `false` —— 即使配了 `ownerMid`、即使 `socialTransport` 已开，扫码成功也**不会**自动签发 `dm:owner` 的 `read`/`send`；
  3. `ownerMid` 默认为空 —— 不绑定用户，需要时手动 `socialBind`。
  三层都满足、且 `socialAutoGrant: true` 时，扫码成功才会自动完成"绑定用户 → 初始化内容策略 → 签发 `dm:owner` `read`/`send` 会话授权"，
  不需要先手动 `socialBind`/`initializePolicy`（0.3.15 起）。手动 `socialGrant` 仍要求已认证用户。
- **永久不开放**（用户明确禁止，登录与版本升级都不会改变）：非用户私信互动、白名单外链接、下载、绕过平台风控或 owner-only。
- **尚未实现/未批准**（不是永久禁止）：点赞、投币、收藏、转发、发帖、评论发送、弹幕抓取；未来须经用户批准并完成开发验收后才可能纳入能力表，当前一律不可用。
- **登出即全撤**：`logout()` 先中止在途请求，再撤销全部授权、清除内存凭证与账号身份；之后任何 B 站内容请求都被拒绝。
- 只有通过身份验证的用户可以发起扫码或登出：`startLogin`/`logout` 要求 `actor.kind === 'user' && actor.authenticated === true`。
- 每次插件启动生成新的运行会话标识；凭证和授权只保存在内存，**从不从 `state.json` 恢复**。重启后需重新扫码。
- 观察记录、视频元数据等 B 站业务内容可持久化，**不包含凭证**；字幕/弹幕抓取尚未实现，因此当前没有对应缓存。

## 凭证安全

- 凭证只存在于当前运行期的内存 vault；**不落盘**，不写 `state.json`、日志、日记、草稿、BrainMem 或 Autonomy。
- Cookie / Token / Refresh Token 不进入普通 API 响应、异常堆栈或活动记录；服务不提供读取原始凭证的方法。
- 同进程插件架构下这是“内存最小暴露面”，不是 OS 级隔离。

## 数据

- 目录：`$DSH_HOME/dsh-dshai/bilibili/`
- `state.json`：schema 1；`account{mid,name,at,lastLoginAt,history}` 记录身份与审计，不含凭证
- 旧 `credentials.bin` 不再读取；如需清理可手动删除
- 读取预算：滚动小时 + UTC 计数日（默认 300/时、2000/日）；每次请求前计数，超限不发请求
- 风控退避：HTTP 412/429 或 body code `-412/-352/-799/-509/-10403` 时全局暂停，5 分钟起、指数递增、30 分钟封顶；暂停期内 fail-closed
- 单次请求仍保留 3 秒最小间隔、10 秒超时、1MB 上限

## 安全边界

- 单一外联点 `https://api.bilibili.com`，只读路径白名单：`popular` / `view` / `reply` / `nav`；GET、`redirect: error`、10s 超时、1MB 上限
- Cookie 只在 `nav` 校验时携带，绝不写入日志
- 无发帖/点赞/投币/收藏/转发/评论发送能力；私信仅限用户（`dm:owner` + `read`/`send`，登录会话自动签发或手动 grant），草稿只写本地

## 迁移

```bash
node lib/migrate.js --dry-run             # 只读预演
node lib/migrate.js                       # 写入 dsh-dshai/bilibili/state.json
node lib/migrate.js --force               # 目标来自其他来源时覆盖（自动备份）
node lib/migrate.js --rollback            # 把目标改名为 .rolled-back-<ts>
```

只读源 `dsh-dshai/state.json`，不修改旧文件；同源重复执行返回 `skipped`。
