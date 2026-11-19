# Giveaway · tyne.pro

**UA** · [EN](#english)

Браузерне розширення для Chrome та Edge, яке збирає коментарі під постом або Reels в Instagram для розіграшу в кабінеті [cp.tyne.pro](https://cp.tyne.pro/tools/giveaway). Тут лежить увесь його код — той самий, що й в архіві для завантаження. Його можна прочитати й перевірити.

## Що робить і чого не робить

- Звертається **тільки до instagram.com**. На сервер tyne.pro чи будь-куди ще нічого не надсилає.
- Результат зберігається файлом JSON або CSV на вашому комп’ютері. У кабінет ви завантажуєте його самі.
- **Не просить і не читає пароль** від Instagram.
- Код не мініфікований: усе, що робить розширення, видно у файлах нижче.

## Дозволи й навіщо вони

| Дозвіл | Навіщо |
|---|---|
| `https://www.instagram.com/*`, `https://i.instagram.com/*` | Звідти розширення бере коментарі й список підписок для перевірки умов розіграшу. Інших сайтів воно не бачить. |
| `cookies` | Читає один cookie Instagram — `csrftoken`, бо без нього Instagram не віддає коментарі. Пароль і cookie інших сайтів недоступні. |
| `tabs`, `activeTab` | Бере адресу відкритого поста й відкриває вікно розширення в новій вкладці. |

## Файли

| Файл | Що всередині |
|---|---|
| [`manifest.json`](manifest.json) | Назва, версія й дозволи |
| [`background.js`](background.js) | Відкриває вікно розширення в новій вкладці (12 рядків) |
| [`popup.js`](popup.js) | Збір коментарів через Instagram, перевірка підписок, збереження JSON/CSV |
| [`popup.html`](popup.html), [`dashboard.html`](dashboard.html) | Інтерфейс розширення |
| [`icons/`](icons) | Іконки |

Пошукайте в коді `fetch(` — усі запити йдуть тільки на `instagram.com`.

## Перевірка архіву

Архів для завантаження лежить у [релізах](../../releases) і на сайті: `https://cp.tyne.pro/downloads/tyne-giveaway-extension.zip`.

- Версія **1.4.1**, SHA-256 архіву:
  `ec7ae2cec866bf85d92b3601d485519ec39e448939903c7dd50996a92f140296`
- Перевірити на Mac: `shasum -a 256 tyne-giveaway-extension.zip`, у Windows: `certutil -hashfile tyne-giveaway-extension.zip SHA256`. Рядок має збігтися з наведеним вище.
- [Звіт VirusTotal](https://www.virustotal.com/gui/file/ec7ae2cec866bf85d92b3601d485519ec39e448939903c7dd50996a92f140296): на 19.11.2026 загрозу знайшли 0 з 42 антивірусів. Звіт можна відкрити й самостійно: на virustotal.com вставте SHA-256 у пошук.

## Встановлення

1. Завантажте архів і розпакуйте його в окрему папку.
2. Відкрийте `chrome://extensions` (або `edge://extensions`) і увімкніть «Режим розробника».
3. Натисніть «Завантажити розпаковане» й оберіть папку.
4. Відкрийте пост в Instagram і натисніть іконку розширення.

Розширення не публікується в Chrome Web Store, тому ставиться в режимі розробника. Саме для цього код і відкритий.

---

## English

A Chrome and Edge extension that collects the comments under an Instagram post or Reel for a giveaway in the [cp.tyne.pro](https://cp.tyne.pro/tools/giveaway) cabinet. This repository holds all of its code, the same as in the downloadable zip, so you can read and check it.

**What it does and does not do**

- Talks to **instagram.com only**. Sends nothing to the tyne.pro server or anywhere else.
- Saves the result as a JSON or CSV file on your computer. You upload it to the cabinet yourself.
- **Does not ask for or read** your Instagram password.
- The code is not minified: everything the extension does is visible in the files.

**Permissions**

- `https://www.instagram.com/*`, `https://i.instagram.com/*`: where it reads comments and follow lists to check the giveaway conditions. It cannot see other sites.
- `cookies`: reads one Instagram cookie, `csrftoken`, because Instagram does not return comments without it. No password, no cookies of other sites.
- `tabs`, `activeTab`: reads the address of the open post and opens the extension window in a new tab.

**Verify the zip**

The zip is in [Releases](../../releases) and at `https://cp.tyne.pro/downloads/tyne-giveaway-extension.zip`. Version 1.4.1, SHA-256 `ec7ae2cec866bf85d92b3601d485519ec39e448939903c7dd50996a92f140296`. [VirusTotal report](https://www.virustotal.com/gui/file/ec7ae2cec866bf85d92b3601d485519ec39e448939903c7dd50996a92f140296): as of 19 Nov 2026, flagged by 0 of 42 antivirus engines.

**Install**: unzip, open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the folder.

---

© 2026 tyne.pro. All rights reserved. See [LICENSE](LICENSE).
