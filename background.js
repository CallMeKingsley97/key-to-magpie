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
const OPEN_TAB_KEY = 'ktm:openTabId';

/**
 * MV3 service worker 会在空闲约 30 秒后被回收，全局变量里的 openTabId
 * 会随之丢失，所以持久化到 chrome.storage.session（浏览器关闭前有效）。
 */
async function getOpenTabId() {
  try {
    const stored = await chrome.storage.session.get(OPEN_TAB_KEY);
    const id = stored && stored[OPEN_TAB_KEY];
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

async function setOpenTabId(tabId) {
  try {
    if (tabId == null) await chrome.storage.session.remove(OPEN_TAB_KEY);
    else await chrome.storage.session.set({ [OPEN_TAB_KEY]: tabId });
  } catch {
    /* storage.session 不可用时静默降级：只是失去标签页复用能力 */
  }
}

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
  chrome.tabs.create({ url, active: true }, async (tab) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    const tabId = tab && tab.id != null ? tab.id : null;
    await setOpenTabId(tabId);
    sendResponse({ ok: true, tabId });
  });
}

function openImportTab(link, label, reuse, sendResponse) {
  const url = importPageUrl(link, label);

  // 复用上一次的扩展页：页面重新加载后会再次尝试打开 magpie。
  if (reuse) {
    (async () => {
      const previous = await getOpenTabId();
      if (previous == null) {
        createImportTab(url, sendResponse);
        return;
      }
      chrome.tabs.update(previous, { url, active: true }, async (tab) => {
        if (chrome.runtime.lastError || !tab) {
          await setOpenTabId(null);
          createImportTab(url, sendResponse);
          return;
        }
        sendResponse({ ok: true, tabId: previous });
      });
    })();
    return;
  }

  createImportTab(url, sendResponse);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 只接受本扩展自己的 content script / popup。
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!message) return false;

  if (message.type === 'KTM_FINISH_IMPORT') {
    (async () => {
      const tabId = await getOpenTabId();
      if (tabId == null) {
        sendResponse({ ok: true });
        return;
      }
      chrome.tabs.update(tabId, { url: chrome.runtime.getURL(IMPORT_PAGE) + '?done=1' }, async () => {
        if (chrome.runtime.lastError) await setOpenTabId(null);
        sendResponse({ ok: true });
      });
    })();
    return true; // 异步响应
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
  (async () => {
    const current = await getOpenTabId();
    if (current === tabId) await setOpenTabId(null);
  })();
});
