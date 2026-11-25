# dsh-dshai-cognition

DSHAI 的“认知内核”：一个自我、一个状态根、一个事件入口。
目标不是把 BrainMem 与 Autonomy 两个包拼在一起，而是按职责重建（见
`docs/cognition/ARCHITECTURE.md`）。

**当前状态：0.3.0（记忆连续性 P0–P3）；S3.10 习惯快路径 + 日期解析；S5 预演 + P3/P6 + A1 只读浏览已做（见 `docs/acceptance/`）。S2 的入口/状态根/只读 API 可用；最小循环（默认关闭）
能走“记安排 → 到点追问 → 回执落账 → 被更正后改口”。模型可参与措辞（默认关闭）；
send/invoke/wake 都通过总线适配器执行并回填 `tool-result`，内核本身没有定时器。
记忆会按强度变糊，维护事件会把低价值痕迹移入可恢复的归档；主动关心的阈值会随结果
缓慢移动；同一情境反复成功后，到点追问不再调用审议；最近几轮对话与她的原话会进入
下一次决策，经验会在后台抽取成候选记忆，高风险整理只给建议。**
`apply()` 只注册 `ctx.get('cognition')`；不起定时器、不联网、不发送。

## 状态根（单一）

```text
<stateRoot>/
  self.json        # 身份、宪法、特质、习惯、结果环形日志
  memory.json      # 活跃记忆、日记索引、活动尾部、事件去重环
  behavior.json    # 精力/心情、兴趣、作息
  experience/      # 经历 jsonl（按月）
  diary/           # 日记正文，一文件一篇
  archive/         # 归档记忆 jsonl（可恢复）
  activity/        # 操作流水 jsonl（按月）
  trace/           # 循环阶段摘要 jsonl（按 eventId 定位，不含记忆正文）
  run.lock         # pid + 启动时间 + 实例 token
```

宿主应显式传 `stateRoot`。未传时使用 `~/.dsh/dsh-dshai/cognition`；
测试传临时目录。新内核不读、不删 `dsh-dshai/brainmem` 与
`dsh-dshai/autonomy`。

## 服务 API（S2 + S3.5）

| 方法 | 说明 |
| --- | --- |
| `onEvent(event)` | 唯一入口；校验、按 `event.id` 幂等、有界队列 32、立即回执 |
| `status()` | 只读摘要：身份、计数、affect、队列 |
| `identity()` / `setIdentity()` | 读 / 写身份（`setIdentity` 只给宿主 UI） |
| `memories({limit, offset, kind, layer, includeArchived})` | 只读列表 |
| `diaryList()` / `diaryRead(id)` | 只读日记 |
| `activity({limit})` | 只读操作流水 |
| `trace({eventId?, limit?})` | 只读循环阶段摘要（验收定位用） |
| `idle()` / `dispose()` | 等待队列排空 / 释放状态根锁（测试与宿主任期用） |

默认 `onEvent` 只把事件写进 `experience/` 与 `activity/` 并更新去重环，
**不跑七阶段、不产生意图、不写记忆**。启用 `cognition.loop: true` 后，事件处理末尾
会跑最小循环：用户消息先经规则编码（带时间的安排、偏好、对旧记忆的更正），再产生
确定性 `send` 意图（经 `onIntent` 交出）；`tick` 到点会对 `followUpAt` 过期的安排
发起一次追问；带 `correlationId` 的 `tool-result` 回填一条 `action`/`observation`
记忆。act 仍不发送；发送由总线负责。

规则编码能识别的时间：今天/今晚/明天/明晚/后天/大后天、周三/星期三/礼拜三、
下周三、本周三、11月20日、2026年11月20日、20号/20日、下个月3号。只精确到日
（`precision:'day'`），提醒固定在当天 20:00 本地时间；无年份取下一个未过日期，
非法日期不写日期。问句（如“之前说的体检怎么样了？”）不会被记成新事实。

### 模型决策（默认关闭）

传入 `model` 时，`decide` 改为“模型优先、确定性兜底”：模型输出必须是
`{action, text, reason, confidence, memoryIds}`，只能引用本次召回里的 id；非法输出、
超时（默认 15s）、预算 `blocked` 都会回落到确定性策略，并记一条
`decision-fallback` 活动。

```js
import { createHostModel } from './lib/decide/host-model.js';

const model = createHostModel({
  invoke: async ({ system, prompt, agentPreset, maxOutputTokens }) => {
    // 由宿主调用自己的 LLM，返回字符串或 { text }
    return { text: '{"action":"reply","text":"我在。","confidence":0.6}' };
  }
});

apply(ctx, { stateRoot, cognition: { loop: true, model: { enabled: true } } }, { model });
```

`createHostModel` 默认不联网、不读配置；它只拼提示并解析 JSON。启用 `model` 但没有
传入适配器会直接报错，不会静默降级。

模型输入里带一段 `presence` 事实：距用户上一条消息多久、最近 20 条里双方各发了多少、
她有没有得到回复、当前时段的本地小时与“深夜/清晨/上午/中午/下午/晚上”。它只是判断
依据，不是发送门槛——几点发、发几条由她结合经历决定。

tick 默认只在有到期安排时询问模型；如果总线在 tick 里带 `payload.allowBrowse: true`，
`allowedActions` 会多出 `invoke`，`capabilities` 里出现只读的 `bilibili.browse`。
模型可以决定“去看看”，也可以选择 silence。invoke 的回执写成一条 `observation` 记忆
（不写 action），失败才写 action 记录。记录见
`docs/acceptance/A1-readonly-browse-2026-11-17.md`。

### 总线适配（已移交 bus 插件）

内核只发意图，不发送、不排期：`lib/index.js` 的 `onIntent` 把意图交给
`ctx.get('cognition-intents')`。真正执行 `send` / `invoke` / `wake`、把结果回填成
带 `correlationId` 的 `tool-result`、以及到点投 `tick`，都由独立的
`dsh-dshai-bus` 插件负责。

包内原本的参考适配器 `lib/bus/adapter.js` 与测试替身 `lib/bus/fake.js` **已删除**：
它们与 bus 插件职责重复，且自述为「契约定型 + 测试用」的参考实现。
意图与回执的词汇表仍在 `lib/ports/contract.js`。

- `send` / `invoke` 成功或失败都会回一条带 `correlationId` 的 `tool-result`；
- `wake` 用绝对 `wakeAt`，排期成功也回 `tool-result`，到点由调度器投 `tick`；
- 内核会拒绝不自洽的意图（未知类型、空文本、过去时间、缺工具），不交给总线。

### 预算闸门

`lib/decide/budget-gate.js` 在每次付费模型调用外面套一层「预留 → 调用 → 结算」。闸门对预算服务分三态：

| 状态 | 判定 | 行为 |
|---|---|---|
| 没装 / 用户主动禁用 | `ctx.get('budget')` 返回 `null` 或 `undefined` | 整体透传，照常调用（预算不是强制依赖） |
| 已注册但服务异常 | 取服务抛错，或返回对象缺 `reserve`/`settle` | **拒绝付费调用**，抛 `BUDGET_BLOCKED`，决策层回落确定性策略并记 `decision-fallback` |
| 正常 | 接口齐全 | 预留 → 调用 → 结算 |

- 第二种是刻意做成 fail-closed 的：把"预算服务坏了"当成"没有预算"，等于静默放行付费请求。
- 估算输入 token 由闸门自己推进：按调用类型记住上次实耗，下次取 `ceil(上次 × 1.2)`；首次无历史用保守常量 24,000。
- 预留失败（额度不足 / 未配置 / 账本损坏）同样不执行付费调用，抛 `BUDGET_BLOCKED`。
- 结算只认真实 usage；拿不到 usage 时**不结算也不释放**，预留保持 pending 交给 Budget 的 TTL / 对账，绝不按 0 记账。
- 事件入口会给 `owner-message` / `tick` 打上 `budget` 摘要（`{level, remaining, asOf}`），
  `blocked` 时 `decide/model-decide.js` 直接跳过模型。
- `peek()`（读状态用于打标）比 `wrap()`（包付费调用）宽松：预算读不到时返回 `null`，
  不让预算故障阻断认知循环本身。

### 记忆衰减与维护（S3.9）

召回按强度分三档：`details`（详细摘要）、`overview`（只剩标题线索）、`trace`（模糊
痕迹）。放太久的低价值记忆不会“一直清楚”，也不会被伪造细节；重说不等于失忆，
被日记引用的记忆不参与归档。

维护由宿主的 `maintenance` 事件触发（内核没有定时器，宿主按维护窗口投递；错过则下次
启动补一次）：

- 自动归档低风险项：测试残留、完全重复、被替代超过 30 天、超过 180 天且强度 < 0.1 的
  低价值痕迹；容量到 85% 先沉最低强度的，重要度 5 与日记引用不动；
- 归档写入 `archive/*.jsonl`，从活跃池移除、计数可见，可恢复，不删除原文；
- 语义相近只给 `proposals` 建议，不自动合并；
- 每次维护写一条 `maintenance` 活动。

### 学习信号（S3.8）

v1 只学一条：主动关心的阈值。

- 到点的安排只有在记忆强度 ≥ `traits.initiativeThreshold`（默认 0.6）时才会主动问；
  太弱的旧事宁可不提，记 `care-skipped`；
- 问过之后：用户接着聊这件事 → 阈值 −0.012（更愿意主动）；72 小时内没回应 →
  +0.006（更谨慎）；用户回了别的事不算信号，避免把“忙”误读成“不喜欢”；
- 每天最多移动 0.02，边界 0.3–0.9；变化记入 `self.outcomes` 与 `care-outcome` 活动；
- 全部确定性、可回放，不依赖模型。

### 习惯快路径（S3.10）

同一情境反复成功，就不再每次重新想；失败退回审议。当前只压缩“到点要不要主动问”这一个
动作，不学具体句子。

- 情境键 = 事件类型 | 话题类 | 时段 | 精力档，例如 `tick|体检|晚上|normal`；精力只分两档
  （< 30 为低，否则不低），避免同一情境被切碎；
- 新习惯从 0.3 起，成功 +0.05、失败 −0.15；信心 ≥ 0.7 才走快路径（约 8 次成功）；
- 连续失败 2 次，这个情境重新交给审议；不用的习惯按 60 天半衰期变淡，但记录不删；
- 成功/失败只来自真实结果：追问后用户接着聊 = 成功，72 小时没回 = 失败，回别的事不算；
- 快路径仍过 act 的全部校验（意图、主动关心阈值、总线），不是绕过安全；
- 每次快路径写一条 `habit-fast-path` 活动，`trace.decide.source = 'habit'`。
- 活跃上限 200 条；到 85%（170 条）时，把“信心 < 0.3 且 180 天没用”的习惯移入冷区
  （`self.habitsDormant`，上限 500，可恢复）；仍超 200 时按最久没用搬家；冷区里的习惯被
  同类结果唤醒时搬回活跃区，不重新从零学；`status()` 暴露 `habits.active/dormant`。

### 记忆连续性（P0–P3，0.2.0）

目标不是“记得更久”，而是“聊到一半接得上、做过的事能回想、说过的话不被改写”。

- **action 记忆带原话**：每次发送写成 `我对用户说：<原话>` + 发送结果 + `correlationId`，不再只是 `{"ok":true}`；
- **逐轮经历卡**：`memory.episodes` 保存最近 200 轮（用户话/她的话/结果），`experience/*.jsonl` 仍是原文真源，可重建；
- **最近对话注入**：模型输入带 `recent`（默认最近 12 轮、2,400 字预算）与 `openLoops`（到期待追问、已发未回），不再只给当前一句；
- **异步抽取**：回复发出后 30–60 秒内合并成批（≤3 轮），模型产出 0–3 条候选，经 `addMemory` 校验落盘；进程重启补跑最近 3 轮；
- **巩固建议**：低风险（重复/过期/已被更正/测试残留）仍自动归档；高风险（同主题抽象、近似合并）只进 `memory.proposals`，在 UI「记忆 → 待确认的整理」里采纳或忽略；
- **召回融合**：`0.65*BM25 + 0.20*recency(90 天) + 0.15*importance`，再按条数与字符预算裁剪；归档/被更正的永不进入；
- **API**：`proposals()` / `applyProposal(id)` / `dismissProposal(id)`；UI 路由 `/cognition/api/proposals` 与 `/proposals/apply|dismiss`。

验收：`host/continuity-driver.js` 用真实模型走“自述 → 无关活动 → 追问”四轮，检查记名字、记体检、
接得上橘猫、action 原话、recent 注入，6/6 PASS（4 次模型调用，记录见报告）。

### S5 预演（A 场景 S1）

- `scripts/rehearse-scene.mjs`：假时钟 + 假总线 + 脚本化模型，回放“记安排 → 到点追问 → 纠正 → 改口”；
- 记录：`../../docs/acceptance/S1-rehearsal-2026-11-17.md`（仓库根 `docs/acceptance/`）；
- 结论：工程链路 PASS（含 P8；每次循环的阶段摘要落 `trace/`），P3/P4/P6 需真实模型才能判；tick 追问已改为带到期记忆做召回。

### 真实宿主（S5 补充）

- `lib/decide/host-agent-model.js`：当 `cognition.model.enabled=true` 且
  `apply` 没有显式传 `deps.model` 时，用 `ctx.get('agents')` 创建一次性
  agent 会话（`provider`/`model` 可配，默认 `deepseek-account`/`deepseek-flash`），
  只发一条 `system + prompt` 消息，收 JSON；每次决策一个会话，用完 dispose。
  这是宿主绑定层，不是内核；真正联网/计费由宿主 agent 负责。
- `host/scene-driver.js`：可选驱动插件，按 S1 时间线投
  `owner-message` / `tick`，把 `send` 意图写成 `tool-result` 回填（假 DM，
  不真实发送），结束后把证据写到 `scene-result.json`。只用于隔离宿主验收。
- 记录：`../../docs/acceptance/S1-real-host-2026-11-17.md`（探索 3 次 + 计分 3 轮；
  三轮 tick 均由模型主动开口、9/9 checks；P3/P6 仍不可评）。
- 日期提醒彩排：`host/date-driver.js` 模拟“11月17日说 11月20号体检 → 20号 20:05
  tick → 主动追问 → 第二次 tick 不重复 → 次日回结果”；真实模型 8/8 checks，
  记录 `../../docs/acceptance/S1-date-reminder-2026-11-17.md`。
- 运行前提：隔离 home 里放真实凭据（从桌面 DSH 复制，勿入仓库）、
  `DSH_HOME` 只对子进程设置、`--profile iso --patch <隔离 plugins.yml>`。

## 配置

```js
apply(ctx, {
  stateRoot: 'D:/path/to/cognition',
  timeZone: 'Asia/Shanghai',
  identity: { name: '助手', gender: '女', profileText: '…' }, // 仅空状态时写入
  memory: { capacity: 2000 },
  behavior: {},
  cognition: {
    loop: false, // true 才跑最小循环
    model: {
      enabled: false,
      provider: 'deepseek-account', // 仅宿主适配器用
      model: 'deepseek-flash',
      timeoutMs: 15000,
      agentPreset: 'dsh-dshai-chat'
    }
  }
});
```

未知配置项直接报错。时区只用于日期精度记录，不写死北京。

## 测试

本包的回归用例统一放在**仓库根 `tests/`**（不在这包自己的目录下），逐个文件跑：

```powershell
# 在仓库根执行
Get-ChildItem tests -Filter *.test.mjs | ForEach-Object { node $_.FullName }
```

Windows 下请勿用 `node --test`：它按目录 spawn 子进程时可能报 EPERM。
每个文件打印 `PASS` / `FAIL` 行，末行是 `结果：N 通过 / M 失败`。

门禁：`cognition` 存在且 `brainmem`/`autonomy` 不存在；未知事件拒绝；
`event.id` 幂等；队列满丢最旧；`apply` 无定时器；读 API 可用；旧根不读不改。

## 当前目录

```text
lib/index.js          # 单入口：配置 → 状态根 → 服务 → ctx.provide
lib/host/             # 配置、状态根解析、run.lock
lib/state/            # schema、原子读写、store
lib/api/              # 事件校验、服务窗口
lib/ports/            # 事件/意图/model/tool-result 词汇表（无实现）
lib/loop/             # 最小七阶段循环（decide 可注入，act 只交意图）
lib/decide/           # 模型决策、宿主 LLM 适配器与预算闸门（模型默认关闭）
lib/memory/           # 召回适配、写入校验、规则编码、衰减/归档维护 + 迁移来的 BrainMem 算法
lib/behavior/         # 迁移来的 Autonomy 非决策代码（未接线，S1 备用）
lib/cycle/            # 仅剩 closed-loop.js：Autonomy 的视频排序与反馈闭环（未接线，S1 备用）
lib/self-state.js     # 自我状态骨架（身份/宪法/特质）
lib/self/             # 学习信号（主动关心阈值）与习惯快路径（情境键、信心、失败回退）
tests/host/           # S2 入口与 API 测试
tests/loop/           # S3 循环与 S3.5 场景测试
tests/memory/         # 衰减分档、维护归档、P3 变糊测试
tests/brainmem/       # 记忆算法测试（继续跑）
tests/autonomy/       # 未退役的行为测试（逐批处置）
scripts/              # 迁移脚本与彩排脚本（rehearse-model.mjs / rehearse-scene.mjs）
```

## 不变量

- 一个逻辑写入者：只有循环写状态；外部只能通过事件进入。
- 旧数据不迁移、不合并；旧根只作回滚档案。
- 不做真实发送、不调付费 provider、不改正式环境。
- 人格统一未完成前，不声称已统一；宿主 preset 不动。

## 客户端设置入口

`client.js` 注册宿主的 `settings.section`：设置里会出现「DSHAI 设置」，面板**原地渲染**概览 / 身份 / 记忆 / 活动 / 数据，不跳页，因此随时可以退回客户端其他设置项。面板顶部另有「在新窗口打开」（`<a target=_blank>`）与「复制链接」：独立页面 `/cognition-ui` 用一次性 `?k=` 入口写 HttpOnly cookie，之后可以在系统浏览器里直接使用。数据走同源的 `/cognition/api/*`（先取 `/cognition/api/csrf` 再带 `x-csrf-token`）。