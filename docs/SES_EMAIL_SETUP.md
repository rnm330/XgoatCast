# 腾讯云邮件推送（SES）API 发信接入指南

> 适用场景：2026-03-02 之后新开通邮件推送的**个人实名**账号不再支持 SMTP 发信（官方公告），
> 只能走 API 或控制台。本项目因此新增了 SES API 发信通道，与原有 SMTP 通道并存，可在超管后台切换。

## 一、控制台准备（一次性）

1. **验证发信域名**：控制台 → 邮件推送 → 发信域名，添加如 `mail.你的域名.com`，
   按提示到 DNS 服务商添加 SPF / DKIM / MX 记录，等待验证通过。
2. **创建发信地址**：如 `noreply@mail.你的域名.com`。
3. **创建邮件模板**（必须，SES 默认仅支持模板发信，自定义内容需历史特殊配置）：
   - 模板类型选「**HTML 富文本**」；若界面要求邮件用途，选择验证码／触发类；
   - 超管后台 → 邮件服务 → SES → 点击「预览邮件模板」「下载 SES 模板」，上传下载的 HTML；也可以使用仓库内 [`docs/ses-email-template.html`](./ses-email-template.html)（仅含 `{{code}}` 单一变量，正文场景文案固定，可直接用于控制台「普通发送」测试）；
   - 提交后等待审核通过。
4. **API 密钥**：访问管理 CAM → 创建子用户，仅授予 `QcloudSESFullAccess`，生成 SecretId / SecretKey
   （不要使用主账号密钥）。

## 二、后台配置

超管后台 → 邮件服务 → 发信方式选「腾讯云邮件推送 SES（API 发信）」，填写：
SecretId、SecretKey、发件邮箱（上面验证过的发信地址）、地域（广州 `ap-guangzhou` 或香港 `ap-hongkong`）、
模板 ID（模板审核通过后列表里的纯数字 ID）。保存后点「发送测试邮件」验证。

发信域名、地址与模板须对应所选地域。SecretKey 留空会保留已保存的值；更换 SecretId 时必须一起更换配套的 SecretKey。
修改配置后须先保存才能发送测试邮件。API 受理成功只说明邮件已提交，并不代表已投递到收件箱；后台会显示邮件 ID 和请求 ID，便于在腾讯云核查。

也可以用环境变量（后台保存的配置优先）：

```ini
MAIL_PROVIDER=tencent-ses
SES_SECRET_ID=
SES_SECRET_KEY=
SES_FROM=noreply@mail.example.com
SES_REGION=ap-guangzhou
SES_TEMPLATE_ID=
```

## 三、实现要点

- 发送走 `SendEmail` 接口（`ses.tencentcloudapi.com`），显式设置 `TriggerType: 1`，验证码走触发类通道；SES 模式不会连接 SMTP，也不会在失败后回退 SMTP。
- 单进程最多并发发送 2 封，最多请求 20 次/秒；注册另有每邮箱、每 IP 和每分钟限流。测试邮件也受统一发送限制。若扩为多个实例，需按腾讯云账号统一限流。
- `Simple`（自定义正文）参数已废弃，未申请特殊配置的账号使用会报 `FailedOperation.WithOutPermission`，
  所以必须走模板；模板变量以 `TemplateData` JSON 字符串传入。
- 排错：后台测试失败会带出腾讯云错误码；也可用 `GetSendEmailStatus` 查询 30 天内的投递状态。
- SMTP 分支保留：企业实名账号或任意其他 SMTP 服务商仍可在后台一键切换回去，代码无需改动。

## 四、模板维护

邮件采用内联样式、表格布局和系统字体，不加载外部图片或脚本；包括隐藏摘要、六位验证码、有效期及账号保护提示。
模板源码位于 `server/src/modules/panels/email-template.ts`。服务端构建会自动导出 `docs/ses-email-template.html`，后台预览和下载使用同一份模板。
本地或网站更新不会自动更新腾讯云已审核的模板；需重新上传、等待审核，并核对后台模板 ID。

官方参考：[SendEmail 参数](https://cloud.tencent.com/document/api/1288/51034)、[模板变量](https://cloud.tencent.com/document/api/1288/51053)、[创建邮件模板](https://cloud.tencent.com/document/api/1288/51042)。
