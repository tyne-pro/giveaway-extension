const open = (url) => { chrome.tabs.create({ url }); window.close(); };
document.getElementById('giveaway').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const params = new URLSearchParams({ autostart: '1' });
  if (tab && tab.url && /instagram\.com/.test(tab.url)) params.set('sourceUrl', tab.url);
  open(chrome.runtime.getURL(`giveaway.html?${params}`));
});
document.getElementById('gbp').addEventListener('click', () => open('https://cp.tyne.pro/tools/gbp'));
document.getElementById('cabinet').addEventListener('click', () => open('https://cp.tyne.pro/user'));
