# DSHAI

> **第三方、非官方项目 · Alpha 阶段**
>
> 仓库：<https://github.com/hanxueyiyue-arch/DSH-DSHAI> · 最新版本：[v0.4.0](https://github.com/hanxueyiyue-arch/DSH-DSHAI/releases/tag/v0.4.0)
>
> 这不是 DeepSeek 官方项目，与 DeepSeek / Bilibili 均无隶属或背书关系。
> 目前处于 Alpha：接口、配置项、数据格式都可能变，已知问题和未完成项在文末列出。
>
> **⚠️ 装之前先看这一条**：cognition 的模型调用**默认开启**。装上并配好模型服务后，
> 每一次决策、抽取、反思、日记都会产生**真实的付费调用**。请先确认账号余额、
> 想好每天大概花多少；要硬限额就先装好 `dsh-dshai-budget`（不装也能跑，只是没有硬限额）。
> 想零成本试用：把 `cognition.model.enabled` 改成 `false`，其余功能照常。
>
> 其余默认都是「关着」的——不扫码、不读私信、不自主调度。

DSHAI 是跑在 DeepSeek Harness（DSH）上的一组插件：一个会记事、有倾向、能自己安排日程的认知内核，加上它用的工具总线、B 站只读工具，以及可选的预算闸门。

## 包含的包

| 包 | 版本 | 作用 | 运行时依赖 |
|---|---|---|---|
| `dsh-dshai-cognition` | 0.4.0 | 认知内核：记忆、倾向、日程、精力、反思、日记 | 无（DSH 提供模型服务） |
| `dsh-dshai-bus` | 0.0.12 | 意图总线、用户会话、B 站工具 | 无 |
| `dsh-dshai-bilibili` | 0.3.16 | B 站只读工具（热门/搜索/视频/字幕/弹幕评论）；可选扫码登录与私信 | `@deepseek-ai/*`（已打包进 Release tgz） |
| `dsh-dshai-budget` | 0.5.2 | 可选的每日金额硬限额；默认不启用 | 无 |

源码在 `packages/`；可安装的 tgz 在 `dist/`（对应 GitHub Release 资产）。回归测试在 `tests/`。

## 测试怎么跑

逐个文件执行（**不要用 `node --test`**：Windows 下它可能因 spawn 权限报 EPERM）：

```powershell
Get-ChildItem tests -Filter *.test.mjs | ForEach-Object { node $_.FullName }
```

每个文件打印 `PASS` / `FAIL` 行，末行是 `结果：N 通过 / M 失败`。

## 环境

- DSH 桌面版（0.2.2-rc 系列）；
- Node.js ≥ 22；
- 只有 cognition 需要模型服务（`deepseek-account`）；**模型调用默认开启**，会产生真实付费调用，详见下方说明。

## 安装

从 [Releases](https://github.com/hanxueyiyue-arch/DSH-DSHAI/releases) 下载四个 `.tgz`（版本要和下面一致，对不上会装错分支），然后：

```powershell
dsh plugin --profile <profile> add file:D:\path\to\dsh-dshai-cognition-0.4.0.tgz
dsh plugin --profile <profile> add file:D:\path\to\dsh-dshai-bus-0.0.12.tgz
dsh plugin --profile <profile> add file:D:\path\to\dsh-dshai-bilibili-0.3.16.tgz
# 可选
dsh plugin --profile <profile> add file:D:\path\to\dsh-dshai-budget-0.5.2.tgz
```

当前版本（v0.4.0）的直链：

| 包 | 下载地址 |
|---|---|
| cognition 0.4.0 | [dsh-dshai-cognition-0.4.0.tgz](https://github.com/hanxueyiyue-arch/DSH-DSHAI/releases/download/v0.4.0/dsh-dshai-cognition-0.4.0.tgz) |
| bilibili 0.3.16 | [dsh-dshai-bilibili-0.3.16.tgz](https://github.com/hanxueyiyue-arch/DSH-DSHAI/releases/download/v0.4.0/dsh-dshai-bilibili-0.3.16.tgz) |
| bus 0.0.12 | [dsh-dshai-bus-0.0.12.tgz](https://github.com/hanxueyiyue-arch/DSH-DSHAI/releases/download/v0.4.0/dsh-dshai-bus-0.0.12.tgz) |
| budget 0.5.2 | [dsh-dshai-budget-0.5.2.tgz](https://github.com/hanxueyiyue-arch/DSH-DSHAI/releases/download/v0.4.0/dsh-dshai-budget-0.5.2.tgz) |

> **bilibili 必须用 tgz 安装。** 它运行时需要 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 等包，这些包在 npm 上没有匹配版本，已通过 `bundledDependencies` 打进 tgz 的 `node_modules`。从 git 目录直接安装不会带依赖。

## 配置

配置写在你自己的 profile 里（不要改包内文件）。示例：

```yaml
- id: cognition
  config:
    stateRoot: D:/data/dshai/cognition   # 记忆/倾向/日记都放这里
    timeZone: Asia/Shanghai
    cognition:
      loop: true
      model:
        enabled: true
        provider: deepseek-account
        model: deepseek-flash
        agentPreset: dshai
    recall:
      mode: p4
      association: true
    personality:
      enabled: true
    journal:
      enabled: true

- id: bilibili
  config:
    ownerMid: ''
    # 默认 none：不读不写私信；real-read 只读；real-send 读取+发送（需自行承担平台规则风险）
    socialTransport: none
    socialAutoGrant: false

- id: cognition-bus
  config:
    scheduler:
      enabled: false
    ownerSession:
      enabled: false
      sendMode: dry-run
```

### 预算（可选）

`dsh-dshai-budget` 默认 `disabled: true`，装了不会运行。要启用：

1. 先写 `<DSH_HOME>/dsh-dshai/budget/config.json`，至少包含 `limits.tokens`、`limits.cost.micros`、`limits.cost.currency: CNY` 和 `prices`；
2. 再把 profile 里的 `budget` 条目改为 `disabled: false`。

**没配置就启用，cognition 的付费调用会被预算闸门阻断。** 不打算配置就别装，cognition 没有 budget 也能正常运行。

## 数据

默认数据目录（`DSH_HOME` 下的 `dsh-dshai/`）：

```
dsh-dshai/cognition/   cognition 的记忆、倾向、日记、日程、技能
dsh-dshai/bilibili/          B 站账号、策略、面板状态
dsh-dshai/bus/              总线诊断
dsh-dshai/budget/            预算配置、账本、储蓄
```

迁移：把旧数据目录复制到新机器，在 profile 里把 `stateRoot`（**顶层配置项，不在 `cognition:` 下面**）指过去即可；B 站登录凭证只存在运行期内存，重启后需要重新扫码。

## 构建发布包

在每个 `packages/<name>` 目录里：

```powershell
npm pack
```

bilibili 的 `package.json` 里已声明 `dependencies` + `bundledDependencies`，`npm pack` 会把依赖一并打进 tgz（约 525 KB）。把产物放到 `dist/` 并上传到 GitHub Release。

## 本次更新（2026-11-25）

### cognition 0.4.0：记忆更新关系的替换词门槛

同一主题的新记忆要让旧记忆失效（`update`），现在除了标题相似，还要求新内容里出现**明确的替换说法**
（改成 / 改为 / 换用 / 换成 / 调整成 / 升级到 / 作废 / 取代 / 不再 / 取消 等）。

起因是线上数据实测：8 对被判成"更新"的记忆里，正文相似度只有 0.152~0.514，全部是**标题相同但讲的是另一件事**
（典型来源是「更正：X」这种标题把不同对话塞进同一主题）。而"真更新"与"真误伤"的正文相似度区间完全重叠
（0.061~0.391 vs 0.032~0.250），任何字符相似度阈值都会同时漏放和误伤，所以改用语义硬门槛。

### bilibili 0.3.16：让"看过"和"看过元信息"可区分

- `dshai_read_video` 的描述改写：明确它只拿到标题/简介/评论，要了解视频内容必须调 `dshai_subtitles`；
- `readVideo` 返回值新增 `next` 字段，直接给出下一步该调什么；
- `readSubtitles` 返回值新增 `nextFrom`：被 `maxChars` 截断时等于最后一句的 `to`，可据此续读；
  区间读到头或无可读内容时为 `null`。

### 预算闸门：区分「没装」和「装了但坏了」

之前 `budget` 服务取不到时会落到"没有预算"分支，**静默放行付费调用**。现在分三态：

| 状态 | 判定 | 行为 |
|---|---|---|
| 没装 / 用户主动禁用 | `ctx.get('budget')` 返回 `null`/`undefined` | 照常调模型（预算不是强制依赖） |
| 已注册但服务异常 | 取服务抛错，或返回对象缺 `reserve`/`settle` | **拒绝付费调用**，抛 `BUDGET_BLOCKED`，回落确定性策略 |
| 正常 | 接口齐全 | 预留 → 调用 → 结算；拿不到 usage 时不按 0 结算 |

### 模型调用默认开启

`cognition.model.enabled` 默认为 `true`。开启状态下每一次决策、抽取、反思、日记都会产生**真实付费调用**，
所以装之前请先确认三件事：① 账号里有余额；② 已想好每天大概花多少；③ 要硬限额就装好 `dsh-dshai-budget`。

想零成本试用：在 profile 里把它改成 `false`。此时认知循环、记忆读写、日记、日程仍然工作，
只是"这一轮说还是不说、做什么"走确定性策略而不是模型判断，不会产生任何模型费用。

另外 `agentPreset` 是可选依赖：全新环境没装配套预设包时，cognition 会跳过挂载并按无预设继续，
不会因此让模型调用失败。

### 预设缺失不再导致调用失败

`cognition.model.agentPreset` 指向的预设是**可选依赖**。全新环境只装了 cognition、没装配套预设包时，
之前 `agentPresets.mount` 会抛错并让整次模型调用失败。现在挂载失败只记一条警告，按"无预设的裸 Agent"继续。

### 发布前脱敏

- `lib/self/tendency-seed.json` 清空：不再携带任何来自真实运行环境的倾向、反思记录、记忆引用与时间戳；
  种子导入机制保留（`items` 为空 = 没有种子，启动迁移直接跳过），使用者可自行按格式填写。
- 本地绝对路径、账号 mid、cookie/token、会话 id、个人化的角色名与对话称呼、测试里的真实视频号与真实对话片段，
  全部替换或移除。复扫 9 类标记均为 0 处。
- 第三方依赖（13 个，均 MIT）的 LICENSE 与版权声明随 tgz 保留。

### 验证状态

```
383 条断言通过 / 0 失败（21 个测试文件，逐个执行）
4 个包入口均可 import，导出结构正常
4 个 tgz 已重新打包，内容复查无个人数据残留
```

### 已知问题与未完成（不要求本轮修完）

1. **真正理解视频**：目前只有标题、简介、评论、官方字幕；没有画面理解，也没有音频转写。
   很多视频没有官方字幕，此时 `dshai_subtitles` 会明确返回 `SUBTITLE_EMPTY`。
2. **观察合并的覆盖面**：只有 `bilibili.video/subtitles/audience` 会生成合并键，`discover`（搜索列表）不生成，
   所以"搜到过"和"看过"目前是两条独立记忆。
3. **偏好层重复只在写入侧合并**：`findSimilarPreference`（阈值 0.72）能拦住新写入的重复偏好，
   但历史上已存在同主题多条时，注入侧不会再去重（试过三种文本相似度量，都会误伤，所以放弃）。
4. **`reflection` 直写记忆绕过质量门**：反思链路直接写 `memory.json`，不经过 `scoreMemoryQuality`，
   这些条目没有质量分档。数量少，暂未统一。
5. **正文字符相似度无法区分「同一件事的新说法」与「同标题不同事」**：实测两者区间完全重叠，
   目前靠替换词这个语义门槛兜底，仍有漏判可能。
6. **QQ 插件未包含**：尚未完成，不在本次发布范围。
7. **Budget 三态有一个判不了的空档**（记录，不在本轮修）：
   闸门同时读 `ctx.get('budget', false)`（宽松）和 `ctx.get('budget', true)`（严格）来区分
   「没装」「失活」和「正常」。它能覆盖**服务仍注册但提供者非 ACTIVE** 的失活情形，
   但**无法区分「用户主动禁用」和「服务故障注销」**——这两种情况在宽松读取里都是 `undefined`，
   闸门会按「没装」处理并放行付费调用。
   要精确区分需要读「用户实际是否启用了 budget」的配置状态；那属于不可靠的旁路猜测，
   所以**保持 Budget 为可选插件、不做状态推断**。遇到预算账本异常时，请先确认 budget 插件本身是否还在运行。
8. **Alpha 阶段**：数据格式（`memory.json` / `behavior.json` / `trace/*.jsonl`）可能随后续版本迁移，
   升级前请自行备份 `stateRoot`。

### 已知问题：从源码构建而不是装 tgz

`dsh-dshai-bilibili` 的 13 个依赖（`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、
`@deepseek-ai/cordis` 等，版本固定在 `0.2.2-rc.2` / `3.19.0` / `4.1.0`）**不在 npm 公共 registry 上**
——它们随 DSH 本体分发。所以：

- 从 git 仓库直接 `npm install` / `npm pack` **会因为依赖解析失败而构建不出来**；
- 官方安装包（`dist/` 里的 tgz）通过 `bundledDependencies` 把这些依赖一并打进去了，所以能直接装；
- 想从源码构建，得先把这些包从你自己的 DSH 安装里取出来（例如从 DSH 的 `node_modules`
  或 `app.asar` 内提取）放到能解析的路径，再执行 `npm pack`。

另外三个包（`cognition` / `budget` / `bus`）没有这个限制，但它们的运行前提同样依赖 DSH 宿主。

## 注意

- B 站接口为非官方接口，使用需遵守平台规则；默认不读不写私信，请自行评估 `real-send` 的风险。
- 登录凭证只保存在当前进程内存，不落盘；但本地状态文件仍可能包含你的 B 站 mid、浏览记录等，请勿把 `dsh-dshai/` 数据目录提交到公开仓库。
- **从旧版本升级时保留原数据目录**：旧版把数据放在 `bili-fish/`，新版默认用 `dsh-dshai/`。
  升级后如果发现记忆、日记、预算账本"空了"，是路径没对上。二选一：
  1. 在 profile 里把 `stateRoot` 指到旧目录（**顶层配置项，不在 `cognition:` 下面**）；
  2. 或把 `<DSH_HOME>/bili-fish/` 整个改名为 `<DSH_HOME>/dsh-dshai/`。
  换目录前先备份；`stateRoot` 里的 `memory.json` / `behavior.json` 是这个项目的全部历史。
- 本项目按 MIT 协议提供，不提供任何担保。

## License

MIT
