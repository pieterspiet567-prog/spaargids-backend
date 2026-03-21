const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const URL =
  'https://www.spaargids.be/sparen/simulatie-woonlening.html#results';

// ---------- HELPERS ----------

function normalizeNumber(value) {
  if (!value) return null;

  const cleaned = String(value)
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');

  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function toDecimal(value, decimals = 4) {
  const num = normalizeNumber(value);
  if (num === null) return null;
  return num.toFixed(decimals).replace('.', ',');
}

function toCurrency(value) {
  const num = normalizeNumber(value);
  if (num === null) return null;

  return new Intl.NumberFormat('nl-BE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
}

function mapFormula(f) {
  const val = String(f || '').toLowerCase().trim();
  if (val.includes('vast')) return 'vaste rentevoet';
  return f;
}

function extract(text) {
  const t = String(text).replace(/\s+/g, ' ');

  const m = t.match(/€\s*([\d.]+,\d{2}).*?per maand/i);
  const i = t.match(/€\s*([\d.]+,\d{2}).*?interest/i);
  const tot = t.match(/€\s*([\d.]+,\d{2}).*?totaal/i);

  return {
    monthly: m?.[1] || null,
    interest: i?.[1] || null,
    total: tot?.[1] || null
  };
}

async function fill(page, selector, value, label) {
  const el = page.locator(selector).first();

  await el.waitFor({ state: 'visible', timeout: 10000 });
  await el.fill('');
  await el.type(String(value), { delay: 20 });

  console.log(`✅ ${label}:`, await el.inputValue());
}

// ---------- ROUTES ----------

app.get('/', (_, res) => {
  res.send('Backend werkt!');
});

app.get('/health', (_, res) => {
  res.json({ ok: true });
});

app.post('/calculate-mortgage', async (req, res) => {
  console.log('🔥 START');

  const { formula, interestRate, amount, durationYears } = req.body;

  const f = mapFormula(formula);
  const rate = toDecimal(interestRate);
  const amt = toCurrency(amount);
  const years = String(Math.round(normalizeNumber(durationYears)));

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // 🔥 belangrijk voor Render
    });

    const page = await browser.newPage();

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    console.log('🌐 Loaded');

    await page.selectOption('#formule', { label: f });

    await fill(page, '#rate', rate, 'rente');
    await fill(page, '#amount', amt, 'bedrag');
    await fill(page, '#year', years, 'looptijd');

    // klik bereken
    const selectors = [
      'button:has-text("Bereken")',
      'input[type="submit"]'
    ];

    let clicked = false;

    for (const s of selectors) {
      const el = page.locator(s).first();
      if (await el.count()) {
        await el.click({ force: true });
        console.log('🧮 Klik via', s);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      await page.locator('#year').press('Enter');
      console.log('🧮 Enter fallback');
    }

    await page.waitForTimeout(4000);

    const text = await page.locator('body').textContent();
    const result = extract(text);

    console.log('📊 RESULT:', result);

    res.json({
      success: true,
      inputs: { f, rate, amt, years },
      result
    });

  } catch (e) {
    console.log('❌ ERROR:', e.message);
    res.status(500).json({ error: e.message });

  } finally {
    if (browser) await browser.close();
  }
});

// ---------- START (RENDER READY) ----------

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server draait op poort ${PORT}`);
});