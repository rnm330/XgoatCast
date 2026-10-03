# 雨云对象存储：下载安装包与后续上传

## 你现在的实例

- 登录入口：[产品独立面板](https://app.rainyun.com/panel/)。这是产品面板账号，不是雨云主站账号；不要在 `/auth/login` 使用这组面板凭据。
- 实例：浙江宁波 `#13674`。
- 套餐：宁波测试 100G 存储＋100G 流量；面板当前显示套餐到期日 `2027-10-11`。
- 存储桶：`xgoat`，桶 ID `20200`。
- S3 API 端点：`https://cn-nb2.rains3.com`。
- 流量在每个重置周期内使用，当前面板显示下次重置日期 `2026-11-04`。从对象存储发给用户的下载流量会计入套餐，上传流量不计费。100GB 流量对约 19MiB 的安装包可支持约五千次完整下载，实际以控制台统计为准。

面板明确提示第二代对象存储仍在测试，数据可能被清除。当前用于测试分发，本地保留安装包与哈希；长期正式发布可迁到正式套餐，网站和客户端仍沿用同一个发布页。

## 在网页上怎么上传

1. 登录独立面板，进入「我的产品 → 对象存储」。
2. 左侧「我的实例」用于管理套餐、凭据和实例开关；右侧「我的存储桶」用于管理文件。
3. 在实例 `#13674` 的「信息与监控」中查看 Endpoint、Access Key、Secret Key。它们用于脚本或 S3 客户端，不能放进下载链接、网页或公开截图。
4. 实例「开启公共访问」已启用，当前安装包可匿名下载。桶页面也有公共访问开关；实例开关会影响实例下的所有桶，因此这个实例只存公开安装包。
5. 点击 `xgoat` 桶进入「文件」，按需要创建 `downloads/windows/<版本>/` 目录。
6. 点击「上传」，选择 `XgoatCast-<版本>-win-x64-setup.exe`，等待完成。
7. 文件菜单中复制永久公开链接，不能使用有时效的临时链接。

公开链接的结构：

```text
https://cn-nb2.rains3.com/xgoat/downloads/windows/<版本>/XgoatCast-<版本>-win-x64-setup.exe
```

这样用户不需要账号或提取码，直接下载安装程序。下载由对象存储提供，网站服务器的 15Mbps 带宽只用于网页与版本信息。

## 后续用脚本上传

私密配置保存在 `~/.config/xgoatcast/release.env`，也可复制项目 `.env.release.example` 为 `.env.release`。Endpoint 必须带 `https://`，区域填写 `rainyun`，使用 Path Style。

准备好新版本安装包与对应说明后，在项目根目录运行：

```bash
npm run release:client -- --notes-file docs/releases/<版本>.md
```

脚本按版本上传安装包，生成最新下载链接、SHA-256 和历史日志。然后部署网站：

```bash
bash deploy.sh
```

日常无需手动编辑下载按钮或更新清单。完整的构建、版本递增与回滚顺序见 [Windows 客户端发布流程](WINDOWS_CLIENT_RELEASE.md)。

## 在面板中看哪里

- 「信息与监控」：套餐到期时间、存储占用、已用流量及下次重置时间。
- 「存储桶 → 文件」：已上传安装包。
- 「域名管理」：以后可绑定下载专用域名，当前使用雨云默认 HTTPS 地址。
- 公共访问用于匿名下载，不能把上传密钥放给用户。
- 弹性计费会涉及套餐外扣费，当前流程不需要开启；额度用尽后按实际需要升级套餐。

官方参考：[快速开始](https://www.rainyun.com/docs/products/ros/buy/quickstart)、[管理实例](https://www.rainyun.com/docs/products/ros/detail/manage)、[Node.js S3 接入](https://www.rainyun.com/docs/products/ros/practice/nodejs)、[流量计费说明](https://www.rainyun.com/docs/products/ros/buy/billing)。
