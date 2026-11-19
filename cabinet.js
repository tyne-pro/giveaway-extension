// Runs on the tyne.pro cabinet only. It tells the page the extension is here and passes the page's
// requests to the background worker. Nothing on other sites can talk to the extension through it.
(() => {
  const version = chrome.runtime.getManifest().version;
  const hello = () => window.postMessage({ source: 'tyne-ext', type: 'hello', version }, window.location.origin);
  document.documentElement.dataset.tyneExt = version;
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'tyne-cabinet') return;
    if (data.cmd === 'ping') { hello(); return; }
    if (data.cmd === 'gbp-collect') {
      chrome.runtime.sendMessage({
        type: 'gbp-collect',
        auditId: String(data.auditId || ''),
        query: String(data.query || '').slice(0, 300),
        keyword: String(data.keyword || '').slice(0, 120),
        city: String(data.city || '').slice(0, 80),
        lang: ['uk', 'ru', 'en'].includes(data.lang) ? data.lang : 'uk',
        token: String(data.token || ''),
      });
    }
  });
  // progress and errors from the background worker back to the page
  chrome.runtime.onMessage.addListener((message) => {
    if (message && typeof message.type === 'string' && message.type.startsWith('gbp-')) {
      window.postMessage({ source: 'tyne-ext', ...message }, window.location.origin);
    }
  });
  hello();
})();
