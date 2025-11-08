require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const puppeteer = require('puppeteer-core'); // puppeteer-core के लिए सही import

const upload = multer({ dest: 'uploads/' });
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const COOKIE_STRING = process.env.COOKIE_STRING || '';
const PORT = process.env.PORT || 3000;
const DEFAULT_THREAD = process.env.THREAD_ID || '';
const DEFAULT_MESSAGE = process.env.MESSAGE || 'Hello from bot';

function parseCookieStringToJSON(str) {
  return str.split(';').map(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    const value = rest.join('=');
    if (!name) return null;
    return {
      name,
      value: decodeURIComponent(value),
      domain: '.facebook.com',
      path: '/',
      httpOnly: false,
      secure: true,
    };
  }).filter(x => x !== null);
}

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true
  });
}

async function loadCookiesFromString(page, cookieString) {
  if (!cookieString) throw new Error('Cookie string is empty');
  const cookies = parseCookieStringToJSON(cookieString);
  await page.setCookie(...cookies);
}

async function sendMessageToThread(threadId, message, cookieString) {
  if (!threadId) throw new Error('Thread ID required');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(60000);
    await loadCookiesFromString(page, cookieString);

    const url = `https://www.facebook.com/messages/t/${threadId}`;
    await page.goto(url, { waitUntil: 'networkidle2' });

    const selectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea'
    ];

    let composer = null;
    for (const s of selectors) {
      try {
        await page.waitForSelector(s, { timeout: 5000 });
        composer = s;
        break;
      } catch (e) {}
    }
    if (!composer) throw new Error('Message composer not found on page (DOM changed).');

    await page.focus(composer);
    await page.evaluate((sel, msg) => {
      const el = document.querySelector(sel);
      if (!el) return;
      if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
        el.focus();
        el.innerText = msg;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        el.value = msg;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, composer, message);

    const sendSelectors = [
      'a[aria-label="Send"]',
      'button[aria-label="Send"]',
      'button[type="submit"]',
      '._30yy._38lh',
      'div[aria-label="Send"]'
    ];

    let clicked = false;
    for (const sel of sendSelectors) {
      const exists = await page.$(sel);
      if (exists) {
        await exists.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(2000);
    const lastMsg = await page.evaluate(() => {
      const msgs = Array.from(document.querySelectorAll('div[role="row"], ._41ud'));
      if (!msgs.length) return null;
      const last = msgs[msgs.length - 1];
      return last.innerText || last.textContent;
    });

    await browser.close();
    return { ok: true, lastMsg: lastMsg || null };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

app.get('/', (req, res) => {
  res.send('FB Messenger cookies sender running. Use POST /send');
});

app.post('/upload-cookies', upload.single('cookies'), (req, res) => {
  if (!req.file) return res.status(400).send('no file');
  const dest = process.env.COOKIE_PATH || 'cookies.json';
  fs.renameSync(req.file.path, dest);
  res.json({ ok: true, saved: dest });
});

app.post('/send', async (req, res) => {
  const threadId = req.body.threadId || DEFAULT_THREAD;
  const message = req.body.message || DEFAULT_MESSAGE;
  const cookieString = COOKIE_STRING;

  if (!threadId) return res.status(400).json({ ok: false, error: 'threadId required' });
  if (!cookieString) return res.status(400).json({ ok: false, error: 'Cookie string not set' });

  try {
    const r = await sendMessageToThread(threadId, message, cookieString);
    res.json({ ok: true, result: r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
