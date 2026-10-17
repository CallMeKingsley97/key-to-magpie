/**
 * Key to Magpie — 扩展内导入页
 *
 * 从 URL 中读取 magpie://import 链接，尝试唤起 magpie，并提供手动兜底。
 * key 只存在于本页 URL / 内存中，不会被发送到任何服务器。
 */

'use strict';

const $ = (id) => document.getElementById(id);

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseLink(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'magpie:') return null;
    if (url.hostname !== 'import' && url.pathname.replace(/^\/+/, '') !== 'import') return null;
    return url;
  } catch {
    return null;
  }
}

function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

function renderFacts(url, name) {
  const facts = $('facts');
  facts.replaceChildren();

  const add = (label, value) => {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    row.append(dt, dd);
    facts.append(row);
  };

  const q = url.searchParams;
  add('Provider', name || q.get('name') || q.get('id') || '未命名');

  const hosts = [];
  for (const key of ['chat', 'responses', 'anthropic', 'gemini']) {
    const host = hostOf(q.get(key) || '');
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  if (hosts.length) add('发送到', hosts.join(', '));

  const models = (q.get('models') || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length) add('模型', models.length > 8 ? `${models.slice(0, 8).join(', ')} 等 ${models.length} 个` : models.join(', '));

  add('Key', q.get('key') ? '已包含（不在此页显示）' : '未包含，magpie 会要求粘贴');
}

function setStatus(text, kind) {
  const box = $('status');
  const label = $('statusText');
  box.classList.toggle('ok', kind === 'ok');
  label.replaceChildren();
  if (kind === 'loading') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    label.append(spinner);
  }
  label.append(document.createTextNode(text));
}

function setupDone() {
  $('title').textContent = '已发送到 magpie';
  $('sub').textContent = '请回到 magpie 窗口，点击 Add / 添加 完成导入。';
  $('facts').classList.add('hidden');
  $('open').classList.add('hidden');
  $('copy').classList.add('hidden');
  $('done').textContent = '关闭此页';
  $('done').onclick = () => window.close();
  setStatus('magpie 已收到导入请求。', 'ok');
  $('foot').textContent = '如果 magpie 没有出现，请从菜单栏或 Dock 打开它。';
}

function setupImport(rawLink, name) {
  const url = parseLink(rawLink);
  if (!url) {
    $('title').textContent = '导入链接无效';
    $('sub').textContent = '请回到令牌管理页，重新点击“导入到 magpie”。';
    $('facts').classList.add('hidden');
    $('open').classList.add('hidden');
    $('copy').classList.add('hidden');
    $('done').textContent = '关闭此页';
    $('done').onclick = () => window.close();
    setStatus('没有找到有效的 magpie://import 链接。');
    return;
  }

  // 立即从地址栏移除带 key 的查询串；链接本身留在内存中。
  try {
    history.replaceState(null, '', location.pathname + '?done=0');
  } catch {
    /* 地址栏清理失败不影响导入 */
  }

  const link = url.toString();
  const open = $('open');
  open.href = link;

  renderFacts(url, name);

  const copy = $('copy');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      copy.textContent = '已复制';
      setTimeout(() => (copy.textContent = '复制导入链接'), 1400);
    } catch {
      // 极少数情况下剪贴板不可用：选中链接让用户手动复制。
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      copy.textContent = '已复制';
      setTimeout(() => (copy.textContent = '复制导入链接'), 1400);
    }
  };

  $('done').onclick = () => {
    location.replace(location.pathname + '?done=1');
  };

  // magpie 的导入弹窗会抢焦点；页面失焦通常说明已经唤起成功。
  let left = false;
  const markLeft = () => {
    left = true;
  };
  window.addEventListener('blur', markLeft);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) markLeft();
  });

  // 先让页面渲染一帧，再尝试外部协议。
  setTimeout(() => {
    try {
      open.click();
    } catch {
      /* 浏览器可能拦截；下面的手动按钮仍然可用 */
    }
  }, 420);

  setTimeout(() => {
    if (left) {
      setStatus('magpie 已打开，请在该窗口中确认添加。', 'ok');
      return;
    }
    setStatus('没有自动打开？点击上方“在 magpie 中打开”。');
    $('foot').textContent = '如果仍然没有反应，请确认已安装 magpie，并允许浏览器打开 magpie 链接。';
  }, 2800);
}

function main() {
  const params = new URLSearchParams(location.search);
  if (params.get('done') === '1') {
    setupDone();
    return;
  }

  const rawLink = safeDecode(params.get('link') || '');
  const name = params.get('name') || '';
  setupImport(rawLink, name);
}

main();
