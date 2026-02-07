/**
 * TWIMP Custom Trail API Test Suite
 * Run: node tests/custom-trail.test.mjs
 */

const API_BASE = process.env.API_URL || 'https://api.twimp.app/api';

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

async function apiGet(endpoint) {
    const response = await fetch(`${API_BASE}/${endpoint}`);
    const data = await response.json();
    return data.body || data;
}

async function test(name, fn) {
    try {
        await fn();
        results.push({ name, passed: true });
        console.log(`✅ ${name}`);
    } catch (err) {
        results.push({ name, passed: false, error: err.message, details: err.details });
        console.log(`❌ ${name}`);
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

// Test Data
const testRun = Date.now();
const creatorId = `test-creator-${testRun}`;
const playerId1 = `test-player1-${testRun}`;
const playerId2 = `test-player2-${testRun}`;

let trailId;
let trailPins;

const startLocation = { lat: 50.702208, lng: -1.938634 };

async function runTests() {
    console.log('\n🧪 TWIMP Custom Trail Test Suite\n');
    console.log(`API: ${API_BASE}`);
    console.log(`Test Run ID: ${testRun}\n`);

    // Create trail
    await test('Create trail with random pins', async () => {
        const result = await api('custom-trail/create', {
            creator_id: creatorId,
            theme: 'easter',
            name: `Test Trail ${testRun}`,
            start_location: startLocation,
            mode: 'random',
            count: 5,
            spawn_radius: 200,
            competitive: false
        });

        assert(result.ok === true, 'Expected ok: true', result);
        assert(result.trail?.id, 'Expected trail.id', result);
        assert(result.trail?.pins?.length === 5, 'Expected 5 pins', result);

        trailId = result.trail.id;
        trailPins = result.trail.pins;
        console.log(`   Trail ID: ${trailId}`);
    });

    // Get trail info
    await test('Get trail info', async () => {
        const result = await apiGet(`custom-trail/${trailId}`);
        assert(result.ok === true, 'Expected ok: true', result);
        assert(result.trail?.mode === 'random', 'Expected mode: random', result);
    });

    // Player starts game
    await test('Player 1 starts game', async () => {
        const result = await api('play', {
            game_ref: `custom-trail-${trailId}`,
            user_id: playerId1,
            lat: startLocation.lat,
            lng: startLocation.lng
        });

        assert(result.ok === true, 'Expected ok: true', result);
        assert(result.session?.totalPins === 5, 'Expected 5 total pins', result);
        assert(result.session?.collectedPins?.length === 0, 'Expected 0 collected pins', result);
    });

    // AWTY far from pins
    await test('AWTY when far from all pins returns arrived: false', async () => {
        const result = await api('awty', {
            game_ref: `custom-trail-${trailId}`,
            user_id: playerId1,
            lat: startLocation.lat,
            lng: startLocation.lng
        });

        assert(result.ok === true, 'Expected ok: true', result);
        assert(result.arrived === false, 'Expected arrived: false when far from pins', result);
        console.log(`   nearestDistance: ${result.nearestDistance}m`);
    });

    // AWTY at pin 0 - THE KEY TEST
    await test('AWTY at pin location returns arrived: true AND collected: true', async () => {
        const pin0 = trailPins[0];
        console.log(`   Testing at pin 0: ${pin0.lat}, ${pin0.lng}`);
        
        const result = await api('awty', {
            game_ref: `custom-trail-${trailId}`,
            user_id: playerId1,
            lat: pin0.lat,
            lng: pin0.lng
        });

        console.log(`   Response keys: ${Object.keys(result).join(', ')}`);
        console.log(`   arrived: ${result.arrived}, collected: ${result.collected}`);

        assert(result.ok === true, 'Expected ok: true', result);
        assert(result.arrived === true, 'Expected arrived: true', result);
        assert(result.collected === true, 'Expected collected: true', result);
    });

    // AWTY 15m from pin
    await test('AWTY at 15m from pin still collects (within 30m radius)', async () => {
        // Use pin 1, offset by ~15m
        const pin1 = trailPins[1];
        const offsetLat = pin1.lat + 0.00013; // ~15m north
        
        const result = await api('awty', {
            game_ref: `custom-trail-${trailId}`,
            user_id: playerId1,
            lat: offsetLat,
            lng: pin1.lng
        });

        console.log(`   arrived: ${result.arrived}, collected: ${result.collected}`);
        
        assert(result.ok === true, 'Expected ok: true', result);
        assert(result.arrived === true, 'Expected arrived: true at 15m', result);
        assert(result.collected === true, 'Expected collected: true at 15m', result);
    });

    // Player 2 independent session
    await test('Player 2 can collect same pins (non-competitive)', async () => {
        // Start game
        await api('play', {
            game_ref: `custom-trail-${trailId}`,
            user_id: playerId2,
            lat: startLocation.lat,
            lng: startLocation.lng
        });

        // Collect pin 0
        const pin0 = trailPins[0];
        const result = await api('awty', {
            game_ref: `custom-trail-${trailId}`,
            user_id: playerId2,
            lat: pin0.lat,
            lng: pin0.lng
        });

        assert(result.collected === true, 'Expected Player 2 to collect same pin', result);
    });

    // Summary
    console.log('\n' + '='.repeat(50));
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

    if (failed > 0) {
        console.log('Failed tests:');
        results.filter(r => !r.passed).forEach(r => {
            console.log(`  ❌ ${r.name}: ${r.error}`);
        });
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
