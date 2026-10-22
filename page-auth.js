'use strict';

(() => {
  let newApiAccessToken = '';
  let newApiUserId = '';
  let hasApiStationRequest = false;
  let enabled = false;
  let hooksInstalled = false;
  let originalClipboardWriteText = null;
  let originalXhrOpen = null;
  let originalSetRequestHeader = null;
  let originalFetch = null;
  const authRequests = new Map();

  const API_KEY_RE = /(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{4,}(?![A-Za-z0-9_-])/;

  const isTokenPage = () =>
    !/^\/(oauth|login|sign-?in|callback|auth)/i.test(location.pathname) &&
    (/(^|\/)(keys?|tokens?|api-keys)(\/|$)/i.test(location.pathname) ||
      /\/console\/(token|keys)(\/|$)/i.test(location.pathname));

  const isApiStationPage = () => {
    if (!enabled || !isTokenPage()) return false;
    if (hasApiStationRequest) return true;
    try {
      return Boolean(localStorage.getItem('auth_token') || window.__APP_CONFIG__?.site_name);
    } catch {
      return false;
    }
  };

  const isApiStationManagementRequest = (requestUrl) => {
    try {
      const url = new URL(requestUrl, location.href);
      return (
        url.origin === location.origin &&
        /(?:^|\/)api\/(?:user|token|v1\/(?:keys|settings\/public))(?:\/|$)/i.test(url.pathname)
      );
    } catch {
      return false;
    }
  };

  const isNewApiManagementRequest = (requestUrl) => {
    try {
      const url = new URL(requestUrl, location.href);
      return url.origin === location.origin && /^\/api\/(user|token)(\/|$)/i.test(url.pathname);
    } catch {
      return false;
    }
  };

  const announceCopiedApiKey = () => {
    window.postMessage({ source: 'KTM_PAGE_AUTH', type: 'API_KEY_COPIED' }, location.origin);
  };

  const captureNewApiHeaders = (headers) => {
    const authorization = headers.get('Authorization') || '';
    const accessToken = authorization.match(/^Bearer\s+(.+)$/i);
    if (accessToken) newApiAccessToken = accessToken[1].trim();

    const userId = headers.get('New-Api-User') || '';
    if (/^[1-9]\d*$/.test(userId)) newApiUserId = userId;
  };

  function onCopy(event) {
    if (!isApiStationPage() || !event.clipboardData) return;
    let text = '';
    try {
      text = event.clipboardData.getData('text/plain') || event.clipboardData.getData('text');
    } catch {}
    if (!text) {
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement
      ) {
        const selectionStart = activeElement.selectionStart;
        const selectionEnd = activeElement.selectionEnd;
        if (selectionStart != null && selectionEnd != null && selectionEnd > selectionStart) {
          text = activeElement.value.slice(selectionStart, selectionEnd);
        }
      } else {
        text = window.getSelection()?.toString() || '';
      }
    }
    if (typeof text === 'string' && API_KEY_RE.test(text)) announceCopiedApiKey();
  }

  function patchedClipboardWriteText(text) {
    const containsApiKey = isApiStationPage() && typeof text === 'string' && API_KEY_RE.test(text);
    const result = originalClipboardWriteText.apply(this, arguments);
    if (!containsApiKey) return result;
    return Promise.resolve(result).then((value) => {
      announceCopiedApiKey();
      return value;
    });
  }

  function patchedXhrOpen(method, requestUrl) {
    if (enabled && isTokenPage() && isApiStationManagementRequest(requestUrl)) {
      hasApiStationRequest = true;
    }
    this.__ktmCaptureNewApiAuth = enabled && isTokenPage() && isNewApiManagementRequest(requestUrl);
    return originalXhrOpen.apply(this, arguments);
  }

  function patchedSetRequestHeader(name, value) {
    if (enabled && this.__ktmCaptureNewApiAuth) {
      const headerName = String(name).toLowerCase();
      const headerValue = String(value);
      if (headerName === 'authorization' && /^Bearer\s+/i.test(headerValue)) {
        newApiAccessToken = headerValue.replace(/^Bearer\s+/i, '').trim();
      } else if (headerName === 'new-api-user' && /^[1-9]\d*$/.test(headerValue)) {
        newApiUserId = headerValue;
      }
    }
    return originalSetRequestHeader.apply(this, arguments);
  }

  function patchedFetch(input, init) {
    if (enabled) {
      const requestUrl = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
      if (isTokenPage() && isApiStationManagementRequest(requestUrl)) hasApiStationRequest = true;
      if (isTokenPage() && isNewApiManagementRequest(requestUrl)) {
        try {
          const headers = new Headers((init && init.headers) || (input && input.headers) || {});
          captureNewApiHeaders(headers);
        } catch {}
      }
    }
    return originalFetch.apply(this, arguments);
  }

  function installHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;
    const clipboard = navigator.clipboard;
    originalClipboardWriteText = clipboard && clipboard.writeText;
    if (typeof originalClipboardWriteText === 'function') {
      try {
        clipboard.writeText = patchedClipboardWriteText;
      } catch {}
    }

    originalXhrOpen = XMLHttpRequest.prototype.open;
    originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    originalFetch = window.fetch;
    XMLHttpRequest.prototype.open = patchedXhrOpen;
    XMLHttpRequest.prototype.setRequestHeader = patchedSetRequestHeader;
    window.fetch = patchedFetch;
    window.addEventListener('copy', onCopy);
  }

  function removeHooks() {
    for (const controller of authRequests.values()) controller.abort();
    authRequests.clear();
    if (!hooksInstalled) return;
    hooksInstalled = false;
    window.removeEventListener('copy', onCopy);
    if (XMLHttpRequest.prototype.open === patchedXhrOpen) {
      XMLHttpRequest.prototype.open = originalXhrOpen;
    }
    if (XMLHttpRequest.prototype.setRequestHeader === patchedSetRequestHeader) {
      XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
    }
    if (window.fetch === patchedFetch) window.fetch = originalFetch;
    const clipboard = navigator.clipboard;
    if (clipboard && clipboard.writeText === patchedClipboardWriteText) {
      try {
        clipboard.writeText = originalClipboardWriteText;
      } catch {}
    }
    newApiAccessToken = '';
    newApiUserId = '';
    hasApiStationRequest = false;
  }

  async function handleAuthRequest(message, signal) {
    const prefix = typeof message.prefix === 'string' ? message.prefix : '';
    if (prefix && (!prefix.startsWith('/') || prefix.startsWith('//') || /[?#]/.test(prefix))) return;

    let data = null;
    let error = '';
    try {
      if (message.operation === 'sub2api.read') {
        data = { accessToken: localStorage.getItem('auth_token') || '' };
      } else if (message.operation === 'newapi.read') {
        data = { accessToken: newApiAccessToken, userId: newApiUserId };
      } else if (message.operation === 'sub2api.refresh') {
        const refreshToken = localStorage.getItem('refresh_token') || '';
        if (!refreshToken) {
          data = { accessToken: '', status: 0 };
        } else {
          const response = await fetch(`${prefix}/api/v1/auth/refresh`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken }),
            signal,
          });
          let json = null;
          try {
            json = await response.json();
          } catch {}
          const result = json && json.code === 0 ? json.data : null;
          const accessToken = result && typeof result.access_token === 'string' ? result.access_token : '';
          if (response.ok && accessToken) {
            localStorage.setItem('auth_token', accessToken);
            if (result.expires_in) {
              localStorage.setItem('token_expires_at', String(Date.now() + Number(result.expires_in) * 1000));
            }
            if (typeof result.refresh_token === 'string' && result.refresh_token) {
              localStorage.setItem('refresh_token', result.refresh_token);
            }
          }
          data = { accessToken: response.ok ? accessToken : '', status: response.status };
        }
      } else if (message.operation === 'newapi.refresh') {
        const response = await fetch(`${prefix}/api/user/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal,
        });
        let json = null;
        try {
          json = await response.json();
        } catch {}
        const accessToken = json && json.success && json.data && json.data.access_token;
        data = {
          accessToken: response.ok && typeof accessToken === 'string' ? accessToken : '',
          status: response.status,
        };
      } else {
        error = '不支持的认证操作。';
      }
    } catch (requestError) {
      error = requestError && requestError.message ? requestError.message : '读取站点登录状态失败。';
    }

    if (!enabled || signal.aborted) return;
    window.postMessage({
      source: 'KTM_PAGE_AUTH_RESPONSE',
      requestId: message.requestId,
      data,
      error,
    }, location.origin);
  }

  window.addEventListener('message', async (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || !message) return;

    if (
      message.source === 'KTM_EXTENSION_CONTENT' &&
      message.type === 'KTM_SET_ENABLED' &&
      typeof message.enabled === 'boolean'
    ) {
      enabled = message.enabled;
      if (enabled) installHooks();
      else removeHooks();
      return;
    }

    if (
      !enabled ||
      !isTokenPage() ||
      message.source !== 'KTM_PAGE_AUTH_REQUEST' ||
      typeof message.requestId !== 'string'
    ) return;

    const controller = new AbortController();
    authRequests.set(message.requestId, controller);
    try {
      await handleAuthRequest(message, controller.signal);
    } finally {
      authRequests.delete(message.requestId);
    }
  });
})();
