'use strict';

(() => {
  let newApiAccessToken = '';
  let newApiUserId = '';

  const isTokenPage = () =>
    !/^\/(oauth|login|sign-?in|callback|auth)/i.test(location.pathname) &&
    (/(^|\/)(keys?|tokens?|api-keys)(\/|$)/i.test(location.pathname) ||
      /\/console\/(token|keys)(\/|$)/i.test(location.pathname));

  const isNewApiManagementRequest = (requestUrl) => {
    try {
      const url = new URL(requestUrl, location.href);
      return url.origin === location.origin && /^\/api\/(user|token)(\/|$)/i.test(url.pathname);
    } catch {
      return false;
    }
  };

  const captureNewApiHeaders = (headers) => {
    const authorization = headers.get('Authorization') || '';
    const accessToken = authorization.match(/^Bearer\s+(.+)$/i);
    if (accessToken) newApiAccessToken = accessToken[1].trim();

    const userId = headers.get('New-Api-User') || '';
    if (/^[1-9]\d*$/.test(userId)) newApiUserId = userId;
  };

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, requestUrl) {
    this.__ktmCaptureNewApiAuth = isTokenPage() && isNewApiManagementRequest(requestUrl);
    return originalXhrOpen.apply(this, arguments);
  };

  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__ktmCaptureNewApiAuth) {
      const headerName = String(name).toLowerCase();
      const headerValue = String(value);
      if (headerName === 'authorization' && /^Bearer\s+/i.test(headerValue)) {
        newApiAccessToken = headerValue.replace(/^Bearer\s+/i, '').trim();
      } else if (headerName === 'new-api-user' && /^[1-9]\d*$/.test(headerValue)) {
        newApiUserId = headerValue;
      }
    }
    return originalSetRequestHeader.apply(this, arguments);
  };

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const requestUrl = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    if (isTokenPage() && isNewApiManagementRequest(requestUrl)) {
      try {
        const headers = new Headers((init && init.headers) || (input && input.headers) || {});
        captureNewApiHeaders(headers);
      } catch {}
    }
    return originalFetch.apply(this, arguments);
  };

  window.addEventListener('message', async (event) => {
    const message = event.data;
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      !message ||
      message.source !== 'KTM_PAGE_AUTH_REQUEST' ||
      typeof message.requestId !== 'string'
    ) return;
    if (!isTokenPage()) return;

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

    window.postMessage({
      source: 'KTM_PAGE_AUTH_RESPONSE',
      requestId: message.requestId,
      data,
      error,
    }, location.origin);
  });
})();
