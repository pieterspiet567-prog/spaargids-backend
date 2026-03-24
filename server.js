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

async function fill(page, selector, value, label) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: 'visible', timeout: 10000 });
  await el.fill('');
  await el.type(String(value), { delay: 20 });
  console.log(`✅ ${label}:`, await el.inputValue());
}

// ---------- CORE SCRAPING ----------

async function extractTableResults(page) {
  await page.waitForTimeout(6000);

  const results = page.locator('#results');
  const count = await results.count();

  console.log('Aantal #results:', count);

  if (count === 0) {
    throw new Error('Geen results containers gevonden');
  }

  const target = results.last();

  const text = await target.innerText();
  console.log('RESULT TEXT:', text.slice(0, 500));

  const matches = [...text.matchAll(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*€/g)];
  console.log('MATCHES:', matches.map(m => m[1]));

  if (matches.length < 3) {
    throw new Error('Niet genoeg bedragen gevonden');
  }

  return {
    monthly: matches[0][1],
    interest: matches[1][1],
    total: matches[2][1]
  };
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
  console.log('BODY:', req.body);

  const { formula, interestRate, amount, durationYears } = req.body;

  const f = mapFormula(formula);
  const rate = toDecimal(interestRate);
  const amt = toCurrency(amount);
  const yearsNum = normalizeNumber(durationYears);
  const years = yearsNum !== null ? String(Math.round(yearsNum)) : null;

  if (!f || !rate || !amt || !years) {
    return res.status(400).json({
      success: false,
      error: 'Ongeldige input'
    });
  }

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(15000);

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    console.log('🌐 Loaded');

    await page.selectOption('#formule', { label: f });
    console.log(`✅ formule: ${f}`);

    await fill(page, '#rate', rate, 'rente');
    await fill(page, '#amount', amt, 'bedrag');
    await fill(page, '#year', years, 'looptijd');

    // klik op bereken
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

    const result = await extractTableResults(page);
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

// ---------- START ----------

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server draait op poort ${PORT}`);
});