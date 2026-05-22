// scraper/scrape.js
// Generic dealership inventory scraper using Playwright.
// Strategy:
//   1. Load the homepage.
//   2. Find links whose text/href suggest "new inventory" and "used inventory".
//   3. For each inventory page, scroll to trigger lazy-loading, then extract listings
//      using a set of heuristics that work across many common dealer platforms
//      (Dealer.com, DealerOn, DealerInspire, AutoTrader, CDK, etc.).
//   4. Save results as JSON.
//
// This is heuristic-driven. It will work on many dealerships out of the box and
// fall back gracefully when it can't find structured data. For unusual sites you
// may need to add a site-specific extractor in extractListings().

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const NEW_KEYWORDS = ['new-inventory', 'new-vehicles', 'new-cars', 'inventory/new', 'new/'];
const USED_KEYWORDS = [
  'used-inventory', 'used-vehicles', 'used-cars', 'pre-owned',
  'preowned', 'inventory/used', 'used/', 'certified',
];

// ---------- helpers ----------

async function findInventoryLinks(page) {
  // Get all anchors, classify by href/text.
  const anchors = await page.$$eval('a', (els) =>
    els.map((a) => ({
      href: a.href || '',
      text: (a.innerText || a.textContent || '').trim().toLowerCase(),
    })),
  );

  const matchAny = (s, keys) => keys.some((k) => s.includes(k));

  const newLinks = [];
  const usedLinks = [];

  for (const a of anchors) {
    if (!a.href || a.href.startsWith('javascript:') || a.href.startsWith('mailto:')) continue;
    const haystack = (a.href + ' ' + a.text).toLowerCase();
    if (matchAny(haystack, NEW_KEYWORDS) && !matchAny(haystack, USED_KEYWORDS)) {
      newLinks.push(a.href);
    } else if (matchAny(haystack, USED_KEYWORDS)) {
      usedLinks.push(a.href);
    }
  }

  // Prefer the shortest URL on the same origin (usually the landing page rather
  // than a deep filter URL).
  const pickBest = (links, origin) => {
    const sameOrigin = links.filter((l) => {
      try {
        return new URL(l).origin === origin;
      } catch {
        return false;
      }
    });
    const pool = sameOrigin.length ? sameOrigin : links;
    return pool.sort((a, b) => a.length - b.length)[0] || null;
  };

  const origin = new URL(page.url()).origin;
  return {
    newUrl: pickBest(newLinks, origin),
    usedUrl: pickBest(usedLinks, origin),
  };
}

async function autoScroll(page, maxScrolls = 12) {
  // Trigger lazy-loaded listings.
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(700);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

async function extractListings(page, condition) {
  // Try several extraction strategies in order.
  return await page.evaluate((condition) => {
    const results = [];
    const seen = new Set();

    const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const pushIfValid = (item) => {
      if (!item.title && !item.image) return;
      const key = (item.url || '') + '|' + (item.image || '') + '|' + (item.title || '');
      if (seen.has(key)) return;
      seen.add(key);
      results.push(item);
    };

    // Strategy 1: JSON-LD Vehicle / Product / Car schema.
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      scripts.forEach((s) => {
        try {
          const data = JSON.parse(s.textContent);
          const arr = Array.isArray(data) ? data : [data];
          arr.forEach((entry) => {
            const items = entry['@graph'] || [entry];
            items.forEach((it) => {
              const type = it['@type'];
              if (!type) return;
              const typeStr = Array.isArray(type) ? type.join(',') : type;
              if (/Vehicle|Car|Product/i.test(typeStr)) {
                pushIfValid({
                  title: cleanText(it.name),
                  price: it.offers?.price || it.price || '',
                  image: typeof it.image === 'string' ? it.image : it.image?.url || it.image?.[0],
                  url: it.url || it.offers?.url || '',
                  year: it.vehicleModelDate || it.modelDate || '',
                  mileage: it.mileageFromOdometer?.value || '',
                  source: 'json-ld',
                });
              }
            });
          });
        } catch {}
      });
    } catch {}

    // Strategy 2: common vehicle card selectors used by dealer platforms.
    const cardSelectors = [
      '.vehicle-card',
      '.inventory-listing',
      '[class*="VehicleCard"]',
      '[class*="vehicle-card"]',
      '[data-vehicle]',
      '[data-listing]',
      '.hproduct',
      '.srp-list-item',
      'li[class*="vehicle"]',
      'article[class*="vehicle"]',
      'div[class*="listing-container"]',
    ];

    cardSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((card) => {
        const titleEl =
          card.querySelector('h1, h2, h3, h4, [class*="title"], [class*="Title"], [class*="name"]');
        const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
        const imgEl = card.querySelector('img');
        const linkEl = card.querySelector('a[href]');

        let image = '';
        if (imgEl) {
          image =
            imgEl.getAttribute('src') ||
            imgEl.getAttribute('data-src') ||
            imgEl.getAttribute('data-lazy-src') ||
            imgEl.getAttribute('data-original') ||
            (imgEl.getAttribute('srcset') || '').split(',')[0]?.trim().split(' ')[0] ||
            '';
        }
        if (image && image.startsWith('//')) image = 'https:' + image;
        if (image && image.startsWith('/')) image = location.origin + image;

        pushIfValid({
          title: cleanText(titleEl?.innerText),
          price: cleanText(priceEl?.innerText),
          image,
          url: linkEl?.href || '',
          source: 'card-selector',
        });
      });
    });

    // Strategy 3: fallback - any <a> that links to what looks like a vehicle detail page
    // and contains an image.
    if (results.length === 0) {
      document.querySelectorAll('a[href*="vehicle"], a[href*="vdp"], a[href*="-id-"]').forEach((a) => {
        const img = a.querySelector('img');
        if (!img) return;
        const image =
          img.getAttribute('src') ||
          img.getAttribute('data-src') ||
          img.getAttribute('data-lazy-src') ||
          '';
        pushIfValid({
          title: cleanText(a.innerText || img.alt),
          price: '',
          image,
          url: a.href,
          source: 'fallback-anchor',
        });
      });
    }

    return results.map((r) => ({ ...r, condition }));
  }, condition);
}

async function scrapeInventoryPage(browser, url, condition) {
  if (!url) return [];
  console.log(`  → ${condition.toUpperCase()} inventory: ${url}`);
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2_500);
    await autoScroll(page);
    const listings = await extractListings(page, condition);
    console.log(`    found ${listings.length} ${condition} vehicles`);
    return listings;
  } catch (err) {
    console.warn(`    error scraping ${condition}: ${err.message}`);
    return [];
  } finally {
    await context.close();
  }
}

// ---------- main entry ----------

async function scrapeDealership(homepageUrl) {
  if (!/^https?:\/\//.test(homepageUrl)) homepageUrl = 'https://' + homepageUrl;

  console.log(`\nScraping dealership: ${homepageUrl}`);
  const browser = await chromium.launch({ headless: true });

  try {
    // Step 1: find inventory links from the homepage.
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    await page.goto(homepageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2_000);

    const { newUrl, usedUrl } = await findInventoryLinks(page);
    console.log(`  detected new inventory:  ${newUrl || '(none)'}`);
    console.log(`  detected used inventory: ${usedUrl || '(none)'}`);
    await context.close();

    // Step 2: scrape each inventory page.
    const newCars = await scrapeInventoryPage(browser, newUrl, 'new');
    const usedCars = await scrapeInventoryPage(browser, usedUrl, 'used');

    const result = {
      dealership: homepageUrl,
      scrapedAt: new Date().toISOString(),
      newInventoryUrl: newUrl,
      usedInventoryUrl: usedUrl,
      cars: [...newCars, ...usedCars].map((c, i) => ({
        id: `${Date.now()}-${i}`,
        ...c,
      })),
    };

    return result;
  } finally {
    await browser.close();
  }
}

// CLI usage: node scraper/scrape.js <url> [outfile]
if (require.main === module) {
  const url = process.argv[2];
  const outfile = process.argv[3] || path.join(__dirname, '..', 'data', 'latest-scrape.json');
  if (!url) {
    console.error('Usage: node scraper/scrape.js <dealership-url> [outfile]');
    process.exit(1);
  }
  scrapeDealership(url)
    .then((res) => {
      fs.mkdirSync(path.dirname(outfile), { recursive: true });
      fs.writeFileSync(outfile, JSON.stringify(res, null, 2));
      console.log(`\nDone. ${res.cars.length} cars total. Saved to ${outfile}`);
    })
    .catch((err) => {
      console.error('Fatal:', err);
      process.exit(1);
    });
}

module.exports = { scrapeDealership };
