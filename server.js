const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const URL = 'https://www.spaargids.be/sparen/simulatie-woonlening.html#results';

// ---------- HELPERS ----------

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;

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
  if (val.includes('variabel')) return 'variabele rentevoet';

  return f;
}

async function fill(page, selector, value, label) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: 'visible', timeout: 10000 });
  await el.click({ force: true });
  await el.fill('');
  await el.type(String(value), { delay: 25 });
  console.log(`✅ ${label}:`, await el.inputValue());
}

function extractCurrency(text) {
  if (!text) return null;
  const match = text.match(/€\s*([\d.]+,\d{2})|([\d.]+,\d{2})\s*€/);
  return match ? (match[1] || match[2]) : null;
}

// ---------- CORE SCRAPING ----------

async function extractMonthlyResult(page) {
  // Wacht tot het simulatieblok zichtbaar is
  const simulationHeading = page.getByText('2. Uw simulatie', { exact: true });
  await simulationHeading.waitFor({ state: 'visible', timeout: 15000 });

  // Neem enkel de container van "Uw simulatie", niet de aflossingstabel eronder
  const simulationBox = simulationHeading.locator('xpath=following-sibling::*[1]');
  await simulationBox.waitFor({ state: 'visible', timeout: 15000 });

  // Wacht tot er effectief "per maand" in staat
  await simulationBox.getByText('per maand', { exact: true }).waitFor({
    state: 'visible',
    timeout: 15000
  });

  const text = await simulationBox.innerText();
  console.log('SIMULATION BOX TEXT:\n', text);

  // Zoek specifiek het bedrag dat vlak voor "per maand" staat
  const monthlyMatch = text.match(/€\s*([\d.]+,\d{2})\s*[\r\n\s]*per maand/i);

  if (!monthlyMatch) {
    throw new Error('Maandbedrag niet gevonden in simulatieblok');
  }

  return monthlyMatch[1];
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
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    console.log('🌐 Loaded');

    // Formule selecteren
    await page.selectOption('#formule', { label: f });
    console.log(`✅ formule: ${f}`);

    // Velden invullen
    await fill(page, '#rate', rate, 'rente');
    await fill(page, '#amount', amt, 'bedrag');
    await fill(page, '#year', years, 'looptijd');

    // Klik op Bereken
    const calculateButton = page.getByRole('button', { name: /bereken/i }).first();

    if (await calculateButton.count()) {
      await calculateButton.click({ force: true });
      console.log('🧮 Klik op Bereken');
    } else {
      await page.locator('#year').press('Enter');
      console.log('🧮 Enter fallback');
    }

    // Enkel "per maand" terughalen
    const monthly = await extractMonthlyResult(page);
    console.log('📊 MONTHLY:', monthly);

    res.json({
      success: true,
      inputs: { formula: f, rate, amount: amt, durationYears: years },
      monthly
    });
  } catch (e) {
    console.log('❌ ERROR:', e.message);
    res.status(500).json({
      success: false,
      error: e.message
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ---------- START ----------

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server draait op poort ${PORT}`);
});