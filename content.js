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
  const PAGE_SIZE = 100;
  const MAX_TOKENS = 1000;
  const FETCH_TIMEOUT = 15000;
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
    /** @type {Record<'chat'|'responses'|'anthropic'|'gemini', string>} 各端点完整 URL（探测用） */
    endpointUrls: { chat: '', responses: '', anthropic: '', gemini: '' },
    /** @type {Record<string, 'ok'|'missing'|'unknown'>} 端点探测结果 */
    probe: {},
    probing: false,
    /** @type {{name:string,id:string,link:string,token:Token}[]} */
    queue: [],
    queueIndex: 0,
    queueDone: false,
    openTabId: null,
    batchOpen: false,
    batchText: '',
    keyCache: new Map(),
    newApiToken: '',
    refreshPromise: null,
    subRefreshPromise: null,

    host: null,
    shadow: null,
    dialogOpen: false,
    listEl: null,
    countEl: null,
    selectAllBtn: null,
    importBtn: null,
    endpointSummaryEl: null,
    queueEl: null,
  };

  // ---------------------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------------------

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

  function isTokenPage() {
    const path = location.pathname;
    if (/^\/(oauth|login|sign-?in|callback|auth)/i.test(path)) return false;
    return (
      /(^|\/)(keys?|tokens?|api-keys)(\/|$)/i.test(path) ||
      /\/console\/(token|keys)(\/|$)/i.test(path)
    );
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
    btn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
      '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
      '</svg><span>导入到 magpie</span>';
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
    btn.textContent = '导入到 magpie';
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
    if (document.querySelector('[data-ktm="floating"]')) return;
    if (!findCreateButton()) return;
    document.documentElement.append(makeFloatingButton());
  }

  function removeFloatingButton() {
    document.querySelectorAll('[data-ktm="floating"]').forEach((el) => el.remove());
  }

  function injectUi() {
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
          target.insertAdjacentElement('afterend', makeToolbarButton());
        } catch {
          ensureFloatingButton();
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

  function findIcon() {
    const candidates = Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]'));
    for (const link of candidates) {
      try {
        const url = new URL(link.href, location.href);
        if (url.protocol === 'https:' && !isLocalHostname(url.hostname)) return url.href;
      } catch {
        /* ignore */
      }
    }
    if (location.protocol === 'https:' && !isLocalHostname(location.hostname)) {
      return location.origin + '/favicon.ico';
    }
    return '';
  }

  function makeContext(kind, prefix, siteName) {
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
      icon: findIcon(),
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
   * magpie 里对话会 404，所以这里逐个发一个最小请求：
   *   - 404 / 405 → 端点不存在，标记 missing（默认取消勾选）
   *   - 401 / 400 / 200 → 端点存在（只是没带 key 或参数），标记 ok
   *
   * 探测结果只影响默认勾选与 UI 提示，用户仍可在高级设置里手动开关。
   */
  async function probeEndpoints(ctx) {
    const result = { chat: 'unknown', responses: 'unknown', anthropic: 'unknown', gemini: 'unknown' };
    const urls = ctx.endpointUrls;

    const checks = [
      {
        key: 'chat',
        run: () =>
          fetchWithTimeout(urls.chat, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'probe', messages: [] }),
          }),
      },
      {
        key: 'responses',
        run: () =>
          fetchWithTimeout(urls.responses, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'probe', input: '' }),
          }),
      },
      {
        key: 'anthropic',
        run: () =>
          fetchWithTimeout(urls.anthropic, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'probe', max_tokens: 1, messages: [] }),
          }),
      },
      {
        key: 'gemini',
        run: () => fetchWithTimeout(urls.gemini, { method: 'GET' }),
      },
    ];

    await Promise.all(
      checks.map(async ({ key, run }) => {
        try {
          const res = await run();
          if (res.status === 404 || res.status === 405 || res.status === 501) {
            result[key] = 'missing';
          } else {
            // 200/400/401/403/429/5xx 都说明路由存在
            result[key] = 'ok';
          }
        } catch {
          // 探测失败不影响使用，只是无法给出提示
          result[key] = 'unknown';
        }
      })
    );

    return result;
  }

  async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { credentials: 'include', ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 网络层重试：失败（网络错误/超时/5xx/429）后自动重试最多 2 次，
   * 退避 500ms → 1200ms。4xx 业务错误不重试。
   * 供无认证头的请求使用（detectContext、sub2api 列表等）。
   */
  async function fetchWithRetry(url, options = {}, timeout = FETCH_TIMEOUT) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchWithTimeout(url, options, timeout);
        if ((response.status >= 500 || response.status === 429) && attempt < 2) {
          lastError = new Error(`HTTP ${response.status}`);
          await sleep(attempt === 0 ? 500 : 1200);
          continue;
        }
        return response;
      } catch (error) {
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

  async function detectContext() {
    const prefixes = pathPrefixes();

    // 公开接口：不登录也能判断是 new-api 还是 sub2api，并拿到站点名。
    for (const prefix of prefixes) {
      try {
        const sub = await fetchWithTimeout(prefix + '/api/v1/settings/public', {}, 7000);
        if (sub.ok) {
          const json = await safeJson(sub);
          const data = json && json.data;
          if (data && (typeof data.site_name === 'string' || typeof data.version === 'string')) {
            return makeContext('sub2api', prefix, data.site_name);
          }
        }
      } catch {
        /* try next */
      }

      try {
        const nw = await fetchWithTimeout(prefix + '/api/status', {}, 7000);
        if (nw.ok) {
          const json = await safeJson(nw);
          const data = json && json.data;
          if (data && (typeof data.system_name === 'string' || typeof data.version === 'string')) {
            return makeContext('newapi', prefix, data.system_name);
          }
        }
      } catch {
        /* try next */
      }
    }

    // 公开接口被挡时，用页面自身的特征兜底。
    if (window.__APP_CONFIG__ && typeof window.__APP_CONFIG__.site_name === 'string') {
      return makeContext('sub2api', '', window.__APP_CONFIG__.site_name);
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
        });
        if (r.ok || r.status === 401 || r.status === 403) {
          return makeContext('sub2api', '', document.title);
        }
      } catch {
        /* ignore */
      }
    }

    try {
      const r = await fetchWithTimeout('/api/token/?p=1&size=1');
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

  async function refreshNewApi(ctx) {
    if (state.refreshPromise) return state.refreshPromise;

    state.refreshPromise = (async () => {
      try {
        const res = await fetchWithTimeout(ctx.prefix + '/api/user/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const json = await safeJson(res);
        const token = json && json.success && json.data && json.data.access_token;
        if (res.ok && typeof token === 'string' && token) {
          state.newApiToken = token;
          return token;
        }
      } catch {
        /* ignore */
      }
      return '';
    })().finally(() => {
      state.refreshPromise = null;
    });

    return state.refreshPromise;
  }

  async function newApiFetch(ctx, url, options = {}, retry = true) {
    const headers = { ...(options.headers || {}) };
    if (state.newApiToken) headers.Authorization = 'Bearer ' + state.newApiToken;

    const response = await fetchWithTimeout(url, { ...options, headers });
    if (response.status === 401 && retry) {
      state.newApiToken = '';
      const token = await refreshNewApi(ctx);
      if (token) return newApiFetch(ctx, url, options, false);
    }
    return response;
  }

  async function newApiPost(ctx, url, body) {
    return newApiFetch(ctx, url, {
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
      authToken = localStorage.getItem('auth_token') || '';
    } catch {
      /* ignore */
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

      if (res.status === 401 || res.status === 403) {
        throw new Error('登录状态已失效，请刷新页面并重新登录。');
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
      if (res.status === 401 || res.status === 403) {
        throw new Error('登录状态已失效，请刷新页面并重新登录。');
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

  async function resolveKeys(tokens) {
    const map = new Map();
    const failures = [];

    if (state.ctx.kind === 'sub2api') {
      for (const token of tokens) {
        if (token.fullKey && token.fullKey.trim()) {
          map.set(token.id, token.fullKey.trim());
        } else {
          failures.push(token);
        }
      }
      return { map, failures };
    }

    // new-api：先试批量接口，再逐个回退。
    const missing = tokens.map((token) => token.id);
    try {
      const res = await newApiPost(state.ctx, state.ctx.prefix + '/api/token/batch/keys', {
        ids: missing,
      });
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

    for (const token of tokens) {
      if (map.has(token.id)) continue;
      if (state.keyCache.has(token.id)) {
        map.set(token.id, state.keyCache.get(token.id));
        continue;
      }
      const url = state.ctx.prefix + `/api/token/${encodeURIComponent(token.id)}/key`;
      // 单个 key 读取失败时重试两次（网络错误或 5xx）。
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
        try {
          const res = await newApiPost(state.ctx, url, {});
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
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false });
        });
      } catch (error) {
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

  async function loadPrefs(ctx) {
    const key = PREF_PREFIX + ctx.host + ctx.prefix;
    const stored = await storageGet(key);
    const prefs = (stored && stored[key]) || {};
    state.prefix = typeof prefs.prefix === 'string' ? prefs.prefix : ctx.siteName;
    state.catalog = typeof prefs.catalog === 'string' ? prefs.catalog : '';
    state.endpoints = { ...DEFAULT_ENDPOINTS, ...(prefs.endpoints || {}) };
    state.probe = {};

    // 探测站点支持的端点：missing 的端点默认不勾选。
    // 用户手动改过端点偏好（prefs.endpoints 存在）时尊重用户选择。
    const userConfigured = Boolean(prefs.endpoints);
    state.probing = true;
    probeEndpoints(ctx)
      .then((probe) => {
        // 面板可能已被关闭或切换了站点
        if (state.ctx !== ctx) return;
        state.probe = probe;
        if (!userConfigured) {
          for (const key of Object.keys(DEFAULT_ENDPOINTS)) {
            if (probe[key] === 'missing') state.endpoints[key] = false;
          }
        }
        if (state.dialogOpen) {
          updateEndpointSummary();
          updateFooter();
          drawList();
        }
      })
      .finally(() => {
        if (state.ctx === ctx) state.probing = false;
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
      },
    });
  }, 400);

  async function openDialog() {
    if (!isTokenPage()) {
      toast('请在令牌管理页使用这个功能。');
      return;
    }
    // 出错时允许重试：只有「已打开且无错误」才直接返回。
    if (state.dialogOpen && !state.error) return;

    state.dialogOpen = true;
    state.loading = true;
    state.busy = false;
    state.error = '';
    state.query = '';
    state.selected.clear();
    state.keyCache.clear();
    state.newApiToken = '';
    state.probe = {};
    state.probing = false;
    ensureHost();
    renderAll();

    try {
      const ctx = await detectContext();
      state.ctx = ctx;
      await loadPrefs(ctx);
      const tokens = await loadTokens(ctx);
      state.tokens = tokens.sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      state.error = /abort|timeout|failed to fetch|network/i.test(message)
        ? '无法连接当前站点，请检查网络后重试。'
        : message;
    } finally {
      state.loading = false;
      if (!state.dialogOpen) return;
      renderAll();
    }
  }

  function closeDialog(clear = true) {
    state.dialogOpen = false;
    state.error = '';
    state.busy = false;
    state.listEl = null;
    state.countEl = null;
    state.selectAllBtn = null;
    state.importBtn = null;
    state.endpointSummaryEl = null;
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

      const endpoints = h('div', { class: 'ktm-endpoints' });
      const endpointLabels = {
        chat: 'OpenAI Chat',
        responses: 'OpenAI Responses',
        anthropic: 'Anthropic',
        gemini: 'Gemini',
      };
      const probeLabels = { ok: '已检测到', missing: '未检测到', unknown: '未探测' };
      for (const key of Object.keys(endpointLabels)) {
        const checkbox = h('input', {
          type: 'checkbox',
          checked: state.endpoints[key],
        });
        checkbox.addEventListener('change', () => {
          state.endpoints[key] = checkbox.checked;
          savePrefs();
          updateEndpointSummary();
          updateFooter();
        });
        const probe = state.probe[key];
        const badge =
          probe && probe !== 'unknown'
            ? h('span', { class: `ktm-probe ${probe}` }, probeLabels[probe])
            : null;
        endpoints.append(
          h(
            'label',
            { class: 'ktm-toggle' },
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

  function updateEndpointSummary() {
    if (!state.endpointSummaryEl || !state.ctx) return;
    const values = endpointValues();
    const rows = Object.entries(values).map(([key, value]) => `${key}: ${value}`);
    const missing = Object.keys(state.probe).filter((key) => state.probe[key] === 'missing');
    const hint = missing.length
      ? `站点未适配：${missing.join(' / ')}（已自动取消勾选，可手动开启）`
      : state.probing
        ? '正在探测站点支持的端点…'
        : '';
    state.endpointSummaryEl.replaceChildren(
      h('div', { class: 'ktm-preview-title' }, '将写入 magpie 的端点'),
      ...rows.map((row) => h('code', { class: 'ktm-preview-row' }, row)),
      hint ? h('div', { class: 'ktm-preview-hint' }, hint) : null
    );
  }

  async function doImport() {
    if (state.busy || !state.ctx) return;
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
      const { map, failures } = await resolveKeys(selected);
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
    if (state.busy) return;

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
      try {
        const { map, failures } = await resolveKeys(selected);
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
        state.batchText = items.map((item) => `magpie import -y ${shellQuote(item.link)}`).join('\n');
        if (failures.length) {
          toast(`${failures.length} 个 Key 获取失败，未包含在命令中。`, 'warn');
        }
      } catch (error) {
        toast(error && error.message ? error.message : String(error), 'error');
        return;
      } finally {
        state.busy = false;
        updateFooter();
      }
    } else {
      state.batchText = state.queue.map((item) => `magpie import -y ${shellQuote(item.link)}`).join('\n');
    }

    state.batchOpen = true;
    renderAll();
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
    .ktm-preview { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; color: var(--ktm-muted); }
    .ktm-preview-title { font-weight: 650; margin-bottom: 2px; }
    .ktm-preview-row { background: none !important; border: 0 !important; padding: 0 !important; color: var(--ktm-muted) !important; }
    .ktm-preview-hint { color: var(--ktm-bad); font-size: 11px; }
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
      .ktm-queue { right: 10px; bottom: 10px; }
    }
  `;

  // ---------------------------------------------------------------------------
  // 全局事件与启动
  // ---------------------------------------------------------------------------

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      if (state.batchOpen) {
        state.batchOpen = false;
        renderAll();
      } else if (state.dialogOpen) {
        closeDialog();
      }
    },
    true
  );

  // 简单的焦点循环：对话框打开时 Tab 不跑出卡片。
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Tab' || !state.dialogOpen) return;
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'KTM_OPEN_PANEL') {
      openDialog();
      sendResponse({ ok: true });
    }
    return false;
  });

  // SPA 路由变化后重新注入。
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (state.dialogOpen) closeDialog();
      scheduleInject();
    }
  }, 1200);

  const observer = new MutationObserver(() => scheduleInject());
  const startObserving = () => {
    if (!document.body) return;
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleInject();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  } else {
    startObserving();
  }

  setInterval(injectUi, 2500);
})();
