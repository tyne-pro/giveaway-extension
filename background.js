// tyne.pro extension, background worker.
// Google module: the cabinet page asks for an audit; the worker opens Google Maps in a background tab,
// reads the place, its reviews and nearby competitors there (the same data a visitor sees), sends it to
// the cabinet that asked, and closes the tab. Nothing is sent anywhere else.

const CABINETS = [/^https:\/\/cp\.tyne\.pro$/, /^http:\/\/localhost(:\d+)?$/];
const MAPS = 'https://www.google.com/maps';
const busy = new Set();

const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };
const tell = (tabId, message) => { if (tabId != null) chrome.tabs.sendMessage(tabId, message).catch(() => {}); };

function waitLoaded(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(on); reject(new Error('maps_timeout')); }, timeout);
    const on = (id, info, tab) => {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer); chrome.tabs.onUpdated.removeListener(on); resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(on);
  });
}

async function runGbp(message, sender) {
  const cabinetTab = sender.tab && sender.tab.id;
  const origin = originOf(sender.tab && sender.tab.url);
  if (!CABINETS.some((re) => re.test(origin))) return;
  if (!/^[0-9a-f-]{36}$/i.test(message.auditId) || busy.has(message.auditId)) return;
  busy.add(message.auditId);
  let mapsTab = null;
  try {
    const link = /^https:\/\/(www\.)?google\.[a-z.]+\/maps\//i.test(message.query) || /^https:\/\/maps\.app\.goo\.gl\//i.test(message.query);
    const q = [message.query, message.city].filter(Boolean).join(' ');
    const url = link ? message.query : `${MAPS}/search/${encodeURIComponent(q)}?hl=${message.lang}`;
    tell(cabinetTab, { type: 'gbp-progress', auditId: message.auditId, stage: 'open' });
    mapsTab = await chrome.tabs.create({ url, active: false });
    const loaded = await waitLoaded(mapsTab.id);
    // short links redirect; give Maps a moment to settle on the place URL
    await new Promise((r) => setTimeout(r, 2500));
    const tab = await chrome.tabs.get(mapsTab.id).catch(() => loaded);
    if (!/^https:\/\/www\.google\.com\//.test(tab.url || '')) {
      // a consent or sign-in page: show it to the person instead of failing silently
      await chrome.tabs.update(mapsTab.id, { active: true });
      mapsTab = null;
      tell(cabinetTab, { type: 'gbp-error', auditId: message.auditId, code: 'consent' });
      return;
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectOnMaps,
      args: [{ auditId: message.auditId, query: link ? '' : message.query, city: message.city, keyword: message.keyword, lang: message.lang, href: tab.url }],
    });
    if (!result || result.error) throw new Error(result ? result.error : 'no_result');
    tell(cabinetTab, { type: 'gbp-progress', auditId: message.auditId, stage: 'send', reviews: result.reviews.length });
    const res = await fetch(`${origin}/api/public/gbp/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: message.token, auditId: message.auditId, collected: result }),
    });
    tell(cabinetTab, res.ok ? { type: 'gbp-sent', auditId: message.auditId } : { type: 'gbp-error', auditId: message.auditId, code: `ingest_${res.status}` });
  } catch (error) {
    tell(cabinetTab, { type: 'gbp-error', auditId: message.auditId, code: String(error && error.message || error).slice(0, 80) });
  } finally {
    busy.delete(message.auditId);
    if (mapsTab) chrome.tabs.remove(mapsTab.id).catch(() => {});
  }
}

// Progress from the Maps tab goes on to the cabinet page; the messages also keep this worker awake
const progressTargets = new Map();
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'gbp-collect' && sender.tab) {
    progressTargets.set(message.auditId, sender.tab.id);
    runGbp(message, sender).finally(() => progressTargets.delete(message.auditId));
  } else if (message.type === 'gbp-progress' && sender.tab && /^https:\/\/www\.google\.com\//.test(sender.tab.url || '')) {
    tell(progressTargets.get(message.auditId), message);
  }
});

// ---------------------------------------------------------------------------------------------
// Runs inside the Google Maps tab (isolated world). Self-contained: it is serialised by executeScript.
// Reads Maps' own JSON endpoints with the tab's session, the same requests the Maps page makes.
async function collectOnMaps(opts) {
  const g = (a, ...path) => { for (const i of path) { if (!Array.isArray(a)) return undefined; a = a[i]; } return a; };
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ping = (stage, extra = {}) => { try { chrome.runtime.sendMessage({ type: 'gbp-progress', auditId: opts.auditId, stage, ...extra }); } catch { /* the page is gone */ } };
  const parse = (text) => JSON.parse(text.slice(text.indexOf('\n') + 1).replace(/\/\*""\*\/\s*$/, ''));
  const hl = opts.lang === 'en' ? 'en' : opts.lang;

  // Map centre and the place's feature id from the URL Maps settled on
  const href = location.href;
  const at = href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  let lat = at ? Number(at[1]) : 50.45, lng = at ? Number(at[2]) : 30.52;
  const fidInUrl = (href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i) || [])[1];
  const nameInUrl = decodeURIComponent((href.match(/\/maps\/place\/([^/@]+)/) || [])[1] || '').replace(/\+/g, ' ');

  const pb = (la, ln, meters, n) => `!4m12!1m3!1d${meters}!2d${ln}!3d${la}!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!7i${n}!8i0!10b1!12m22!1m3!18b1!30b1!34e1!2m3!5m1!6e2!20e3!4b0!10b1!12b1!13b1!16b1!17m1!3e1!20m3!5e2!6b1!14b1!46m1!1b0!96b1!19m4!2m3!1i360!2i120!4i8`;
  async function search(q, la, ln, meters, n) {
    const res = await fetch(`/search?tbm=map&authuser=0&hl=${hl}&q=${encodeURIComponent(q)}&pb=${encodeURIComponent(pb(la, ln, meters, n))}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`search_${res.status}`);
    const d = parse(await res.text());
    const single = Array.isArray(d[6]) && str(d[6][11]) ? d[6] : null;
    const items = (g(d, 0, 1) || []).map((x) => g(x, 14)).filter((b) => Array.isArray(b) && str(b[11]));
    return { single, items };
  }

  function place(b) {
    const hours = {};
    for (const day of g(b, 203, 0) || []) {
      const name = str(g(day, 0));
      const times = (g(day, 3) || []).map((t) => str(g(t, 0))).filter(Boolean);
      if (name) hours[name] = times;
    }
    if (!Object.keys(hours).length) for (const day of g(b, 34, 1) || []) { const name = str(g(day, 0)); if (name) hours[name] = (g(day, 1) || []).filter((t) => typeof t === 'string'); }
    const attributes = [];
    for (const group of g(b, 100, 1) || []) for (const opt of g(group, 2) || []) { const label = str(g(opt, 1)); if (label && g(opt, 2, 0) === 1) attributes.push(label); }
    const hist = g(b, 175, 3);
    const histogram = Array.isArray(hist) && hist.length === 5 ? Object.fromEntries(hist.map((n, i) => [String(i + 1), num(n) || 0])) : undefined;
    const placeId = str(b[78]);
    let website = str(g(b, 7, 0));
    if (website && website.startsWith('/url?')) { try { website = new URL(website, location.origin).searchParams.get('q') || website; } catch { /* keep */ } }
    return {
      placeId, fid: str(b[10]), name: str(b[11]), categories: (g(b, 13) || []).filter((c) => typeof c === 'string'),
      address: str(b[39]) || (Array.isArray(b[2]) ? b[2].filter((x) => typeof x === 'string').join(', ') : str(b[18])),
      lat: num(g(b, 9, 2)), lng: num(g(b, 9, 3)), phone: str(g(b, 178, 0, 0)) || str(g(b, 178, 0, 1, 1, 0)),
      website, rating: num(g(b, 4, 7)), reviewCount: num(g(b, 4, 8)), description: str(g(b, 32, 1, 1)) || str(g(b, 154, 0, 0)),
      status: str(g(b, 34, 4, 4)) || str(g(b, 88, 0)) || '', hours, attributes, photos: num(g(b, 37, 1)), histogram,
      mapsUrl: placeId ? `https://www.google.com/maps/place/?q=place_id:${placeId}` : undefined,
    };
  }

  try {
    ping('place');
    // 1. The place itself: by the feature id from a link, else the first match for the name
    const q = opts.query ? [opts.query, opts.city].filter(Boolean).join(' ') : nameInUrl;
    if (!q) return { error: 'no_query' };
    const found = await search(q, lat, lng, at ? 15000 : 400000, 10);
    const pool = found.single ? [found.single, ...found.items] : found.items;
    const b = (fidInUrl && pool.find((x) => x[10] === fidInUrl)) || pool[0];
    if (!b) return { error: 'not_found_on_maps' };
    const p = place(b);
    if (p.lat != null && p.lng != null) { lat = p.lat; lng = p.lng; }

    // 2. Reviews, newest first, page by page
    const reviews = [];
    if (p.fid) {
      let token = '';
      const rid = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
      for (let page = 0; page < 50 && reviews.length < 1000; page++) {
        const pbr = `!1m6!1s${encodeURIComponent(p.fid)}!6m4!4m1!1e1!4m1!1e3!2m2!1i20!2s${encodeURIComponent(token)}!5m2!1s${rid}!7e81!8m9!2b1!3b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1!11m0!13m1!1e1`;
        const res = await fetch(`/maps/rpc/listugcposts?authuser=0&hl=${hl}&pb=${pbr}`, { credentials: 'include' });
        if (!res.ok) break;
        const d = parse(await res.text());
        for (const item of g(d, 2) || []) {
          const el = Array.isArray(g(item, 0)) ? item[0] : item;
          const id = str(g(el, 0));
          const rating = num(g(el, 2, 0, 0));
          if (!id || !rating) continue;
          const micros = num(g(el, 1, 2));
          reviews.push({ id, rating, text: str(g(el, 2, 15, 0, 0)) || str(g(el, 2, 15, 1, 0)) || '', time: micros ? Math.round(micros / 1000) : 0, author: str(g(el, 1, 4, 5, 0)), reply: str(g(el, 3, 14, 0, 0)) });
        }
        ping('reviews', { reviews: reviews.length, total: p.reviewCount || null });
        token = str(g(d, 1)) || '';
        if (!token) break;
        await sleep(350 + Math.random() * 300);
      }
    }

    // 3. Competitors: the Maps list for the main query around the place
    const keyword = opts.keyword || p.categories[0] || '';
    let competitors = [];
    if (keyword) {
      ping('competitors');
      const near = await search(keyword, lat, lng, 4000, 20).catch(() => ({ items: [] }));
      competitors = near.items.slice(0, 20).map((x, i) => {
        const c = place(x);
        return { placeId: c.placeId, name: c.name, rating: c.rating, reviewCount: c.reviewCount, categories: c.categories, position: i + 1, self: (!!p.fid && c.fid === p.fid) || (!!p.placeId && c.placeId === p.placeId) };
      });
    }
    delete p.fid;
    return { place: p, reviews, competitors, keyword };
  } catch (error) {
    return { error: String(error && error.message || error).slice(0, 80) };
  }
}
