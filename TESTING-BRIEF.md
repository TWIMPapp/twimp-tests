# TWIMP E2E Testing Brief

## Context

TWIMP builds location-based games (egg hunts, dragon adventures, murder mysteries). Players walk around the real world and the game responds to their GPS position.

### Repositories

- **API**: `~/twimp-api` - Vercel serverless functions, Supabase for sessions
- **Game Frontend**: `~/twimp-game` - Next.js app at `game.twimp.app`
- **Tests**: `~/twimp-tests` - E2E test suite (this repo)

### Key API Endpoints

All endpoints are on `https://api.twimp.app/api/`:

| Endpoint | Purpose |
|----------|---------|
| `POST /custom-trail/create` | Create a new trail with pins |
| `POST /custom-trail/play` | Start a session for a user |
| `POST /custom-trail/awty` | "Are We There Yet" - check proximity, collect pins |
| `POST /custom-trail/status` | Get session status (collected count, etc.) |

### How the Game Works

1. Trail is created with N pins at GPS coordinates
2. Player loads `game.twimp.app/trail/{id}` and clicks "Start"
3. Frontend polls `/awty` every ~5 seconds with player's GPS
4. When player is within ~20m of a pin, API returns `arrived: true, collected: true`
5. Frontend shows success animation, updates count
6. Game completes when all pins collected

---

## What's Already Done

### Test Infrastructure (`~/twimp-tests`)

- `tests/custom-trail.api.mjs` - API-only tests (no browser)
- `tests/custom-trail.e2e.mjs` - Full browser tests with Puppeteer + GPS mocking
- Uses real `api.twimp.app` (live testing, not local)

### Bug Already Found & Fixed

**user_id regeneration bug**: The frontend had:
```javascript
const userId = (user_id as string) || `player_${Date.now()}`;
```

This ran on every re-render, generating a NEW user_id each time. So `/play` created a session for one ID, but subsequent `/awty` calls used different IDs → "No active session".

**Fix**: Wrapped in `useState()` so it only generates once per session.

---

## What Needs Testing

### 1. Multi-Player Simulation (Priority: HIGH)

The games support multiple players on the same trail. Need to test:

- [ ] 2+ players starting the same trail simultaneously
- [ ] Each player has independent session state
- [ ] Player A collecting a pin doesn't affect Player B's uncollected pins
- [ ] All players can complete the trail independently

**Implementation approach**: Spawn multiple Puppeteer browser contexts, each with different user IDs and GPS positions.

### 2. Competitive Mode (Priority: HIGH)

Some trails have `competitive: true` - shared collection pool.

- [ ] When Player A collects a pin, it disappears for ALL players
- [ ] First player to collect wins that pin
- [ ] Race condition: what if 2 players collect the exact same pin at the same moment?
- [ ] Verify correct winner is credited

### 3. Race Conditions (Priority: MEDIUM)

- [ ] Simultaneous `/play` calls with same user_id
- [ ] Simultaneous `/awty` calls (rapid GPS updates)
- [ ] Player disconnects mid-game, reconnects
- [ ] Session expiry during active game

### 4. GPS Edge Cases (Priority: MEDIUM)

- [ ] Player exactly on pin boundary (20m threshold)
- [ ] GPS drift - position bouncing around pin
- [ ] Very fast movement (GPS teleporting)
- [ ] Invalid/null GPS coordinates

### 5. Trail Variations (Priority: LOW but comprehensive)

- [ ] Random mode vs custom pin placement
- [ ] With/without questions (`has_questions: true`)
- [ ] Different themes (easter, valentine, general)
- [ ] Large trails (20 pins) vs small (3 pins)

---

## Test Utilities Needed

### GPS Simulation Helper

```javascript
// Set fake GPS position for a browser context
async function setGPS(page, lat, lng, accuracy = 10) {
  await page.setGeolocation({ latitude: lat, longitude: lng, accuracy });
}

// Simulate walking from point A to point B
async function walkTo(page, fromLat, fromLng, toLat, toLng, steps = 10, delayMs = 500) {
  for (let i = 0; i <= steps; i++) {
    const lat = fromLat + (toLat - fromLat) * (i / steps);
    const lng = fromLng + (toLng - fromLng) * (i / steps);
    await setGPS(page, lat, lng);
    await sleep(delayMs);
  }
}
```

### Multi-Browser Session Manager

```javascript
class MultiPlayerTest {
  constructor(trailId, playerCount) {
    this.trailId = trailId;
    this.players = []; // Array of { browser, page, userId, position }
  }
  
  async spawnPlayer(startLat, startLng) { /* ... */ }
  async movePlayer(playerId, lat, lng) { /* ... */ }
  async collectAndVerify(playerId, pinIndex) { /* ... */ }
  async cleanup() { /* ... */ }
}
```

### Test Trail Generator

Create test trails with predictable pin positions:

```javascript
async function createTestTrail(options = {}) {
  const response = await fetch('https://api.twimp.app/api/custom-trail/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creator_id: `test_${Date.now()}`,
      theme: options.theme || 'easter',
      name: options.name || 'E2E Test Trail',
      start_location: options.start || { lat: 50.702208, lng: -1.938634 },
      mode: 'custom',
      pins: options.pins || [
        { lat: 50.702208, lng: -1.938634 },
        { lat: 50.702308, lng: -1.938534 },
        { lat: 50.702408, lng: -1.938434 },
      ],
      competitive: options.competitive || false,
      has_questions: options.has_questions || false,
    }),
  });
  return response.json();
}
```

---

## Session Cleanup

Tests create sessions in Supabase. Need cleanup strategy:

1. Use `creator_id` prefix like `test_*` for all test trails
2. Add cleanup endpoint or Supabase query to delete test data
3. Run cleanup at start of test suite (not end - allows debugging failures)

---

## Running Tests

```bash
cd ~/twimp-tests
npm install
npm test              # All tests
npm run test:api      # API-only (fast)
npm run test:e2e      # Browser tests (slower)
npm run test:multi    # Multi-player tests (slowest)
```

---

## Success Criteria

1. **Zero race conditions** - Multi-player games work reliably
2. **Competitive mode fairness** - First player to arrive gets the pin
3. **Session stability** - No "No active session" errors during normal play
4. **GPS accuracy** - Pins collected at correct threshold, not before/after

---

## Notes

- Tests hit **live** `api.twimp.app` - be aware of rate limits
- Puppeteer requires `--no-sandbox` on some CI environments
- GPS simulation uses Chromium's built-in geolocation override
- Frontend at `game.twimp.app` deploys via Vercel on git push
