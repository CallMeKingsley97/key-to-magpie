# Key to Magpie

Chrome 插件：在 [new-api](https://github.com/QuantumNous/new-api) / [sub2api](https://github.com/Wei-Shaw/sub2api) 的令牌管理页面增加「导入到 magpie」按钮，把你的 API Key 通过 [magpie](https://github.com/yetone/magpie) 官方导入协议（`magpie://import` 链接）一键导入为 provider。

## 安装

1. 打开 Chrome，进入 `chrome://extensions`
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
| models | new-api 令牌的「模型限制」列表（未限制则留空） |
| catalog / website / keys | 自动补全（models.dev、站点首页、令牌页地址） |

高级设置里可以改名称前缀、catalog，以及四个端点各自的开关；偏好按站点记忆。

## 安全说明

- 插件只在当前站点内发同源请求读取令牌列表和明文 key，不经过任何第三方服务器
- key 只出现在 magpie 导入链接里；链接在扩展内页打开后立即从地址栏清除
- magpie 收到链接后会先显示确认弹窗，你点 Add 才会写入 `~/.config/magpie/providers.json`
- 插件不申请任何 host 权限，只在匹配的令牌页路径下激活

## 手动测试清单

- [ ] `chrome://extensions` 加载本目录，无报错
- [ ] 打开 `https://api.chengmo.cc.cd/keys`（new-api），页面出现「导入到 magpie」按钮
- [ ] 点击按钮，面板列出账号下的所有令牌
- [ ] 勾选一个 key 导入 → magpie 弹出确认窗，host / key / 模型正确 → 点 Add
- [ ] magpie Providers 页面出现新 provider，端点可正常对话
- [ ] 全选导入 → 队列模式逐个完成，全部出现在 magpie
- [ ] （可选）在 sub2api 站 `/keys` 页重复上述验证
- [ ] 高级设置里关闭某个端点（如 gemini），导入后 magpie 中该端点为空

## 文件结构

```
manifest.json   扩展配置（MV3，无 host 权限）
content.js      页面脚本：注入按钮、读取令牌、生成导入链接、导入队列
background.js   service worker：打开/复用导入页标签
open.html/js    扩展内导入页：唤起 magpie 协议 + 兜底说明
popup.html/js   工具栏弹窗：在当前标签页唤起导入面板
icons/          扩展图标
```
