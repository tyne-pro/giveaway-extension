// ============================================================
// Giveaway Comment Collector — popup logic
// Тягне ВСІ коментарі поста/reels Instagram через web-приватний
// ендпоінт /api/v1/media/{id}/comments/ з повною пагінацією.
// Працює з вашої залогіненої сесії (cookies браузера) — тобто з
// вашого IP, без ліміту 100.
// ============================================================

const IG_APP_ID = '936619743392459'; // публічний web app id Instagram
const SHORTCODE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const COMMENT_PAGE_DELAY_MS = 90;
const VERIFY_CONCURRENCY = 4;
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 12000;
const MAX_BACKOFF_MS = 4000;

let collectAborted = false;

let lastResult = null; // { shortcode, usernames, comment_counts, user_ids, total, unique_users }

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = 'info') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status show ${kind}`;
}

function hideStatus() {
  $('status').className = 'status';
}

function getQueryParams() {
  const params = new URLSearchParams(window.location.search);
  if (window.location.hash.includes('?')) {
    const hashQuery = window.location.hash.slice(window.location.hash.indexOf('?') + 1);
    for (const [key, value] of new URLSearchParams(hashQuery)) params.set(key, value);
  }
  return params;
}

function setCurrentUrl(url) {
  currentUrl = url || '';
  const input = $('urlInput');
  const label = $('url');
  if (input) input.value = currentUrl;
  if (label) label.textContent = currentUrl || 'Відкрийте пост Instagram у вкладці…';
}

function getCurrentUrl() {
  const input = $('urlInput');
  return input ? input.value.trim() : currentUrl;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUsername(username) {
  return String(username || '').trim().replace(/^@+/, '').toLowerCase();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function fetchJsonWithRetry(url, options, label) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let retryAfterMs = 0;
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (res.status === 401 || res.status === 403) {
        throw new Error('Instagram відхилив запит (увійдіть в акаунт у цій вкладці).');
      }
      if (res.status === 404) {
        throw new Error(`${label} не знайдено.`);
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get('Retry-After');
        retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 0;
        throw new Error(`retry:${res.status}`);
      }
      if (!res.ok) {
        throw new Error(`Instagram повернув статус ${res.status}.`);
      }
      return await res.json();
    } catch (error) {
      const isTimeout = error.name === 'AbortError';
      lastError = isTimeout ? new Error(`retry:timeout`) : error;
      const canRetry = String(lastError.message || '').startsWith('retry:') || lastError.name === 'TypeError';
      if (!canRetry || attempt === MAX_RETRIES) {
        lastError = isTimeout ? new Error(`Тайм-аут запиту (${label}).`) : lastError;
        break;
      }
      const backoff = Math.min(MAX_BACKOFF_MS, 400 * 2 ** attempt);
      await sleep(Math.max(backoff, retryAfterMs));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error(`Не вдалося завантажити ${label}.`);
}

// Instagram shortcode -> media_id (pk). Shortcode = base64(pk) власним алфавітом.
function shortcodeToMediaId(shortcode) {
  let id = 0n;
  for (const ch of shortcode) {
    const idx = SHORTCODE_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    id = id * 64n + BigInt(idx);
  }
  return id.toString();
}

// Витягнути shortcode з URL поста/reels/tv
function extractShortcode(url) {
  const m = url.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function getCsrfToken() {
  return new Promise((resolve) => {
    chrome.cookies.get(
      { url: 'https://www.instagram.com', name: 'csrftoken' },
      (cookie) => resolve(cookie ? cookie.value : '')
    );
  });
}

// Один запит сторінки коментарів
async function fetchCommentsPage(mediaId, minId, csrf) {
  const params = new URLSearchParams({
    can_support_threading: 'true',
    sort_order: 'recent',
  });
  if (minId) params.set('min_id', minId);

  return fetchJsonWithRetry(
    `https://www.instagram.com/api/v1/media/${mediaId}/comments/?${params.toString()}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: {
        'X-IG-App-ID': IG_APP_ID,
        'X-CSRFToken': csrf,
        'X-Requested-With': 'XMLHttpRequest',
      },
    },
    'сторінку коментарів'
  );
}

// Повний збір з пагінацією
async function collectAllComments(mediaId, csrf, onProgress) {
  const seenByUser = new Map(); // username -> Set(commentPk)  (дедуп проти повторів між сторінками)
  const userIds = {};
  const seenPks = new Set();
  const seenCursors = new Set();
  let minId = null;
  let page = 0;

  while (true) {
    if (collectAborted) break;
    page++;
    const data = await fetchCommentsPage(mediaId, minId, csrf);
    const comments = data.comments || [];

    for (const c of comments) {
      const pk = String(c.pk || c.id || '');
      const username = c.user && c.user.username;
      if (!pk || !username || seenPks.has(pk)) continue;
      seenPks.add(pk);
      if (!seenByUser.has(username)) seenByUser.set(username, new Set());
      seenByUser.get(username).add(pk);
      if (c.user.pk || c.user.id) userIds[username] = String(c.user.pk || c.user.id);
    }

    onProgress(seenPks.size, seenByUser.size, page);

    const next = data.next_min_id;
    if (!next || comments.length === 0) break;

    // next_min_id може бути рядком або об'єктом — нормалізуємо
    minId = typeof next === 'string' ? next : JSON.stringify(next);
    if (seenCursors.has(minId)) break;
    seenCursors.add(minId);

    // Коротка пауза лишає збір швидким, а retry вище бере на себе тимчасові ліміти.
    await sleep(COMMENT_PAGE_DELAY_MS);
  }

  const comment_counts = {};
  for (const [u, pks] of seenByUser) comment_counts[u] = pks.size;
  const usernames = Object.keys(comment_counts);
  const total = usernames.reduce((s, u) => s + comment_counts[u], 0);

  return { usernames, comment_counts, user_ids: userIds, total, unique_users: usernames.length };
}

// Розгорнутий список з повторами: логін повторюється стільки разів,
// скільки залишив коментарів (чим більше коментарів — тим більше шансів).
function expandWithRepeats(r) {
  const out = [];
  const usernames = getActiveUsernames(r);
  for (const u of usernames) {
    const n = r.comment_counts[u] || 1;
    for (let i = 0; i < n; i++) out.push(u);
  }
  return out;
}

function getActiveUsernames(r) {
  return r.eligible_usernames || r.usernames;
}

function parseRequiredPages() {
  return $('requiredPages').value
    .split(/[\n,;\s]+/)
    .map(normalizeUsername)
    .filter(Boolean)
    .filter((name, index, list) => list.indexOf(name) === index);
}

async function checkUserFollowsPage(userId, requiredUsername, csrf) {
  const params = new URLSearchParams({
    count: '12',
    query: requiredUsername,
  });
  const data = await fetchJsonWithRetry(
    `https://www.instagram.com/api/v1/friendships/${userId}/following/?${params.toString()}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: {
        'X-IG-App-ID': IG_APP_ID,
        'X-CSRFToken': csrf,
        'X-Requested-With': 'XMLHttpRequest',
      },
    },
    'підписки користувача'
  );

  const users = Array.isArray(data.users) ? data.users : [];
  return users.some((u) => normalizeUsername(u.username) === requiredUsername);
}

async function checkUserRequirements(username, requiredPages, csrf) {
  const userId = lastResult.user_ids[username];
  if (!userId) return { username, ok: false, failed: requiredPages, error: 'немає id користувача', unverified: false };

  const failed = [];
  for (const page of requiredPages) {
    let follows;
    try {
      follows = await checkUserFollowsPage(userId, page, csrf);
    } catch (error) {
      // приватний акаунт / rate limit — не можемо перевірити, а не "не підписаний"
      return { username, ok: false, failed: [page], error: error.message || 'не вдалося перевірити', unverified: true };
    }
    if (!follows) {
      failed.push(page);
      break; // далі не має сенсу — юзер вже не пройшов умову
    }
  }

  return { username, ok: failed.length === 0, failed, error: null, unverified: false };
}

async function mapWithConcurrency(items, concurrency, worker, onItemDone) {
  const results = [];
  let index = 0;

  async function run() {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (error) {
        results[currentIndex] = {
          username: items[currentIndex],
          ok: false,
          failed: [],
          error: error.message || 'не вдалося перевірити',
        };
      }
      onItemDone(results[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

// ---------- UI wiring ----------

let currentUrl = '';

async function init() {
  const params = getQueryParams();
  const sourceUrl = params.get('sourceUrl');
  const shortcodeFromParams = params.get('id');

  if (sourceUrl) {
    setCurrentUrl(sourceUrl);
  } else if (shortcodeFromParams) {
    setCurrentUrl(`https://www.instagram.com/p/${shortcodeFromParams}/`);
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    setCurrentUrl((tab && tab.url) || '');
  }

  const sc = extractShortcode(currentUrl);
  if (sc) {
    $('collect').disabled = false;
    if (params.get('autostart') === '1') setTimeout(onCollect, 250);
  } else {
    const message = 'Вставте посилання на Instagram /p/… або /reel/…';
    const label = $('url');
    if (label) label.textContent = message;
    $('collect').disabled = false;
    setStatus(message, 'info');
  }
}

async function onCollect() {
  setCurrentUrl(getCurrentUrl());
  const shortcode = extractShortcode(currentUrl);
  if (!shortcode) {
    setStatus('Вставте правильне посилання на Instagram пост або reels.', 'err');
    return;
  }

  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId) {
    setStatus('Не вдалося розпізнати ID поста.', 'err');
    return;
  }

  $('collect').disabled = true;
  $('stats').className = 'stats';
  collectAborted = false;
  if ($('stopCollect')) $('stopCollect').style.display = 'inline-block';
  setStatus('Збираю коментарі… ', 'info');

  try {
    const csrf = await getCsrfToken();
    const result = await collectAllComments(mediaId, csrf, (total, users, page) => {
      $('status').innerHTML =
        `<span class="spin"></span> Сторінка ${page} — зібрано ${total} коментарів від ${users} користувачів…`;
    });

    lastResult = { shortcode, ...result };
    renderResult(lastResult);
    setStatus(
      collectAborted
        ? `Зупинено: ${result.total} коментарів від ${result.unique_users} користувачів (частково).`
        : `Готово: ${result.total} коментарів від ${result.unique_users} користувачів.`,
      'ok'
    );
  } catch (e) {
    setStatus(e.message || 'Помилка збору коментарів.', 'err');
  } finally {
    $('collect').disabled = false;
    if ($('stopCollect')) $('stopCollect').style.display = 'none';
  }
}

function badgeFor(r, u) {
  const status = r.subscription_status && r.subscription_status[u];
  return status
    ? status.ok
      ? '<span class="badge ok">OK</span>'
      : status.unverified
        ? `<span class="badge warn" title="${escapeHtml(status.error || '')}">?</span>`
        : '<span class="badge bad">ні</span>'
    : '';
}

function renderList(r) {
  if (copyMode === 'repeats') {
    // показуємо реальний розгорнутий список — той самий, що піде в копіювання
    const expanded = expandWithRepeats(r);
    $('list').innerHTML = expanded
      .map((u) => `<div class="row"><span class="u">@${escapeHtml(u)} ${badgeFor(r, u)}</span></div>`)
      .join('');
  } else {
    const usernames = getActiveUsernames(r);
    const sorted = usernames
      .map((u) => [u, r.comment_counts[u] || 0])
      .sort((a, b) => b[1] - a[1]);
    $('list').innerHTML = sorted
      .map(([u, c]) => `<div class="row"><span class="u">@${escapeHtml(u)} ${badgeFor(r, u)}</span><span class="c">${c}</span></div>`)
      .join('');
  }
}

function renderResult(r) {
  $('statTotal').textContent = r.total;
  $('statUsers').textContent = r.unique_users;
  $('statEligible').textContent = r.eligible_usernames ? r.eligible_usernames.length : '—';

  $('copy').textContent = r.eligible_usernames ? 'Копіювати для колеса' : 'Копіювати список';

  renderList(r);

  $('stats').className = 'stats show';
  updateCopyPreview();
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let copyMode = 'repeats'; // 'unique' | 'repeats' — за замовч. з повторами (більше коментарів = більше шансів)

function updateCopyPreview() {
  const el = $('copyPreview');
  if (!el) return;
  if (!lastResult) {
    el.textContent = '';
    return;
  }
  const list = copyMode === 'repeats' ? expandWithRepeats(lastResult) : getActiveUsernames(lastResult);
  el.textContent =
    copyMode === 'repeats'
      ? `Буде скопійовано ${list.length} рядків (з повторами за кількістю коментарів)`
      : `Буде скопійовано ${list.length} унікальних логінів`;
}

function onCopy() {
  if (!lastResult) return;
  const list = copyMode === 'repeats' ? expandWithRepeats(lastResult) : getActiveUsernames(lastResult);
  navigator.clipboard.writeText(list.join('\n')).then(() => {
    setStatus(
      copyMode === 'repeats'
        ? `Скопійовано ${list.length} рядків з повторами (за кількістю коментарів).`
        : `Скопійовано ${list.length} унікальних логінів.`,
      'ok'
    );
  });
}

function onJson() {
  if (!lastResult) return;
  const payload = { ...lastResult, usernames_expanded: expandWithRepeats(lastResult) };
  download(
    `giveaway_${lastResult.shortcode}.json`,
    JSON.stringify(payload, null, 2),
    'application/json'
  );
}

function onCsv() {
  if (!lastResult) return;
  const rows = [['username', 'comments']];
  for (const u of getActiveUsernames(lastResult)) rows.push([u, lastResult.comment_counts[u]]);
  const csv = rows
    .map((r) =>
      r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')
    )
    .join('\n');
  download(`giveaway_${lastResult.shortcode}.csv`, csv, 'text/csv');
}

async function onCheckSubscriptions() {
  if (!lastResult) return;

  const requiredPages = parseRequiredPages();
  if (!requiredPages.length) {
    setStatus('Введіть Instagram-сторінки для перевірки, наприклад: brand partner.', 'err');
    return;
  }

  $('checkSubs').disabled = true;
  $('collect').disabled = true;
  setStatus(`Перевіряю підписки на: ${requiredPages.map((p) => `@${p}`).join(', ')}…`, 'info');

  try {
    const csrf = await getCsrfToken();
    const usernames = lastResult.usernames;
    const subscriptionStatus = {};
    let done = 0;

    const checks = await mapWithConcurrency(
      usernames,
      VERIFY_CONCURRENCY,
      (username) => checkUserRequirements(username, requiredPages, csrf),
      (result) => {
        done++;
        subscriptionStatus[result.username] = result;
        $('status').innerHTML =
          `<span class="spin"></span> Перевірено ${done}/${usernames.length}. Підходить: ${
            Object.values(subscriptionStatus).filter((r) => r.ok).length
          }`;
      }
    );

    const eligible = checks.filter((r) => r.ok).map((r) => r.username);
    lastResult = {
      ...lastResult,
      required_pages: requiredPages,
      subscription_status: subscriptionStatus,
      eligible_usernames: eligible,
    };
    renderResult(lastResult);
    setStatus(`Готово: ${eligible.length} з ${usernames.length} користувачів виконали умови.`, 'ok');
  } catch (error) {
    setStatus(error.message || 'Не вдалося перевірити підписки.', 'err');
  } finally {
    $('checkSubs').disabled = false;
    $('collect').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  if ($('urlInput')) {
    $('urlInput').addEventListener('input', () => {
      setCurrentUrl(getCurrentUrl());
      $('collect').disabled = !extractShortcode(currentUrl);
    });
  }
  $('collect').addEventListener('click', onCollect);
  if ($('stopCollect')) {
    $('stopCollect').addEventListener('click', () => { collectAborted = true; });
  }
  $('checkSubs').addEventListener('click', onCheckSubscriptions);
  $('copy').addEventListener('click', onCopy);
  $('json').addEventListener('click', onJson);
  $('csv').addEventListener('click', onCsv);

  // Перемикач режиму копіювання: унікальні / з повторами
  document.querySelectorAll('#modeToggle .opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      copyMode = btn.dataset.mode;
      document.querySelectorAll('#modeToggle .opt').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (lastResult) renderList(lastResult);
      updateCopyPreview();
    });
  });
});
