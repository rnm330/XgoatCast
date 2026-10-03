(() => {
  const release = document.querySelector('#release');
  const history = document.querySelector('#release-history');
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function notes(value) {
    const container = element('div', undefined, 'notes');
    let list;
    for (const line of (Array.isArray(value) ? value.join('\n') : String(value || '暂无更新说明')).split(/\r?\n/)) {
      if (!line.trim()) { list = undefined; continue; }
      if (line.startsWith('- ')) {
        if (!list) { list = element('ul'); container.append(list); }
        list.append(element('li', line.slice(2)));
      } else { list = undefined; container.append(element('p', line)); }
    }
    return container;
  }
  async function loadHistory(latestVersion) {
    if (!history) return;
    history.replaceChildren(element('p', '正在读取历史更新…', 'meta'));
    try {
      const response=await fetch('/downloads/windows/history.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error();
      const data=await response.json();
      if(data.schemaVersion!==1 || data.product!=='XgoatCast' || !Array.isArray(data.releases))throw Error();
      history.replaceChildren();
      for(const v of data.releases) {
        if(v.version===latestVersion || typeof v.version!=='string')continue;
        const entry=element('details',undefined,'history-entry');
        const summary=element('summary');
        summary.append(element('span',v.version),element('time',String(v.publishedAt || ''),'meta'));
        entry.append(summary,notes(v.notes));
        history.append(entry);
      }
      if(!history.childElementCount)history.append(element('p','暂无更早版本。','meta'));
    } catch {
      const retry=element('button','重新读取历史更新');retry.type='button';retry.addEventListener('click',()=>loadHistory(latestVersion));
      history.replaceChildren(element('p','历史更新暂时无法读取。','meta'),retry);
    }
  }
  async function load() {
    release.replaceChildren(element('p', '正在读取最新版本…'));
    release.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/downloads/windows/latest.json', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error();
      const v = await response.json();
      if (v.schemaVersion !== 1 || v.product !== 'XgoatCast' || typeof v.version !== 'string' || !['beta', 'stable'].includes(v.channel)) throw Error();
      const meta = element('div', '最新版本', 'meta');
      meta.append(element('span', v.channel === 'beta' ? 'Beta' : '稳定版', 'badge'));
      release.replaceChildren(meta, element('h2', v.version));
      if (v.publishedAt) release.append(element('p', `发布于 ${v.publishedAt} · Windows x64${v.bytes ? ` · ${(v.bytes / 1048576).toFixed(1)} MiB` : ''}`, 'meta'));
      release.append(notes(v.notes));
      void loadHistory(v.version);
      if (!/^[a-f0-9]{64}$/i.test(v.sha256 || '')) {
        release.append(element('p', '安装包正在准备中，请稍后回来查看。', 'meta'));
        return;
      }
      const url = new URL(v.downloadUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw Error();
      const download = element('a', '下载', 'download');
      download.href = url.href; download.target = '_blank'; download.rel = 'noopener noreferrer';
      release.append(download);
      release.append(element('div', `SHA-256：${v.sha256}`, 'checksum'));
    } catch {
      const retry = element('button', '重新读取版本');
      retry.type = 'button'; retry.addEventListener('click', load);
      release.replaceChildren(element('p', '暂时无法读取发布信息，请检查网络后重试。', 'notes'), retry);
    } finally { release.setAttribute('aria-busy', 'false'); }
  }
  void load();
})();
