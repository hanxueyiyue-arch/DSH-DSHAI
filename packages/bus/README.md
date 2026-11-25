# dsh-dshai-bus

公共插件（骨架）。定位是“电脑”，不是“人”：

- 把外部事件送进认知内核（`ingest`）；
- 执行内核发出的意图：`send` 交传输、`invoke` 交工具目录、`wake` 交调度器；
- 把执行结果作为 `tool-result` 送回内核；
- 维护只读工具目录（`capabilities`）与调用策略（`canInvoke`）；
- 不判断谁是用户、不塑造性格、不写记忆、不发消息本身（传输/工具由下层插件提供）。

## 现状

- 纯逻辑模块 `lib/bus.js`，可用 `createCognitionBus` 直接实例化；
- `lib/tools/bilibili.js` 提供只读的 `bilibili.browse` 工具（**只经 bilibili 插件**；未加载/未授权时拒绝，不做匿名兜底）；
- `lib/index.js` 的 `apply(ctx, config)` 已可装配到宿主：提供 `cognition-intents`
  （内核的 `onIntent` 会找它）与 `cognition-bus`（给驱动/宿主配置传输与工具）；
- 延迟绑定：`apply` 时 `cognition` 还没加载也没关系，第一次提交意图时再 `ctx.get('cognition')`；
- 没有 QQ/身份登记/预算/审批；这些后续加；
- 测试：本包没有独立测试目录；回归用例在仓库根 `tests/`，逐个文件跑：
  `Get-ChildItem tests -Filter *.test.mjs | ForEach-Object { node $_ }`
  （Windows 下 `node --test` 可能因 spawn 权限报 EPERM，所以不用它）。

## 宿主装配

```js
// plugins.yml
- insert:
    - id: dsh-dshai-bus
      name: 'file:///.../dsh-dshai-bus/lib/index.js'
      config:
        prefix: bus
        tools:
          bilibili: true     # 注册只读 bilibili.browse
          timeoutMs: 10000
        # allowTools: ['bilibili.browse']  # 可选白名单；不在名单里的工具会被拒绝
```

```js
// 驱动/宿主侧
const facade = ctx.get('cognition-bus');
facade.setTransport(async (intent) => ({ ok: true, messageId: 'dm-1' }));
facade.setScheduler(async (request) => ({ ok: true, scheduleId: 's-1' }));
facade.registerTool('demo.echo', { readOnly: true, invoke: async args => ({ ok: true, args }) });
facade.submit({ type: 'send', text: '你好', correlationId: 'c-1' });
```

`apply` 只按 tick 时段表起定时器；`bilibili.browse` 只经 bilibili 插件读取，不匿名请求。

## tick 时段表

- 一天最多 6 段，必须完整覆盖 `00:00–24:00`，不可重叠、不可跨午夜；
- 每段有自己的 `tickMs`，第一次 tick 在“段起点 + 间隔”（不在段起点本身）；
- 间隔 ≥ 段长时，本段不 tick；
- 重启后按绝对时间计算，不补发错过的 tick；
- 运行时配置在 `<DSH_HOME>/dsh-dshai/bus/settings.json`：

```json
{
  "segments": [
    { "start": "00:00", "end": "08:00", "tickMs": 7200000 },
    { "start": "08:00", "end": "24:00", "tickMs": 1800000 }
  ]
}
```

工具：

- `tick.schedule`（只读）：查看各段、当前段、下一次 tick；
- `heartbeat.set`（只改当前段）：改当前时段的唤醒间隔，不能改段边界。

## API

```js
import { createCognitionBus } from 'dsh-dshai-bus/bus';

const bus = createCognitionBus({ clock: () => Date.now() });
bus.registerTool('bilibili.browse', {
  description: '只读公开视频',
  readOnly: true,
  cost: 'free',
  limits: { max: 5 },
  invoke: async args => ({ ok: true, items: [] })
});
bus.setPolicy(({ tool, context }) => tool.name !== 'risky.write');
bus.setTransport(async intent => ({ ok: true, messageId: 'dm-1' }));
bus.setScheduler(async request => ({ ok: true, scheduleId: 's-1' }));
bus.bind(cognitionService); // 需要 onEvent
await bus.ingest(event);    // 外部事件入口
```

`capabilities()` 返回 `{ tool, readOnly, description, args, cost }`，内核会把它翻译成模型可见的能力目录。

`submit(intent)` 由内核的 `onIntent` 调用；回执统一为
`{type:'tool-result', payload:{correlationId, ok, result|error, intentType}}`。
写工具在没有策略时默认拒绝；策略可返回 `true/false/{ok,reason}`。

失败码：`bus-tool-not-found`、`bus-tool-denied`、`bus-write-tool-not-allowed`、
`bus-execution-failed`、`bus-transport-missing`、`bus-scheduler-missing`、
`wake-time-not-future`。

## 聊天通道（HTTP）

`lib/channel-http.js` 提供最小可用的聊天入口/出口：POST 文本 → 投 `owner-message`
→ 等内核空闲 → 返回本轮 `send` 文本；`GET .../health` 用于探活。

```js
import { createHttpChatChannel } from 'dsh-dshai-bus/channel-http';

const channel = createHttpChatChannel({
  facade: ctx.get('cognition-bus'),
  getService: () => ctx.get('cognition'),
  port: 0 // 0 = 随机端口
});
const { url } = await channel.start(); // POST {text} 到 url
```

它只把 `send` 收进 outbox 并回执，不接外部平台；GUI / B 站适配器以后按同一契约接入。

## 边界

- 骨架期只保证“意图 → 回执”的契约，不保证并发、重试、幂等存储；
- 正式实现必须补：发送速率与防封号、预算硬限制、身份登记与用户绑定、事件审计；
- 与内核的契约以 `dsh-dshai-cognition` 的 `lib/ports/bus.js` 为准。
