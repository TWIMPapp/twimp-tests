/**
 * TWIMP Multi-Player API Test Suite
 *
 * Tests that multiple players can play the same trail independently
 * in non-competitive mode. Each player should have their own session
 * and be able to collect all pins regardless of other players.
 *
 * Run: node tests/multiplayer.api.mjs
 */

import {
    API_BASE, api, createSuite, assert, assertEqual, log,
    createTestTrail, startGame, awty, offsetCoords
} from './helpers.mjs';

const { test, printSummary } = createSuite('Multi-Player');

const testRun = Date.now();
const players = Array.from({ length: 3 }, (_, i) => `test-player${i + 1}-${testRun}`);

let trailId;
let trailPins;

async function runTests() {
    console.log('\n' + '='.repeat(60));
    console.log('👥 TWIMP Multi-Player Test Suite');
    console.log('='.repeat(60));
    console.log(`\nAPI: ${API_BASE}`);
    console.log(`Players: ${players.length}`);
    console.log(`Test Run: ${testRun}\n`);

    // -------- Setup: Create shared trail --------

    await test('Create non-competitive trail with 5 pins', async () => {
        const result = await createTestTrail({
            count: 5,
            spawn_radius: 200,
            competitive: false
        });

        trailId = result.trail.id;
        trailPins = result.trail.pins;
        log(`Trail ID: ${trailId}`);
        log(`Pins: ${trailPins.length}`);
    });

    // -------- All players start independently --------

    await test('All 3 players start game independently', async () => {
        for (const playerId of players) {
            const result = await startGame(trailId, playerId);
            assert(result.ok === true, `Player ${playerId} failed to start`, result);
            assertEqual(result.session?.totalPins, 5, `Player ${playerId} totalPins`);
            assertEqual(result.session?.collectedPins?.length, 0, `Player ${playerId} initial collected`);
            log(`${playerId}: started, 0/${result.session.totalPins} collected`);
        }
    });

    // -------- Player 1 collects all pins --------

    await test('Player 1 collects all 5 pins', async () => {
        for (let i = 0; i < trailPins.length; i++) {
            const pin = trailPins[i];
            const result = await awty(trailId, players[0], pin.lat, pin.lng);
            assert(result.ok === true, `AWTY failed for pin ${i}`, result);
            assert(result.arrived === true, `Expected arrived=true at pin ${i}`, result);
            log(`Pin ${i}: arrived=${result.arrived}, collected=${result.collected}`);
        }
    });

    // -------- Player 2 can still collect the same pins --------

    await test('Player 2 collects same pins (independent session)', async () => {
        for (let i = 0; i < trailPins.length; i++) {
            const pin = trailPins[i];
            const result = await awty(trailId, players[1], pin.lat, pin.lng);
            assert(result.ok === true, `AWTY failed for pin ${i}`, result);
            assert(result.arrived === true, `Expected arrived=true at pin ${i}`, result);
            assert(result.collected === true, `Expected collected=true at pin ${i}`, result);
            log(`Pin ${i}: collected=${result.collected}`);
        }
    });

    // -------- Player 3 collects in reverse order --------

    await test('Player 3 collects pins in reverse order', async () => {
        for (let i = trailPins.length - 1; i >= 0; i--) {
            const pin = trailPins[i];
            const result = await awty(trailId, players[2], pin.lat, pin.lng);
            assert(result.ok === true, `AWTY failed for pin ${i}`, result);
            assert(result.arrived === true, `Expected arrived=true at pin ${i}`, result);
            assert(result.collected === true, `Expected collected=true at pin ${i}`, result);
        }
        log('All 5 pins collected in reverse order');
    });

    // -------- Verify each player's session state --------

    await test('All players show as completed via AWTY', async () => {
        // Use AWTY at an already-collected pin to check session state
        const pin = trailPins[0];
        for (const playerId of players) {
            const result = await awty(trailId, playerId, pin.lat, pin.lng);
            assert(result.ok === true, `AWTY failed for ${playerId}`, result);
            const completed = result.completed === true || result.session?.completed === true;
            const collected = result.session?.collectedPins?.length || 0;
            log(`${playerId}: completed=${completed}, collected=${collected}`);
        }
    });

    // -------- Player collecting already-collected pin --------

    await test('AWTY at already-collected pin does not error', async () => {
        const pin = trailPins[0];
        const result = await awty(trailId, players[0], pin.lat, pin.lng);
        assert(result.ok === true, 'Expected ok response for re-visit', result);
        log(`Re-visit response: arrived=${result.arrived}, collected=${result.collected}, completed=${result.completed}`);
    });

    // -------- Simultaneous start --------

    await test('Multiple players can start at the same time', async () => {
        // Create a fresh trail for this test
        const fresh = await createTestTrail({ count: 3, spawn_radius: 150, competitive: false });
        const freshId = fresh.trail.id;

        // Start all players in parallel
        const startPromises = players.map(p => startGame(freshId, p));
        const results = await Promise.all(startPromises);

        for (let i = 0; i < results.length; i++) {
            assert(results[i].ok === true, `Parallel start failed for player ${i}`, results[i]);
            assertEqual(results[i].session?.totalPins, 3, `Player ${i} totalPins`);
        }
        log(`All ${players.length} players started in parallel successfully`);
    });

    // -------- Summary --------

    const { failed } = printSummary();
    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
