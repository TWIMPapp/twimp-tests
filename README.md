# TWIMP Test Suite

E2E and API tests for TWIMP games with GPS simulation.

## Setup

```bash
npm install
```

## Tests

### API-only tests (fast, no browser)
```bash
npm run test:api
```

Tests the backend API directly:
- Trail creation
- Player sessions
- AWTY proximity detection
- Pin collection

### Full E2E tests (browser + GPS)
```bash
npm test
```

Full end-to-end tests using Puppeteer:
1. Creates a trail via API
2. Launches browser with mocked GPS
3. Plays through the game
4. Verifies collection via UI

### Environment Variables

- `API_URL` - API endpoint (default: `https://api.twimp.app/api`)
- `GAME_URL` - Game frontend (default: `https://game.twimp.app`)

Example for local testing:
```bash
API_URL=http://localhost:3001/api GAME_URL=http://localhost:3000 npm test
```

## Test Structure

```
tests/
  custom-trail.api.mjs   # API-only tests
  custom-trail.e2e.mjs   # Full browser E2E tests
```

## Adding Tests

Tests use a simple framework:
- `test(name, async fn)` - Define a test
- `assert(condition, message, details)` - Assert expectations
- `api(endpoint, body)` - Make API calls
- `setGeolocation(page, lat, lng)` - Mock GPS position

## CI Integration (future)

Can be integrated with GitHub Actions:
```yaml
- run: npm ci
- run: npm run test:api  # Always run API tests
- run: npm test          # Run E2E on main branch
```
