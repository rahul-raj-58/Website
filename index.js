// server/index.js
// Express server. Serves the dashboard UI, runs scrapes on demand, and persists
// reviews / comments / activity to JSON files in ../data.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { scrapeDealership } = require('../scraper/scrape');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const CARS_FILE = path.join(DATA_DIR, 'cars.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const loadJSON = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const saveJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

const today = () => new Date().toISOString().slice(0, 10);

const logActivity = (user, action, details = {}) => {
  const activity = loadJSON(ACTIVITY_FILE, []);
  activity.push({
    user,
    action,
    details,
    at: new Date().toISOString(),
    date: today(),
  });
  saveJSON(ACTIVITY_FILE, activity);
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- API ----

// Trigger a scrape. Body: { url, user }
app.post('/api/scrape', async (req, res) => {
  const { url, user } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const result = await scrapeDealership(url);
    // Merge into cars store. Existing cars (same image+title) keep their reviews.
    const cars = loadJSON(CARS_FILE, []);
    const keyFor = (c) => (c.image || '') + '|' + (c.title || '');
    const existing = new Map(cars.map((c) => [keyFor(c), c]));
    for (const c of result.cars) {
      const k = keyFor(c);
      if (!existing.has(k)) {
        existing.set(k, {
          ...c,
          dealership: result.dealership,
          firstSeen: result.scrapedAt,
          reviews: [],
        });
      }
    }
    const merged = Array.from(existing.values());
    saveJSON(CARS_FILE, merged);
    logActivity(user || 'anonymous', 'scrape', {
      dealership: result.dealership,
      newCarsFound: result.cars.length,
    });
    res.json({
      dealership: result.dealership,
      scrapedAt: result.scrapedAt,
      newInventoryUrl: result.newInventoryUrl,
      usedInventoryUrl: result.usedInventoryUrl,
      carsScraped: result.cars.length,
      totalCarsTracked: merged.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// List all cars (optional filter by dealership / condition)
app.get('/api/cars', (req, res) => {
  const { dealership, condition } = req.query;
  let cars = loadJSON(CARS_FILE, []);
  if (dealership) cars = cars.filter((c) => (c.dealership || '').includes(dealership));
  if (condition) cars = cars.filter((c) => c.condition === condition);
  res.json(cars);
});

// Add a review/comment to a car. Body: { carId, user, rating, comment }
app.post('/api/cars/:carId/review', (req, res) => {
  const { carId } = req.params;
  const { user, rating, comment } = req.body || {};
  const cars = loadJSON(CARS_FILE, []);
  const car = cars.find((c) => c.id === carId);
  if (!car) return res.status(404).json({ error: 'car not found' });

  const review = {
    user: user || 'anonymous',
    rating: rating || null,
    comment: comment || '',
    at: new Date().toISOString(),
  };
  car.reviews = car.reviews || [];
  car.reviews.push(review);
  saveJSON(CARS_FILE, cars);
  logActivity(user || 'anonymous', 'review', {
    carId,
    title: car.title,
    rating,
    hasComment: !!comment,
  });
  res.json(car);
});

// Daily report. Optional ?date=YYYY-MM-DD (defaults today).
app.get('/api/report', (req, res) => {
  const date = req.query.date || today();
  const user = req.query.user;
  const activity = loadJSON(ACTIVITY_FILE, []);
  const filtered = activity.filter((a) => a.date === date && (!user || a.user === user));

  const summary = {
    date,
    user: user || 'all users',
    totalActions: filtered.length,
    scrapes: filtered.filter((a) => a.action === 'scrape').length,
    reviews: filtered.filter((a) => a.action === 'review').length,
    dealershipsScraped: [
      ...new Set(filtered.filter((a) => a.action === 'scrape').map((a) => a.details.dealership)),
    ],
    carsReviewed: filtered
      .filter((a) => a.action === 'review')
      .map((a) => ({ title: a.details.title, rating: a.details.rating, at: a.at })),
    timeline: filtered.sort((a, b) => a.at.localeCompare(b.at)),
  };
  res.json(summary);
});

// List distinct dates that have activity (for the report date picker).
app.get('/api/report/dates', (_req, res) => {
  const activity = loadJSON(ACTIVITY_FILE, []);
  const dates = [...new Set(activity.map((a) => a.date))].sort().reverse();
  res.json(dates);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nDealership dashboard running at http://localhost:${PORT}`);
});
