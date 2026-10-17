/**
 * Key to Magpie — popup
 *
 * 只有一个动作：让当前标签页里的 content script 打开导入面板。
 */

'use strict';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const openBtn = $('open');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function isSupportedUrl(url) {
  return /^https?:/i.test(url || '');
}

async function openPanel() {
  openBtn.disabled = true;
  setStatus('正在查找当前标签页…');

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (error) {
    setStatus('无法访问标签页：' + (error && error.message ? error.message : error), 'err');
    openBtn.disabled = false;
    return;
  }

  const tab = tabs && tabs[0];
  if (!tab || tab.id == null || !isSupportedUrl(tab.url)) {
    setStatus('请先打开中转站的令牌管理页（/token 或 /keys）。', 'err');
    openBtn.disabled = false;
    return;
  }

  setStatus('正在发送…');
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'KTM_OPEN_PANEL' });
    if (response && response.ok === false) {
      setStatus(response.error || '当前页面没有找到可用的令牌接口。', 'err');
      openBtn.disabled = false;
      return;
    }
    setStatus('已打开导入面板。', 'ok');
    setTimeout(() => window.close(), 700);
  } catch (error) {
    // content script 未注入：多半不是令牌页，或刚安装还没刷新页面。
    setStatus('这个页面无法使用，请先刷新页面，或确认地址是令牌管理页。', 'err');
    openBtn.disabled = false;
  }
}

openBtn.addEventListener('click', openPanel);
