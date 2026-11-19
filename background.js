function buildDashboardUrl(sourceUrl) {
  const params = new URLSearchParams();
  if (sourceUrl) params.set('sourceUrl', sourceUrl);
  params.set('autostart', '1');
  return chrome.runtime.getURL(`dashboard.html?${params.toString()}`);
}

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({
    url: buildDashboardUrl(tab && tab.url ? tab.url : ''),
  });
});
