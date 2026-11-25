# Changelog

## 0.3.15 — 2026-11-19

- 首次登录即可用：新增配置 `ownerMid`（用户 B 站 mid）。扫码成功后自动绑定用户账号、初始化内容策略，并按 `socialAutoGrant` 签发 `dm:owner` read/send 会话授权；未配置 `ownerMid` 时保持旧行为。
- 新增 `tests/social-owner-bootstrap.test.mjs`：首次登录冷启动、重复 poll 不重复授权、未配置 ownerMid 的旧行为。
- 测试：Bilibili 插件 40 个测试文件逐文件通过。

## 0.3.5 — 2026-11-06

- 字幕：`readSubtitles({ full: true })` 可返回完整正文；默认仍保留 500–12000 字限制，`truncated` 反映真实截断。
- 评论：`readVideo` / `readAudience` 的评论正文不再截断到 400/800 字。
- 新增服务层 `listUserVideos({ mid, limit, order })`，返回 UP 主公开视频列表；**不新增 Agent 工具**，工具面仍为 7 个。
- 保持登录、owner-only、grant、dailySendMax、Budget、Autonomy 接口不变。
- 相关测试：Bilibili 201/201；隔离安装 0.3.5 验收通过；真实单条发送成功。
