# Key to Magpie

简体中文 | [English](./README_EN.md)

适用于 Chrome 和 Microsoft Edge（Chromium 111+）的扩展：在 [new-api](https://github.com/QuantumNous/new-api) / [sub2api](https://github.com/Wei-Shaw/sub2api) 的令牌管理页面增加「导入到 magpie」按钮，把你的 API Key 通过 [magpie](https://github.com/yetone/magpie) 官方导入协议（`magpie://import` 链接）一键导入为 provider。

## 安装

1. 打开 Chrome 的 `chrome://extensions`，或 Edge 的 `edge://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录（`key-to-magpie/`）
4. 确认 magpie 桌面应用已安装并至少运行过一次（`/Applications/magpie.app`）

## 使用

1. 打开中转站的令牌管理页：
   - new-api：`/token`（如 `https://your-station.com/token`）
   - sub2api：`/keys`
2. 页面上的「创建令牌 / 添加 API Key」按钮旁会出现 **「导入到 magpie」** 按钮（找不到创建按钮时显示在右下角）
3. 点击后会弹出面板，列出你所有的 key（名称、状态、分组、模型数、掩码 key）
4. 勾选要导入的 key（可单个、多个或全选），点「导入」
   - 单个 key：直接弹出 magpie 确认窗口
   - 多个 key：进入队列模式，逐个唤起 magpie，每个都要在 magpie 窗口里点 **Add / 添加** 确认
5. 回到 magpie 的 Providers 页面，确认新 provider 出现

## 导入映射

| magpie 配置项 | 来源 |
| --- | --- |
| name | `前缀 · 令牌名`（可在高级设置改前缀） |
| id | `host-前缀-令牌id` 自动生成的小写 slug |
| chat / responses | `https://站点/v1`（OpenAI 兼容端点） |
| anthropic | `https://站点`（Claude Code 用） |
| gemini | `https://站点/v1beta` |
| key | 令牌明文 key（经站点接口取回，只在本机传递） |
| models | new-api 令牌的「模型限制」列表；sub2api 用明文 key 调 `/v1/models` 取得（未限制则留空） |
| catalog / website / keys | 自动补全（models.dev、站点首页、令牌页地址） |
| icon | 站点在公开接口里配置的 logo（见下） |

### 图标

`icon` 优先取站点自己在公开接口里设置的 logo（new-api 的 `/api/status` →
`logo`，sub2api 的 `/api/v1/settings/public` → `site_logo`），取不到才退回
页面 favicon。

magpie 对 `icon` 校验很严（必须 https、公网 host、不带凭据和 fragment），
不合格的值会让整个导入链接失效，所以插件会先过滤；过滤后为空就不传这个
参数，由 magpie 用自己的字母色块或 catalog 图标——这比传一个所有中转站
都长一样的面板 favicon 更好。

### 余额查询

magpie 内置了 new-api 和 sub2api 的余额查询，但 `magpie://import` 没有
`balance` 参数，只能在导入后用 CLI 补上。勾选「高级设置 → 在批量命令中
配置余额查询」后，「批量命令」里每个 key 会多出一行：

```sh
magpie provider set '<id>' balance='https://站点/api/usage/token'
```

magpie 会按端点路径自动推断取值字段（new-api 的 `/api/usage/token`、
sub2api 的 `/v1/usage`），所以只需要给 URL。这个开关只影响「批量命令」，
因为单个导入走的是图形界面，没有执行命令的环节。

### 端点探测

不同中转站适配的 API 端点不一样（例如有的站点只有 `/v1/chat/completions`，
没有 Anthropic 的 `/v1/messages`）。导入面板打开时会向四个端点各发一个最小
请求做探测：

- `404 / 405` → 站点未适配该端点，自动取消勾选并在高级设置里标注「未检测到」
- `401 / 400 / 200` 等 → 端点存在，保持勾选
- 探测失败（网络错误等）→ 标记「未探测」，保持默认勾选

探测结果只影响默认勾选与提示，随时可以在「高级设置 → 导入的 API 端点」里
手动开关；手动改过端点后，偏好按站点记忆，探测不再改动你的选择。

高级设置里可以改名称前缀、catalog，以及四个端点各自的开关；偏好按站点记忆。

## 安全说明

- 插件只在当前站点内发同源请求读取令牌列表和明文 key，不经过任何第三方服务器
- 登录态在令牌页的页面上下文中读取和刷新，令牌只用于当前站点请求
- sub2api 站会用明文 key 调本站的 `/v1/models` 取模型列表，同样是同源请求
- key 只出现在 magpie 导入链接里；链接在扩展内页打开后立即从地址栏清除
- magpie 收到链接后会先显示确认弹窗，你点 Add 才会写入 `~/.config/magpie/providers.json`
- 为兼容登录后通过 SPA 切换到令牌页，插件会轻量检查 HTTP(S) 页面的 URL；只有进入令牌页路径后才扫描页面内容、显示按钮或请求站点 API

## 手动测试清单

- [ ] `chrome://extensions` 加载本目录，无报错
- [ ] 在 Edge 的 `edge://extensions` 加载本目录，刷新已登录的令牌页并确认面板能列出令牌
- [ ] 打开 `https://api.chengmo.cc.cd/keys`（new-api），页面出现「导入到 magpie」按钮
- [ ] 点击按钮，面板列出账号下的所有令牌
- [ ] 勾选一个 key 导入 → magpie 弹出确认窗，host / key / 模型正确 → 点 Add
- [ ] magpie Providers 页面出现新 provider，端点可正常对话
- [ ] 全选导入 → 队列模式逐个完成，全部出现在 magpie
- [ ] （可选）在 sub2api 站 `/keys` 页重复上述验证
- [ ] 高级设置里关闭某个端点（如 gemini），导入后 magpie 中该端点为空
- [ ] 打开一个只适配部分端点的站点，确认未适配的端点被自动取消勾选并标注「未检测到」
- [ ] 高级设置里「配置余额查询」显示本站余额接口地址（new-api 为 `/api/usage/token`，sub2api 为 `/v1/usage`）
- [ ] 用「批量命令」导入后，magpie 的 provider 卡片上出现余额
- [ ] sub2api 站导入后，magpie 里该 provider 的模型列表不为空
- [ ] 站点在后台设了自己的 logo 时，magpie 里 provider 显示的是站点 logo 而非面板默认图标

## 友情链接

- [linux.do](https://linux.do) — 新的理想型技术社区
- [V2EX](https://www.v2ex.com) — 创意工作者们的社区

## 文件结构

```
manifest.json   扩展配置（MV3，在 HTTP(S) 页面检查 SPA 路由）
content.js      页面脚本：注入按钮、读取令牌、生成导入链接、导入队列
background.js   service worker：打开/复用导入页标签
open.html/js    扩展内导入页：唤起 magpie 协议 + 兜底说明
popup.html/js   工具栏弹窗：在当前标签页唤起导入面板
icons/          扩展图标
```

## 许可证

[MIT](./LICENSE)
