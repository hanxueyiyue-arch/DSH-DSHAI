# dsh-dshai-budget 0.5.2

DSHAI 的独立预算插件：为 DSH **自主发起、已接入预算控制链路**的付费活动
提供每日**金额硬限额**，Token 只做统计与提示；可选把当天未用完的金额结转到以后几天，
并允许 DSHAI 在金额不足时**申请**当日临时补额、由用户在设置页批准。

## 安装（可选）

本包默认 **不启用**（`cordis.patch.yml` 里 `disabled: true`）。安装后不会自动运行；启用前必须先配置
`<DSH_HOME>/dsh-dshai/budget/config.json` 的 `limits` 与 `prices`，否则 cognition 的付费调用会被预算闸门阻断。
不打算配置的话，别装这个包——cognition 没有 budget 也能正常运行。

- 预算只管理自主活动；用户主动发起的开发/测试/对话不计入，也不受此拦截。
- **金额是唯一硬限额**；Token 仍会预留、统计、在超出估算时告警，但不会单独阻断付费调用。
- 未完成用户配置时，付费自主调用默认禁止。
- 硬限额只能由持有宿主注入私有 trust 的真实用户入口修改；插件自身绝不自增额度。

## 正式状态（2026-11-07）

- 正式版本 **0.5.1** 已部署；安装/重启/账本基础验收 PASS，GUI 五项人工检查 PASS。
- 金额硬限额与 Token 软告警已生效；历史 Guard 已解除；4 条历史 uncertain 已按授权保守核销。
- 储蓄已由用户在设置页开启（`retainDays:7`，尚无批次）；`topups` 无记录；
  modelDecision、自动活动、长期自主通信关闭。
- 真实 Provider 付费闭环、真实补额申请/批准、储蓄真实跨日结转**尚未测试**，不得标为已闭环。
- 部署与证据：`reports/V0.5.1-DEPLOYMENT-REPORT.md`。

## 储蓄结转（0.5.0 新增）

- 每天的基础额度 = `limits.cost.micros`。当天结束时若有未用完的金额，形成一笔**批次（lot）**：
  记录来源日、金额、剩余、被预留占用、到期日。
- 消费先扣当天基础额度，基础额度用完后才动储蓄；多笔批次按**最早到期优先**分配，
  每 1 微元只能被使用一次（结算按实际金额扣减，预留只做占用）。
- 保留天数由用户设置，默认 7，范围 1–30。来源日的次日算第 1 天，可用 `retainDays` 天，
  第 `retainDays + 1` 天失效；未用完的部分到期即作废，不会复活。
- **只对“DSH 运行过”的日期结转**：当天有日桶或活动记录才算运行过（运行但零消费也会整日结转）；
  DSH 全天未运行的日期不产生批次，也不补发。
- 储蓄默认关闭；关闭后不再新增批次，已有批次保留在文件中但不计入可用余额。
- 批次存放在独立文件 `savings.json`，旧版插件重新保存 `state.json` 不会破坏已有批次。

## 临时补额（0.5.1 新增）

- DSHAI 只在金额确实不足时**申请**：Budget 是唯一账本，Autonomy 用现有 `quote()` 与
  `status()` 算出缺口后调用 `requestTopUp()`，不产生额外模型调用，也不读取凭证。
- 申请进入 `state.json` 的 `topups`，状态为 `pending`；同一天同一请求键幂等，
  每日 pending 上限 5 条（技术防洪，不是行为限制）。
- **只有宿主认证的真实用户**能在 Budget 设置页批准或拒绝；批准时可修改本次金额。
  拒绝、撤销、过期都会写审计；DSHAI 没有批准、修改永久限额或绕过 Budget 的权限。
- 临时额度**只在当天有效**，按北京时间（UTC+8）计费日到期，跨日自动 `expired`；
  不修改 `config.json` 的每日基础额度，也不进入储蓄、不产生批次。
- 消费顺序固定为 **基础额度 → 当日临时额度 → 储蓄**；临时额度先到期，所以先于储蓄使用。
- 撤销只针对未使用部分；若仍有进行中的预留占用该临时额度，撤销会被拒绝（`TOPUP_IN_USE`），
  以避免把已承诺的额度抽走。
- 重启、跨日、重复批准、并发预留、撤销都不会重复增加额度：批准只改记录状态，
  可用额每次由 `approved - used - reserved` 现算。

## 数据

```
$DSH_HOME/dsh-dshai/budget/
├─ state.json        日桶、预留、审计、guard、临时补额记录（schema 2，人民币微元）
├─ savings.json      储蓄批次与日结算记录（schema 1；0.4.x 不读取也不改写）
├─ config.json       用户配置（插件只读，configure 写入前会备份）
├─ backups/          state 备份、旧账本迁移备份、损坏账本证据（corrupt-<hash>.json）
└─ config-backups/   config 备份
```

- 设置页与 API 走同一条 `/dsh-dshai/budget/api/*` 路由；所有特权动作都在服务端再次校验
  trust 与 CSRF，客户端状态不能替代授权。
- `topups` 是 `state.json` 内的对象；0.5.0 读取 0.5.1 账本时会忽略该字段，
  重新保存后临时补额记录会丢失（回退前应先导出或停止使用补额）。

不改动 BrainMem / Autonomy / Bilibili 的 state。

## 安全边界

- guard 阻断表示“此前已有调用超出预留金额”，默认拒绝所有新付费调用；解除必须由用户核查后
  经 `clearGuard()` 显式清除并写审计，重启不会自动清除。
- `authorizeOnce()` 可创建**一次**例外：只匹配指定 `provider/model`（可绑定 `taskId`/`caller`）、
  金额上限与有效期；命中一次即置 `used`，不解除 guard，不绕过每日额度。
- 过期例外在预留尝试时标记 `expired` 并写审计；`status().exceptions` 只列仍可用的例外。
- **账本损坏 fail-closed**：`state.json` 或 `savings.json` 无法读取/解析时，不给新预留、
  不覆盖原文件、不自动创建空账本；损坏原文复制到 `backups/corrupt-<hash>.json`，
  `status()` 标记 `ledger.health='corrupt'`。
- **旧版账本不猜测迁移**：v1 美元账本标记 `legacy` 并阻断付费；只有在确认无任何消费/占用时，
  才能由可信用户入口调用 `migrateLegacy()` 完成受控迁移。
- **异常用量不零结算**：负数、NaN、Infinity、字符串、小数或全缺失的用量一律拒绝；
  拿不到可信用量时预留保持 pending，超 TTL 后 `recover()` 标记 uncertain（仍占额度）。
- **uncertain 对账**（0.5.0）：`reconcile()` 支持四种模式——按实际用量结算（`settle`）、
  接受最坏金额入账（`accept`）、可信零消费释放（`release-zero`）、
  用户接受风险后人工释放（`release-risk`，必须显式 `acceptRisk: true`）。
  只有 uncertain 可对账，pending 不能越过 TTL 直接人工核销。
  日桶被 prune 时，仍被 pending/uncertain 引用的日期不会删除；若日桶因历史版本或人工损坏已缺失，
  `reconcile()` 返回 `DAY_OUT_OF_RETENTION`，不会为缺失日期新建一个“复活”的空日桶。
- **计费日由时钟决定**：生产环境拒绝调用方传入 `at`；只有测试可开启 `clockOverrides`。
- **Token 估算更保守**（0.5.0）：`quote()` 在输入、缓存读取与输出之和上再加
  `max(512, 15%)` 的缓冲，避免历史那种“预留 9,964、实际 18,098”的低估。
  即使实际 Token 超过预留，也只写审计告警，不再触发 guard；只有实际**金额**超过预留才触发 guard。

## 配置（config.json）

```json
{
  "version": 1,
  "timeZone": "Asia/Shanghai",
  "limits": {
    "tokens": 200000,
    "cost": { "micros": 2000000, "currency": "CNY" }
  },
  "holidays": ["2026-10-01", "2026-10-02"],
  "reservationTtlMinutes": 30,
  "prices": {},
  "savings": { "enabled": true, "retainDays": 7 },
  "setBy": "user",
  "setAt": "2026-10-30T00:00:00.000Z"
}
```

- `limits.tokens` 与 `limits.cost.micros` 必须同时为正整数；缺一即视为未配置（付费禁止）。
  Token 上限用于统计与提示，不再是阻断依据。
- `savings.enabled` 缺省 `false`；`retainDays` 必须是 1–30 的整数，缺省 7。
- 金额单位为人民币微元（1e-6 CNY），币种固定 `CNY`。
- `prices` 可覆盖默认价格；每项必须带 `source` 与 `effectiveFrom`，`peak`/`offPeak` 必须显式
  给出 `cacheRead`、`cacheMiss`、`output`；字段缺失或币种非 `CNY` 的条目会被拒绝。
- Provider 路由别名 `deepseek-account`、`deepseek-official` 直接引用官方 `deepseek` 价格表；
  未知 provider/model 一律 `UNKNOWN_PRICE` 并拒绝付费调用。
- `holidays` 用于把中国法定节假日排除在高峰时段之外。

## 服务接口（`ctx.get('budget')`）

| 方法 | 说明 |
| --- | --- |
| `status()` | 今日已用/预留/剩余（基础 + 临时补额 + 储蓄）、阻断原因、ledger 健康度、guard、warnings、uncertain、储蓄批次、临时补额视图；始终可调用 |
| `quote({provider,model,estimatedInputTokens,maxOutputTokens})` | 按高峰价 + 最大输出 + 15%/512 Token 缓冲估算最坏用量 |
| `reserve({runId,model,...})` | 调用前原子占位；金额不足、账本损坏、guard 阻断即拒绝；Token 不足仅告警 |
| `settle({runId,usage})` | 用真实用量结算，幂等；未知价格按最坏情况入账；异常用量拒绝 |
| `release({runId,reason,actor,trust})` | 释放未产生用量的预留；uncertain 需可信用户入口 |
| `recover()` | 把超时未结算的预留标记为 uncertain（不归零），并回收孤儿储蓄占用 |
| `configure({actor,trust,limits,...,savings})` | 仅持有宿主注入私有 trust 的真实用户入口可调用 |
| `clearGuard({actor,trust,reason})` | 用户核查后解除 guard，写 `budget-guard-cleared` 审计 |
| `reconcile({actor,trust,runId,mode,usage,acceptRisk})` | uncertain 对账：`settle`/`accept`/`release-zero`/`release-risk` |
| `savings()` | 只读储蓄视图（批次、到期日、可用额、最近日结算） |
| `requestTopUp({caller,taskId,reason,amountMicros,requestKey})` | DSHAI 申请当日临时补额；不要求 trust，同键幂等，pending 上限 5 |
| `topUps({dayKey,limit})` | 只读临时补额列表；旧日 pending/approved 显示为 `expired` |
| `decideTopUp({id,decision,amountMicros,actor,trust})` | 可信用户批准/拒绝；批准金额可调整 |
| `revokeTopUp({id,reason,actor,trust})` | 撤销未使用的临时额度；有进行中占用时拒绝 |
| `migrateLegacy({actor,trust})` | 仅当 v1 美元账本无任何消费时受控迁移为 v2 |
| `restoreBackup({file,actor,trust})` | 从 backups/ 中的已验证 v2 备份恢复 |
| `reservations()` | 只读预留列表（含 `savingsHolds`、`baseMicros`） |
| `authorizeOnce({...})` | 单次例外：guard 阻断期间额外放行一次匹配的付费预留；不解除 guard |
| `revokeException({actor,trust,id})` | 撤销尚未使用的单次例外 |
| `withPaidCall(options, run)` | 调用方封装：预留 → 执行 → 结算/保留；预留失败时 `run` 不会被调用 |

## 调用方接入（推荐）

```js
const budget = ctx.get('budget')
if (budget === null) return

const { ok, result, settled } = await budget.withPaidCall(
  {
    caller: 'autonomy',
    taskId: cycleId,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    estimatedInputTokens,
    maxOutputTokens,
    usageFrom: (out) => out?.usage,
    onError: 'keep-pending',
  },
  () => callModelOnce(),
)
```

- 调用前按高峰价 + 最大输出 + 缓冲占位；未配置/金额不足/未知模型直接抛错，`run` 不会执行。
- 调用后按 `usage`（`inputTokens/cacheReadTokens/cacheWriteTokens/outputTokens`）结算，幂等。
- 调用失败时错误上带 `usage` 会先结算再抛；默认保留 pending，只有调用方以
  `requestStarted === false` 证明请求未发出时才释放。
- 拿不到用量不会按 0 结算；超 TTL 后变 uncertain，可用 `reconcile` 处理。
- 一个 `runId` 只能对应一次调用；重试请生成新的 `runId`。

## 与 Autonomy 的兼容（推荐 0.3.16）

- `status()`、`quote()`、`withPaidCall()` 的签名与关键返回形状保持兼容：
  `used`/`reserved`/`remaining` 仍是 `{ tokens, cost: { micros, currency } }`，
  并新增 `remaining.base`、`remaining.savings`、`warnings`、`savings`。
- 0.5.0 的 `status()` 增加 `enforcement: { tokens: 'advisory', cost: 'hard' }`。
  Autonomy 0.3.15 识别该字段后，不再用 `quote().tokens` 与 `remaining.tokens` 自行判
  `TOKEN_LIMIT`；未声明该字段的旧 Budget 仍按双硬限额处理，行为不变。
- 只升级 Budget、不升级 Autonomy 时，0.3.14 仍会按旧逻辑提前判 `TOKEN_LIMIT`（Token 已用尽时）。
  正式部署应把 Autonomy 0.3.15 与 Budget 0.5.0 一起升级。
- 累计 Token 超过每日限额但金额充足时，Budget 仍放行；Token 超额只出现在 `warnings`
  与审计 `budget-token-estimate-low` 中。
- Autonomy 0.3.16 在金额不足（`COST_LIMIT`）时会调用 `requestTopUp()`，只申请缺口、
  不发起模型调用、不修改额度；申请失败只写日志，不影响原错误返回。旧 Budget 没有
  `requestTopUp` 时安静跳过。

## 设置页（0.5.1）

- 不再依赖 `window.prompt` / `window.confirm` / `window.alert`：Electron 渲染进程不支持这些
  原生对话框，旧版点击“解除 Guard”会直接无反应。所有需要确认的动作改为页内输入框、
  确认/取消按钮与结果提示。
- Guard 解除：填写理由（≥4 字）后确认；uncertain 对账：按实际用量输入四项、接受最坏、
  零消费释放、接受风险释放都需二次确认，`>24h` 的条目默认折叠。
- 单次例外与临时补额撤销也使用页内确认；临时补额批准可先调整金额再提交。
- 服务端仍要求 `trust` 与 `x-dsh-dshai-csrf`；设置页只是可信用户的输入入口。
- 交互测试用 jsdom + React 19 `act()` 做真实挂载与点击/输入（`tests/client-ui.test.mjs`），
  不只验证 HTTP 路由。

## 回退

- 0.4.1 能读取 0.5.0 的 `state.json`（未知字段被忽略），也能继续拒绝超额金额；
  但它的 `readReservation` 白名单会丢掉 `savingsHolds`/`baseMicros`，重新保存后新字段消失。
- `savings.json` 独立存放，0.4.1 不读取也不改写；回到 0.5.0 后 `reconcileHolds()` 会回收孤儿占用，
  不会永久卡死（见 `tests/savings.test.mjs` 的旧版重存测试）。
- 回退到 0.4.1 会重新把 Token 当硬限额：若当天 Token 已接近上限，可能出现新的 `TOKEN_LIMIT` 阻断。
  回退前应确认 Token 余量充足，或先用 0.5.0 关闭储蓄并观察一天。
- 回退 Autonomy 0.3.15 到 0.3.14 同样会恢复“Token 用尽即拦截”的旧行为；两者应成对回退。
- `savings.json` 损坏时 Budget 0.5.0 fail-closed（`ledger.health='corrupt'`，禁止付费）；
  删除或从 `backups/` 恢复该文件后再启动，不会影响 `state.json` 中的已结算记录。
- 0.5.1 的 `topups` 是 `state.json` 新字段：0.5.0/0.4.x 读取时会忽略，重新保存后临时补额
  记录丢失；回退前应停止申请/批准并使用完或撤销当日额度。`topupMicros` 同理会被旧版
  白名单丢弃，回退后该部分消费会计入基础/储蓄，需人工核对当天账目。
- 回退 Autonomy 0.3.16 到 0.3.15 只是失去“金额不足时自动申请”，不影响预算执行；
  Budget 0.5.1 仍可单独运行。

## 计费口径

- 价格按官方文档（人民币/百万 Token）：高峰为北京时间周一至周五 09:00–12:00、14:00–18:00
  （扣除中国法定节假日），其余为低谷；空闲价为高峰一半。
- 金额 = 未命中缓存输入 × cacheMiss + 缓存读取 × cacheRead + 输出 × output（+ 缓存写入，当前为 0），
  单位为**人民币微元**。
- 不接收 totalTokens，避免把已包含在总量中的缓存/推理 Token 重复计算。

## 边界

- 不负责 B站登录、视频理解、记忆算法或 GUI；GUI 仅是本地设置页。
- 不宣称控制未接入本服务的调用；只覆盖经 `withPaidCall`/预留执行的调用，
  不能保证 Provider 侧绝不超过已预留的最坏值。
- 0.5.1 只在隔离工作区开发与测试，未部署到正式 profile；正式账本、配置、Guard 与
  uncertain 均未改动。
- 临时补额只解决“当天额度不足”的申请与审批，不改变永久每日预算；0.5.1 仍不做自动
  长期通信、自动批准或绕过 Budget 的通道。
