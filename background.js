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
  const debug = {};
  const step = async (tabId, func, args, world = 'ISOLATED') => (await chrome.scripting.executeScript({ target: { tabId }, func, args, world }))[0].result;
  try {
    const link = /^https:\/\/(www\.)?google\.[a-z.]+\/maps\//i.test(message.query) || /^https:\/\/maps\.app\.goo\.gl\//i.test(message.query);
    const q = [message.query, message.city].filter(Boolean).join(' ');
    const url = link ? message.query : `${MAPS}/search/${encodeURIComponent(q)}?hl=${message.lang}`;
    tell(cabinetTab, { type: 'gbp-progress', auditId: message.auditId, stage: 'open' });
    mapsTab = await chrome.tabs.create({ url, active: false });
    await waitLoaded(mapsTab.id);
    await new Promise((r) => setTimeout(r, 2500)); // short links redirect; let Maps settle on the place URL
    let tab = await chrome.tabs.get(mapsTab.id);
    if (!/^https:\/\/www\.google\.com\//.test(tab.url || '')) {
      // a consent or sign-in page: show it to the person instead of failing silently
      await chrome.tabs.update(mapsTab.id, { active: true });
      mapsTab = null;
      tell(cabinetTab, { type: 'gbp-error', auditId: message.auditId, code: 'consent' });
      return;
    }

    // 1. The place, its rank for each query and the competitors, from Maps' search
    const keywords = (message.keywords || []).filter(Boolean).slice(0, 4);
    const found = await step(tab.id, findOnMaps, [{ auditId: message.auditId, query: link ? '' : message.query, city: message.city, keywords, lang: message.lang, href: tab.url }]);
    if (!found || found.error) throw new Error(found ? found.error : 'no_result');
    const place = parsePlace(found.place);
    if (!place.name) throw new Error('not_found_on_maps');

    // 2. The place page: Maps embeds the full card there (hours, attributes, description, photos)
    if (place.placeId) {
      tell(cabinetTab, { type: 'gbp-progress', auditId: message.auditId, stage: 'card' });
      await chrome.tabs.update(tab.id, { url: `${MAPS}/search/?api=1&query=${encodeURIComponent(place.name)}&query_place_id=${encodeURIComponent(place.placeId)}&hl=${message.lang}` });
      await waitLoaded(tab.id).catch(() => null);
      await new Promise((r) => setTimeout(r, 2000));
      tab = await chrome.tabs.get(tab.id);
      const raw = await step(tab.id, readAppState, [], 'MAIN').catch((e) => ({ error: String(e && e.message || e) }));
      debug.card = raw && raw.error ? raw.error : raw ? `ok ${String(raw).length}` : 'empty';
      if (typeof raw === 'string') {
        try {
          const full = JSON.parse(raw.slice(raw.indexOf('\n') + 1).replace(/^\)\]\}'/, ''));
          const card = parsePlace(full[6]);
          if (card.name) for (const [k, v] of Object.entries(card)) if (isEmpty(place[k]) && !isEmpty(v)) place[k] = v;
          debug.cardFields = ['hours', 'attributes', 'description', 'photos', 'website'].filter((k) => !isEmpty(card[k]));
        } catch (e) { debug.card = `parse ${String(e && e.message || e).slice(0, 60)}`; }
      }
    }

    // 3. Reviews, from the place page with the tab's session
    let reviews = [];
    if (place.fid) {
      tell(cabinetTab, { type: 'gbp-progress', auditId: message.auditId, stage: 'reviews', reviews: 0, total: place.reviewCount || null });
      const got = await step(tab.id, readReviews, [{ auditId: message.auditId, fid: place.fid, lang: message.lang, total: place.reviewCount || null }]);
      reviews = (got && got.reviews) || [];
      debug.reviews = got && got.debug;
    }

    const collected = { place: { ...place, fid: undefined }, reviews, competitors: found.competitors.map((c) => ({ ...c, self: (!!place.fid && c.fid === place.fid) || (!!place.placeId && c.placeId === place.placeId), fid: undefined })), ranks: found.ranks.map((r) => ({ query: r.query, position: r.ids.findIndex((id) => id && (id === place.fid || id === place.placeId)) + 1 || null, top: r.top })), keyword: found.keyword, debug };
    tell(cabinetTab, { type: 'gbp-progress', auditId: message.auditId, stage: 'send', reviews: reviews.length });
    const res = await fetch(`${origin}/api/public/gbp/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: message.token, auditId: message.auditId, collected }),
    });
    tell(cabinetTab, res.ok ? { type: 'gbp-sent', auditId: message.auditId } : { type: 'gbp-error', auditId: message.auditId, code: `ingest_${res.status}` });
  } catch (error) {
    tell(cabinetTab, { type: 'gbp-error', auditId: message.auditId, code: String(error && error.message || error).slice(0, 80) });
  } finally {
    busy.delete(message.auditId);
    if (mapsTab) chrome.tabs.remove(mapsTab.id).catch(() => {});
  }
}

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
const g = (a, ...path) => { for (const i of path) { if (!Array.isArray(a)) return undefined; a = a[i]; } return a; };
const str = (v) => (typeof v === 'string' ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A place card as Maps sends it (one big positional array) to plain fields. */
function parsePlace(b) {
  if (!Array.isArray(b)) return {};
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
  if (website && website.startsWith('/url?')) { try { website = new URL(website, 'https://www.google.com').searchParams.get('q') || website; } catch { /* keep */ } }
  const photos = num(g(b, 37, 1)) ?? num(g(b, 171, 1)) ?? (Array.isArray(g(b, 171, 0)) ? g(b, 171, 0).length : undefined);
  return {
    placeId, fid: str(b[10]), name: str(b[11]), categories: (g(b, 13) || []).filter((c) => typeof c === 'string'),
    address: str(b[39]) || (Array.isArray(b[2]) ? b[2].filter((x) => typeof x === 'string').join(', ') : str(b[18])),
    lat: num(g(b, 9, 2)), lng: num(g(b, 9, 3)), phone: str(g(b, 178, 0, 0)) || str(g(b, 178, 0, 1, 1, 0)),
    website, rating: num(g(b, 4, 7)), reviewCount: num(g(b, 4, 8)), description: str(g(b, 32, 1, 1)) || str(g(b, 154, 0, 0)),
    status: str(g(b, 34, 4, 4)) || str(g(b, 88, 0)) || '', hours, attributes, photos, histogram,
    mapsUrl: placeId ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(str(b[11]) || '')}&query_place_id=${placeId}` : undefined,
  };
}

// Company base: the cabinet sends the searches and a grid of map cells; the worker runs them in a background
// Maps tab, page by page, and posts the list of companies to the cabinet that asked.
const LANGS = ['uk', 'ru', 'en', 'pl', 'de', 'es', 'fr', 'pt', 'hi'];
async function runLeads(message, sender) {
  const cabinetTab = sender.tab && sender.tab.id;
  const origin = originOf(sender.tab && sender.tab.url);
  if (!CABINETS.some((re) => re.test(origin))) return;
  const job = message.job || {};
  if (!/^[0-9a-f-]{36}$/i.test(job.runId) || busy.has(job.runId)) return;
  busy.add(job.runId);
  const lang = LANGS.includes(job.lang) ? job.lang : 'uk';
  const say = (m) => tell(cabinetTab, { runId: job.runId, ...m });
  let mapsTab = null;
  let beat = 0;
  const heartbeat = (error) => {
    if (!error && Date.now() - beat < 60000) return;
    beat = Date.now();
    fetch(`${origin}/api/public/leads/ingest`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: message.token, runId: job.runId, error }) }).catch(() => {});
  };
  leadsBeats.set(job.runId, heartbeat);
  try {
    const first = (job.cells || [])[0];
    const url = first ? `${MAPS}/@${first.lat},${first.lng},13z?hl=${lang}` : `${MAPS}/search/${encodeURIComponent(job.place || '')}?hl=${lang}`;
    say({ type: 'leads-progress', stage: 'open' });
    mapsTab = await chrome.tabs.create({ url, active: false });
    await waitLoaded(mapsTab.id);
    await new Promise((r) => setTimeout(r, 1500));
    const tab = await chrome.tabs.get(mapsTab.id);
    if (!/^https:\/\/www\.google\.com\//.test(tab.url || '')) {
      await chrome.tabs.update(mapsTab.id, { active: true });
      mapsTab = null;
      say({ type: 'leads-error', code: 'consent' });
      heartbeat('consent');
      return;
    }
    const got = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectLeads, args: [{ runId: job.runId, queries: (job.queries || []).slice(0, 5), place: String(job.place || ''), cells: (job.cells || []).slice(0, 25), maxRows: Math.min(Number(job.maxRows) || 100, 2400), lang }] }))[0].result;
    if (got && got.error === 'captcha') {
      // Google wants a "not a robot" check: leave the tab open in front so the person can pass it
      await chrome.tabs.update(mapsTab.id, { active: true, url: `${MAPS}?hl=${lang}` });
      mapsTab = null;
    }
    if (!got || got.error) throw new Error(got ? got.error : 'no_result');
    say({ type: 'leads-progress', stage: 'send', found: got.items.length });
    const res = await fetch(`${origin}/api/public/leads/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: message.token, runId: job.runId, items: got.items, debug: got.debug }),
    });
    say(res.ok ? { type: 'leads-sent' } : { type: 'leads-error', code: `ingest_${res.status}` });
  } catch (error) {
    const code = String(error && error.message || error).slice(0, 60);
    say({ type: 'leads-error', code });
    heartbeat(code);
  } finally {
    busy.delete(job.runId);
    leadsBeats.delete(job.runId);
    if (mapsTab) chrome.tabs.remove(mapsTab.id).catch(() => {});
  }
}
const leadsBeats = new Map();

// Progress from the Maps tab goes on to the cabinet page; the messages also keep this worker awake
const progressTargets = new Map();
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'gbp-collect' && sender.tab) {
    progressTargets.set(message.auditId, sender.tab.id);
    runGbp(message, sender).finally(() => progressTargets.delete(message.auditId));
  } else if (message.type === 'gbp-progress' && sender.tab && /^https:\/\/www\.google\.com\//.test(sender.tab.url || '')) {
    tell(progressTargets.get(message.auditId), message);
  } else if (message.type === 'leads-collect' && sender.tab && message.job) {
    progressTargets.set(message.job.runId, sender.tab.id);
    runLeads(message, sender).finally(() => progressTargets.delete(message.job.runId));
  } else if (message.type === 'leads-progress' && sender.tab && /^https:\/\/www\.google\.com\//.test(sender.tab.url || '')) {
    tell(progressTargets.get(message.runId), message);
    const beat = leadsBeats.get(message.runId);
    if (beat) beat();
  }
});

// ---------------------------------------------------------------------------------------------
// The functions below run inside the Google Maps tab. Each is self-contained: executeScript serialises it.
// They call Maps' own JSON endpoints with the tab's session, the same requests the Maps page makes.

/** Finds the place and checks its position for each query. Returns raw Maps arrays; the worker parses them. */
async function findOnMaps(opts) {
  const g = (a, ...path) => { for (const i of path) { if (!Array.isArray(a)) return undefined; a = a[i]; } return a; };
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const ping = (stage, extra = {}) => { try { chrome.runtime.sendMessage({ type: 'gbp-progress', auditId: opts.auditId, stage, ...extra }); } catch { /* the page is gone */ } };
  const parse = (text) => JSON.parse(text.slice(text.indexOf('\n') + 1).replace(/\/\*""\*\/\s*$/, ''));
  const href = opts.href || location.href;
  const at = href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  let lat = at ? Number(at[1]) : 50.45, lng = at ? Number(at[2]) : 30.52;
  const fidInUrl = (href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i) || [])[1];
  const nameInUrl = decodeURIComponent((href.match(/\/maps\/place\/([^/@]+)/) || [])[1] || '').replace(/\+/g, ' ');
  const pb = (la, ln, meters, n) => `!4m12!1m3!1d${meters}!2d${ln}!3d${la}!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!7i${n}!8i0!10b1!12m22!1m3!18b1!30b1!34e1!2m3!5m1!6e2!20e3!4b0!10b1!12b1!13b1!16b1!17m1!3e1!20m3!5e2!6b1!14b1!46m1!1b0!96b1!19m4!2m3!1i360!2i120!4i8`;
  async function search(q, la, ln, meters, n) {
    const res = await fetch(`/search?tbm=map&authuser=0&hl=${opts.lang}&q=${encodeURIComponent(q)}&pb=${encodeURIComponent(pb(la, ln, meters, n))}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`search_${res.status}`);
    const d = parse(await res.text());
    const single = Array.isArray(d[6]) && str(d[6][11]) ? d[6] : null;
    const items = (g(d, 0, 1) || []).map((x) => g(x, 14)).filter((b) => Array.isArray(b) && str(b[11]));
    return { single, items };
  }
  const light = (b, i) => ({ placeId: str(b[78]), fid: str(b[10]), name: str(b[11]), rating: g(b, 4, 7), reviewCount: g(b, 4, 8), categories: (g(b, 13) || []).filter((c) => typeof c === 'string'), position: i + 1 });
  try {
    ping('place');
    const q = opts.query ? [opts.query, opts.city].filter(Boolean).join(' ') : nameInUrl;
    if (!q) return { error: 'no_query' };
    const found = await search(q, lat, lng, at ? 15000 : 400000, 10);
    const pool = found.single ? [found.single, ...found.items] : found.items;
    const place = (fidInUrl && pool.find((x) => x[10] === fidInUrl)) || pool[0];
    if (!place) return { error: 'not_found_on_maps' };
    if (typeof g(place, 9, 2) === 'number') { lat = place[9][2]; lng = place[9][3]; }
    // queries: the person's own, else the place's first categories
    const queries = (opts.keywords.length ? opts.keywords : (g(place, 13) || []).filter((c) => typeof c === 'string').slice(0, 3)).slice(0, 4);
    ping('competitors');
    const ranks = [];
    let competitors = [];
    for (const query of queries) {
      const near = await search(query, lat, lng, 4000, 20).catch(() => ({ items: [] }));
      const list = near.items.slice(0, 20);
      ranks.push({ query, ids: list.map((b) => str(b[10]) || str(b[78])), top: list.slice(0, 3).map((b) => str(b[11])) });
      if (!competitors.length) competitors = list.map(light);
      await new Promise((r) => setTimeout(r, 400));
    }
    return { place, competitors, ranks, keyword: queries[0] || '' };
  } catch (error) {
    return { error: String(error && error.message || error).slice(0, 80) };
  }
}

/** Runs in the page's own world: the full place card Maps embedded into the place page. */
function readAppState() {
  try {
    const s = window.APP_INITIALIZATION_STATE;
    const raw = s && s[3] && (s[3][6] || s[3][5]);
    return typeof raw === 'string' && raw.length > 100 ? raw : null;
  } catch { return null; }
}

/** Reviews, newest first, page by page. Keeps a short trace so a format change can be seen in the logs. */
async function readReviews(opts) {
  const g = (a, ...path) => { for (const i of path) { if (!Array.isArray(a)) return undefined; a = a[i]; } return a; };
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const ping = (extra) => { try { chrome.runtime.sendMessage({ type: 'gbp-progress', auditId: opts.auditId, stage: 'reviews', total: opts.total, ...extra }); } catch { /* gone */ } };
  const parse = (text) => JSON.parse(text.slice(text.indexOf('\n') + 1));
  const reviews = [];
  const debug = { pages: 0 };
  let token = '';
  const rid = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  try {
    for (let page = 0; page < 50 && reviews.length < 1000; page++) {
      const pb = `!1m6!1s${encodeURIComponent(opts.fid)}!6m4!4m1!1e1!4m1!1e3!2m2!1i20!2s${encodeURIComponent(token)}!5m2!1s${rid}!7e81!8m9!2b1!3b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1!11m0!13m1!1e1`;
      const res = await fetch(`/maps/rpc/listugcposts?authuser=0&hl=${opts.lang}&pb=${pb}`, { credentials: 'include' });
      const text = await res.text();
      debug.pages++;
      if (!res.ok) { debug.status = res.status; debug.head = text.slice(0, 160); break; }
      let d;
      try { d = parse(text); } catch (e) { debug.head = text.slice(0, 160); debug.parse = String(e.message).slice(0, 60); break; }
      const list = g(d, 2) || [];
      if (page === 0) { debug.top = Array.isArray(d) ? d.map((x) => (Array.isArray(x) ? `a${x.length}` : typeof x)).join(',') : typeof d; debug.first = JSON.stringify(list[0] || null).slice(0, 400); }
      for (const item of list) {
        const el = Array.isArray(g(item, 0)) ? item[0] : item;
        const id = str(g(el, 0));
        const rating = num(g(el, 2, 0, 0));
        if (!id || !rating) continue;
        const micros = num(g(el, 1, 2));
        reviews.push({ id, rating, text: str(g(el, 2, 15, 0, 0)) || str(g(el, 2, 15, 1, 0)) || '', time: micros ? Math.round(micros / 1000) : 0, author: str(g(el, 1, 4, 5, 0)), reply: str(g(el, 3, 14, 0, 0)) });
      }
      ping({ reviews: reviews.length });
      token = str(g(d, 1)) || '';
      if (!token) break;
      await new Promise((r) => setTimeout(r, 350 + Math.random() * 300));
    }
  } catch (error) { debug.error = String(error && error.message || error).slice(0, 80); }
  debug.read = reviews.length;
  return { reviews, debug };
}

/** Company base: every query in every cell, page by page (20 a page, about 240 per search at most). Parses in the tab. */
async function collectLeads(opts) {
  const g = (a, ...path) => { for (const i of path) { if (!Array.isArray(a)) return undefined; a = a[i]; } return a; };
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const ping = (extra) => { try { chrome.runtime.sendMessage({ type: 'leads-progress', runId: opts.runId, ...extra }); } catch { /* the page is gone */ } };
  const parse = (text) => JSON.parse(text.slice(text.indexOf('\n') + 1).replace(/\/\*""\*\/\s*$/, ''));
  const pb = (la, ln, meters, off) => `!4m12!1m3!1d${meters}!2d${ln}!3d${la}!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!7i20!8i${off}!10b1!12m22!1m3!18b1!30b1!34e1!2m3!5m1!6e2!20e3!4b0!10b1!12b1!13b1!16b1!17m1!3e1!20m3!5e2!6b1!14b1!46m1!1b0!96b1!19m4!2m3!1i360!2i120!4i8`;
  const lead = (b, query) => {
    const placeId = str(b[78]);
    let website = str(g(b, 7, 0));
    if (website && website.startsWith('/url?')) { try { website = new URL(website, 'https://www.google.com').searchParams.get('q') || website; } catch { /* keep */ } }
    return {
      placeId, fid: str(b[10]), name: str(b[11]), categories: (g(b, 13) || []).filter((c) => typeof c === 'string').slice(0, 6),
      address: str(b[39]) || (Array.isArray(b[2]) ? b[2].filter((x) => typeof x === 'string').join(', ') : str(b[18])),
      district: str(b[14]), lat: num(g(b, 9, 2)), lng: num(g(b, 9, 3)),
      phone: str(g(b, 178, 0, 0)) || str(g(b, 178, 0, 1, 1, 0)), website,
      rating: num(g(b, 4, 7)), reviewCount: num(g(b, 4, 8)),
      hours: Array.isArray(g(b, 203, 0)) || Array.isArray(g(b, 34, 1)),
      status: str(g(b, 34, 4, 4)) || str(g(b, 88, 0)) || '', query,
    };
  };
  const at = location.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const cells = opts.cells.length ? opts.cells : [{ lat: at ? Number(at[1]) : 50.45, lng: at ? Number(at[2]) : 30.52, meters: 30000, text: true }];
  const seen = new Set();
  const items = [];
  const debug = { requests: 0, errors: 0, cells: cells.length };
  const total = cells.length * opts.queries.length;
  // Pace like a person scrolling the map: a ceiling per search, pauses between pages and areas,
  // a longer rest every 50 requests, and a full stop when Google starts refusing.
  const budget = Math.min(opts.maxRequests || 400, 400);
  const wait = (min, max) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
  let stop = '';
  let step = 0;
  try {
    for (const cell of cells) {
      for (const query of opts.queries) {
        if (stop) break;
        step++;
        ping({ stage: 'collect', step, total, found: items.length });
        if (step > 1) await wait(1200, 2500);
        const q = cell.text || !opts.cells.length ? `${query} ${opts.place}`.trim() : query;
        let retried = false;
        for (let off = 0; off < 300; off += 20) {
          let list = [];
          if (debug.requests >= budget) { stop = 'budget'; break; }
          if (debug.requests && debug.requests % 50 === 0) await wait(8000, 12000);
          try {
            const res = await fetch(`/search?tbm=map&authuser=0&hl=${opts.lang}&q=${encodeURIComponent(q)}&pb=${encodeURIComponent(pb(cell.lat, cell.lng, cell.meters, off))}`, { credentials: 'include' });
            debug.requests++;
            if (res.redirected && /\/sorry\//.test(res.url)) { debug.errors++; stop = 'captcha'; break; }
            if (res.status === 429 && !retried) { debug.errors++; retried = true; off -= 20; await wait(15000, 20000); continue; }
            if (res.status === 429) { debug.errors++; stop = 'rate'; break; }
            if (!res.ok) { debug.errors++; debug.status = res.status; break; }
            const d = parse(await res.text());
            list = (g(d, 0, 1) || []).map((x) => g(x, 14)).filter((b) => Array.isArray(b) && str(b[11]));
            if (!list.length && off === 0 && Array.isArray(d[6]) && str(d[6][11])) list = [d[6]];
          } catch (e) { debug.errors++; debug.last = String(e && e.message || e).slice(0, 60); break; }
          let fresh = 0;
          for (const b of list) {
            const key = str(b[10]) || str(b[78]) || str(b[11]);
            if (seen.has(key)) continue;
            seen.add(key); fresh++;
            items.push(lead(b, query));
          }
          if (list.length < 20 || !fresh || items.length >= opts.maxRows) break;
          await wait(600, 1200);
        }
        if (items.length >= opts.maxRows) break;
      }
      if (items.length >= opts.maxRows || stop) break;
    }
  } catch (error) { debug.error = String(error && error.message || error).slice(0, 80); }
  debug.found = items.length;
  if (stop) debug.stop = stop;
  // share of filled fields: a sudden zero means Google changed its answer and the reader needs fixing
  debug.fill = { phone: items.filter((x) => x.phone).length, website: items.filter((x) => x.website).length, rating: items.filter((x) => x.rating != null).length, coords: items.filter((x) => x.lat != null).length };
  if (!items.length && stop === 'captcha') return { error: 'captcha', debug };
  if (!items.length && debug.errors) return { error: 'maps_failed', debug };
  return { items: items.slice(0, opts.maxRows), debug };
}
