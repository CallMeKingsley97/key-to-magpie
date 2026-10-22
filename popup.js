/**
 * Key to Magpie — popup
 *
 * 管理当前站点的扩展开关，并打开当前标签页的导入面板。
 */

'use strict';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const siteStateEl = $('site-state');
const toggleBtn = $('toggle');
const openBtn = $('open');
const SITE_ENABLED_PREFIX = 'ktm:site-enabled:';

let activeTab = null;
let activeOrigin = '';
let siteEnabled = true;
let supportedPage = false;

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function isSupportedUrl(url) {
  return /^https?:/i.test(url || '');
}

function isTokenManagementUrl(url) {
  try {
    const path = new URL(url).pathname;
    return !/^\/(oauth|login|sign-?in|callback|auth)/i.test(path) &&
      (/(^|\/)(keys?|tokens?|api-keys)(\/|$)/i.test(path) ||
        /\/console\/(token|keys)(\/|$)/i.test(path));
  } catch {
    return false;
  }
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result || {});
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function renderSiteState() {
  const site = new URL(activeOrigin).host;
  const pageType = supportedPage ? '令牌管理页' : '非令牌管理页';
  siteStateEl.textContent = `当前站点：${site} · ${siteEnabled ? '已开启' : '已关闭'} · ${pageType}`;
  toggleBtn.textContent = siteEnabled ? '关闭当前站点插件' : '开启当前站点插件';
  toggleBtn.disabled = false;
  openBtn.disabled = !siteEnabled || !supportedPage;
}

async function loadActiveSite() {
  toggleBtn.disabled = true;
  openBtn.disabled = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null || !isSupportedUrl(tab.url)) {
    siteStateEl.textContent = '当前页面不支持此功能';
    toggleBtn.disabled = true;
    openBtn.disabled = true;
    setStatus('请切换到 http 或 https 网站。', 'err');
    return;
  }

  activeTab = tab;
  activeOrigin = new URL(tab.url).origin;
  const key = SITE_ENABLED_PREFIX + activeOrigin;
  const preferences = await storageGet(key);
  siteEnabled = preferences[key] !== false;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'KTM_GET_STATUS' });
    supportedPage = response ? Boolean(response.supported) : isTokenManagementUrl(tab.url);
  } catch {
    supportedPage = isTokenManagementUrl(tab.url);
  }
  renderSiteState();
}

async function toggleSite() {
  if (!activeTab || !activeOrigin) return;
  const desiredEnabled = !siteEnabled;
  const key = SITE_ENABLED_PREFIX + activeOrigin;
  toggleBtn.disabled = true;
  openBtn.disabled = true;
  setStatus(desiredEnabled ? '正在开启当前站点…' : '正在关闭当前站点…');

  try {
    await storageSet({ [key]: desiredEnabled });
    siteEnabled = desiredEnabled;
    renderSiteState();
    try {
      await chrome.tabs.sendMessage(activeTab.id, {
        type: 'KTM_SET_ENABLED',
        origin: activeOrigin,
        enabled: desiredEnabled,
      });
    } catch {
      /* 页面脚本尚未就绪时，存储的设置会在刷新或下次导航时生效 */
    }
    setStatus(
      desiredEnabled ? '已开启；当前页面功能已恢复。' : '已关闭；当前页面不会再显示扩展功能。',
      'ok'
    );
  } catch (error) {
    setStatus('保存站点开关失败：' + (error && error.message ? error.message : error), 'err');
    renderSiteState();
  }
}

async function openPanel() {
  if (!activeTab || !siteEnabled) return;
  openBtn.disabled = true;
  setStatus('正在打开导入面板…');

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'KTM_OPEN_PANEL' });
    if (response && response.ok === false) {
      setStatus(response.error || '当前页面没有找到可用的令牌接口。', 'err');
      openBtn.disabled = false;
      return;
    }
    setStatus('已打开导入面板。', 'ok');
    setTimeout(() => window.close(), 700);
  } catch {
    setStatus('这个页面无法使用，请刷新页面后重试。', 'err');
    openBtn.disabled = false;
  }
}

toggleBtn.addEventListener('click', toggleSite);
openBtn.addEventListener('click', openPanel);

loadActiveSite().catch((error) => {
  siteStateEl.textContent = '无法读取当前站点';
  toggleBtn.disabled = true;
  openBtn.disabled = true;
  setStatus('读取失败：' + (error && error.message ? error.message : error), 'err');
});
