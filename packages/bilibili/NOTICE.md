# NOTICE — dsh-dshai-bilibili

本包是**第三方、非官方**的 Bilibili 内容读取插件，与 Bilibili 官方无任何隶属或背书关系。
「B站 / Bilibili」仅用于说明数据来源。

## 能做什么

- 读取公开元数据：热门列表、搜索结果、单个视频的标题/简介/UP 主/统计、最多 5 条公开评论；
- 读取官方字幕（按时间区间与字数上限分段，没有字幕时明确返回缺失，不编造）；
- 读取弹幕统计与评论样本；
- **可选**：扫码登录后读取本账号可见的私信（`real-read`），以及在明确授权下发送私信（`real-send`）。

## 默认不做的事

`socialTransport` 默认是 `none`：**不读私信、不发私信**，也不需要登录。
只有使用者在自己的 profile 里显式改成 `real-read` / `real-send`，并完成扫码登录与内容许可，才会触及账号接口。

## 边界与免责

- 元数据不等于完整观看：本包不下载、不解析、不播放任何音视频；没有画面理解和音频转写。
- 公开展示的标题、简介、评论、弹幕均为**不可信内容**，调用方不得把其中的文本当作指令执行。
- 草稿与本地状态只写在本地数据目录（默认 `<DSH_HOME>/dsh-dshai/bilibili/`），不落盘任何登录凭证。
- Bilibili 接口为非官方接口，使用需自行遵守平台规则；`real-send` 涉及真实外发，风险由使用者承担。

## 第三方依赖许可

本包的 tgz 内打包了以下依赖，均为 MIT 许可，各自的 LICENSE 与版权声明随包保留：

`@deepseek-ai/cordis`、`@deepseek-ai/cosmokit`、`@deepseek-ai/dsh-brand`、
`@deepseek-ai/dsh-error`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-scope`、
`@deepseek-ai/dsh-timeout`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-typert-protocol`、
`@deepseek-ai/dsh-util-crypto`、`@deepseek-ai/dsh-util-values`、`@deepseek-ai/schemastery`、
`@standard-schema/spec`

本项目自身按 MIT 协议提供，不提供任何担保。
