# 跨站网络加速

部署在 Cloudflare Workers 上的增强型反向代理服务，通过将目标网站的请求转发到 Worker，实现对被限制网站的访问加速。内置深度 JS 钩子和智能 URL 重写，自动处理页面内的所有链接、动态请求、CSS 资源，保证页面内跳转和动态请求也能正常走代理。

---

## 工作原理

```
用户浏览器
    │
    ▼
Cloudflare Worker（你的域名）
    │  重写请求头 Host
    │  移除 CSP / X-Frame-Options
    ▼
目标网站（如 www.google.com）
    │
    ▼
Worker 处理响应
    │  HTML：17 种正则替换 + 注入增强 JS 钩子
    │  CSS：重写 url() 和 @import
    │  其他：透传（带修改后的响应头）
    ▼
用户浏览器
```

---

## URL 格式

Worker 支持两种路径格式：

| 格式 | 示例 | 说明 |
|------|------|------|
| `/域名/路径` | `/www.google.com/search?q=test` | 默认使用 HTTPS |
| `/协议//域名/路径` | `/https//example.com/path` | 显式指定协议 |

访问根路径 `/` 返回内置的使用引导页面。

---

## 部署

### 前置条件

- Cloudflare 账号
- 一个绑定到 Cloudflare 的域名（可选，也可用 `*.workers.dev` 免费子域名）

### 步骤

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers & Pages** → **创建 Worker**
3. 将 `worker.js` 的全部内容粘贴到编辑器
4. 点击 **部署**
5. 访问分配的 `*.workers.dev` 地址，或绑定自定义域名

### 绑定自定义域名

Workers & Pages → 你的 Worker → **触发器** → **添加自定义域** → 填入域名 → 保存。

---

## 使用方式

### 网页界面

直接访问 Worker 根路径，会显示内置的引导页面，输入目标域名点击「立即访问」即可。

### 直接构造 URL

```
https://你的worker域名/www.google.com
https://你的worker域名/github.com/torvalds/linux
https://你的worker域名/https//example.com/path?query=1
```

---

## 技术细节

### 响应头处理

自动移除或修改以下响应头，绕过浏览器安全限制：

- **智能移除** `Content-Security-Policy`（检测到 Cloudflare 验证页面时保留，避免验证失败）
- 移除 `Content-Security-Policy-Report-Only`
- 移除 `X-Frame-Options`（允许被 iframe 嵌入）
- 添加 `Access-Control-Allow-Origin: *`（解决跨域问题）

**Cloudflare 验证检测机制**：
- 检查响应头 `cf-mitigated` 或 `cf-chl-bypass`
- 检查页面内容是否包含 `challenges.cloudflare.com`
- 验证页面保留原始 CSP，确保验证脚本正常加载

### HTML 响应处理（18 种正则替换）

| 序号 | 处理内容 | 示例 |
|------|----------|------|
| 0 | 保护 Cloudflare 验证 URL | `challenges.cloudflare.com` |
| 1 | 双引号绝对链接 | `href="https://example.com"` |
| 2 | 单引号绝对链接 | `src='https://example.com'` |
| 3 | 无引号绝对链接 | `href=https://example.com` |
| 4-5 | 协议相对链接 | `src="//cdn.example.com"` |
| 6-8 | CSS `url()` 各种引号 | `url("https://...")` |
| 9 | CSS 协议相对 | `url(//cdn.example.com)` |
| 10 | CSS `@import` | `@import "https://..."` |
| 11-12 | 相对路径 | `href="/path"` |
| 13 | CSS 相对路径 | `url("/path")` |
| 14 | `srcset` 响应式图片 | `srcset="img.jpg 1x, img@2x.jpg 2x"` |
| 15 | `<meta refresh>` 重定向 | `<meta http-equiv="refresh" content="0;url=...">` |
| 16 | 移除 `<base>` 标签 | 避免基础 URL 冲突 |
| 17 | 注入 JS 钩子 | 优先在 `<head>` 末尾，否则 `<body>` 开头 |
| 18 | 恢复被保护的 URL | 还原 Cloudflare 验证 URL |

### CSS 响应处理

单独处理 CSS 文件（`text/css` / `application/css`），重写：

- `url()` 中的绝对、协议相对、相对路径
- `@import` 语句

### JS 钩子劫持范围（增强版）

注入的脚本会在页面运行时劫持以下 API，确保动态产生的请求也走代理：

**网络请求**
- `window.fetch`
- `XMLHttpRequest.prototype.open`

**DOM 操作**
- `HTMLElement.prototype.setAttribute`（`src` / `href` / `action`）
- `Node.prototype.appendChild`
- `Node.prototype.insertBefore`（新增）
- `Node.prototype.replaceChild`（新增）

**动态 HTML**
- `Element.prototype.innerHTML`（新增）
- `Element.prototype.outerHTML`（新增）
- `document.write`（新增）
- `document.writeln`（新增）

**导航**
- `window.open`
- `location.assign` / `location.replace` / `location.href`
- `history.pushState` / `history.replaceState`

**自动修复**
- `MutationObserver`（新增）—— 监听 DOM 变化，自动修复新插入的元素

**安全机制**
- 防重复注入检测
- 防无限重定向保护（最多 5 次）
- 过滤特殊协议（`data:`、`mailto:`、`javascript:`、`about:` 等）
- **Cloudflare 验证白名单**（`challenges.cloudflare.com`、`/cdn-cgi/` 不代理）

---

## 兼容性提升

相比基础版本，增强版新增：

- 支持单引号、无引号属性
- 支持 `srcset` 响应式图片
- 支持 `<meta refresh>` 重定向
- 支持 CSS 文件独立处理
- 支持 `innerHTML`/`outerHTML` 动态 HTML
- 支持 `document.write` 写入
- 支持 `MutationObserver` 自动修复
- 智能移除 CSP（保留 Cloudflare 验证页面的 CSP）
- **Cloudflare 验证白名单**（解决验证页面无法显示的问题）

---

## 限制与注意事项

- **WebSocket** 不支持（Cloudflare Workers 限制）
- **部分网站** 有 Cloudflare 检测或 IP 封锁，可能无法正常代理
- **Service Worker / PWA** 类网站可能因沙箱限制无法完整运行
- Cloudflare Workers 免费版每天有 **10 万次请求**限额，超出后需升级付费计划
- 本工具仅供学习和合法用途，请遵守当地法律法规

---

## 更新日志

**260315-dev3（验证修复版）**
- 修复 Cloudflare 验证页面无法显示的问题
- 新增 Cloudflare 验证域名白名单（`challenges.cloudflare.com`、`/cdn-cgi/`）
- 智能检测验证页面，保留其 CSP 响应头
- 正则替换新增保护机制，避免破坏验证 URL

**260315-dev2（增强版）**
- 新增 17 种正则替换规则，覆盖更多 URL 格式
- 新增 CSS 文件独立处理
- 新增响应头安全限制移除（CSP、X-Frame-Options）
- JS 钩子新增 `innerHTML`、`outerHTML`、`document.write` 劫持
- JS 钩子新增 `insertBefore`、`replaceChild` 劫持
- JS 钩子新增 `MutationObserver` 自动修复
- 修复 `location.href` getter 返回值错误
- 新增 `action` 属性处理（表单提交）

**260315-dev1（基础版）**
- 基础反向代理功能
- 5 种正则替换
- 基础 JS 钩子劫持

---

## 文件说明

| 文件 | 说明 |
|------|------|
| `worker.js` | Worker 全部逻辑，单文件部署 |
