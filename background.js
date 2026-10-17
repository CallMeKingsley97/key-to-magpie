/**
 * Key to Magpie — service worker
 *
 * 只做一件事：把 content script 生成的 magpie://import 链接放到一个扩展页
 * (open.html) 中打开。扩展页负责调用系统协议，并把 key 留在本机。
 *
 * 之所以不直接在 content script 里跳转 magpie://：
 * 1. 内容脚本里跳自定义协议容易触发浏览器的“外部协议”拦截；
 * 2. 扩展页可以显示“没有自动打开”的兜底按钮；
 * 3. 同一个标签页可以复用，连续导入多个 key 时不会开一堆标签页。
 */

'use strict';

const IMPORT_PAGE = 'open.html';
const MAX_LINK_LENGTH = 64 * 1024;

/** @type {number|null} 当前用于打开 magpie 链接的标签页 */
let openTabId = null;

function isAllowedImportLink(link) {
  return (
    typeof link === 'string' &&
    link.length > 0 &&
    link.length <= MAX_LINK_LENGTH &&
    /^magpie:\/\/import\?/i.test(link)
  );
}

function importPageUrl(link, label) {
  const params = new URLSearchParams();
  params.set('link', link);
  if (label) params.set('name', String(label).slice(0, 120));
  return chrome.runtime.getURL(IMPORT_PAGE) + '?' + params.toString();
}

function createImportTab(url, sendResponse) {
  chrome.tabs.create({ url, active: true }, (tab) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    openTabId = tab && tab.id != null ? tab.id : null;
    sendResponse({ ok: true, tabId: openTabId });
  });
}

function openImportTab(link, label, reuse, sendResponse) {
  const url = importPageUrl(link, label);

  // 复用上一次的扩展页：页面重新加载后会再次尝试打开 magpie。
  if (reuse && openTabId != null) {
    chrome.tabs.update(openTabId, { url, active: true }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        openTabId = null;
        createImportTab(url, sendResponse);
        return;
      }
      sendResponse({ ok: true, tabId: openTabId });
    });
    return;
  }

  createImportTab(url, sendResponse);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 只接受本扩展自己的 content script / popup。
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!message) return false;

  if (message.type === 'KTM_FINISH_IMPORT') {
    if (openTabId == null) {
      sendResponse({ ok: true });
      return false;
    }
    chrome.tabs.update(
      openTabId,
      { url: chrome.runtime.getURL(IMPORT_PAGE) + '?done=1' },
      () => {
        if (chrome.runtime.lastError) openTabId = null;
        sendResponse({ ok: true });
      }
    );
    return true;
  }

  if (message.type !== 'KTM_OPEN_IMPORT') return false;

  const payload = message.payload || {};
  const link = payload.link;

  if (!isAllowedImportLink(link)) {
    sendResponse({ ok: false, error: 'invalid magpie import link' });
    return false;
  }

  openImportTab(link, payload.label, payload.reuse === true, sendResponse);
  return true; // 异步响应
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === openTabId) openTabId = null;
});
