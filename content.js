/**
 * Key to Magpie — content script
 *
 * 在 new-api / sub2api 的令牌管理页注入“导入到 magpie”按钮：
 *   1. 读取当前用户的所有令牌（new-api 需要再取一次明文 key）；
 *   2. 把每个令牌映射成 magpie 的 provider 配置（name / id / chat /
 *      responses / anthropic / gemini / key / models / website / keys / icon）；
 *   3. 通过 magpie 官方的 magpie://import 链接导入。
 *
 * 只做同源请求，不需要 host_permissions，也不会把 key 发到第三方服务器。
 */

'use strict';

(() => {
  if (window.__KTM_CONTENT__) return;
  window.__KTM_CONTENT__ = true;

  // ---------------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------------

  const ROOT_ID = 'ktm-root';
  const PREF_PREFIX = 'ktm:pref:';
  const SITE_ENABLED_PREFIX = 'ktm:site-enabled:';
  const PAGE_SIZE = 100;
  const MAX_TOKENS = 1000;
  const FETCH_TIMEOUT = 15000;
  const PROBE_TIMEOUT = 3000;
  const MAX_NAME_BYTES = 80;
  const MAX_MODELS = 200;

  const DEFAULT_ENDPOINTS = Object.freeze({
    chat: true,
    responses: true,
    anthropic: true,
    gemini: true,
  });

  const CREATE_BUTTON_RE =
    /(添加令牌|新增令牌|创建令牌|新建令牌|添加\s*API\s*密钥|新增\s*API\s*密钥|创建\s*API\s*密钥|新建\s*API\s*密钥|添加密钥|新增密钥|创建密钥|新建密钥|Create\s+API\s+Key|Add\s+API\s+Key|New\s+API\s+Key|Create\s+Token|Add\s+Token|New\s+Token|Create\s+Key|Add\s+Key)/i;
  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  const state = {
    enabled: true,
    contextInvalidated: false,
    featureController: new AbortController(),
    /** @type {null | ReturnType<typeof makeContext>} */
    ctx: null,
    /** @type {Token[]} */
    tokens: [],
    /** @type {Set<string>} */
    selected: new Set(),
    query: '',
    loading: false,
    busy: false,
    error: '',
    prefix: '',
    catalog: '',
    endpoints: { ...DEFAULT_ENDPOINTS },
    /**
     * 是否在批量命令里补一条 magpie provider set 配置余额查询。
     * import 链接没有 balance 参数，只能导入后用 CLI 补。
     */
    balance: true,
    /** @type {Record<'chat'|'responses'|'anthropic'|'gemini', string>} 各端点完整 URL（探测用） */
    endpointUrls: { chat: '', responses: '', anthropic: '', gemini: '' },
    /** @type {Record<string, 'ok'|'auth'|'forbidden'|'missing'|'unknown'|'skipped'>} 端点探测结果 */
    probe: {},
    probeDetails: {},
    probeMessage: '',
    probing: false,
    probeController: null,
    endpointSelectionTouched: false,
    endpointInputs: {},
    /** @type {{name:string,id:string,link:string,token:Token}[]} */
    queue: [],
    queueIndex: 0,
    queueDone: false,
    openTabId: null,
    batchOpen: false,
    batchText: '',
    keyCache: new Map(),
    newApiToken: '',
    newApiUserId: '',
    refreshPromise: null,
    subRefreshPromise: null,
    authError: '',

    host: null,
    shadow: null,
    dialogOpen: false,
    copyPromptOpen: false,
    copyPromptTrigger: null,
    listEl: null,
    countEl: null,
    selectAllBtn: null,
    importBtn: null,
    endpointSummaryEl: null,
    balanceHintEl: null,
    queueEl: null,
  };

  // ---------------------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------------------

  function extensionContextAvailable() {
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function invalidateExtensionContext() {
    if (state.contextInvalidated) return;
    state.contextInvalidated = true;
    state.enabled = false;
    state.featureController.abort();
    cancelEndpointProbe();
    setPageAuthEnabled(false);
    stopOnTokenPage();
    state.host?.remove();
    state.host = null;
    state.shadow = null;
    state.dialogOpen = false;
    state.copyPromptOpen = false;
    state.queue = [];
    state.tokens = [];
    state.selected.clear();
    state.keyCache.clear();
  }

  function extensionContextIsUsable() {
    if (state.contextInvalidated) return false;
    if (extensionContextAvailable()) return true;
    invalidateExtensionContext();
    return false;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'style') el.style.cssText = value;
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key === 'attrs') {
          for (const [attr, attrValue] of Object.entries(value)) {
            if (attrValue != null && attrValue !== false) el.setAttribute(attr, String(attrValue));
          }
        } else if (key.startsWith('on') && typeof value === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key in el) {
          try {
            el[key] = value;
          } catch {
            el.setAttribute(key, String(value));
          }
        } else {
          el.setAttribute(key, String(value));
        }
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function slug(value, max = 48) {
    return String(value || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '');
  }

  function truncateUtf8(value, maxBytes) {
    const encoder = new TextEncoder();
    let out = '';
    let bytes = 0;
    for (const ch of String(value || '')) {
      const size = encoder.encode(ch).length;
      if (bytes + size > maxBytes) break;
      out += ch;
      bytes += size;
    }
    return out;
  }

  function maskKey(key) {
    const value = String(key || '');
    if (!value) return '—';
    if (value.length <= 10) return value.slice(0, 3) + '••••';
    return value.slice(0, 6) + '••••' + value.slice(-4);
  }

  function isLocalHostname(host) {
    const value = String(host || '').toLowerCase();
    return (
      value === 'localhost' ||
      value === '::1' ||
      value.endsWith('.local') ||
      /^127\./.test(value) ||
      /^10\./.test(value) ||
      /^192\.168\./.test(value) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(value)
    );
  }

  function httpAllowed() {
    return location.protocol === 'https:' || isLocalHostname(location.hostname);
  }

  function cleanSiteName(value) {
    const name = String(value || '').trim();
    if (!name) return '';
    if (/^(new\s*api|newapi|sub2api|one\s*api|oneapi|api)$/i.test(name)) return '';
    return name.slice(0, 60);
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (result) => resolve(result || {}));
      } catch {
        resolve({});
      }
    });
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(value, () => resolve());
      } catch {
        resolve();
      }
    });
  }

  function siteEnabledKey() {
    return SITE_ENABLED_PREFIX + location.origin;
  }

  async function clipboardWrite(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.append(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, `'\\''`) + "'";
  }

  function toast(text, kind = 'info') {
    if (!state.enabled || !extensionContextIsUsable()) return;
    ensureHost();
    state.shadow.querySelectorAll('.ktm-toast').forEach((el) => el.remove());
    const el = h('div', {
      class: `ktm-toast ${kind}`,
      attrs: { role: 'status', 'aria-live': 'polite' },
    }, text);
    state.shadow.append(el);
    setTimeout(() => el.remove(), 3400);
  }

  // ---------------------------------------------------------------------------
  // 页面识别与注入
  // ---------------------------------------------------------------------------

  function makeMagpieIcon(size) {
    const icon = document.createElement('img');
    try {
      icon.src = chrome.runtime.getURL('icons/magpie.svg');
    } catch {
      invalidateExtensionContext();
      return icon;
    }
    icon.width = size;
    icon.height = size;
    icon.alt = '';
    icon.draggable = false;
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = `width:${size}px;height:${size}px;object-fit:contain;filter:brightness(0) invert(1);flex:none`;
    return icon;
  }

  function isTokenPage() {
    const path = location.pathname;
    if (/^\/(oauth|login|sign-?in|callback|auth)/i.test(path)) return false;
    return (
      /(^|\/)(keys?|tokens?|api-keys)(\/|$)/i.test(path) ||
      /\/console\/(token|keys)(\/|$)/i.test(path)
    );
  }

  function requestMagpieImportAfterCopy() {
    if (!state.enabled || state.copyPromptOpen) return;
    state.copyPromptTrigger =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTimeout(() => {
      if (!state.enabled || !isTokenPage() || state.copyPromptOpen) {
        if (!isTokenPage()) state.copyPromptTrigger = null;
        return;
      }
      state.copyPromptOpen = true;
      renderAll();
    }, 150);
  }

  function closeCopyPrompt(importNow = false) {
    const trigger = state.copyPromptTrigger;
    state.copyPromptOpen = false;
    state.copyPromptTrigger = null;
    renderAll();
    if (importNow) {
      openDialog();
    } else if (trigger && trigger.isConnected) {
      trigger.focus({ preventScroll: true });
    }
  }

  function findCreateButton() {
    const direct = document.querySelector('[data-tour="keys-create-btn"]');
    if (direct && isVisible(direct)) return direct;

    const candidates = Array.from(
      document.querySelectorAll('button, a[role="button"], [data-ktm-ignore], .btn')
    );
    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.closest('#' + ROOT_ID)) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.length > 40) continue;
      if (!CREATE_BUTTON_RE.test(text)) continue;
      if (!isVisible(el)) continue;
      return el;
    }
    return null;
  }

  function makeToolbarButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.ktm = 'toolbar';
    btn.title = '把当前账户的 API Key 导入 magpie';
    btn.style.cssText = [
      'all:unset',
      'box-sizing:border-box',
      'display:inline-flex',
      'align-items:center',
      'gap:6px',
      'height:32px',
      'padding:0 12px',
      'border-radius:8px',
      'cursor:pointer',
      'font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
      'color:#fff',
      'background:linear-gradient(135deg,#7c3aed,#ec4899)',
      'box-shadow:0 4px 12px rgba(124,58,237,.28)',
      'transition:transform .12s ease,box-shadow .12s ease,filter .12s ease',
      'white-space:nowrap',
      'user-select:none',
    ].join(';');
    btn.append(makeMagpieIcon(18), h('span', { text: '导入到 magpie' }));
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'translateY(-1px)';
      btn.style.filter = 'brightness(1.06)';
      btn.style.boxShadow = '0 8px 20px rgba(124,58,237,.38)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = '';
      btn.style.filter = '';
      btn.style.boxShadow = '0 4px 12px rgba(124,58,237,.28)';
    });
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDialog();
    });
    return btn;
  }

  function makeFloatingButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.ktm = 'floating';
    btn.append(makeMagpieIcon(20), h('span', { text: '导入到 magpie' }));
    btn.style.cssText = [
      'all:unset',
      'box-sizing:border-box',
      'position:fixed',
      'right:22px',
      'bottom:22px',
      'z-index:2147483000',
      'display:inline-flex',
      'align-items:center',
      'gap:8px',
      'height:42px',
      'padding:0 18px',
      'border-radius:999px',
      'cursor:pointer',
      'font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
      'color:#fff',
      'background:linear-gradient(135deg,#7c3aed,#ec4899)',
      'box-shadow:0 12px 34px rgba(124,58,237,.4)',
      'transition:transform .12s ease,filter .12s ease',
      'white-space:nowrap',
      'user-select:none',
    ].join(';');
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'translateY(-2px)';
      btn.style.filter = 'brightness(1.06)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = '';
      btn.style.filter = '';
    });
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDialog();
    });
    return btn;
  }

  function ensureFloatingButton() {
    if (
      !state.enabled ||
      state.contextInvalidated ||
      document.querySelector('[data-ktm="floating"]')
    ) return;
    const button = makeFloatingButton();
    if (state.enabled && !state.contextInvalidated) document.documentElement.append(button);
  }

  function removeFloatingButton() {
    document.querySelectorAll('[data-ktm="floating"]').forEach((el) => el.remove());
  }

  function injectUi() {
    if (state.contextInvalidated) return;
    if (!extensionContextIsUsable()) return;
    if (!state.enabled) {
      document.querySelectorAll('[data-ktm="toolbar"], [data-ktm="floating"]').forEach((el) => el.remove());
      return;
    }
    if (!isTokenPage()) {
      document.querySelectorAll('[data-ktm="toolbar"], [data-ktm="floating"]').forEach((el) => el.remove());
      return;
    }

    const existing = document.querySelector('[data-ktm="toolbar"]');
    const target = findCreateButton();

    if (target) {
      removeFloatingButton();
      if (!existing) {
        try {
          const button = makeToolbarButton();
          if (state.enabled && !state.contextInvalidated) {
            target.insertAdjacentElement('afterend', button);
          }
        } catch {
          if (state.enabled && !state.contextInvalidated) ensureFloatingButton();
        }
      }
      return;
    }

    if (!existing) ensureFloatingButton();
  }

  const scheduleInject = debounce(injectUi, 260);

  // ---------------------------------------------------------------------------
  // 站点识别
  // ---------------------------------------------------------------------------

  function pathPrefixes() {
    const parts = location.pathname.split('/').filter(Boolean);
    const out = new Set(['']);
    const index = parts.findIndex((part) => /^(keys?|tokens?|api-keys)$/i.test(part));
    if (index >= 0) {
      // 依次尝试所有祖先路径：/newapi/console/token → /newapi/console、
      // /newapi、''。短的优先，因为多数部署的 API 在根路径。
      for (let i = index; i >= 0; i -= 1) {
        const prefix = '/' + parts.slice(0, i).join('/');
        out.add(prefix === '/' ? '' : prefix);
      }
    }
    return Array.from(out).sort((a, b) => a.length - b.length);
  }

  /**
   * 检查一个候选图标 URL 能否作为 magpie 的 icon= 参数。
   *
   * magpie 对这个参数校验很严（见其 importurl.go 的 iconURL）：必须是
   * https、公网 host、不能带用户名密码或 fragment，否则整个导入链接会被
   * 判为无效。所以这里先过滤，宁可少传一个图标，也不能让导入失败。
   */
  function iconParam(value) {
    // 空值要单独挡掉：new URL('', base) 会解析成页面地址本身，
    // 而站点 logo 字段为空正是常见情况（此时应回退到 favicon）。
    // 含空白的值也不是 URL，同样挡掉，避免被当成相对路径解析。
    const raw = String(value || '').trim();
    if (!raw || /\s/.test(raw)) return '';
    try {
      const url = new URL(raw, location.href);
      if (url.protocol !== 'https:') return '';
      if (!url.hostname || isLocalHostname(url.hostname)) return '';
      if (url.username || url.password || url.hash) return '';
      if (url.href === location.href) return '';
      return url.href;
    } catch {
      return '';
    }
  }

  /**
   * 站点自己的 logo。
   *
   * new-api 与 sub2api 的公开接口都带站点 logo，这是站点运营者设置的图，
   * 比页面 favicon 更准确：magpie 的 favicon.go 明确说过，这类面板的
   * /favicon.ico 是面板自带的，每个中转站长得一模一样。
   */
  function findIcon(siteLogo) {
    const own = iconParam(siteLogo);
    if (own) return own;

    const candidates = Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]'));
    for (const link of candidates) {
      const url = iconParam(link.href);
      if (url) return url;
    }
    if (location.protocol === 'https:' && !isLocalHostname(location.hostname)) {
      return location.origin + '/favicon.ico';
    }
    return '';
  }

  /**
   * 站点的余额查询端点。
   *
   * magpie 内置了这两种面板的余额查询，都只需要 key，且会按路径自动推断
   * 取值字段（见其 balance.go 的 balancePathOf）：
   *   new-api  /api/usage/token  → $data.total_available / 500000
   *   sub2api  /v1/usage         → $remaining
   * 但 magpie://import 没有 balance 参数，只能导入后用 CLI 补上。
   */
  function balanceUrlFor(kind, origin, base) {
    if (kind === 'newapi') return origin + base + '/api/usage/token';
    if (kind === 'sub2api') return origin + base + '/v1/usage';
    return '';
  }

  function makeContext(kind, prefix, siteName, siteLogo) {
    const base = prefix || '';
    const origin = location.origin;
    const ctx = {
      kind,
      prefix: base,
      origin,
      host: location.hostname,
      siteName: cleanSiteName(siteName) || cleanSiteName(document.title) || location.hostname,
      anthropicBase: origin + base,
      openaiBase: origin + base + '/v1',
      geminiBase: origin + base + '/v1beta',
      website: origin,
      keysUrl: origin + location.pathname,
      icon: findIcon(siteLogo),
      /** 站点自己的余额查询端点（magpie provider set balance=…），没有则为空 */
      balanceUrl: balanceUrlFor(kind, origin, base),
    };
    ctx.endpointUrls = {
      chat: ctx.openaiBase + '/chat/completions',
      responses: ctx.openaiBase + '/responses',
      anthropic: ctx.anthropicBase + '/v1/messages',
      gemini: ctx.geminiBase + '/models',
    };
    return ctx;
  }

  /**
   * 探测各端点是否真的存在。
   *
   * 不同中转站适配的端点不一样（见 magpie 的「API 端点」面板：anthropic
   * /v1/messages、openai /v1/chat/completions 等）。不存在的端点导入后
   * magpie 里对话会 404，所以这里按 New API 文档发最小有效请求：
   * 使用一个已启用令牌的 API Key；不同协议使用各自要求的认证头。
   *   - 404 / 405 / 501 → 端点不存在，标记 missing（完整探测后默认取消勾选）
   *   - 401 / 403 → Key 认证失败或无权限，不视为端点已确认
   *   - 2xx → 端点响应成功，标记 ok
   *   - 其他 4xx（除 401 / 403）→ 请求被拒绝，无法确认端点可用
   *   - 其他状态或网络错误 → 无法确认，保留默认勾选
   *
   * 探测结果只影响默认勾选与 UI 提示，用户仍可在高级设置里手动开关。
   */
  function classifyProbeStatus(status) {
    if (status === 404 || status === 405 || status === 501) return 'missing';
    if (status === 401) return 'auth';
    if (status === 403) return 'forbidden';
    if (status >= 200 && status < 300) return 'ok';
    return 'unknown';
  }

  async function runProbeRequest(controller, run) {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PROBE_TIMEOUT);
    try {
      const value = await run(controller.signal);
      return { value, timedOut };
    } catch (error) {
      return { error, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchProbeStatus(url, options) {
    const response = await fetch(url, options);
    const result = { status: response.status, ok: response.ok };
    try {
      await response.body?.cancel();
    } catch {}
    return result;
  }

  async function probeEndpoints(ctx, controller) {
    const result = {};
    const details = {};
    const urls = ctx.endpointUrls;
    const signal = controller.signal;
    const token = state.tokens.find((item) => item.enabled);
    if (!token) {
      return { statuses: result, details, message: '没有启用的 API Key，未执行端点探测。', complete: false };
    }

    let apiKey = '';
    try {
      const resolved = await resolveKeys([token], false, signal);
      apiKey = resolved.map.get(token.id) || '';
    } catch {
      /* 未能读取 Key 时跳过探测，避免发送无认证请求 */
    }
    if (signal.aborted) return { cancelled: true };
    if (!apiKey) {
      return {
        statuses: result,
        details,
        message: '未能读取已启用令牌的 API Key，未执行端点探测。',
        complete: false,
      };
    }

    const bearer = { Authorization: `Bearer ${apiKey}` };
    const contentType = { 'Content-Type': 'application/json' };
    const modelResult = { model: '', status: 'unknown' };
    const modelRequest = await runProbeRequest(controller, async (requestSignal) => {
      const res = await fetch(ctx.openaiBase + '/models', {
        credentials: 'include',
        headers: bearer,
        signal: requestSignal,
      });
      modelResult.status = classifyProbeStatus(res.status);
      if (res.ok) {
        const json = await safeJson(res);
        if (requestSignal.aborted) return;
        const rows = json && Array.isArray(json.data) ? json.data : [];
        const firstModel = rows.find((row) => row && typeof row.id === 'string' && row.id.trim());
        if (firstModel) modelResult.model = firstModel.id.trim();
      } else {
        details.models = `HTTP ${res.status}`;
      }
    });
    if (signal.aborted && !modelRequest.timedOut) return { cancelled: true };
    if (modelRequest.error || modelRequest.timedOut) {
      modelResult.status = 'unknown';
      details.models = modelRequest.timedOut ? '超过 3 秒未响应，已停止后续探测' : '网络错误';
    }
    result.models = modelResult.status;

    if (modelRequest.timedOut) {
      return {
        statuses: {},
        details: { models: '超过 3 秒未响应，已停止后续探测' },
        message: '单个请求超过 3 秒，已停止后续探测；不影响导入。',
        complete: false,
      };
    }

    const model =
      modelResult.model ||
      (Array.isArray(token.models) ? token.models.find((item) => typeof item === 'string' && item.trim()) : '') ||
      '';
    if (!model) {
      result.chat = 'unknown';
      result.responses = 'unknown';
      result.anthropic = 'unknown';
      result.gemini = 'skipped';
      return {
        statuses: result,
        details,
        message: '未能从 /v1/models 或令牌限制中取得可用模型，未发送模型探测请求。',
        complete: false,
      };
    }

    const checks = [
      {
        key: 'chat',
        run: (requestSignal) =>
          fetchProbeStatus(urls.chat, {
            credentials: 'include',
            method: 'POST',
            headers: { ...contentType, ...bearer },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: 'Reply with 1.' }],
              max_tokens: 1,
            }),
            signal: requestSignal,
          }),
      },
      {
        key: 'responses',
        run: (requestSignal) =>
          fetchProbeStatus(urls.responses, {
            credentials: 'include',
            method: 'POST',
            headers: { ...contentType, ...bearer },
            body: JSON.stringify({ model, input: 'Reply with 1.', max_output_tokens: 1, store: false }),
            signal: requestSignal,
          }),
      },
      {
        key: 'anthropic',
        run: (requestSignal) =>
          fetchProbeStatus(urls.anthropic, {
            credentials: 'include',
            method: 'POST',
            headers: {
              ...contentType,
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'Reply with 1.' }],
            }),
            signal: requestSignal,
          }),
      },
    ];

    for (let index = 0; index < checks.length; index += 1) {
      const { key, run } = checks[index];
      const request = await runProbeRequest(controller, run);
      if (signal.aborted && !request.timedOut) return { cancelled: true };
      if (request.error || request.timedOut) {
        result[key] = 'unknown';
        details[key] = request.timedOut ? '超过 3 秒未响应，已停止后续探测' : '网络错误';
      } else {
        result[key] = classifyProbeStatus(request.value.status);
        if (!request.value.ok) details[key] = `HTTP ${request.value.status}`;
      }
      if (request.timedOut) {
        return {
          statuses: {},
          details: { [key]: '超过 3 秒未响应，已停止后续探测' },
          message: '单个请求超过 3 秒，已停止后续探测；不影响导入。',
          complete: false,
        };
      }
    }

    result.gemini = 'skipped';
    return {
      statuses: result,
      details,
      message: '已按顺序完成端点探测。为避免重复请求模型列表，本次未单独探测 Gemini。',
      complete: true,
    };
  }

  async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const upstreamSignal = options.signal || state.featureController.signal;
    const abortFromUpstream = () => controller.abort();
    if (upstreamSignal) {
      if (upstreamSignal.aborted) controller.abort();
      else upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
    }
    try {
      return await fetch(url, { credentials: 'include', ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    }
  }

  /**
   * 网络层重试：失败（网络错误/超时/5xx/429）后自动重试最多 2 次，
   * 退避 500ms → 1200ms。4xx 业务错误不重试。
   * 供无认证头的请求使用（detectContext、sub2api 列表等）。
   */
  async function fetchWithRetry(url, options = {}, timeout = FETCH_TIMEOUT) {
    let lastError = null;
    const signal = options.signal || state.featureController.signal;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) throw signal.reason || new Error('插件功能已关闭。');
      try {
        const response = await fetchWithTimeout(url, { ...options, signal }, timeout);
        if ((response.status >= 500 || response.status === 429) && attempt < 2) {
          lastError = new Error(`HTTP ${response.status}`);
          await sleep(attempt === 0 ? 500 : 1200);
          continue;
        }
        return response;
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        if (attempt < 2) await sleep(attempt === 0 ? 500 : 1200);
      }
    }
    throw lastError || new Error('请求失败');
  }

  async function safeJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function detectContext(signal = state.featureController.signal) {
    const prefixes = pathPrefixes();

    // 公开接口：不登录也能判断是 new-api 还是 sub2api，并拿到站点名。
    for (const prefix of prefixes) {
      if (signal.aborted) throw signal.reason || new Error('插件功能已关闭。');
      try {
        const sub = await fetchWithTimeout(prefix + '/api/v1/settings/public', { signal }, 7000);
        if (sub.ok) {
          const json = await safeJson(sub);
          const data = json && json.data;
          if (data && (typeof data.site_name === 'string' || typeof data.version === 'string')) {
            return makeContext('sub2api', prefix, data.site_name, data.site_logo);
          }
        }
      } catch {
        /* try next */
      }
      if (signal.aborted) throw signal.reason || new Error('插件功能已关闭。');

      try {
        const nw = await fetchWithTimeout(prefix + '/api/status', { signal }, 7000);
        if (nw.ok) {
          const json = await safeJson(nw);
          const data = json && json.data;
          if (data && (typeof data.system_name === 'string' || typeof data.version === 'string')) {
            return makeContext('newapi', prefix, data.system_name, data.logo);
          }
        }
      } catch {
        /* try next */
      }
    }
    if (signal.aborted) throw signal.reason || new Error('插件功能已关闭。');

    // 公开接口被挡时，用页面自身的特征兜底。
    // __APP_CONFIG__ 是 sub2api 前端注入的公开设置副本，字段与接口一致。
    if (window.__APP_CONFIG__ && typeof window.__APP_CONFIG__.site_name === 'string') {
      return makeContext('sub2api', '', window.__APP_CONFIG__.site_name, window.__APP_CONFIG__.site_logo);
    }

    if (document.querySelector('[data-tour="keys-create-btn"]')) {
      return makeContext('sub2api', '', document.title);
    }

    const subToken = (() => {
      try {
        return localStorage.getItem('auth_token') || '';
      } catch {
        return '';
      }
    })();

    if (subToken) {
      try {
        const r = await fetchWithTimeout('/api/v1/keys?page=1&page_size=1', {
          headers: { Authorization: 'Bearer ' + subToken },
          signal,
        });
        if (r.ok || r.status === 401 || r.status === 403) {
          return makeContext('sub2api', '', document.title);
        }
      } catch {
        /* ignore */
      }
    }
    if (signal.aborted) throw signal.reason || new Error('插件功能已关闭。');

    try {
      const r = await fetchWithTimeout('/api/token/?p=1&size=1', { signal });
      if (r.ok || r.status === 401 || r.status === 403) {
        return makeContext('newapi', '', document.title);
      }
    } catch {
      /* ignore */
    }

    throw new Error('无法识别当前中转站：没有找到 new-api 或 sub2api 的令牌接口。');
  }

  // ---------------------------------------------------------------------------
  // 读取令牌
  // ---------------------------------------------------------------------------

  async function runPageAuthOperation(operation) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await new Promise((resolve, reject) => {
      const timeoutMs = operation === 'sub2api.read' ? 1500 : FETCH_TIMEOUT + 1000;
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('页面认证桥接超时。'));
      }, timeoutMs);

      const onMessage = (event) => {
        const message = event.data;
        if (
          event.source !== window ||
          event.origin !== location.origin ||
          !message ||
          message.source !== 'KTM_PAGE_AUTH_RESPONSE' ||
          message.requestId !== requestId
        ) return;

        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        if (message.error) reject(new Error(message.error));
        else resolve(message.data || {});
      };

      window.addEventListener('message', onMessage);
      window.postMessage({
        source: 'KTM_PAGE_AUTH_REQUEST',
        requestId,
        operation,
        prefix: state.ctx ? state.ctx.prefix : '',
      }, location.origin);
    });

    return result;
  }

  async function refreshNewApi(ctx) {
    if (state.refreshPromise) return state.refreshPromise;

    state.refreshPromise = (async () => {
      try {
        const result = await runPageAuthOperation('newapi.refresh');
        if (typeof result.accessToken === 'string' && result.accessToken) {
          const token = result.accessToken;
          state.newApiToken = token;
          return token;
        }
        if (result.status >= 400) state.authError = `登录状态刷新失败（HTTP ${result.status}）。`;
      } catch {
        try {
          const response = await fetchWithTimeout(ctx.prefix + '/api/user/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          const json = await safeJson(response);
          const token = json && json.success && json.data && json.data.access_token;
          if (response.ok && typeof token === 'string' && token) {
            state.newApiToken = token;
            return token;
          }
          if (response.status >= 400) state.authError = `登录状态刷新失败（HTTP ${response.status}）。`;
        } catch {
          /* ignore */
        }
      }
      return '';
    })().finally(() => {
      state.refreshPromise = null;
    });

    return state.refreshPromise;
  }

  async function newApiFetch(ctx, url, options = {}, retry = true) {
    const headers = { ...(options.headers || {}) };
    try {
      const userId = localStorage.getItem('uid') || '';
      if (/^[1-9]\d*$/.test(userId)) state.newApiUserId = userId;
    } catch {}
    if (state.newApiUserId) headers['New-Api-User'] = state.newApiUserId;
    if (state.newApiToken) headers.Authorization = 'Bearer ' + state.newApiToken;

    const response = await fetchWithTimeout(url, { ...options, headers });
    if (response.status === 401 && retry && !options.signal?.aborted) {
      state.newApiToken = '';
      const token = await refreshNewApi(ctx);
      if (token && !options.signal?.aborted) return newApiFetch(ctx, url, options, false);
    }
    return response;
  }

  async function newApiPost(ctx, url, body, options = {}) {
    return newApiFetch(ctx, url, {
      ...options,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  function normalizeNewApiToken(token, index) {
    const id = String(token.id != null ? token.id : index);
    const name = String(token.name || `Token ${id}`).trim();
    const enabled = Number(token.status) === 1;
    let models = [];
    if (token.model_limits_enabled && token.model_limits) {
      models = String(token.model_limits)
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean);
    }
    return {
      id,
      name,
      masked: maskKey(token.key || ''),
      group: String(token.group || '').trim(),
      enabled,
      statusLabel: enabled ? '启用' : '已禁用',
      models,
      source: 'newapi',
      raw: token,
    };
  }

  function normalizeSub2ApiToken(token, index) {
    const id = String(token.id != null ? token.id : index);
    const name = String(token.name || `Key ${id}`).trim();
    const status = String(token.status || '').toLowerCase();
    const enabled = status === 'active';
    const group =
      (token.group && token.group.name) ||
      token.group_name ||
      (typeof token.group === 'string' ? token.group : '');
    const statusLabel =
      status === 'active'
        ? '启用'
        : status === 'quota_exhausted'
          ? '额度用尽'
          : status === 'expired'
            ? '已过期'
            : '已禁用';
    return {
      id,
      name,
      masked: maskKey(token.key || ''),
      group: String(group || '').trim(),
      enabled,
      statusLabel,
      models: [],
      source: 'sub2api',
      fullKey: String(token.key || ''),
      raw: token,
    };
  }

  /**
   * sub2api 401 时用 localStorage 中的 refresh_token 自动续期。
   * 成功后写回 auth_token / refresh_token / token_expires_at（与站点自身逻辑一致）。
   */
  async function refreshSub2Api(ctx) {
    if (state.subRefreshPromise) return state.subRefreshPromise;

    state.subRefreshPromise = (async () => {
      try {
        const result = await runPageAuthOperation('sub2api.refresh');
        if (typeof result.accessToken === 'string') return result.accessToken;
        if (result.status >= 400) state.authError = `登录状态刷新失败（HTTP ${result.status}）。`;
      } catch {
      }

      let refreshToken = '';
      try {
        refreshToken = localStorage.getItem('refresh_token') || '';
      } catch {
        /* ignore */
      }
      if (!refreshToken) return '';

      try {
        const res = await fetchWithTimeout(ctx.prefix + '/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        const json = await safeJson(res);
        const data = json && json.code === 0 ? json.data : null;
        const accessToken = data && data.access_token;
        if (res.ok && typeof accessToken === 'string' && accessToken) {
          try {
            localStorage.setItem('auth_token', accessToken);
            if (data.expires_in) {
              localStorage.setItem(
                'token_expires_at',
                String(Date.now() + Number(data.expires_in) * 1000)
              );
            }
            if (typeof data.refresh_token === 'string' && data.refresh_token) {
              localStorage.setItem('refresh_token', data.refresh_token);
            }
          } catch {
            /* localStorage 不可用时本次会话内仍可用 */
          }
          return accessToken;
        }
        if (res.status >= 400) state.authError = `登录状态刷新失败（HTTP ${res.status}）。`;
      } catch {
        /* ignore */
      }
      return '';
    })().finally(() => {
      state.subRefreshPromise = null;
    });

    return state.subRefreshPromise;
  }

  async function loadSub2ApiTokens(ctx) {
    let authToken = '';
    try {
      const result = await runPageAuthOperation('sub2api.read');
      authToken = typeof result.accessToken === 'string' ? result.accessToken : '';
    } catch {
      try {
        authToken = localStorage.getItem('auth_token') || '';
      } catch {
        /* ignore */
      }
    }

    const headers = () => (authToken ? { Authorization: 'Bearer ' + authToken } : {});
    const all = [];

    for (let page = 1; page <= Math.ceil(MAX_TOKENS / PAGE_SIZE); page += 1) {
      const fetchKeysPage = () =>
        fetchWithRetry(`${ctx.prefix}/api/v1/keys?page=${page}&page_size=${PAGE_SIZE}`, {
          headers: headers(),
        });

      let res = await fetchKeysPage();

      // access token 过期：用 refresh_token 换新后重试一次。
      if (res.status === 401) {
        const fresh = await refreshSub2Api(ctx);
        if (fresh) {
          authToken = fresh;
          res = await fetchKeysPage();
        }
      }

      if (res.status === 401) throw new Error(state.authError || '登录状态已失效，请刷新页面并重新登录。');
      if (res.status === 403) {
        throw new Error('站点拒绝读取令牌列表（HTTP 403），请检查账号权限或站点访问策略。');
      }
      if (res.status === 404) {
        throw new Error('没有找到 sub2api 的令牌接口。');
      }
      if (!res.ok) {
        throw new Error(`读取令牌失败（HTTP ${res.status}）。`);
      }

      const json = await safeJson(res);
      const data = json && json.data;
      const items = (data && Array.isArray(data.items) && data.items) || [];
      if (!items.length) break;

      all.push(...items);
      const total = Number(data && data.total) || all.length;
      if (items.length < PAGE_SIZE || all.length >= total || all.length >= MAX_TOKENS) break;
    }

    return all.map(normalizeSub2ApiToken);
  }

  async function loadNewApiTokens(ctx) {
    try {
      const auth = await runPageAuthOperation('newapi.read');
      if (typeof auth.accessToken === 'string') state.newApiToken = auth.accessToken;
      if (/^[1-9]\d*$/.test(String(auth.userId || ''))) state.newApiUserId = String(auth.userId);
    } catch {}

    const all = [];
    let total = Infinity;
    let startPage = 1;

    const fetchPage = async (page) => {
      const url = `${ctx.prefix}/api/token/?p=${page}&size=${PAGE_SIZE}`;
      // 网络层失败先重试两次，再走带认证的请求（401 时自动刷新）。
      let res = null;
      for (let attempt = 0; attempt < 3 && !res; attempt += 1) {
        try {
          res = await newApiFetch(ctx, url);
          if (res.status >= 500 || res.status === 429) {
            if (attempt < 2) {
              res = null;
              await sleep(attempt === 0 ? 500 : 1200);
            }
          }
        } catch (error) {
          if (attempt >= 2) throw error;
          await sleep(attempt === 0 ? 500 : 1200);
        }
      }
      if (!res) throw new Error('读取令牌失败：网络错误。');
      if (res.status === 401) throw new Error(state.authError || '登录状态已失效，请刷新页面并重新登录。');
      if (res.status === 403) {
        throw new Error('站点拒绝读取令牌列表（HTTP 403），请检查账号权限或站点访问策略。');
      }
      if (res.status === 404) {
        throw new Error('没有找到 new-api 的令牌接口。');
      }
      if (!res.ok) {
        throw new Error(`读取令牌失败（HTTP ${res.status}）。`);
      }
      const json = await safeJson(res);
      if (json && json.success === false) {
        throw new Error(json.message || '读取令牌失败。');
      }
      const data = json && json.data;
      const items = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : [];
      return { items, total: Number(data && data.total) || 0 };
    };

    let first = await fetchPage(startPage);
    if (!first.items.length) {
      // 旧版 new-api 从 p=0 开始。
      startPage = 0;
      first = await fetchPage(startPage);
    }

    all.push(...first.items);
    total = first.total || all.length;

    for (let page = startPage + 1; page <= startPage + Math.ceil(MAX_TOKENS / PAGE_SIZE); page += 1) {
      if (all.length >= total || all.length >= MAX_TOKENS) break;
      const next = await fetchPage(page);
      if (!next.items.length) break;
      all.push(...next.items);
      if (next.items.length < PAGE_SIZE) break;
    }

    return all.map(normalizeNewApiToken);
  }

  async function loadTokens(ctx) {
    return ctx.kind === 'sub2api' ? loadSub2ApiTokens(ctx) : loadNewApiTokens(ctx);
  }

  // ---------------------------------------------------------------------------
  // 读取完整 Key
  // ---------------------------------------------------------------------------

  /**
   * 用明文 key 调 /v1/models，补全 sub2api 令牌的模型列表。
   *
   * 该接口按 key 所属分组的模型白名单过滤，所以拿到的是这个 key 真正能用
   * 的模型，比分组配置本身更准确。并发数限制得比较低，避免给站点压力。
   * 任何失败都只是让这个 key 的模型列表留空，由 magpie 导入后自行获取。
   */
  async function fillSub2ApiModels(tokens, keys, signal) {
    const targets = tokens.filter((token) => keys.has(token.id) && !token.models.length);
    if (!targets.length) return;

    const CONCURRENCY = 4;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length && !signal?.aborted) {
        const token = targets[cursor];
        cursor += 1;
        try {
          const res = await fetchWithTimeout(
            state.ctx.openaiBase + '/models',
            { headers: { Authorization: 'Bearer ' + keys.get(token.id) }, signal },
            8000
          );
          if (!res.ok) continue;
          const json = await safeJson(res);
          const data = json && json.data;
          if (!Array.isArray(data)) continue;
          const models = data
            .map((row) => (row && typeof row.id === 'string' ? row.id.trim() : ''))
            .filter(Boolean);
          if (models.length) token.models = models;
        } catch {
          /* 拿不到就留空 */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  }

  async function resolveKeys(tokens, fetchModels = true, signal = null) {
    const map = new Map();
    const failures = [];
    const requestSignal = signal || state.featureController.signal;

    if (state.ctx.kind === 'sub2api') {
      for (const token of tokens) {
        if (token.fullKey && token.fullKey.trim()) {
          map.set(token.id, token.fullKey.trim());
        } else {
          failures.push(token);
        }
      }
      // sub2api 的模型限制挂在分组上，列表接口不返回，所以这里用明文 key
      // 调一次 /v1/models：该接口按 key 所属分组的 allowlist 过滤，结果就是
      // 这个 key 实际能用的模型。失败不影响导入，留空让 magpie 自己获取。
      if (fetchModels) await fillSub2ApiModels(tokens, map, requestSignal);
      return { map, failures };
    }

    // new-api：先试批量接口，再逐个回退。
    const missing = tokens.map((token) => token.id);
    try {
      const res = await newApiPost(
        state.ctx,
        state.ctx.prefix + '/api/token/batch/keys',
        { ids: missing },
        { signal: requestSignal }
      );
      if (res.ok) {
        const json = await safeJson(res);
        const data = json && json.data;
        const keys = data && (data.keys || data);
        if (keys && typeof keys === 'object') {
          if (Array.isArray(keys)) {
            for (const row of keys) {
              if (row && row.id != null && typeof row.key === 'string' && row.key.trim()) {
                map.set(String(row.id), row.key.trim());
                state.keyCache.set(String(row.id), row.key.trim());
              }
            }
          } else {
            for (const [id, key] of Object.entries(keys)) {
              if (typeof key === 'string' && key.trim()) {
                map.set(String(id), key.trim());
                state.keyCache.set(String(id), key.trim());
              }
            }
          }
        }
      }
    } catch {
      /* 批量接口不可用时逐个读取 */
    }
    if (requestSignal.aborted) return { map, failures };

    for (const token of tokens) {
      if (requestSignal.aborted) break;
      if (map.has(token.id)) continue;
      if (state.keyCache.has(token.id)) {
        map.set(token.id, state.keyCache.get(token.id));
        continue;
      }
      const url = state.ctx.prefix + `/api/token/${encodeURIComponent(token.id)}/key`;
      // 单个 key 读取失败时重试两次（网络错误或 5xx）。
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
        if (requestSignal.aborted) break;
        try {
          const res = await newApiPost(state.ctx, url, {}, { signal: requestSignal });
          const json = await safeJson(res);
          const key = res.ok && json && json.data && json.data.key;
          if (typeof key === 'string' && key.trim()) {
            map.set(token.id, key.trim());
            state.keyCache.set(token.id, key.trim());
            ok = true;
          } else if (res.status >= 500 && attempt < 2) {
            await sleep(attempt === 0 ? 500 : 1200);
          } else {
            break;
          }
        } catch {
          if (attempt >= 2) break;
          await sleep(attempt === 0 ? 500 : 1200);
        }
      }
      if (!ok) failures.push(token);
      await sleep(120);
    }

    return { map, failures };
  }

  // ---------------------------------------------------------------------------
  // magpie 配置映射
  // ---------------------------------------------------------------------------

  function providerName(token) {
    const prefix = state.prefix.trim();
    const base = prefix ? `${prefix} · ${token.name}` : token.name;
    return truncateUtf8(base || `Token ${token.id}`, MAX_NAME_BYTES);
  }

  function providerId(token) {
    const hostPart = slug(state.ctx.host, 32) || 'relay';
    const prefixPart = slug((state.ctx.prefix || '').replace(/^\/+/, ''), 16);
    const idPart =
      slug(token.id, 16) || 'key';
    let id = [hostPart, prefixPart, idPart].filter(Boolean).join('-');
    id = id.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
    if (!id || id === 'magpie' || id === 'group') id = 'relay-' + idPart;
    return id;
  }

  function endpointValues() {
    const ctx = state.ctx;
    if (!ctx) return {};
    const values = {};
    // magpie 的四个参数都是「基础 URL」，具体方法路径由 magpie 自己拼：
    //   chat/responses → 站点 /v1（拼 /chat/completions、/responses）
    //   anthropic      → 站点根（拼 /v1/messages，Claude Code 用）
    //   gemini         → 站点 /v1beta（拼 /models）
    if (state.endpoints.chat) values.chat = ctx.openaiBase;
    if (state.endpoints.responses) values.responses = ctx.openaiBase;
    if (state.endpoints.anthropic) values.anthropic = ctx.anthropicBase;
    if (state.endpoints.gemini) values.gemini = ctx.geminiBase;
    return values;
  }

  function buildImportLink(token, key, name) {
    const params = new URLSearchParams();
    params.set('name', name);
    params.set('id', providerId(token));

    const endpoints = endpointValues();
    for (const [keyName, value] of Object.entries(endpoints)) {
      if (value) params.set(keyName, value);
    }

    params.set('key', key);

    const models = Array.from(new Set((token.models || []).map((m) => String(m).trim()).filter(Boolean))).slice(
      0,
      MAX_MODELS
    );
    if (models.length) params.set('models', models.join(','));

    const catalog = state.catalog.trim().toLowerCase();
    if (catalog && /^[a-z0-9.-]+$/.test(catalog)) params.set('catalog', catalog);

    if (state.ctx.website) params.set('website', state.ctx.website);
    if (state.ctx.keysUrl) params.set('keys', state.ctx.keysUrl);
    if (state.ctx.icon) params.set('icon', state.ctx.icon);

    return 'magpie://import?' + params.toString();
  }

  function buildImportItems(tokens, keys) {
    const nameCounts = new Map();
    for (const token of tokens) {
      const name = providerName(token);
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    }

    return tokens.map((token) => {
      let name = providerName(token);
      if (nameCounts.get(name) > 1) {
        name = truncateUtf8(`${name} #${token.id}`, MAX_NAME_BYTES);
      }
      return {
        token,
        name,
        id: providerId(token),
        link: buildImportLink(token, keys.get(token.id), name),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 打开导入
  // ---------------------------------------------------------------------------

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        if (!extensionContextIsUsable()) {
          resolve({ ok: false, error: '扩展上下文已失效。' });
          return;
        }
        chrome.runtime.sendMessage(message, (response) => {
          try {
            if (!extensionContextIsUsable()) {
              resolve({ ok: false, error: '扩展上下文已失效。' });
              return;
            }
            const lastError = chrome.runtime.lastError;
            if (lastError) {
              if (/extension context invalidated/i.test(lastError.message || '')) {
                invalidateExtensionContext();
              }
              resolve({ ok: false, error: lastError.message });
              return;
            }
            resolve(response || { ok: false });
          } catch (error) {
            if (
              /extension context invalidated/i.test(
                error && error.message ? error.message : String(error)
              )
            ) {
              invalidateExtensionContext();
            }
            resolve({ ok: false, error: String(error && error.message ? error.message : error) });
          }
        });
      } catch (error) {
        if (
          /extension context invalidated/i.test(
            error && error.message ? error.message : String(error)
          )
        ) {
          invalidateExtensionContext();
        }
        resolve({ ok: false, error: String(error && error.message ? error.message : error) });
      }
    });
  }

  async function openImport(item, reuse) {
    const result = await sendMessage({
      type: 'KTM_OPEN_IMPORT',
      payload: { link: item.link, label: item.name, reuse: Boolean(reuse) },
    });
    if (result && result.tabId != null) state.openTabId = result.tabId;
    if (!result || !result.ok) {
      toast('没能自动打开 magpie，请使用“复制当前链接”手动导入。', 'warn');
    }
    return result;
  }

  async function finishImportTab() {
    await sendMessage({ type: 'KTM_FINISH_IMPORT' });
  }

  // ---------------------------------------------------------------------------
  // 对话框
  // ---------------------------------------------------------------------------

  function ensureHost() {
    if (state.host && state.host.isConnected) return;
    state.host = document.createElement('div');
    state.host.id = ROOT_ID;
    state.host.style.cssText =
      'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.append(state.host);
    state.shadow = state.host.attachShadow({ mode: 'open' });
  }

  function cancelEndpointProbe() {
    const controller = state.probeController;
    state.probeController = null;
    state.probing = false;
    if (controller && !controller.signal.aborted) controller.abort();
  }

  async function loadPrefs(ctx) {
    const key = PREF_PREFIX + ctx.host + ctx.prefix;
    const stored = await storageGet(key);
    const prefs = (stored && stored[key]) || {};
    state.prefix = typeof prefs.prefix === 'string' ? prefs.prefix : ctx.siteName;
    state.catalog = typeof prefs.catalog === 'string' ? prefs.catalog : '';
    state.endpoints = { ...DEFAULT_ENDPOINTS, ...(prefs.endpoints || {}) };
    state.balance = typeof prefs.balance === 'boolean' ? prefs.balance : true;
    state.probe = {};
    state.probeDetails = {};
    state.probeMessage = '';

    // 探测站点支持的端点：missing 的端点默认不勾选。
    // 用户手动改过端点偏好（prefs.endpoints 存在）时尊重用户选择。
    const userConfigured = Boolean(prefs.endpoints);
    cancelEndpointProbe();
    const controller = new AbortController();
    state.probeController = controller;
    state.probing = true;
    probeEndpoints(ctx, controller)
      .then(({ statuses, details, message, complete, cancelled }) => {
        // 面板可能已被关闭或切换了站点
        if (state.ctx !== ctx || state.probeController !== controller || cancelled) return;
        state.probe = statuses;
        state.probeDetails = details;
        state.probeMessage = message;
        if (!userConfigured && !state.endpointSelectionTouched && complete) {
          for (const key of Object.keys(DEFAULT_ENDPOINTS)) {
            if (statuses[key] === 'missing' || statuses[key] === 'forbidden') {
              state.endpoints[key] = false;
            }
            if (state.endpointInputs[key]) state.endpointInputs[key].checked = state.endpoints[key];
          }
        }
        if (state.dialogOpen) {
          updateEndpointSummary();
          updateFooter();
          drawList();
        }
      })
      .finally(() => {
        if (state.probeController !== controller) return;
        state.probeController = null;
        state.probing = false;
        if (state.dialogOpen) {
          updateEndpointSummary();
          updateFooter();
        }
      });
  }

  const savePrefs = debounce(() => {
    if (!state.ctx) return;
    const key = PREF_PREFIX + state.ctx.host + state.ctx.prefix;
    storageSet({
      [key]: {
        prefix: state.prefix,
        catalog: state.catalog,
        endpoints: { ...state.endpoints },
        balance: state.balance,
      },
    });
  }, 400);

  async function openDialog() {
    if (!state.enabled || !extensionContextIsUsable()) return;
    if (!isTokenPage()) {
      toast('请在令牌管理页使用这个功能。');
      return;
    }
    // 出错时允许重试：只有「已打开且无错误」才直接返回。
    if (state.dialogOpen && !state.error) return;

    cancelEndpointProbe();
    const requestSignal = state.featureController.signal;
    state.dialogOpen = true;
    state.loading = true;
    state.busy = false;
    state.error = '';
    state.query = '';
    state.selected.clear();
    state.keyCache.clear();
    state.newApiToken = '';
    state.authError = '';
    state.probe = {};
    state.probeDetails = {};
    state.probeMessage = '';
    state.probing = false;
    state.endpointSelectionTouched = false;
    state.endpointInputs = {};
    ensureHost();
    renderAll();

    try {
      const ctx = await detectContext(requestSignal);
      if (!state.enabled || requestSignal.aborted) return;
      state.ctx = ctx;
      const tokens = await loadTokens(ctx);
      if (!state.enabled || requestSignal.aborted) return;
      state.tokens = tokens.sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
      await loadPrefs(ctx);
    } catch (error) {
      if (!state.enabled || requestSignal.aborted) return;
      const message = error && error.message ? error.message : String(error);
      state.error = /abort|timeout|failed to fetch|network/i.test(message)
        ? '无法连接当前站点，请检查网络后重试。'
        : message;
    } finally {
      if (state.featureController.signal !== requestSignal) return;
      state.loading = false;
      if (!state.dialogOpen) return;
      renderAll();
    }
  }

  function closeDialog(clear = true) {
    cancelEndpointProbe();
    state.dialogOpen = false;
    state.error = '';
    state.busy = false;
    state.listEl = null;
    state.countEl = null;
    state.selectAllBtn = null;
    state.importBtn = null;
    state.endpointSummaryEl = null;
    state.endpointInputs = {};
    state.balanceHintEl = null;
    if (clear && !state.queue.length) {
      state.tokens = [];
      state.selected.clear();
      state.keyCache.clear();
      state.newApiToken = '';
    }
    renderAll();
  }

  function toggleSelectAll() {
    const usable = state.tokens.filter((token) => token.enabled);
    const allSelected = usable.length > 0 && usable.every((token) => state.selected.has(token.id));
    if (allSelected) {
      usable.forEach((token) => state.selected.delete(token.id));
    } else {
      usable.forEach((token) => state.selected.add(token.id));
    }
    drawList();
    updateFooter();
  }

  function updateFooter() {
    const usable = state.tokens.filter((token) => token.enabled);
    const allSelected = usable.length > 0 && usable.every((token) => state.selected.has(token.id));
    if (state.countEl) {
      state.countEl.textContent = `已选 ${state.selected.size} / ${state.tokens.length}`;
    }
    if (state.selectAllBtn) {
      state.selectAllBtn.textContent = allSelected ? '取消全选' : '全选可用';
      state.selectAllBtn.disabled = usable.length === 0 || state.busy;
    }
    if (state.importBtn) {
      state.importBtn.disabled =
        state.selected.size === 0 ||
        state.busy ||
        !httpAllowed() ||
        Object.keys(endpointValues()).length === 0;
      state.importBtn.textContent = state.busy
        ? '正在读取 Key…'
        : state.selected.size
          ? `导入选中 (${state.selected.size})`
          : '导入选中';
    }
  }

  function drawList() {
    if (!state.listEl) return;
    const list = state.listEl;
    list.replaceChildren();

    const query = state.query.trim().toLowerCase();
    const tokens = state.tokens.filter((token) => {
      if (!query) return true;
      return (
        token.name.toLowerCase().includes(query) ||
        token.id.toLowerCase().includes(query) ||
        token.group.toLowerCase().includes(query) ||
        token.masked.toLowerCase().includes(query)
      );
    });

    if (!tokens.length) {
      list.append(h('div', { class: 'ktm-empty' }, state.tokens.length ? '没有匹配的令牌' : '没有找到令牌'));
      return;
    }

    for (const token of tokens) {
      const selected = state.selected.has(token.id);
      const row = h('label', {
        class: `ktm-row${selected ? ' sel' : ''}${token.enabled ? '' : ' off'}`,
      });

      const checkbox = h('input', {
        type: 'checkbox',
        class: 'ktm-check',
        checked: selected,
        disabled: !token.enabled || state.busy,
      });
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(token.id);
        else state.selected.delete(token.id);
        row.classList.toggle('sel', checkbox.checked);
        updateFooter();
      });

      const who = h('div', { class: 'ktm-who' });
      const title = h('div', { class: 'ktm-name' });
      title.append(document.createTextNode(token.name));
      if (token.group) title.append(h('span', { class: 'ktm-badge group' }, token.group));
      if (!token.enabled) title.append(h('span', { class: 'ktm-badge bad' }, token.statusLabel));
      else title.append(h('span', { class: 'ktm-badge ok' }, '启用'));
      if (token.models.length) title.append(h('span', { class: 'ktm-badge' }, `${token.models.length} 个模型`));
      who.append(title);

      const sub = h('div', { class: 'ktm-sub' });
      sub.append(h('code', {}, token.masked || '—'));
      sub.append(document.createTextNode(`  ·  #${token.id}`));
      who.append(sub);

      row.append(checkbox, who);

      if (!token.enabled) {
        row.title = `${token.statusLabel}的令牌不能导入 magpie`;
      } else {
        row.title = token.models.length ? `可用模型：${token.models.slice(0, 12).join(', ')}` : '可用模型由 magpie 自动获取';
      }

      list.append(row);
    }
  }

  function renderAll() {
    ensureHost();
    state.shadow.replaceChildren();

    const style = document.createElement('style');
    style.textContent = CSS;
    state.shadow.append(style);

    if (state.dialogOpen) state.shadow.append(renderDialog());
    if (state.queue.length) state.shadow.append(renderQueue());
    if (state.batchOpen) state.shadow.append(renderBatch());
    if (state.copyPromptOpen) {
      const prompt = renderCopyPrompt();
      state.shadow.append(prompt);
      prompt.showModal();
    }
  }

  function renderCopyPrompt() {
    const overlay = h('dialog', {
      class: 'ktm-overlay ktm-copy-prompt',
      attrs: {
        'aria-labelledby': 'ktm-copy-prompt-title',
        'aria-describedby': 'ktm-copy-prompt-description',
      },
    });
    overlay.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeCopyPrompt();
    });
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) closeCopyPrompt();
    });

    const card = h('div', { class: 'ktm-card ktm-copy-card' });
    const header = h('div', { class: 'ktm-copy-header' });
    const brand = h('div', { class: 'ktm-copy-brand' });
    brand.append(makeMagpieIcon(24));
    const eyebrow = h('span', { class: 'ktm-copy-eyebrow', text: 'KEY TO MAGPIE' });
    const close = h('button', {
      class: 'ktm-icon-btn ktm-copy-close',
      type: 'button',
      attrs: { 'aria-label': '关闭提示' },
      text: '×',
      onclick: () => closeCopyPrompt(),
    });
    header.append(brand, eyebrow, close);

    const title = h('h2', {
      class: 'ktm-copy-title',
      attrs: { id: 'ktm-copy-prompt-title' },
      text: '要把密钥导入 Magpie 吗？',
    });
    const description = h(
      'p',
      { class: 'ktm-copy-description', attrs: { id: 'ktm-copy-prompt-description' } },
      '继续后会打开导入面板，让你选择要导入的密钥。'
    );
    const note = h('div', { class: 'ktm-copy-note' });
    note.innerHTML =
      '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.25" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v4m0-6h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    note.append(h('span', { text: '不会自动导入；最终保存仍由你在 Magpie 中确认。' }));

    const actions = h('div', { class: 'ktm-copy-actions' });
    const cancel = h('button', {
      class: 'ktm-btn ktm-copy-secondary',
      type: 'button',
      autofocus: true,
      text: '暂不导入',
      onclick: () => closeCopyPrompt(),
    });
    actions.append(
      cancel,
      h(
        'button',
        { class: 'ktm-btn primary ktm-copy-primary', type: 'button', onclick: () => closeCopyPrompt(true) },
        makeMagpieIcon(17),
        h('span', { text: '打开导入面板' })
      )
    );
    card.append(header, title, description, note, actions);
    overlay.append(card);
    setTimeout(() => {
      if (cancel.isConnected) cancel.focus();
    }, 0);
    return overlay;
  }

  function renderDialog() {
    const overlay = h('div', {
      class: 'ktm-overlay',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '导入到 magpie' },
    });
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) closeDialog();
    });

    const card = h('div', { class: 'ktm-card' });

    // header
    const header = h('div', { class: 'ktm-head' });
    const mark = h('div', { class: 'ktm-mark' });
    mark.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
      '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
      '</svg>';
    const titles = h('div', { class: 'ktm-titles' });
    titles.append(h('div', { class: 'ktm-title' }, '导入到 magpie'));
    titles.append(
      h(
        'div',
        { class: 'ktm-subtitle' },
        state.ctx ? `${state.ctx.siteName} · ${state.ctx.host}` : '正在识别当前站点…'
      )
    );
    const close = h('button', {
      class: 'ktm-icon-btn',
      type: 'button',
      attrs: { 'aria-label': '关闭' },
      text: '×',
      onclick: () => closeDialog(),
    });
    header.append(mark, titles, close);
    card.append(header);

    // body
    const body = h('div', { class: 'ktm-body' });

    if (state.loading) {
      const loading = h('div', { class: 'ktm-loading' });
      loading.append(h('span', { class: 'ktm-spinner' }));
      loading.append(document.createTextNode('正在读取令牌…'));
      body.append(loading);
    } else if (state.error) {
      const error = h('div', { class: 'ktm-error', attrs: { role: 'alert' } });
      error.append(h('div', { class: 'ktm-error-title' }, '读取失败'));
      error.append(h('div', { class: 'ktm-error-text' }, state.error));
      const actions = h('div', { class: 'ktm-error-actions' });
      actions.append(
        h('button', {
          class: 'ktm-btn',
          type: 'button',
          text: '重试',
          onclick: () => openDialog(),
        })
      );
      error.append(actions);
      body.append(error);
    } else {
      const note = h('div', { class: 'ktm-note' });
      note.append(document.createTextNode('每个 Key 会创建一个 magpie provider，名称为 '));
      note.append(h('code', {}, '站点 · 令牌名'));
      note.append(document.createTextNode('。导入时 magpie 会显示 host 和 key，确认后才会保存。'));
      body.append(note);

      if (!httpAllowed()) {
        body.append(
          h(
            'div',
            { class: 'ktm-warn' },
            '当前站点使用 http。magpie 的导入链接只接受 https（本机 / 局域网地址除外），请改用 https 访问后再导入。'
          )
        );
      }

      const bar = h('div', { class: 'ktm-toolbar' });
      const search = h('input', {
        class: 'ktm-search',
        type: 'search',
        placeholder: '搜索令牌名 / 分组 / Key…',
        value: state.query,
        attrs: { 'aria-label': '搜索令牌' },
      });
      search.addEventListener('input', () => {
        state.query = search.value;
        drawList();
      });
      const selectAll = h('button', {
        class: 'ktm-btn small',
        type: 'button',
        text: '全选可用',
        onclick: toggleSelectAll,
      });
      state.selectAllBtn = selectAll;
      bar.append(search, selectAll);
      body.append(bar);

      state.listEl = h('div', { class: 'ktm-list' });
      body.append(state.listEl);

      // advanced
      const details = h('details', { class: 'ktm-advanced' });
      details.append(h('summary', {}, '高级设置'));
      const grid = h('div', { class: 'ktm-grid' });

      const prefixInput = h('input', {
        class: 'ktm-input',
        type: 'text',
        value: state.prefix,
        placeholder: '站点名',
      });
      prefixInput.addEventListener('input', () => {
        state.prefix = prefixInput.value;
        savePrefs();
      });
      grid.append(
        h('label', { class: 'ktm-field' }, h('span', {}, 'Provider 名称前缀'), prefixInput)
      );

      const catalogInput = h('input', {
        class: 'ktm-input',
        type: 'text',
        value: state.catalog,
        placeholder: 'openai / anthropic / google（可选）',
      });
      catalogInput.addEventListener('input', () => {
        state.catalog = catalogInput.value;
        savePrefs();
      });
      grid.append(
        h('label', { class: 'ktm-field' }, h('span', {}, 'models.dev 目录（可选）'), catalogInput)
      );

      // magpie 内置了 new-api / sub2api 的余额查询，但 import 链接传不了，
      // 只能在批量命令里补一条 provider set。
      const balanceBox = h('input', { type: 'checkbox', checked: state.balance });
      balanceBox.addEventListener('change', () => {
        state.balance = balanceBox.checked;
        savePrefs();
        updateBalanceHint();
      });
      const balanceHint = h('span', { class: 'ktm-hint' });
      state.balanceHintEl = balanceHint;
      grid.append(
        h(
          'label',
          { class: 'ktm-toggle' },
          balanceBox,
          h('span', {}, '在批量命令中配置余额查询'),
          balanceHint
        )
      );
      updateBalanceHint();

      const endpoints = h('div', { class: 'ktm-endpoints' });
      state.endpointInputs = {};
      const endpointLabels = {
        chat: 'OpenAI Chat',
        responses: 'OpenAI Responses',
        anthropic: 'Anthropic',
        gemini: 'Gemini',
      };
      const probeLabels = {
        ok: '已检测到',
        auth: '认证失败',
        forbidden: '无访问权限',
        missing: '未检测到',
        unknown: '无法确认',
        skipped: '暂未探测',
      };
      for (const key of Object.keys(endpointLabels)) {
        const checkbox = h('input', {
          type: 'checkbox',
          checked: state.endpoints[key],
        });
        state.endpointInputs[key] = checkbox;
        checkbox.addEventListener('change', () => {
          state.endpointSelectionTouched = true;
          state.endpoints[key] = checkbox.checked;
          savePrefs();
          updateEndpointSummary();
          updateFooter();
        });
        const probe = state.probe[key];
        const badge = probe
          ? h('span', { class: `ktm-probe ${probe}` }, probeLabels[probe])
          : null;
        endpoints.append(
          h(
            'label',
            { class: 'ktm-toggle', title: state.probeDetails[key] || '' },
            checkbox,
            h('span', {}, endpointLabels[key]),
            badge
          )
        );
      }
      grid.append(
        h('div', { class: 'ktm-field wide' }, h('span', {}, '导入的 API 端点'), endpoints)
      );

      state.endpointSummaryEl = h('div', { class: 'ktm-preview' });
      grid.append(state.endpointSummaryEl);
      details.append(grid);
      body.append(details);
    }

    card.append(body);

    // footer
    const footer = h('div', { class: 'ktm-foot' });
    state.countEl = h('div', { class: 'ktm-count' }, `已选 ${state.selected.size} / ${state.tokens.length}`);
    const footActions = h('div', { class: 'ktm-foot-actions' });
    const batchBtn = h('button', {
      class: 'ktm-btn',
      type: 'button',
      text: '批量命令',
      title: '复制一条可一次导入全部 Key 的终端命令',
      onclick: () => openBatch(),
    });
    state.importBtn = h('button', {
      class: 'ktm-btn primary',
      type: 'button',
      text: '导入选中',
      onclick: () => doImport(),
    });
    footActions.append(batchBtn, state.importBtn);
    footer.append(state.countEl, footActions);
    card.append(footer);

    overlay.append(card);

    // 打开后聚焦关闭按钮，方便键盘用户。
    setTimeout(() => {
      if (close.isConnected) close.focus();
    }, 0);

    // 首次绘制列表和状态
    if (!state.loading && !state.error) {
      drawList();
      updateFooter();
      updateEndpointSummary();
    }

    return overlay;
  }

  /**
   * 余额开关的说明文字。
   *
   * magpie 按余额端点的路径自动推断取值字段，所以这里只需要给出 URL；
   * 站点类型识别不出来时（如公开接口被挡的兜底路径）没有可用的端点，
   * 开关就没有意义，直接标注出来。
   */
  function updateBalanceHint() {
    const el = state.balanceHintEl;
    if (!el) return;
    const url = state.ctx && state.ctx.balanceUrl;
    if (!url) {
      el.textContent = '当前站点未识别出余额接口';
      el.className = 'ktm-hint muted';
      return;
    }
    el.textContent = url;
    el.className = 'ktm-hint';
  }

  function updateEndpointSummary() {
    if (!state.endpointSummaryEl || !state.ctx) return;
    const values = endpointValues();
    const rows = Object.entries(values).map(([key, value]) => `${key}: ${value}`);
    const probeNames = {
      chat: 'OpenAI Chat',
      responses: 'OpenAI Responses',
      anthropic: 'Anthropic',
      gemini: 'Gemini',
      models: '/v1/models',
    };
    const probeLabels = {
      ok: '已检测到',
      auth: '认证失败',
      forbidden: '无访问权限',
      missing: '未检测到',
      unknown: '无法确认',
      skipped: '暂未探测',
    };
    const missing = Object.keys(DEFAULT_ENDPOINTS).filter((key) => state.probe[key] === 'missing');
    const authFailed = Object.keys(state.probe).filter((key) => state.probe[key] === 'auth');
    const forbidden = Object.keys(state.probe).filter((key) => state.probe[key] === 'forbidden');
    const unknown = Object.keys(state.probe).filter((key) => state.probe[key] === 'unknown');
    const hints = [];
    if (missing.length) {
      hints.push({
        text: `站点未适配：${missing.map((key) => probeNames[key]).join(' / ')}（默认取消勾选，保留已保存偏好）`,
        kind: 'error',
      });
    }
    if (authFailed.length) {
      hints.push({
        text: `API Key 认证失败：${authFailed.map((key) => probeNames[key]).join(' / ')}（不作为已检测成功）`,
        kind: 'note',
      });
    }
    if (forbidden.length) {
      hints.push({
        text: `API Key 或所属分组无权访问：${forbidden.map((key) => probeNames[key]).join(' / ')}（默认取消勾选，保留已保存偏好）`,
        kind: 'note',
      });
    }
    if (state.probe.models) {
      hints.push({
        text: `/v1/models：${probeLabels[state.probe.models]}${state.probe.models === 'unknown' ? '（接口请求未成功）' : ''}`,
        kind: state.probe.models === 'ok' ? 'success' : 'note',
      });
    }
    if (unknown.length) {
      hints.push({
        text: `无法确认：${unknown.map((key) => probeNames[key]).join(' / ')}（探测失败，保留默认勾选）`,
        kind: 'note',
      });
    }
    const failures = Object.entries(state.probeDetails).map(([key, detail]) => `${probeNames[key]}：${detail}`);
    if (failures.length) hints.push({ text: failures.join('；'), kind: 'note' });
    if (state.probeMessage) hints.push({ text: state.probeMessage, kind: 'note' });
    if (state.probing) hints.push({ text: '正在依次探测（单请求最多 3 秒，可直接导入）…', kind: 'note' });
    state.endpointSummaryEl.replaceChildren(
      h('div', { class: 'ktm-preview-title' }, '将写入 magpie 的端点'),
      ...rows.map((row) => h('code', { class: 'ktm-preview-row' }, row)),
      ...hints.map(({ text, kind }) =>
        h('div', { class: `ktm-preview-hint${kind === 'note' ? ' neutral' : ''}` }, text)
      )
    );
  }

  async function doImport() {
    if (!state.enabled || state.busy || !state.ctx) return;
    cancelEndpointProbe();
    const requestSignal = state.featureController.signal;
    const selected = state.tokens.filter((token) => state.selected.has(token.id));
    if (!selected.length) return;

    if (!httpAllowed()) {
      toast('当前站点是 http，magpie 只接受 https 导入链接（本机 / 局域网除外）。', 'error');
      return;
    }
    if (!Object.keys(endpointValues()).length) {
      toast('请至少保留一个 API 端点。', 'error');
      return;
    }

    state.busy = true;
    updateFooter();
    renderAll();

    try {
      const { map, failures } = await resolveKeys(selected, true, requestSignal);
      if (!state.enabled || requestSignal.aborted) return;
      const usable = selected.filter((token) => map.has(token.id));
      if (!usable.length) {
        throw new Error('没有获取到完整的 API Key，请刷新页面后重试。');
      }

      const items = buildImportItems(usable, map);

      // 立即清掉完整 key 和缓存，只保留导入链接（仍需在内存中传给 magpie）。
      for (const token of state.tokens) {
        if (token.fullKey) token.fullKey = '';
      }
      state.keyCache.clear();
      state.selected.clear();
      state.tokens = [];
      state.busy = false;
      closeDialog(false);

      if (failures.length) {
        toast(`${failures.length} 个 Key 获取失败，已跳过。`, 'warn');
      }

      if (items.length === 1) {
        await openImport(items[0], false);
        toast('已在 magpie 中打开，请确认添加。', 'ok');
      } else {
        state.queue = items;
        state.queueIndex = 0;
        state.queueDone = false;
        renderAll();
        await openQueueItem();
      }
    } catch (error) {
      if (!state.enabled || requestSignal.aborted) return;
      state.busy = false;
      state.error = error && error.message ? error.message : String(error);
      renderAll();
    }
  }

  // ---------------------------------------------------------------------------
  // 队列面板（多个 Key 顺序导入）
  // ---------------------------------------------------------------------------

  async function openQueueItem() {
    const item = state.queue[state.queueIndex];
    if (!item) return;
    await openImport(item, true);
    renderAll();
  }

  function nextQueueItem() {
    if (state.queueIndex < state.queue.length - 1) {
      state.queueIndex += 1;
      openQueueItem();
    } else {
      state.queueDone = true;
      finishImportTab();
      renderAll();
    }
  }

  function endQueue() {
    state.queue = [];
    state.queueIndex = 0;
    state.queueDone = false;
    state.busy = false;
    finishImportTab();
    renderAll();
  }

  function copyQueueLink() {
    const item = state.queue[state.queueIndex];
    if (!item) return;
    clipboardWrite(item.link).then((ok) => {
      toast(ok ? '当前导入链接已复制。' : '复制失败，请手动选择链接。', ok ? 'ok' : 'error');
    });
  }

  function renderQueue() {
    const panel = h('div', { class: 'ktm-queue', attrs: { role: 'region', 'aria-label': 'magpie 导入进度' } });

    const head = h('div', { class: 'ktm-queue-head' });
    head.append(h('div', { class: 'ktm-queue-title' }, '导入到 magpie'));
    head.append(
      h('button', {
        class: 'ktm-icon-btn small',
        type: 'button',
        attrs: { 'aria-label': '结束导入' },
        text: '×',
        onclick: () => endQueue(),
      })
    );
    panel.append(head);

    if (state.queueDone) {
      panel.append(
        h('div', { class: 'ktm-queue-done' }, '全部导入链接都已打开。请确认 magpie 中每个 provider 都已添加。')
      );
      const actions = h('div', { class: 'ktm-queue-actions' });
      actions.append(
        h('button', {
          class: 'ktm-btn',
          type: 'button',
          text: '复制批量命令',
          onclick: () => openBatch(),
        }),
        h('button', {
          class: 'ktm-btn primary',
          type: 'button',
          text: '结束',
          onclick: () => endQueue(),
        })
      );
      panel.append(actions);
      return panel;
    }

    const item = state.queue[state.queueIndex];
    const progress = h('div', { class: 'ktm-progress' });
    const fill = h('div', { class: 'ktm-progress-fill' });
    fill.style.width = `${((state.queueIndex + 1) / state.queue.length) * 100}%`;
    progress.append(fill);
    panel.append(progress);

    panel.append(
      h('div', { class: 'ktm-queue-step' }, `${state.queueIndex + 1} / ${state.queue.length}`)
    );
    panel.append(h('div', { class: 'ktm-queue-name' }, item.name));
    panel.append(
      h(
        'div',
        { class: 'ktm-queue-hint' },
        'magpie 窗口已打开。点 Add / 添加 完成这个 Key，然后回来点「下一个」。'
      )
    );

    const actions = h('div', { class: 'ktm-queue-actions' });
    actions.append(
      h('button', {
        class: 'ktm-btn small',
        type: 'button',
        text: '重新打开',
        onclick: () => openQueueItem(),
      }),
      h('button', {
        class: 'ktm-btn small',
        type: 'button',
        text: '复制链接',
        onclick: () => copyQueueLink(),
      }),
      h('button', {
        class: 'ktm-btn primary small',
        type: 'button',
        text: state.queueIndex === state.queue.length - 1 ? '完成' : '下一个',
        onclick: () => nextQueueItem(),
      })
    );
    panel.append(actions);

    return panel;
  }

  // ---------------------------------------------------------------------------
  // 批量命令
  // ---------------------------------------------------------------------------

  async function openBatch() {
    if (!state.enabled || state.busy) return;

    if (!state.queue.length) {
      // 没有队列时直接用当前选中项生成命令，不必先走一遍导入。
      const selected = state.tokens.filter((token) => state.selected.has(token.id));
      if (!selected.length) {
        toast('请先选择要导入的 Key。', 'warn');
        return;
      }
      if (!httpAllowed()) {
        toast('当前站点是 http，magpie 只接受 https 导入链接（本机 / 局域网除外）。', 'error');
        return;
      }
      if (!Object.keys(endpointValues()).length) {
        toast('请至少保留一个 API 端点。', 'error');
        return;
      }

      state.busy = true;
      updateFooter();
      const requestSignal = state.featureController.signal;
      try {
        const { map, failures } = await resolveKeys(selected, true, requestSignal);
        if (!state.enabled || requestSignal.aborted) return;
        const usable = selected.filter((token) => map.has(token.id));
        if (!usable.length) {
          throw new Error('没有获取到完整的 API Key，请刷新页面后重试。');
        }
        const items = buildImportItems(usable, map);
        // 立即清掉完整 key 和缓存，命令文本留在内存里供复制。
        for (const token of state.tokens) {
          if (token.fullKey) token.fullKey = '';
        }
        state.keyCache.clear();
        state.batchText = batchCommands(items);
        if (failures.length) {
          toast(`${failures.length} 个 Key 获取失败，未包含在命令中。`, 'warn');
        }
      } catch (error) {
        if (!state.enabled || requestSignal.aborted) return;
        toast(error && error.message ? error.message : String(error), 'error');
        return;
      } finally {
        if (state.featureController.signal === requestSignal) {
          state.busy = false;
          updateFooter();
        }
      }
    } else {
      state.batchText = batchCommands(state.queue);
    }

    state.batchOpen = true;
    renderAll();
  }

  /**
   * 生成批量导入命令。
   *
   * magpie://import 没有 balance 参数，余额查询只能在导入后用
   * `magpie provider set <id> balance=<url>` 补上。provider id 由
   * providerId() 生成，与 magpie 的 Slug() 规则一致，且 magpie 保存时会
   * 原样沿用链接里的 id，所以这里可以放心引用。
   */
  function batchCommands(items) {
    const lines = [];
    const balanceUrl = state.balance && state.ctx ? state.ctx.balanceUrl : '';
    for (const item of items) {
      lines.push(`magpie import -y ${shellQuote(item.link)}`);
      if (balanceUrl) {
        lines.push(`magpie provider set ${shellQuote(item.id)} balance=${shellQuote(balanceUrl)}`);
      }
    }
    return lines.join('\n');
  }

  function renderBatch() {
    const overlay = h('div', {
      class: 'ktm-overlay',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '批量导入命令' },
    });
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) {
        state.batchOpen = false;
        renderAll();
      }
    });

    const card = h('div', { class: 'ktm-card ktm-batch-card' });
    const head = h('div', { class: 'ktm-head' });
    head.append(
      h('div', { class: 'ktm-titles' },
        h('div', { class: 'ktm-title' }, '批量导入命令'),
        h('div', { class: 'ktm-subtitle' }, '在终端中一次导入全部 Key，无需逐个确认')
      )
    );
    head.append(
      h('button', {
        class: 'ktm-icon-btn',
        type: 'button',
        attrs: { 'aria-label': '关闭' },
        text: '×',
        onclick: () => {
          state.batchOpen = false;
          renderAll();
        },
      })
    );
    card.append(head);

    const body = h('div', { class: 'ktm-body' });
    body.append(
      h(
        'div',
        { class: 'ktm-warn' },
        '下面的命令包含你的 API Key，请勿分享或粘贴到公开页面。命令会以 -y 跳过 magpie 的确认对话框。'
      )
    );

    const textarea = h('textarea', { class: 'ktm-command', readonly: true, spellcheck: false });
    textarea.value = state.batchText;
    body.append(textarea);

    const actions = h('div', { class: 'ktm-batch-actions' });
    actions.append(
      h('button', {
        class: 'ktm-btn',
        type: 'button',
        text: '全选',
        onclick: () => {
          textarea.focus();
          textarea.select();
        },
      }),
      h('button', {
        class: 'ktm-btn primary',
        type: 'button',
        text: '复制命令',
        onclick: async () => {
          const ok = await clipboardWrite(state.batchText);
          toast(ok ? '命令已复制，请到终端粘贴执行。' : '复制失败，请手动全选复制。', ok ? 'ok' : 'error');
        },
      })
    );
    body.append(actions);
    card.append(body);
    overlay.append(card);
    return overlay;
  }

  // ---------------------------------------------------------------------------
  // 样式
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ktm-overlay {
      position: fixed; inset: 0; pointer-events: auto;
      display: flex; align-items: center; justify-content: center;
      padding: 20px;
      background: rgba(12, 12, 18, .48);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: var(--ktm-fg);
      animation: ktm-fade .16s ease-out;
    }
    .ktm-copy-prompt {
      width: 100vw; height: 100vh; max-width: none; max-height: none;
      margin: 0; border: 0; overflow: auto;
    }
    .ktm-copy-prompt::backdrop { background: transparent; }
    .ktm-card {
      --ktm-bg: #fff;
      --ktm-fg: #17171c;
      --ktm-muted: #6b6b76;
      --ktm-line: #e7e7ec;
      --ktm-soft: #f6f6f8;
      --ktm-brand: #7c3aed;
      --ktm-brand2: #ec4899;
      --ktm-ok: #16a34a;
      --ktm-bad: #dc2626;
      width: min(760px, 100%);
      max-height: min(86vh, 840px);
      display: flex; flex-direction: column;
      background: var(--ktm-bg);
      color: var(--ktm-fg);
      border-radius: 18px;
      box-shadow: 0 30px 90px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.06);
      overflow: hidden;
      animation: ktm-pop .18s cubic-bezier(.2,.9,.25,1.15);
    }
    @media (prefers-color-scheme: dark) {
      .ktm-card {
        --ktm-bg: #17171d;
        --ktm-fg: #f4f4f7;
        --ktm-muted: #a0a0ab;
        --ktm-line: #2b2b34;
        --ktm-soft: #1e1e26;
        --ktm-ok: #4ade80;
        --ktm-bad: #f87171;
        box-shadow: 0 30px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.06);
      }
    }
    .ktm-head { display: flex; align-items: center; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--ktm-line); }
    .ktm-mark {
      flex: 0 0 auto; width: 38px; height: 38px; border-radius: 12px;
      display: grid; place-items: center; color: #fff;
      background: linear-gradient(135deg, var(--ktm-brand), var(--ktm-brand2));
      box-shadow: 0 8px 20px rgba(124,58,237,.28);
    }
    .ktm-mark svg { width: 20px; height: 20px; }
    .ktm-titles { min-width: 0; flex: 1; }
    .ktm-title { font-size: 16px; font-weight: 750; letter-spacing: -.01em; }
    .ktm-subtitle { font-size: 12.5px; color: var(--ktm-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ktm-icon-btn {
      all: unset; flex: 0 0 auto; width: 32px; height: 32px; border-radius: 9px;
      display: grid; place-items: center; cursor: pointer; font-size: 20px; line-height: 1;
      color: var(--ktm-muted); transition: background .12s ease, color .12s ease;
    }
    .ktm-icon-btn:hover { background: var(--ktm-soft); color: var(--ktm-fg); }
    .ktm-icon-btn.small { width: 26px; height: 26px; font-size: 17px; }
    .ktm-body { padding: 16px 18px 8px; overflow: auto; min-height: 120px; }
    .ktm-note { font-size: 13px; color: var(--ktm-muted); margin-bottom: 12px; }
    .ktm-note code, .ktm-preview code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--ktm-soft); border: 1px solid var(--ktm-line); padding: 1px 5px; border-radius: 5px; }
    .ktm-warn {
      font-size: 12.5px; color: #b45309; background: rgba(245,158,11,.12);
      border: 1px solid rgba(245,158,11,.25); border-radius: 10px; padding: 9px 11px; margin-bottom: 12px;
    }
    @media (prefers-color-scheme: dark) { .ktm-warn { color: #fbbf24; } }
    .ktm-loading { display: flex; align-items: center; gap: 10px; padding: 34px 0; color: var(--ktm-muted); justify-content: center; }
    .ktm-spinner {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid color-mix(in srgb, var(--ktm-fg) 18%, transparent);
      border-top-color: var(--ktm-brand);
      animation: ktm-spin .75s linear infinite;
    }
    .ktm-error { padding: 18px 0 8px; }
    .ktm-error-title { font-weight: 700; color: var(--ktm-bad); margin-bottom: 6px; }
    .ktm-error-text { color: var(--ktm-muted); font-size: 13px; white-space: pre-wrap; }
    .ktm-error-actions { margin-top: 12px; }
    .ktm-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
    .ktm-search {
      flex: 1; min-width: 0; height: 34px; padding: 0 11px;
      border: 1px solid var(--ktm-line); border-radius: 9px;
      background: var(--ktm-soft); color: var(--ktm-fg); font: inherit; outline: none;
    }
    .ktm-search:focus { border-color: var(--ktm-brand); box-shadow: 0 0 0 3px rgba(124,58,237,.14); }
    .ktm-list { border: 1px solid var(--ktm-line); border-radius: 12px; overflow: auto; max-height: 320px; background: var(--ktm-bg); }
    .ktm-row {
      display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px;
      border-bottom: 1px solid var(--ktm-line); cursor: pointer;
      transition: background .1s ease;
    }
    .ktm-row:last-child { border-bottom: 0; }
    .ktm-row:hover { background: var(--ktm-soft); }
    .ktm-row.sel { background: color-mix(in srgb, var(--ktm-brand) 8%, var(--ktm-bg)); }
    .ktm-row.off { opacity: .62; cursor: default; }
    .ktm-check { width: 15px; height: 15px; margin: 2px 0 0; accent-color: var(--ktm-brand); flex: 0 0 auto; cursor: pointer; }
    .ktm-check:disabled { cursor: default; }
    .ktm-who { min-width: 0; flex: 1; }
    .ktm-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 600; font-size: 13.5px; }
    .ktm-sub { color: var(--ktm-muted); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
    .ktm-sub code { font: 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .ktm-badge {
      display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 999px;
      font-size: 10.5px; font-weight: 650; letter-spacing: .01em;
      background: var(--ktm-soft); color: var(--ktm-muted); border: 1px solid var(--ktm-line);
    }
    .ktm-badge.ok { color: var(--ktm-ok); border-color: color-mix(in srgb, var(--ktm-ok) 30%, transparent); background: color-mix(in srgb, var(--ktm-ok) 10%, transparent); }
    .ktm-badge.bad { color: var(--ktm-bad); border-color: color-mix(in srgb, var(--ktm-bad) 30%, transparent); background: color-mix(in srgb, var(--ktm-bad) 10%, transparent); }
    .ktm-badge.group { color: #2563eb; border-color: rgba(37,99,235,.25); background: rgba(37,99,235,.09); }
    @media (prefers-color-scheme: dark) { .ktm-badge.group { color: #93c5fd; } }
    .ktm-empty { padding: 28px 12px; text-align: center; color: var(--ktm-muted); font-size: 13px; }
    .ktm-advanced { margin-top: 12px; border-top: 1px solid var(--ktm-line); padding-top: 10px; }
    .ktm-advanced summary { cursor: pointer; color: var(--ktm-muted); font-size: 12.5px; font-weight: 600; user-select: none; }
    .ktm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px 0 4px; }
    .ktm-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--ktm-muted); font-weight: 600; }
    .ktm-field.wide { grid-column: 1 / -1; }
    .ktm-input {
      height: 32px; padding: 0 10px; border: 1px solid var(--ktm-line); border-radius: 8px;
      background: var(--ktm-soft); color: var(--ktm-fg); font: inherit; font-weight: 400; outline: none;
    }
    .ktm-input:focus { border-color: var(--ktm-brand); box-shadow: 0 0 0 3px rgba(124,58,237,.13); }
    .ktm-endpoints { display: flex; flex-wrap: wrap; gap: 12px; padding-top: 2px; }
    .ktm-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 500; color: var(--ktm-fg); cursor: pointer; }
    .ktm-toggle input { accent-color: var(--ktm-brand); }
    .ktm-probe {
      display: inline-flex; align-items: center; height: 16px; padding: 0 6px; border-radius: 999px;
      font-size: 10px; font-weight: 650; letter-spacing: .01em;
    }
    .ktm-probe.ok { color: var(--ktm-ok); background: color-mix(in srgb, var(--ktm-ok) 10%, transparent); }
    .ktm-probe.missing { color: var(--ktm-bad); background: color-mix(in srgb, var(--ktm-bad) 10%, transparent); }
    .ktm-probe.auth, .ktm-probe.forbidden, .ktm-probe.unknown, .ktm-probe.skipped { color: var(--ktm-muted); background: var(--ktm-soft); }
    .ktm-hint {
      font-size: 11px; font-weight: 400; color: var(--ktm-muted);
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ktm-hint.muted { opacity: .7; font-style: italic; }
    .ktm-preview { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; color: var(--ktm-muted); }
    .ktm-preview-title { font-weight: 650; margin-bottom: 2px; }
    .ktm-preview-row { background: none !important; border: 0 !important; padding: 0 !important; color: var(--ktm-muted) !important; }
    .ktm-preview-hint { color: var(--ktm-bad); font-size: 11px; }
    .ktm-preview-hint.neutral { color: var(--ktm-muted); }
    .ktm-preview-hint.success { color: var(--ktm-ok); }
    .ktm-btn:focus-visible, .ktm-icon-btn:focus-visible, .ktm-check:focus-visible, .ktm-toggle input:focus-visible {
      outline: 2px solid var(--ktm-brand); outline-offset: 2px;
    }
    .ktm-search:focus-visible, .ktm-input:focus-visible { border-color: var(--ktm-brand); box-shadow: 0 0 0 3px rgba(124,58,237,.14); }
    .ktm-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 12px 18px 16px; border-top: 1px solid var(--ktm-line);
      background: var(--ktm-bg);
    }
    .ktm-count { color: var(--ktm-muted); font-size: 12.5px; }
    .ktm-foot-actions { display: flex; gap: 8px; }
    .ktm-btn {
      all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 12px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--ktm-line); background: var(--ktm-bg); color: var(--ktm-fg);
      font: 600 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      transition: background .12s ease, transform .1s ease, opacity .12s ease;
      white-space: nowrap;
    }
    .ktm-btn:hover { background: var(--ktm-soft); }
    .ktm-btn:active { transform: scale(.985); }
    .ktm-btn.primary {
      border: 0; color: #fff;
      background: linear-gradient(135deg, var(--ktm-brand), var(--ktm-brand2));
      box-shadow: 0 6px 16px rgba(124,58,237,.26);
    }
    .ktm-btn.primary:hover { filter: brightness(1.05); background: linear-gradient(135deg, var(--ktm-brand), var(--ktm-brand2)); }
    .ktm-btn.small { height: 28px; padding: 0 10px; font-size: 12px; }
    .ktm-btn:disabled { opacity: .45; cursor: default; transform: none; }
    .ktm-queue {
      pointer-events: auto; position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
      width: min(370px, calc(100vw - 32px));
      background: #17171d; color: #f4f4f7;
      border: 1px solid #2b2b34; border-radius: 16px;
      box-shadow: 0 24px 70px rgba(0,0,0,.45);
      padding: 14px;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      animation: ktm-slide .2s ease-out;
    }
    .ktm-queue-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .ktm-queue-title { font-weight: 700; font-size: 13.5px; }
    .ktm-queue .ktm-icon-btn { color: #a0a0ab; }
    .ktm-queue .ktm-icon-btn:hover { background: #26262f; color: #fff; }
    .ktm-progress { height: 4px; border-radius: 999px; background: #2b2b34; overflow: hidden; margin-bottom: 8px; }
    .ktm-progress-fill { height: 100%; background: linear-gradient(90deg, #7c3aed, #ec4899); border-radius: inherit; transition: width .25s ease; }
    .ktm-queue-step { color: #a0a0ab; font-size: 11.5px; }
    .ktm-queue-name { font-weight: 650; font-size: 14px; margin: 2px 0 4px; overflow-wrap: anywhere; }
    .ktm-queue-hint { color: #a0a0ab; font-size: 12px; margin-bottom: 10px; }
    .ktm-queue-actions { display: flex; gap: 7px; flex-wrap: wrap; }
    .ktm-queue .ktm-btn { border-color: #34343f; background: #202028; color: #f4f4f7; }
    .ktm-queue .ktm-btn:hover { background: #2a2a34; }
    .ktm-queue .ktm-btn.primary { border: 0; color: #fff; background: linear-gradient(135deg,#7c3aed,#ec4899); }
    .ktm-queue-done { color: #d4d4dd; font-size: 12.5px; margin-bottom: 10px; }
    .ktm-batch-card { width: min(720px, 100%); }
    .ktm-command {
      width: 100%; min-height: 190px; resize: vertical;
      padding: 11px 12px; border: 1px solid var(--ktm-line); border-radius: 10px;
      background: var(--ktm-soft); color: var(--ktm-fg);
      font: 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      outline: none; white-space: pre; overflow: auto;
    }
    .ktm-batch-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
    .ktm-toast {
      pointer-events: none; position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
      z-index: 2147483647; max-width: min(560px, calc(100vw - 40px));
      padding: 9px 14px; border-radius: 10px;
      background: #17171d; color: #f4f4f7; border: 1px solid #2b2b34;
      box-shadow: 0 14px 40px rgba(0,0,0,.4);
      font: 600 12.5px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      animation: ktm-toast .18s ease-out;
    }
    .ktm-toast.ok { border-color: rgba(74,222,128,.35); }
    .ktm-toast.warn { border-color: rgba(251,191,36,.4); }
    .ktm-toast.error { border-color: rgba(248,113,113,.45); }
    .ktm-copy-card {
      width: min(432px, 100%); max-height: none; padding: 24px;
      border: 1px solid color-mix(in srgb, var(--ktm-line), transparent 12%);
      border-radius: 20px;
      box-shadow: 0 28px 80px rgba(0,0,0,.24), 0 2px 8px rgba(0,0,0,.08);
    }
    .ktm-copy-header { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
    .ktm-copy-brand {
      display: grid; place-items: center; width: 44px; height: 44px; flex: none;
      border-radius: 14px; background: linear-gradient(135deg, #7c3aed, #ec4899);
      box-shadow: 0 8px 18px rgba(124,58,237,.22);
    }
    .ktm-copy-eyebrow { color: var(--ktm-muted); font-size: 10px; font-weight: 750; letter-spacing: .12em; }
    .ktm-copy-close { margin-left: auto; }
    .ktm-copy-close:focus-visible, .ktm-copy-actions .ktm-btn:focus-visible {
      outline: 3px solid rgba(124,58,237,.42); outline-offset: 2px;
    }
    .ktm-copy-title { margin: 0; font-size: 20px; font-weight: 740; letter-spacing: -.025em; line-height: 1.35; }
    .ktm-copy-description { margin: 9px 0 18px; color: var(--ktm-muted); font-size: 14px; line-height: 1.65; }
    .ktm-copy-note {
      display: flex; align-items: flex-start; gap: 9px; margin-bottom: 22px; padding: 11px 12px;
      border: 1px solid var(--ktm-line); border-radius: 12px; background: var(--ktm-soft);
      color: var(--ktm-muted); font-size: 12px; line-height: 1.55;
    }
    .ktm-copy-note svg { width: 17px; height: 17px; flex: none; margin-top: 1px; color: var(--ktm-brand); }
    .ktm-copy-actions { display: flex; justify-content: flex-end; gap: 9px; }
    .ktm-copy-actions .ktm-btn { min-height: 42px; padding: 0 14px; border-radius: 11px; font-size: 13px; }
    .ktm-copy-primary { display: inline-flex; gap: 8px; }
    @keyframes ktm-spin { to { transform: rotate(360deg); } }
    @keyframes ktm-fade { from { opacity: 0; } }
    @keyframes ktm-pop { from { opacity: 0; transform: translateY(8px) scale(.98); } }
    @keyframes ktm-slide { from { opacity: 0; transform: translateY(12px); } }
    @keyframes ktm-toast { from { opacity: 0; transform: translate(-50%, 8px); } }
    @media (prefers-reduced-motion: reduce) {
      .ktm-card, .ktm-overlay, .ktm-queue, .ktm-toast { animation: none; }
      .ktm-spinner { animation: none; }
      .ktm-btn, .ktm-progress-fill { transition: none; }
    }
    @media (max-width: 640px) {
      .ktm-grid { grid-template-columns: 1fr; }
      .ktm-overlay { padding: 10px; }
      .ktm-card { max-height: 92vh; border-radius: 14px; }
      .ktm-copy-card { padding: 20px; border-radius: 18px; }
      .ktm-copy-actions { flex-direction: column-reverse; }
      .ktm-copy-actions .ktm-btn { width: 100%; }
      .ktm-queue { right: 10px; bottom: 10px; }
    }
  `;

  // ---------------------------------------------------------------------------
  // 全局事件与启动
  // ---------------------------------------------------------------------------

  let started = false;
  let observer = null;
  let injectInterval = null;
  let locationInterval = null;
  let enabledPreferenceChanged = false;
  let lastHref = location.href;

  function setPageAuthEnabled(enabled) {
    window.postMessage({
      source: 'KTM_EXTENSION_CONTENT',
      type: 'KTM_SET_ENABLED',
      enabled,
    }, location.origin);
  }

  function stopOnTokenPage() {
    observer?.disconnect();
    if (injectInterval) clearInterval(injectInterval);
    if (locationInterval) clearInterval(locationInterval);
    injectInterval = null;
    locationInterval = null;
    document.querySelectorAll('[data-ktm="toolbar"], [data-ktm="floating"]').forEach((el) => el.remove());
  }

  function checkLocationChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    setPageAuthEnabled(state.enabled && isTokenPage());
    const copyPromptWasOpen = state.copyPromptOpen;
    state.copyPromptOpen = false;
    state.copyPromptTrigger = null;
    if (state.dialogOpen) closeDialog();
    else if (copyPromptWasOpen) renderAll();
    if (state.enabled && isTokenPage()) startOnTokenPage();
    if (state.enabled && started) scheduleInject();
  }

  function startLocationMonitor() {
    if (!locationInterval) locationInterval = setInterval(checkLocationChange, 1200);
  }

  function setFeatureEnabled(enabled, force = false) {
    if (!extensionContextIsUsable()) return;
    const nextEnabled = enabled !== false;
    const changed = state.enabled !== nextEnabled;
    state.enabled = nextEnabled;
    setPageAuthEnabled(nextEnabled && isTokenPage());
    if (!changed && !force) return;

    if (nextEnabled) {
      state.featureController = new AbortController();
      startLocationMonitor();
      if (isTokenPage()) startOnTokenPage();
      return;
    }

    state.featureController.abort();
    cancelEndpointProbe();
    state.queue = [];
    state.queueIndex = 0;
    state.queueDone = false;
    state.batchOpen = false;
    state.batchText = '';
    state.copyPromptOpen = false;
    state.copyPromptTrigger = null;
    if (state.dialogOpen) closeDialog();
    else {
      state.tokens = [];
      state.selected.clear();
      state.keyCache.clear();
      state.newApiToken = '';
    }
    stopOnTokenPage();
    state.host?.remove();
    state.host = null;
    state.shadow = null;
  }

  function startOnTokenPage() {
    if (!state.enabled || state.contextInvalidated || !isTokenPage()) return;
    setPageAuthEnabled(true);
    if (!started) {
      started = true;

      document.addEventListener(
        'keydown',
        (event) => {
          if (!state.enabled || event.key !== 'Escape') return;
          if (state.batchOpen) {
            state.batchOpen = false;
            renderAll();
          } else if (state.dialogOpen) {
            closeDialog();
          }
        },
        true
      );

      document.addEventListener(
        'keydown',
        (event) => {
          if (!state.enabled || event.key !== 'Tab' || !state.dialogOpen) return;
          const focusables = Array.from(
            state.shadow.querySelectorAll(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], summary'
            )
          ).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = state.shadow.activeElement;
          if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        },
        true
      );

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (
          !state.enabled ||
          event.source !== window ||
          event.origin !== location.origin ||
          !message ||
          message.source !== 'KTM_PAGE_AUTH' ||
          message.type !== 'API_KEY_COPIED' ||
          !isTokenPage()
        ) return;
        requestMagpieImportAfterCopy();
      });
    }

    if (!observer) observer = new MutationObserver(() => scheduleInject());
    const startObserving = () => {
      if (!state.enabled || !document.body || !observer) return;
      observer.observe(document.body, { childList: true, subtree: true });
      scheduleInject();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserving, { once: true });
    } else {
      startObserving();
    }
    if (!injectInterval) injectInterval = setInterval(injectUi, 2500);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!extensionContextIsUsable()) return false;
    if (!message || sender.id !== chrome.runtime.id) return false;
    if (message.type === 'KTM_GET_STATUS') {
      sendResponse({ ok: true, enabled: state.enabled, supported: isTokenPage() });
      return false;
    }
    if (message.type === 'KTM_SET_ENABLED') {
      if (message.origin !== location.origin || typeof message.enabled !== 'boolean') return false;
      enabledPreferenceChanged = true;
      setFeatureEnabled(message.enabled, true);
      sendResponse({ ok: true, enabled: state.enabled });
      return false;
    }
    if (message.type === 'KTM_OPEN_PANEL') {
      if (!state.enabled) {
        sendResponse({ ok: false, error: '当前站点已关闭插件功能。' });
      } else if (!isTokenPage()) {
        sendResponse({ ok: false, error: '请先打开中转站的令牌管理页。' });
      } else {
        openDialog();
        sendResponse({ ok: true });
      }
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (!extensionContextIsUsable() || areaName !== 'local' || !changes[siteEnabledKey()]) return;
    enabledPreferenceChanged = true;
    setFeatureEnabled(changes[siteEnabledKey()].newValue !== false, true);
  });

  (async () => {
    const key = siteEnabledKey();
    const stored = await storageGet(key);
    if (!enabledPreferenceChanged) setFeatureEnabled(stored[key] !== false, true);
  })();
})();
