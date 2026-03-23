const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const URL =
  'https://www.spaargids.be/sparen/simulatie-woonlening.html#results';

// ---------- HELPERS ----------

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return null;

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

async function extractTableResults(page) {
  await page.waitForTimeout(5000);

  const tables = page.locator('#results table');
  const tableCount = await tables.count();
  console.log('Aantal #results tables:', tableCount);

  if (tableCount === 0) {
    throw new Error('Geen tabellen gevonden binnen #results');
  }

  // Neem de laatste tabel, want de eerste #results container is leeg volgens de logs
  const targetTable = tables.last();

  await targetTable.waitFor({ state: 'visible', timeout: 15000 });

  const headers = await targetTable
    .locator('thead th')
    .allTextContents()
    .catch(() => []);
  console.log(
    'HEADERS:',
    headers.map(h => h.trim()).filter(Boolean)
  );

  const rows = await targetTable.locator('tbody tr').all();
  console.log('Aantal rows gevonden:', rows.length);

  if (!rows.length) {
    throw new Error('Geen resultaatrijen gevonden in de gekozen tabel');
  }

  const firstRow = rows[0];
  const cells = await firstRow.locator('td').all();

  const values = [];
  for (const cell of cells) {
    values.push((await cell.innerText()).trim());
  }

  console.log('CELLS:', values);

  if (values.length < 5) {
    throw new Error(`Te weinig kolommen: ${values.length}`);
  }

  return {
    monthly: values[2],
    interest: values[3],
    total: values[4]
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
    page.setDefaultNavigationTimeout(30000);

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    page.on('requestfailed', req => {
      const url = req.url();
      if (
        url.includes('google-analytics') ||
        url.includes('analytics.google.com') ||
        url.includes('googletagmanager') ||
        url.includes('yahoo.com') ||
        url.includes('advertising-cdn')
      ) {
        return;
      }
      console.log('REQUEST FAILED:', url, req.failure()?.errorText);
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    console.log('🌐 Loaded');

    await page.selectOption('#formule', { label: f });
    console.log(`✅ formule: ${f}`);

    await fill(page, '#rate', rate, 'rente');
    await fill(page, '#amount', amt, 'bedrag');
    await fill(page, '#year', years, 'looptijd');

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