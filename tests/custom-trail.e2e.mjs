/**
 * TWIMP Custom Trail E2E Test Suite
 * 
 * Full end-to-end test:
 * 1. Creates a trail via API (as creator)
 * 2. Opens browser to play the game
 * 3. Fakes GPS to simulate walking to pins
 * 4. Verifies collection works via UI
 * 
 * Run: npm test
 */

import puppeteer from 'puppeteer';

const API_BASE = process.env.API_URL || 'https://api.twimp.app/api';
const GAME_BASE = process.env.GAME_URL || 'https://game.twimp.app';

// ============ Test Helpers ============

const results = [];

async function api(endpoint, body) {
    const response = await fetch(`${API_BASE}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await response.json();
    return data.body || data;
}

function log(msg) {
    console.log(`   ${msg}`);
}

async function test(name, fn) {
    console.log(`\n🧪 ${name}`);
    try {
        await fn();
        results.push({ name, passed: true });
        console.log(`✅ PASSED: ${name}`);
    } catch (err) {
        results.push({ name, passed: false, error: err.message });
        console.log(`❌ FAILED: ${name}`);
        console.log(`   Error: ${err.message}`);
        if (err.details) console.log(`   Details:`, JSON.stringify(err.details, null, 2));
    }
}

function assert(condition, message, details) {
    if (!condition) {
        const err = new Error(message);
        err.details = details;
        throw err;
    }
}

// ============ GPS Mocking ============

async function setGeolocation(page, lat, lng) {
    await page.setGeolocation({ latitude: lat, longitude: lng });
    log(`GPS set to: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
}

// ============ Test Data ============

const testRun = Date.now();
const creatorId = `e2e-creator-${testRun}`;
const startLocation = { lat: 50.702208, lng: -1.938634 };

let trailId;
let trailPins;
let browser;
let page;

// ============ Tests ============

async function runTests() {
    console.log('\n' + '='.repeat(60));
    console.log('🎮 TWIMP Custom Trail E2E Test Suite');
    console.log('='.repeat(60));
    console.log(`\nAPI: ${API_BASE}`);
    console.log(`Game: ${GAME_BASE}`);
    console.log(`Test Run: ${testRun}\n`);

    try {
        // -------- Phase 1: API Setup --------

        await test('Create trail via API', async () => {
            const result = await api('custom-trail/create', {
                creator_id: creatorId,
                theme: 'easter',
                name: `E2E Test Trail ${testRun}`,
                start_location: startLocation,
                mode: 'random',
                count: 3,  // Small number for quick test
                spawn_radius: 150,
                competitive: false
            });

            assert(result.ok === true, 'Expected ok: true', result);
            assert(result.trail?.id, 'Expected trail.id', result);
            assert(result.trail?.pins?.length === 3, 'Expected 3 pins', result);

            trailId = result.trail.id;
            trailPins = result.trail.pins;
            log(`Trail ID: ${trailId}`);
            log(`Trail URL: ${GAME_BASE}/trail/${trailId}`);
            log(`Pins: ${trailPins.map(p => `(${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`).join(', ')}`);
        });

        // -------- Phase 2: Browser Setup --------

        await test('Launch browser', async () => {
            browser = await puppeteer.launch({
                headless: false,  // Set to true for CI
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                defaultViewport: { width: 375, height: 812 }  // Mobile viewport
            });
            page = await browser.newPage();

            // Grant geolocation permission
            const context = browser.defaultBrowserContext();
            await context.overridePermissions(GAME_BASE, ['geolocation']);

            // Set initial GPS to start location
            await setGeolocation(page, startLocation.lat, startLocation.lng);

            // Intercept network requests to see requests and responses
            await page.setRequestInterception(true);
            page.on('request', req => {
                if (req.url().includes('/awty') || req.url().includes('/play')) {
                    try {
                        const body = JSON.parse(req.postData() || '{}');
                        const endpoint = req.url().includes('/play') ? 'PLAY' : 'AWTY';
                        log(`${endpoint} REQUEST: user_id=${body.user_id} game_ref=${body.game_ref}`);
                    } catch (e) { /* ignore */ }
                }
                req.continue();
            });
            page.on('response', async res => {
                if (res.url().includes('/awty') || res.url().includes('/play')) {
                    try {
                        const json = await res.json();
                        const endpoint = res.url().includes('/play') ? 'PLAY' : 'AWTY';
                        log(`${endpoint} RESPONSE: ${JSON.stringify(json).slice(0, 300)}`);
                    } catch (e) { /* ignore */ }
                }
            });

            log('Browser launched with geolocation permissions');
        });

        // -------- Phase 3: Load Game --------

        await test('Load game page', async () => {
            const url = `${GAME_BASE}/trail/${trailId}`;
            log(`Navigating to: ${url}`);
            await page.goto(url, { waitUntil: 'networkidle2' });

            // Wait for the Start button
            await page.waitForSelector('button', { timeout: 10000 });
            const pageText = await page.evaluate(() => document.body.innerText);
            assert(pageText.includes('Start'), 'Expected Start button on page', { pageText: pageText.slice(0, 500) });
            log('Game page loaded, Start button visible');
        });

        await test('Start the game', async () => {
            // Click Start button
            await page.click('button');
            
            // Wait for map to load (game state changes to 'playing')
            await page.waitForFunction(
                () => document.body.innerText.includes('/3') || document.body.innerText.includes('0/3'),
                { timeout: 10000 }
            );
            log('Game started, map visible');
        });

        // -------- Phase 4: Collect Pins --------

        await test('Move to pin 0 and collect', async () => {
            const pin = trailPins[0];
            log(`Moving to pin 0: ${pin.lat}, ${pin.lng}`);
            
            // Set GPS to pin location
            await setGeolocation(page, pin.lat, pin.lng);
            
            // Wait for collection (success dialog or counter update)
            // The AWTY polling interval is 5 seconds, so wait up to 10s
            await page.waitForFunction(
                () => {
                    const text = document.body.innerText;
                    return text.includes('Found it') || 
                           text.includes('1/3') ||
                           text.includes('Next');
                },
                { timeout: 15000 }
            );

            const pageText = await page.evaluate(() => document.body.innerText);
            const collected = pageText.includes('Found it') || pageText.includes('1/3');
            assert(collected, 'Expected pin to be collected', { pageText: pageText.slice(0, 500) });
            log('Pin 0 collected!');
        });

        await test('Dismiss success dialog if present', async () => {
            // Try to click "Next" button if success dialog is showing
            try {
                const nextButton = await page.$('button:has-text("Next")');
                if (nextButton) {
                    await nextButton.click();
                    log('Dismissed success dialog');
                } else {
                    // Try finding button with "Next" text
                    const buttons = await page.$$('button');
                    for (const btn of buttons) {
                        const text = await btn.evaluate(el => el.innerText);
                        if (text.includes('Next')) {
                            await btn.click();
                            log('Dismissed success dialog');
                            break;
                        }
                    }
                }
            } catch (e) {
                log('No success dialog to dismiss (or already dismissed)');
            }
            
            // Small delay for UI to settle
            await new Promise(r => setTimeout(r, 1000));
        });

        await test('Collect remaining pins', async () => {
            for (let i = 1; i < trailPins.length; i++) {
                const pin = trailPins[i];
                log(`Moving to pin ${i}: ${pin.lat}, ${pin.lng}`);
                
                await setGeolocation(page, pin.lat, pin.lng);
                
                // Wait for collection
                await page.waitForFunction(
                    (expected) => {
                        const text = document.body.innerText;
                        return text.includes('Found it') || 
                               text.includes(`${expected}/3`) ||
                               text.includes('You did it') ||
                               text.includes('completed');
                    },
                    { timeout: 15000 },
                    i + 1
                );

                // Dismiss dialog if present
                try {
                    const buttons = await page.$$('button');
                    for (const btn of buttons) {
                        const text = await btn.evaluate(el => el.innerText);
                        if (text.includes('Next')) {
                            await btn.click();
                            break;
                        }
                    }
                } catch (e) { /* ignore */ }

                await new Promise(r => setTimeout(r, 1000));
                log(`Pin ${i} collected`);
            }
        });

        await test('Verify game completion', async () => {
            const pageText = await page.evaluate(() => document.body.innerText);
            const completed = pageText.includes('You did it') || 
                             pageText.includes('completed') ||
                             pageText.includes('3/3');
            assert(completed, 'Expected game to be completed', { pageText: pageText.slice(0, 500) });
            log('Game completed successfully!');
        });

    } finally {
        // Cleanup
        if (browser) {
            await browser.close();
            log('Browser closed');
        }
    }

    // -------- Summary --------

    console.log('\n' + '='.repeat(60));
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

    if (failed > 0) {
        console.log('Failed tests:');
        results.filter(r => !r.passed).forEach(r => {
            console.log(`  ❌ ${r.name}: ${r.error}`);
        });
        process.exit(1);
    } else {
        console.log('🎉 All tests passed!\n');
    }
}

// Run
runTests().catch(err => {
    console.error('Test suite error:', err);
    if (browser) browser.close();
    process.exit(1);
});
