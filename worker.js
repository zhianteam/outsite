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

  // 如果是 HTML 响应，对内容进行修改
  if (contentType && contentType.includes('text/html')) {
    const html = await responseClone.text()
    // 修改所有以 http:// 或 https:// 开头的链接，以及所有以 / 开头的相对链接
    // OpenWeb Proxy核心JS钩子（精简版，防止无限重定向）
    const proxyInjection = `
    (function(){
      // 防止重复注入
      if(window.__PROXY_INJECTED__) return; window.__PROXY_INJECTED__=true;
      // 防止无限重定向
      if(window.__PROXY_REDIRECT_COUNT__===undefined) window.__PROXY_REDIRECT_COUNT__=0;
      if(window.__PROXY_REDIRECT_COUNT__>5) { alert('Too many proxy redirects!'); return; }
      window.__PROXY_REDIRECT_COUNT__++;
      // 动态劫持fetch、XHR、open、setAttribute、appendChild、location、history等
      function changeURL(url){
        try{
          if(!url||typeof url!=='string') return url;
          if(url.startsWith('data:')||url.startsWith('mailto:')||url.startsWith('javascript:')||url.startsWith('chrome')||url.startsWith('edge')) return url;
          if(url.startsWith(window.location.origin+'/')) return url;
          if(url.startsWith('//')) url = window.location.protocol + url;
          let u = new URL(url, window.location.href);
          // 只代理http/https且不是本地
          if((u.protocol==='http:'||u.protocol==='https:') && u.host!==window.location.host){
            return window.location.origin + '/' + u.host + u.pathname + u.search + u.hash;
          }
        }catch(e){}
        return url;
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
        if(name==='src'||name==='href') value = changeURL(value);
        return origSetAttr.call(this, name, value);
      };
      // appendChild
      const origAppendChild = Node.prototype.appendChild;
      Node.prototype.appendChild = function(child){
        try{
          if(child.src) child.src = changeURL(child.src);
          if(child.href) child.href = changeURL(child.href);
        }catch{};
        return origAppendChild.call(this, child);
      };
      // location.assign/replace/href
      const origAssign = window.location.assign;
      window.location.assign = function(url){ origAssign.call(window.location, changeURL(url)); };
      const origReplace = window.location.replace;
      window.location.replace = function(url){ origReplace.call(window.location, changeURL(url)); };
      Object.defineProperty(window.location, 'href', {
        set: function(url){ origAssign.call(window.location, changeURL(url)); },
        get: function(){ return origAssign.toString(); }
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
    })();
    `;
    const modifiedHtml = html
      // 1. 绝对链接转镜像
      .replace(/(href|src|action)="https?:\/\/([^\"/]+)([^\"]*)"/g, (match, attr, host, path) => {
        const mirrorUrl = `https://${url.host}/${host}${path}`
        return `${attr}="${mirrorUrl}"`
      })
      // 1.1 协议相对链接 //host/path 转镜像
      .replace(/(href|src|action)="\/\/([^\"/]+)([^\"]*)"/g, (match, attr, host, path) => {
        const mirrorUrl = `https://${url.host}/${host}${path}`
        return `${attr}="${mirrorUrl}"`
      })
      // 2. url("https://...") 样式转镜像
      .replace(/url\("https?:\/\/([^\"/]+)([^\"]*)"\)/g, (match, host, path) => {
        const mirrorUrl = `https://${url.host}/${host}${path}`
        return `url("${mirrorUrl}")`
      })
      // 2.1 url("//host/path") 样式转镜像
      .replace(/url\("\/\/([^\"/]+)([^\"]*)"\)/g, (match, host, path) => {
        const mirrorUrl = `https://${url.host}/${host}${path}`
        return `url("${mirrorUrl}")`
      })
      // 3. 以 / 开头的相对链接补全为 /当前域名/xxx
      .replace(/(href|src|action)="\/(?!\/)([^\"]*)"/g, (match, attr, path) => {
        // 只补全不是 // 开头的
        return `${attr}="/${targetDomain}/${path}"`
      })
      // 4. url("/xxx") 补全为 /当前域名/xxx
      .replace(/url\("\/(?!\/)([^\"]*)"\)/g, (match, path) => {
        return `url("/${targetDomain}/${path}")`
      })
      // 5. 插入 OpenWeb Proxy 动态代理JS钩子
      .replace(/<\/body>/, `<script>${proxyInjection}</script></body>`)

    return new Response(modifiedHtml, {
      status: response.status,
      headers: response.headers,
    })
  }

  // 如果不是 HTML 响应，直接返回原始响应
  return response
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