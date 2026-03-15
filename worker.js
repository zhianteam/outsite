/**
 * 跨站网络加速 - Cloudflare Workers 反向代理
 * @version 260315-dev3
 * @description 增强型反向代理，支持深度 JS 钩子和智能 URL 重写
 * @author 致安团队 (Zhian Team)
 * @license GPL-3.0
 */

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)

  // 如果访问的是根域名（即没有路径），返回索引页面
  if (url.pathname === '/') {
    return new Response(indexHtml(), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }

  // 解析请求路径，支持 /http(s)//domain/xxx 及 /domain/xxx
  const pathSegments = url.pathname.split('/');
  if (pathSegments.length < 2) {
    return new Response('Invalid path', { status: 400 });
  }

  let targetProtocol = 'https:';
  let targetDomain = '';
  let targetPath = '';
  if ((pathSegments[1] === 'http' || pathSegments[1] === 'https') && pathSegments[2]) {
    // 形如 /http//www.google.com/xxx
    targetProtocol = pathSegments[1] + ':';
    targetDomain = pathSegments[2];
    targetPath = pathSegments.slice(3).join('/');
  } else {
    // 形如 /www.google.com/xxx
    targetDomain = pathSegments[1];
    targetPath = pathSegments.slice(2).join('/');
  }
  // 构造目标 URL
  const targetUrl = `${targetProtocol}//${targetDomain}/${targetPath}${url.search}`;

  // 修改请求头，设置目标域名
  const newRequestHeaders = new Headers(request.headers)
  newRequestHeaders.set('Host', targetDomain)

  // 转发请求到目标网站
  const response = await fetch(targetUrl, {
    method: request.method,
    headers: newRequestHeaders,
    body: request.body,
  })

  // 处理返回的响应
  const responseClone = response.clone()
  const contentType = response.headers.get('content-type')

  // 移除限制性响应头
  const newResponseHeaders = new Headers(response.headers)
  // 只在非 Cloudflare 验证页面时移除 CSP（保留验证页面的 CSP）
  const isChallengeResponse = response.headers.get('cf-mitigated') || 
                               response.headers.get('cf-chl-bypass') ||
                               (contentType && contentType.includes('text/html') && 
                                (await responseClone.clone().text()).includes('challenges.cloudflare.com'))
  
  if (!isChallengeResponse) {
    newResponseHeaders.delete('Content-Security-Policy')
    newResponseHeaders.delete('Content-Security-Policy-Report-Only')
  }
  newResponseHeaders.delete('X-Frame-Options')
  newResponseHeaders.set('Access-Control-Allow-Origin', '*')

  // 如果是 HTML 响应，对内容进行修改
  if (contentType && contentType.includes('text/html')) {
    const html = await responseClone.text()
    // 修改所有以 http:// 或 https:// 开头的链接，以及所有以 / 开头的相对链接
    // OpenWeb Proxy核心JS钩子（增强版）
    const proxyInjection = `
    (function(){
      // 防止重复注入
      if(window.__PROXY_INJECTED__) return; window.__PROXY_INJECTED__=true;
      // 防止无限重定向
      if(window.__PROXY_REDIRECT_COUNT__===undefined) window.__PROXY_REDIRECT_COUNT__=0;
      if(window.__PROXY_REDIRECT_COUNT__>5) { console.error('Too many proxy redirects!'); return; }
      window.__PROXY_REDIRECT_COUNT__++;
      
      // URL 转换核心函数
      function changeURL(url){
        try{
          if(!url||typeof url!=='string') return url;
          // 特殊协议直接放行
          if(url.startsWith('data:')||url.startsWith('mailto:')||url.startsWith('javascript:')||url.startsWith('chrome')||url.startsWith('edge')||url.startsWith('about:')) return url;
          // Cloudflare 验证相关域名白名单（不代理）
          if(url.includes('challenges.cloudflare.com')||url.includes('cloudflare.com/cdn-cgi/')||url.includes('/cdn-cgi/challenge')) return url;
          // 已经是代理路径，不再处理
          if(url.startsWith(window.location.origin+'/')) return url;
          // 协议相对链接补全
          if(url.startsWith('//')) url = window.location.protocol + url;
          let u = new URL(url, window.location.href);
          // 只代理http/https且不是本地
          if((u.protocol==='http:'||u.protocol==='https:') && u.host!==window.location.host){
            return window.location.origin + '/' + u.host + u.pathname + u.search + u.hash;
          }
        }catch(e){}
        return url;
      }
      
      // 处理 HTML 字符串中的 URL
      function processHTML(html){
        if(typeof html!=='string') return html;
        return html
          .replace(/(href|src|action)=["']https?:\\/\\/([^"'\\/]+)([^"']*)["']/gi, (m,a,h,p)=>\`\${a}="\${window.location.origin}/\${h}\${p}"\`)
          .replace(/(href|src|action)=["']\\/\\/([^"'\\/]+)([^"']*)["']/gi, (m,a,h,p)=>\`\${a}="\${window.location.origin}/\${h}\${p}"\`)
          .replace(/url\\(["']?https?:\\/\\/([^"')\\/]+)([^"')]*)["']?\\)/gi, (m,h,p)=>\`url("\${window.location.origin}/\${h}\${p}")\`);
      }
      
      // fetch
      const origFetch = window.fetch;
      window.fetch = function(input, init){
        let url = (typeof input==='string')?input:(input&&input.url)||input;
        url = changeURL(url);
        if(typeof input==='string') return origFetch(url, init);
        else{
          const newReq = new Request(url, input);
          return origFetch(newReq, init);
        }
      };
      
      // XHR
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args){
        url = changeURL(url);
        return origOpen.call(this, method, url, ...args);
      };
      
      // window.open
      const origWinOpen = window.open;
      window.open = function(url, ...args){
        url = changeURL(url);
        return origWinOpen.call(window, url, ...args);
      };
      
      // setAttribute
      const origSetAttr = HTMLElement.prototype.setAttribute;
      HTMLElement.prototype.setAttribute = function(name, value){
        if((name==='src'||name==='href'||name==='action') && typeof value==='string') value = changeURL(value);
        return origSetAttr.call(this, name, value);
      };
      
      // appendChild
      const origAppendChild = Node.prototype.appendChild;
      Node.prototype.appendChild = function(child){
        try{
          if(child.src) child.src = changeURL(child.src);
          if(child.href) child.href = changeURL(child.href);
          if(child.action) child.action = changeURL(child.action);
        }catch{}
        return origAppendChild.call(this, child);
      };
      
      // insertBefore
      const origInsertBefore = Node.prototype.insertBefore;
      Node.prototype.insertBefore = function(newNode, refNode){
        try{
          if(newNode.src) newNode.src = changeURL(newNode.src);
          if(newNode.href) newNode.href = changeURL(newNode.href);
          if(newNode.action) newNode.action = changeURL(newNode.action);
        }catch{}
        return origInsertBefore.call(this, newNode, refNode);
      };
      
      // replaceChild
      const origReplaceChild = Node.prototype.replaceChild;
      Node.prototype.replaceChild = function(newChild, oldChild){
        try{
          if(newChild.src) newChild.src = changeURL(newChild.src);
          if(newChild.href) newChild.href = changeURL(newChild.href);
          if(newChild.action) newChild.action = changeURL(newChild.action);
        }catch{}
        return origReplaceChild.call(this, newChild, oldChild);
      };
      
      // innerHTML / outerHTML
      const origInnerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      Object.defineProperty(Element.prototype, 'innerHTML', {
        set: function(html){ origInnerHTMLDesc.set.call(this, processHTML(html)); },
        get: function(){ return origInnerHTMLDesc.get.call(this); }
      });
      const origOuterHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
      Object.defineProperty(Element.prototype, 'outerHTML', {
        set: function(html){ origOuterHTMLDesc.set.call(this, processHTML(html)); },
        get: function(){ return origOuterHTMLDesc.get.call(this); }
      });
      
      // document.write / writeln
      const origWrite = document.write;
      document.write = function(html){ origWrite.call(document, processHTML(html)); };
      const origWriteln = document.writeln;
      document.writeln = function(html){ origWriteln.call(document, processHTML(html)); };
      
      // location.assign/replace/href
      const origAssign = window.location.assign;
      window.location.assign = function(url){ origAssign.call(window.location, changeURL(url)); };
      const origReplace = window.location.replace;
      window.location.replace = function(url){ origReplace.call(window.location, changeURL(url)); };
      const origHrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
      Object.defineProperty(window.location, 'href', {
        set: function(url){ origHrefDesc.set.call(window.location, changeURL(url)); },
        get: function(){ return origHrefDesc.get.call(window.location); }
      });
      
      // history
      const origPush = history.pushState;
      history.pushState = function(state, title, url){
        if(url) url = changeURL(url);
        return origPush.call(history, state, title, url);
      };
      const origReplaceState = history.replaceState;
      history.replaceState = function(state, title, url){
        if(url) url = changeURL(url);
        return origReplaceState.call(history, state, title, url);
      };
      
      // MutationObserver 监听 DOM 变化
      const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
          mutation.addedNodes.forEach(node => {
            if(node.nodeType === 1){
              try{
                if(node.src) node.src = changeURL(node.src);
                if(node.href) node.href = changeURL(node.href);
                if(node.action) node.action = changeURL(node.action);
                // 递归处理子元素
                node.querySelectorAll('[src],[href],[action]').forEach(el => {
                  if(el.src) el.src = changeURL(el.src);
                  if(el.href) el.href = changeURL(el.href);
                  if(el.action) el.action = changeURL(el.action);
                });
              }catch{}
            }
          });
        });
      });
      observer.observe(document.documentElement, {childList: true, subtree: true});
    })();
    `;
    const modifiedHtml = html
      // 0. 保护 Cloudflare 验证相关的 URL（不替换）
      .replace(/(challenges\.cloudflare\.com|cloudflare\.com\/cdn-cgi\/)/g, '__CF_PROTECTED__$1')
      // 1. 双引号属性：绝对链接
      .replace(/(href|src|action|data)="https?:\/\/([^\"/]+)([^\"]*)"/gi, (match, attr, host, path) => {
        if(host.includes('__CF_PROTECTED__')) return match.replace(/__CF_PROTECTED__/g, '')
        return `${attr}="https://${url.host}/${host}${path}"`
      })
      // 2. 单引号属性：绝对链接
      .replace(/(href|src|action|data)='https?:\/\/([^'\/]+)([^']*)'/gi, (match, attr, host, path) => {
        return `${attr}='https://${url.host}/${host}${path}'`
      })
      // 3. 无引号属性：绝对链接（不规范但有些网站这么写）
      .replace(/(href|src|action|data)=https?:\/\/([^\s>]+)/gi, (match, attr, hostpath) => {
        return `${attr}="https://${url.host}/${hostpath}"`
      })
      // 4. 协议相对链接 //host/path（双引号）
      .replace(/(href|src|action|data)="\/\/([^\"/]+)([^\"]*)"/gi, (match, attr, host, path) => {
        return `${attr}="https://${url.host}/${host}${path}"`
      })
      // 5. 协议相对链接（单引号）
      .replace(/(href|src|action|data)='\/\/([^'\/]+)([^']*)'/gi, (match, attr, host, path) => {
        return `${attr}='https://${url.host}/${host}${path}'`
      })
      // 6. CSS url() 双引号
      .replace(/url\("https?:\/\/([^\"/]+)([^\"]*)"\)/gi, (match, host, path) => {
        return `url("https://${url.host}/${host}${path}")`
      })
      // 7. CSS url() 单引号
      .replace(/url\('https?:\/\/([^'\/]+)([^']*)'\)/gi, (match, host, path) => {
        return `url('https://${url.host}/${host}${path}')`
      })
      // 8. CSS url() 无引号
      .replace(/url\(https?:\/\/([^\s)]+)\)/gi, (match, hostpath) => {
        return `url("https://${url.host}/${hostpath}")`
      })
      // 9. CSS url() 协议相对
      .replace(/url\(["']?\/\/([^\s)"']+)["']?\)/gi, (match, hostpath) => {
        return `url("https://${url.host}/${hostpath}")`
      })
      // 10. CSS @import
      .replace(/@import\s+["']https?:\/\/([^\"/]+)([^"']*)["']/gi, (match, host, path) => {
        return `@import "https://${url.host}/${host}${path}"`
      })
      // 11. 相对路径（双引号）
      .replace(/(href|src|action|data)="\/(?!\/)([^\"]*)"/gi, (match, attr, path) => {
        return `${attr}="/${targetDomain}/${path}"`
      })
      // 12. 相对路径（单引号）
      .replace(/(href|src|action|data)='\/(?!\/)([^']*)'/gi, (match, attr, path) => {
        return `${attr}='/${targetDomain}/${path}'`
      })
      // 13. CSS url() 相对路径
      .replace(/url\(["']?\/(?!\/)([^\s)"']*)["']?\)/gi, (match, path) => {
        return `url("/${targetDomain}/${path}")`
      })
      // 14. srcset 属性（响应式图片）
      .replace(/srcset="([^"]*)"/gi, (match, srcset) => {
        const newSrcset = srcset.replace(/https?:\/\/([^\s,]+)/g, (m, hostpath) => {
          return `https://${url.host}/${hostpath}`
        }).replace(/\/\/([^\s,]+)/g, (m, hostpath) => {
          return `https://${url.host}/${hostpath}`
        }).replace(/\s\/([^\s,]+)/g, (m, path) => {
          return ` /${targetDomain}/${path.trim()}`
        })
        return `srcset="${newSrcset}"`
      })
      // 15. meta refresh 重定向
      .replace(/<meta([^>]*http-equiv=["']?refresh["']?[^>]*)>/gi, (match, attrs) => {
        return match.replace(/url=([^\s;"'>]+)/gi, (m, metaUrl) => {
          if(metaUrl.startsWith('http://') || metaUrl.startsWith('https://')){
            const u = new URL(metaUrl)
            return `url=https://${url.host}/${u.host}${u.pathname}${u.search}${u.hash}`
          } else if(metaUrl.startsWith('//')){
            return `url=https://${url.host}/${metaUrl.substring(2)}`
          } else if(metaUrl.startsWith('/')){
            return `url=/${targetDomain}${metaUrl}`
          }
          return m
        })
      })
      // 16. 处理 <base> 标签（移除或重写）
      .replace(/<base\s+href=["']([^"']+)["'][^>]*>/gi, '')
      // 17. 插入 JS 钩子（优先在 <head> 末尾，否则 <body> 开头）
      .replace(/<\/head>/i, `<script>${proxyInjection}</script></head>`)
      .replace(/<body([^>]*)>/i, (match, attrs) => {
        if(html.includes('</head>')) return match
        return `<body${attrs}><script>${proxyInjection}</script>`
      })
      // 18. 恢复被保护的 Cloudflare URL
      .replace(/__CF_PROTECTED__/g, '')

    return new Response(modifiedHtml, {
      status: response.status,
      headers: newResponseHeaders,
    })
  }

  // 如果是 CSS 响应，也需要处理 url()
  if (contentType && (contentType.includes('text/css') || contentType.includes('application/css'))) {
    const css = await responseClone.text()
    const modifiedCss = css
      .replace(/url\(["']?https?:\/\/([^\s)"']+)["']?\)/gi, (match, hostpath) => {
        return `url("https://${url.host}/${hostpath}")`
      })
      .replace(/url\(["']?\/\/([^\s)"']+)["']?\)/gi, (match, hostpath) => {
        return `url("https://${url.host}/${hostpath}")`
      })
      .replace(/url\(["']?\/(?!\/)([^\s)"']*)["']?\)/gi, (match, path) => {
        return `url("/${targetDomain}/${path}")`
      })
      .replace(/@import\s+["']https?:\/\/([^\s"']+)["']/gi, (match, hostpath) => {
        return `@import "https://${url.host}/${hostpath}"`
      })
    
    return new Response(modifiedCss, {
      status: response.status,
      headers: newResponseHeaders,
    })
  }

  // 其他响应直接返回，但使用修改后的响应头
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newResponseHeaders,
  })
}

// 返回索引页面的 HTML 内容
function indexHtml() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="HandheldFriendly" content="true">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>跨站网络加速 - 致安.</title>
  <link rel="stylesheet" href="https://unpkg.com/mdui@1.0.2/dist/css/mdui.min.css">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    a {
      color: #ffffff;
    }
    
    body {
      background: #000000;
      color: #FFFFFF;
      font-family: 'Roboto', sans-serif;
    }
    
    .header {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      z-index: 9999;
    }
    
    .hero {
      width: 100%;
      height: 100vw;
      max-height: 600px;
      position: relative;
      overflow: hidden;
      background: linear-gradient(135deg, #1a1a1a 0%, #000000 100%);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .hero::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-image: 
        linear-gradient(90deg, rgba(200,200,200,0.03) 1px, transparent 1px),
        linear-gradient(rgba(200,200,200,0.03) 1px, transparent 1px);
      background-size: 50px 50px;
      animation: gridMove 20s linear infinite;
      z-index: 0;
    }
    
    @keyframes gridMove {
      0% { transform: translate(0, 0); }
      100% { transform: translate(50px, 50px); }
    }
    
    .hero-content {
      position: relative;
      z-index: 1;
      text-align: center;
      padding: 20px;
    }
    
    .hero-title {
      font-size: 3rem;
      font-weight: 300;
      margin-bottom: 1rem;
      letter-spacing: -0.02em;
    }
    
    .hero-subtitle {
      font-size: 1.2rem;
      font-weight: 300;
      color: #999;
      margin-bottom: 2rem;
    }
    
    .nav {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      color: #ffffff;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      z-index: 10;
    }
    
    .nav-text {
      box-sizing: border-box;
      display: inline-block;
      font-size: 20px;
      font-weight: 500;
      height: 96px;
      line-height: 24px;
      padding-top: 24px;
      width: 100%;
    }
    
    .nav-direction {
      font-size: 15px;
      line-height: 18px;
      margin-bottom: 1px;
      opacity: 0.55;
    }
    
    @media (min-width: 768px) {
      .hero {
        height: 75vw;
        max-height: 700px;
      }
    }
    
    @media (min-width: 1024px) {
      .hero {
        height: 56.25vw;
        max-height: calc(100vh - 100px);
      }
    }
    
    .custom-section {
      height: auto;
      padding: 30px;
    }
    
    .input-container {
      max-width: 600px;
      margin: 30px auto;
      background: #212121;
      padding: 30px;
      border-radius: 8px;
    }
    
    .mdui-textfield-input {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      padding: 12px 16px;
      color: #fff;
      font-size: 16px;
      width: 100%;
      margin-bottom: 15px;
      transition: all 0.3s;
    }
    
    .mdui-textfield-input:focus {
      background: rgba(255, 255, 255, 0.08);
      border-color: #2196F3;
      outline: none;
    }
    
    .mdui-textfield-input::placeholder {
      color: #666;
    }
    
    .features-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-top: 30px;
    }
    
    .feature-card {
      background: #212121;
      padding: 30px;
      border-radius: 8px;
      text-align: center;
      transition: all 0.3s;
    }
    
    .feature-card:hover {
      background: #2a2a2a;
      transform: translateY(-2px);
    }
    
    .feature-icon {
      font-size: 3rem;
      margin-bottom: 15px;
    }
    
    .feature-title {
      font-size: 1.2rem;
      margin-bottom: 10px;
    }
    
    .feature-desc {
      font-size: 0.9rem;
      color: #999;
    }
    
    .custom-footer {
      padding: 30px;
      background: #212121;
      text-align: center;
      color: #999;
    }
    
    .mdui-snackbar {
      z-index: 10000 !important;
      margin-top: 64px !important;
    }
    
    @media (max-width: 768px) {
      .hero-title {
        font-size: 2rem;
      }
      
      .hero-subtitle {
        font-size: 1rem;
      }
      
      .input-container {
        padding: 20px;
      }
    }
  </style>
</head>
<body class="mdui-theme-layout-dark">
  <div class="mdui-appbar mdui-appbar-fixed header">
    <div class="mdui-toolbar">
      <a href="javascript:;" class="mdui-btn mdui-btn-icon">
        <i class="mdui-icon material-icons">language</i>
      </a>
      <a href="javascript:;" class="mdui-typo-title">致安.</a>
      <div class="mdui-toolbar-spacer"></div>
      <a href="javascript:;" class="mdui-btn mdui-btn-icon" mdui-tooltip="{content: '帮助'}">
        <i class="mdui-icon material-icons">help_outline</i>
      </a>
    </div>
  </div>
  
  <div class="hero">
    <div class="hero-content">
      <h1 class="hero-title">跨站网络加速</h1>
      <p class="hero-subtitle">快速访问全球网站 · 突破网络限制</p>
    </div>
    
    <div class="nav mdui-color-theme">
      <div class="mdui-container">
        <div class="mdui-row">
          <div class="mdui-col-xs-2 mdui-col-sm-6"></div>
          <a href="#start" class="mdui-ripple mdui-color-theme mdui-col-xs-10 mdui-col-sm-6" style="text-align: right; display: block; text-decoration: none;">
            <div class="nav-text">
              <i class="mdui-icon material-icons" style="float: right; margin-left: 10px; padding-top: 23px;">arrow_forward</i>
              <span class="nav-direction" style="display: block;">Start</span>
              <div style="margin-right: 34px;">开始使用</div>
            </div>
          </a>
        </div>
      </div>
    </div>
  </div>
  
  <div class="custom-section" id="start">
    <h1>开始使用</h1>
    <p style="margin-bottom: 20px; color: #999;">输入您想要访问的网站域名</p>
    
    <div class="input-container">
      <input class="mdui-textfield-input" type="text" id="domainInput" placeholder="例如：www.google.com">
      <button class="mdui-btn mdui-btn-raised mdui-ripple mdui-color-theme-accent" onclick="goToMirror()" style="width: 100%;">
        <i class="mdui-icon material-icons">arrow_forward</i>
        立即访问
      </button>
    </div>
    
    <div class="features-grid">
      <div class="feature-card">
        <div class="feature-icon">🚀</div>
        <div class="feature-title">高速访问</div>
        <div class="feature-desc">全球CDN加速，毫秒级响应</div>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🔒</div>
        <div class="feature-title">安全加密</div>
        <div class="feature-desc">HTTPS加密传输，保护隐私</div>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🌍</div>
        <div class="feature-title">全球节点</div>
        <div class="feature-desc">覆盖全球主要地区</div>
      </div>
      <div class="feature-card">
        <div class="feature-icon">⚡</div>
        <div class="feature-title">即时响应</div>
        <div class="feature-desc">无需等待，即刻访问</div>
      </div>
    </div>
  </div>
  
  <div class="custom-footer">
    <p>&copy; 致安团队 Zhian Team, Co.</p>
  </div>

  <script src="https://unpkg.com/mdui@1.0.2/dist/js/mdui.min.js"></script>
  <script>
    function goToMirror() {
      const domain = document.getElementById('domainInput').value.trim();
      if (domain) {
        window.location.href = \`\${window.location.origin}/\${domain}\`;
      } else {
        mdui.snackbar({
          message: '请输入要访问的域名',
          position: 'top'
        });
      }
    }
    
    document.getElementById('domainInput').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        goToMirror();
      }
    });
  </script>
</body>
</html>
  `
}