# QQ 群接入

## 使用流程

- 群主或管理员发送「管理」→ 打开绑定网页 → 将网页生成的绑定码发回群内 → 回原浏览器设置管理密码。
- 绑定入口 10 分钟有效，浏览器绑定码 5 分钟有效且只能使用一次。群内公开链接本身不授予管理权限。
- 每个 QQ 群独立保存管理密码、声网配置和共享记录。完成配置后，所有成员可发送「屏幕共享」。
- 共享者打开网页开始共享，群内随后收到观看入口；结束后发送统计通知。QQ 不支持沿用黑盒的消息卡片原地更新方式。
- 群指令面板包含「管理」「屏幕共享」「帮助」。群内不使用仅支持单聊的自定义菜单。
- 当前实测仅收到 @机器人消息。管理、绑定码和屏幕共享均须先在QQ群输入 @ 并选择机器人，再发送命令；复制按钮默认包含“@XgoatCast屏幕共享机器人 绑定码”；QQ若未把粘贴的名字转换为有效提及，仍需在QQ中选择机器人。

## 服务端与 QQ 后台

服务端 `.env` 设置 `QQ_APP_ID`、`QQ_APP_SECRET`，重启生效。密钥不写入前端、文档和版本库。

在超级管理员「全局配置」查看 QQ 状态、复制回调地址、验证凭据及同步群指令面板。

QQ 开放平台配置 HTTPS 回调地址：

`https://cast.xgoat.top/api/integrations/qq/webhook`

订阅群消息与机器人群关系事件：

- `GROUP_AT_MESSAGE_CREATE`：@机器人消息。
- `GROUP_MESSAGE_CREATE`：开启接收所有消息后收到的普通群消息。
- `GROUP_ADD_ROBOT`、`GROUP_DEL_ROBOT`：机器人加入、退出群聊。
- `GROUP_MSG_RECEIVE`、`GROUP_MSG_REJECT`：群主动消息接收开关。

这些事件属于 `GROUP_AND_C2C_EVENT (1 << 25)`。Webhook 无需配置 WebSocket 连接。后台选项与账号可开通能力以实际后台为准，服务端不能自行授予全量消息权限。

## 协议与失败处理

- AppID + AppSecret 换取 Access Token，服务端缓存、共享刷新请求；401 只刷新重试一次。
- 每次回调，包括地址验证，均对原始请求体做 Ed25519 验签，并检查 AppID 和签名时间。签名密钥算法与官方公钥、握手签名示例匹配。
- 地址验证 `op=13` 返回 `plain_token` 和签名；事件持久化后及时返回 `op=12`，异步执行业务。
- 普通聊天内容与附件不保存。只有本服务指令入队；处理后删除指令正文，保留有限期去重元数据。
- 同一消息的全量事件、@事件及重复投递共用去重键；业务写入与发送队列在同一 SQLite 事务内提交。
- 群主/管理员以已验签消息的 `member_role` 判定；缺失时尝试群成员信息接口。该接口仍在内邀，失败时不授予绑定权限，不把邀请机器人者默认为群主。
- 移除机器人会撤销绑定、清除管理密码及浏览器授权、轮换管理密钥。晚到的消息不能重新激活已退出群；重新加入需重新绑定。
- 群被动消息 5 分钟内最多回复 5 次；本流程固定使用序号 1/2/3，分别对应命令回复、共享开始、共享结束。
- 生命周期通知超出被动回复时间后，尚未尝试发送的通知可转主动消息；主动消息受群授权与平台频控约束。
- 出站队列限制机器人与单群发送速度。被动消息使用固定消息 ID 和序号重试。主动消息超时或进程中断导致结果未知时标记待核查，不盲目重复发送。
- 明确的 Markdown 权限拒绝可回退为文本；链接被拒绝会发送纯文本说明。确认创建入口发送失败时取消待开始会话。
- 群指令面板按固定备注识别，后续同步更新本服务面板，不覆盖其他面板。

## 验证范围与上线测试

本地测试涵盖验签、篡改、重放、握手、浏览器隔离、普通成员拒绝、管理员绑定、过期、跨群隔离、撤销、去重、事务回滚、共享入口和观看通知、发送不确定结果、重启恢复、格式回退及链接拒绝。

仍需真实 QQ 群测试：普通消息是否回调、角色字段是否返回、管理链接能否打开、QQ 内置浏览器与外部浏览器的绑定设备一致性、声网共享与观看、超时后的主动结束通知。

## 已核对的官方文档

- [启动接入](https://bot.q.qq.com/wiki/develop/api-v2/)
- [获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)
- [API 调用与 OpenID](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)
- [Webhook](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)、[验签](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)、[事件结构](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html)
- [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)、[群消息发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
- [群全量消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)、[@消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)
- [群成员信息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_members_member_openid.get.html)
- [机器人加入群](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_add_robot.html)、[退出群](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_del_robot.html)
- [菜单与指令面板](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/)、[创建面板](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.post.html)、[更新面板](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels_panel_id.put.html)
- [消息交互事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html)、[文本交互](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html)

当前入口使用指令消息和链接按钮，无需按钮回调；以后增加回调按钮时须订阅 `INTERACTION_CREATE` 并应答交互。频道、单聊、富媒体附件、历史聊天查询不属于本次群屏幕共享业务范围。
