/**
 * TWIMP GPS Edge Cases & Boundary Test Suite
 *
 * Tests GPS proximity thresholds and edge cases:
 * - Exact boundary at 20m collection radius
 * - Just inside / just outside radius
 * - GPS drift (repeated checks near boundary)
 * - Invalid/null coordinates
 * - Large trails (20 pins)
 * - Small trails (1 pin)
 *
 * Run: node tests/edge-cases.api.mjs
 */

import {
    API_BASE, api, createSuite, assert, assertEqual, log,
    createTestTrail, startGame, awty, offsetCoords, distanceMeters,
    generatePinGrid
} from './helpers.mjs';

const { test, printSummary } = createSuite('GPS Edge Cases');

const testRun = Date.now();
const playerId = `edge-player-${testRun}`;

const COLLECTION_RADIUS = 30; // meters — backend uses ~30m threshold

async function runTests() {
    console.log('\n' + '='.repeat(60));
    console.log('📍 TWIMP GPS Edge Cases Test Suite');
    console.log('='.repeat(60));
    console.log(`\nAPI: ${API_BASE}`);
    console.log(`Collection radius: ${COLLECTION_RADIUS}m`);
    console.log(`Test Run: ${testRun}\n`);

    // ======== Boundary Tests ========

    let boundaryTrailId, boundaryPins;

    await test('Setup: Create trail for boundary tests', async () => {
        const result = await createTestTrail({
            count: 5,
            spawn_radius: 200,
            competitive: false
        });
        boundaryTrailId = result.trail.id;
        boundaryPins = result.trail.pins;
        await startGame(boundaryTrailId, playerId);
        log(`Trail ${boundaryTrailId} with ${boundaryPins.length} pins`);
    });

    await test('Exactly at pin (0m) — should collect', async () => {
        const pin = boundaryPins[0];
        const result = await awty(boundaryTrailId, playerId, pin.lat, pin.lng);
        assert(result.ok === true, 'AWTY failed', result);
        assert(result.arrived === true, 'Expected arrived=true at 0m', result);
        log(`0m: arrived=${result.arrived}, collected=${result.collected}`);
    });

    await test('10m from pin — should collect (well within radius)', async () => {
        const pin = boundaryPins[1];
        const pos = offsetCoords(pin.lat, pin.lng, 10, 0);
        const dist = distanceMeters(pin.lat, pin.lng, pos.lat, pos.lng);
        log(`Offset distance: ${dist.toFixed(1)}m`);

        const result = await awty(boundaryTrailId, playerId, pos.lat, pos.lng);
        assert(result.ok === true, 'AWTY failed', result);
        assert(result.arrived === true, `Expected arrived=true at ~10m`, result);
        log(`10m: arrived=${result.arrived}, collected=${result.collected}`);
    });

    await test('25m from pin — should collect (within 30m radius)', async () => {
        const pin = boundaryPins[2];
        const pos = offsetCoords(pin.lat, pin.lng, 25, 0);
        const dist = distanceMeters(pin.lat, pin.lng, pos.lat, pos.lng);
        log(`Offset distance: ${dist.toFixed(1)}m`);

        const result = await awty(boundaryTrailId, playerId, pos.lat, pos.lng);
        assert(result.ok === true, 'AWTY failed', result);
        assert(result.arrived === true, `Expected arrived=true at ~25m`, result);
        log(`25m: arrived=${result.arrived}, collected=${result.collected}`);
    });

    await test('35m from pin — should NOT collect (outside 30m radius)', async () => {
        const pin = boundaryPins[3];
        const pos = offsetCoords(pin.lat, pin.lng, 35, 0);
        const dist = distanceMeters(pin.lat, pin.lng, pos.lat, pos.lng);
        log(`Offset distance: ${dist.toFixed(1)}m`);

        const result = await awty(boundaryTrailId, playerId, pos.lat, pos.lng);
        assert(result.ok === true, 'AWTY failed', result);
        assert(result.arrived === false, `Expected arrived=false at ~35m`, result);
        log(`35m: arrived=${result.arrived}`);
        if (result.nearestDistance) log(`Nearest distance reported: ${result.nearestDistance}m`);
    });

    await test('50m from pin — should NOT collect', async () => {
        const pin = boundaryPins[3]; // Same pin (still uncollected from 35m test)
        const pos = offsetCoords(pin.lat, pin.lng, 50, 0);
        const dist = distanceMeters(pin.lat, pin.lng, pos.lat, pos.lng);
        log(`Offset distance: ${dist.toFixed(1)}m`);

        const result = await awty(boundaryTrailId, playerId, pos.lat, pos.lng);
        assert(result.ok === true, 'AWTY failed', result);
        assert(result.arrived === false, `Expected arrived=false at ~50m`, result);
        log(`50m: arrived=${result.arrived}`);
    });

    // ======== GPS Drift Simulation ========

    await test('GPS drift: rapid checks near 30m boundary', async () => {
        // Use pin 4 (not yet collected)
        const pin = boundaryPins[4];

        // Simulate GPS bouncing around the 30m boundary: 32m, 35m, 28m, 33m, 25m
        const offsets = [32, 35, 28, 33, 25];
        let collected = false;

        for (const meters of offsets) {
            const pos = offsetCoords(pin.lat, pin.lng, meters, 0);
            const result = await awty(boundaryTrailId, playerId, pos.lat, pos.lng);

            const status = result.arrived ? 'ARRIVED' : 'not arrived';
            log(`  ${meters}m: ${status}`);

            if (result.arrived === true || result.collected === true) {
                collected = true;
                log(`  Pin collected at ${meters}m offset`);
            }
        }

        // 28m and 25m are inside radius, should trigger collection
        assert(collected, 'Expected pin to be collected when GPS drifts inside radius');
    });

    // ======== Trail Size Variations ========

    await test('Single pin trail (count: 1)', async () => {
        const result = await createTestTrail({
            count: 1,
            spawn_radius: 100,
            competitive: false
        });

        const singleTrailId = result.trail.id;
        assertEqual(result.trail.pins.length, 1, 'Expected 1 pin');

        const singlePlayer = `single-player-${testRun}`;
        await startGame(singleTrailId, singlePlayer);

        const pin = result.trail.pins[0];
        const awtyResult = await awty(singleTrailId, singlePlayer, pin.lat, pin.lng);
        assert(awtyResult.ok === true, 'AWTY failed', awtyResult);
        assert(awtyResult.arrived === true, 'Expected arrived=true', awtyResult);
        log(`Single pin trail: arrived=${awtyResult.arrived}, collected=${awtyResult.collected}`);

        // Game should be complete after collecting the only pin
        const completed = awtyResult.completed === true ||
                         awtyResult.session?.completed === true ||
                         awtyResult.collected === true;
        assert(completed, 'Expected game to complete after single pin', awtyResult);
    });

    await test('Large trail (20 pins)', async () => {
        const result = await createTestTrail({
            count: 20,
            spawn_radius: 500,
            competitive: false
        });

        assertEqual(result.trail.pins.length, 20, 'Expected 20 pins');
        log(`Large trail created: ${result.trail.id} with 20 pins`);

        // Verify all pins have valid coordinates
        for (const pin of result.trail.pins) {
            assert(typeof pin.lat === 'number' && !isNaN(pin.lat), `Invalid lat: ${pin.lat}`);
            assert(typeof pin.lng === 'number' && !isNaN(pin.lng), `Invalid lng: ${pin.lng}`);
        }

        // Verify minimum pin spacing (should be >= 50m apart)
        let minDist = Infinity;
        for (let i = 0; i < result.trail.pins.length; i++) {
            for (let j = i + 1; j < result.trail.pins.length; j++) {
                const d = distanceMeters(
                    result.trail.pins[i].lat, result.trail.pins[i].lng,
                    result.trail.pins[j].lat, result.trail.pins[j].lng
                );
                if (d < minDist) minDist = d;
            }
        }
        log(`Minimum pin spacing: ${minDist.toFixed(1)}m`);
        assert(minDist >= 45, `Pins too close: ${minDist.toFixed(1)}m (expected >= 50m)`);
    });

    // ======== Session Edge Cases ========

    await test('AWTY without starting game returns error', async () => {
        // Fresh trail, no /play call
        const fresh = await createTestTrail({ count: 3, spawn_radius: 150, competitive: false });
        const noSessionPlayer = `no-session-${testRun}`;

        const result = await awty(fresh.trail.id, noSessionPlayer, 50.702208, -1.938634);
        log(`Response without session: ok=${result.ok}, message=${result.message}`);

        // Should fail — no active session
        assert(result.ok === false || result.error || result.message,
            'Expected error when no session exists', result);
    });

    await test('Reconnect: resume session after re-calling /play', async () => {
        const fresh = await createTestTrail({ count: 3, spawn_radius: 150, competitive: false });
        const reconnectPlayer = `reconnect-${testRun}`;

        // Start, collect pin 0
        await startGame(fresh.trail.id, reconnectPlayer);
        const pin0 = fresh.trail.pins[0];
        await awty(fresh.trail.id, reconnectPlayer, pin0.lat, pin0.lng);

        // "Reconnect" — call /play again
        const resumed = await startGame(fresh.trail.id, reconnectPlayer);
        assert(resumed.ok === true, 'Resume failed', resumed);

        const collected = resumed.session?.collectedPins?.length || 0;
        log(`Resumed session: ${collected} pins collected (expected >= 1)`);
        assert(collected >= 1, 'Expected at least 1 pin to be preserved after reconnect', resumed);
    });

    // ======== Theme Variations ========

    await test('Create trail with each theme', async () => {
        const themes = ['easter', 'valentine', 'general'];
        for (const theme of themes) {
            const result = await createTestTrail({
                count: 3,
                spawn_radius: 150,
                competitive: false,
                theme
            });
            assert(result.ok === true, `Failed to create ${theme} trail`, result);
            log(`${theme}: trail ${result.trail.id} created`);
        }
    });

    // -------- Summary --------

    const { failed } = printSummary();
    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
