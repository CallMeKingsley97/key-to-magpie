'use strict';

(() => {
  const isTokenPage = () =>
    !/^\/(oauth|login|sign-?in|callback|auth)/i.test(location.pathname) &&
    (/(^|\/)(keys?|tokens?|api-keys)(\/|$)/i.test(location.pathname) ||
      /\/console\/(token|keys)(\/|$)/i.test(location.pathname));

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
