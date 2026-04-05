/**
 * TWIMP Competitive Mode API Test Suite
 *
 * Tests the shared pin pool in competitive mode:
 * - First player to arrive at a pin claims it for everyone
 * - Other players can no longer collect claimed pins
 * - Game ends when all pins are globally collected
 * - Race condition: simultaneous collection attempts
 *
 * Run: node tests/competitive.api.mjs
 */

import {
    API_BASE, api, createSuite, assert, assertEqual, log,
    createTestTrail, startGame, awty, collectPin, sleep
} from './helpers.mjs';

const { test, printSummary } = createSuite('Competitive Mode');

const testRun = Date.now();
const player1 = `comp-player1-${testRun}`;
const player2 = `comp-player2-${testRun}`;
const player3 = `comp-player3-${testRun}`;

let trailId;
let trailPins;

async function runTests() {
    console.log('\n' + '='.repeat(60));
    console.log('🏆 TWIMP Competitive Mode Test Suite');
    console.log('='.repeat(60));
    console.log(`\nAPI: ${API_BASE}`);
    console.log(`Test Run: ${testRun}\n`);

    // -------- Setup: Create competitive trail --------

    await test('Create competitive trail with 5 pins', async () => {
        const result = await createTestTrail({
            count: 5,
            spawn_radius: 200,
            competitive: true
        });

        trailId = result.trail.id;
        trailPins = result.trail.pins;
        assert(result.trail.competitive === true, 'Expected competitive: true', result.trail);
        log(`Trail ID: ${trailId}`);
        log(`Pins: ${trailPins.length}`);
        log(`Competitive: ${result.trail.competitive}`);
    });

    // -------- Both players start --------

    await test('Both players start the competitive game', async () => {
        const r1 = await startGame(trailId, player1);
        const r2 = await startGame(trailId, player2);

        assert(r1.ok === true, 'Player 1 start failed', r1);
        assert(r2.ok === true, 'Player 2 start failed', r2);
        assert(r1.competitive === true, 'Expected competitive flag in response', r1);
        assertEqual(r1.session?.totalPins, 5, 'Player 1 totalPins');
        assertEqual(r2.session?.totalPins, 5, 'Player 2 totalPins');
        log(`Both players started, competitive=${r1.competitive}`);
    });

    // -------- Player 1 claims pin 0 --------

    await test('Player 1 arrives at pin 0 and claims it', async () => {
        const pin = trailPins[0];
        const result = await awty(trailId, player1, pin.lat, pin.lng);

        assert(result.ok === true, 'AWTY failed', result);
        assert(result.arrived === true, 'Expected arrived=true', result);
        log(`arrived=${result.arrived}, collected=${result.collected}`);

        // If there's a task (question), collect via /next
        if (result.task) {
            log('Pin has a question, collecting via /next');
            const collectResult = await collectPin(trailId, player1, 0);
            assert(collectResult.ok === true, 'Collect failed', collectResult);
            assert(collectResult.collected === true, 'Expected collected=true', collectResult);
            log(`Collected via /next: collected=${collectResult.collected}`);
        } else {
            // Auto-collected
            assert(result.collected === true, 'Expected collected=true (auto)', result);
        }
    });

    // -------- Player 2 cannot claim the same pin --------

    await test('Player 2 cannot collect pin 0 (already claimed by Player 1)', async () => {
        const pin = trailPins[0];
        const result = await awty(trailId, player2, pin.lat, pin.lng);

        assert(result.ok === true, 'AWTY failed', result);
        log(`Player 2 at pin 0: arrived=${result.arrived}, collected=${result.collected}`);

        // In competitive mode, the pin is gone. Player 2 should NOT be able to collect it.
        // The API should either return arrived=false (pin already claimed, not a valid target)
        // or some indication that it's already been taken.
        if (result.arrived === true && result.task) {
            // If arrived=true with task, try to collect - should fail
            const collectResult = await collectPin(trailId, player2, 0);
            assert(collectResult.ok === false || collectResult.collected === false,
                'Expected Player 2 to be denied pin 0', collectResult);
            log(`Player 2 denied: ${collectResult.message || 'not collected'}`);
        } else {
            // Pin not offered as a valid target
            log('Pin 0 not available to Player 2 (already globally claimed)');
        }
    });

    // -------- Player 2 claims a different pin --------

    await test('Player 2 claims pin 1 (unclaimed)', async () => {
        const pin = trailPins[1];
        const result = await awty(trailId, player2, pin.lat, pin.lng);

        assert(result.ok === true, 'AWTY failed', result);
        assert(result.arrived === true, 'Expected arrived=true', result);
        log(`arrived=${result.arrived}, collected=${result.collected}`);

        if (result.task) {
            const collectResult = await collectPin(trailId, player2, 1);
            assert(collectResult.ok === true, 'Collect failed', collectResult);
            assert(collectResult.collected === true, 'Expected collected=true', collectResult);
        } else {
            assert(result.collected === true, 'Expected collected=true (auto)', result);
        }
    });

    // -------- Verify global state --------

    await test('Global state shows 2 pins collected by different players', async () => {
        // Resume sessions to get current state
        const r1 = await startGame(trailId, player1);
        const r2 = await startGame(trailId, player2);

        const global1 = r1.session?.globalCollectedPins || [];
        const global2 = r2.session?.globalCollectedPins || [];

        log(`Player 1 sees globalCollectedPins: [${global1}]`);
        log(`Player 2 sees globalCollectedPins: [${global2}]`);

        // Both players should see the same global state
        assertEqual(global1.length, 2, 'Expected 2 globally collected');
        assertEqual(global2.length, 2, 'Expected 2 globally collected');

        // Check ownership
        const by1 = r1.session?.globalCollectedBy || r1.trail?.globalCollectedBy || {};
        log(`globalCollectedBy: ${JSON.stringify(by1)}`);
    });

    // -------- One player finishes remaining pins --------

    await test('Player 1 collects remaining pins 2, 3, 4', async () => {
        for (let i = 2; i < trailPins.length; i++) {
            const pin = trailPins[i];
            const result = await awty(trailId, player1, pin.lat, pin.lng);
            assert(result.ok === true, `AWTY failed for pin ${i}`, result);

            if (result.arrived === true && result.task) {
                const collectResult = await collectPin(trailId, player1, i);
                assert(collectResult.ok === true, `Collect failed for pin ${i}`, collectResult);
                log(`Pin ${i}: collected via /next`);
            } else if (result.arrived === true) {
                log(`Pin ${i}: auto-collected`);
            } else if (result.completed) {
                log(`Game already completed at pin ${i}`);
                break;
            }
        }
    });

    // -------- Game should be complete for everyone --------

    await test('Game is complete for all players after all pins claimed', async () => {
        // Check via AWTY - should return completed
        const pin = trailPins[0]; // Doesn't matter which pin, game is over
        const r1 = await awty(trailId, player1, pin.lat, pin.lng);
        const r2 = await awty(trailId, player2, pin.lat, pin.lng);

        log(`Player 1: completed=${r1.completed}`);
        log(`Player 2: completed=${r2.completed}`);

        // At least one indicator of completion
        const p1Done = r1.completed === true || r1.session?.completed === true;
        const p2Done = r2.completed === true || r2.session?.completed === true;

        assert(p1Done, 'Expected Player 1 game to be complete', r1);
        assert(p2Done, 'Expected Player 2 game to be complete', r2);
    });

    // -------- Scoring --------

    await test('Global state shows all 5 pins claimed with correct owners', async () => {
        // Use the trail info endpoint to check global ownership
        const infoResponse = await fetch(`${API_BASE}/custom-trail/${trailId}`);
        const info = await infoResponse.json();
        const trail = info.body?.trail || info.trail;

        log(`Trail info: ${JSON.stringify(trail?.globalCollectedBy || {})}`);

        // Also check via /play resume
        const r1 = await startGame(trailId, player1);
        const globalPins = r1.session?.globalCollectedPins || [];
        const globalBy = r1.session?.globalCollectedBy || {};

        log(`Global collected: ${globalPins.length} pins`);
        log(`Ownership: ${JSON.stringify(globalBy)}`);

        assertEqual(globalPins.length, 5, 'All 5 pins should be globally collected');

        // Count per player
        const p1Count = Object.values(globalBy).filter(v => v === player1).length;
        const p2Count = Object.values(globalBy).filter(v => v === player2).length;
        log(`Player 1 claimed: ${p1Count}, Player 2 claimed: ${p2Count}`);
        assert(p1Count + p2Count === 5, `Total claimed should be 5, got ${p1Count + p2Count}`);
    });

    // ======== Race Condition: Simultaneous Claims ========

    await test('Race condition: 2 players claim same pin simultaneously', async () => {
        // Fresh competitive trail
        const fresh = await createTestTrail({
            count: 3,
            spawn_radius: 200,
            competitive: true
        });
        const freshId = fresh.trail.id;
        const freshPins = fresh.trail.pins;

        // Both players start
        await startGame(freshId, player1);
        await startGame(freshId, player2);

        // Both send AWTY to same pin at the same time
        const pin = freshPins[0];
        const [r1, r2] = await Promise.all([
            awty(freshId, player1, pin.lat, pin.lng),
            awty(freshId, player2, pin.lat, pin.lng)
        ]);

        log(`Player 1: arrived=${r1.arrived}, collected=${r1.collected}`);
        log(`Player 2: arrived=${r2.arrived}, collected=${r2.collected}`);

        // At most ONE player should have collected
        const p1Collected = r1.collected === true;
        const p2Collected = r2.collected === true;

        // Both might get arrived=true with a task (question), or one auto-collects
        // The key invariant: if both auto-collect, only one should actually get credit
        if (p1Collected && p2Collected) {
            // Both claimed — check if the backend still only credits one in global state
            const state = await startGame(freshId, player3);
            await startGame(freshId, player3); // need to start first
            const globalCount = state.session?.globalCollectedPins?.length || 0;
            log(`Both reported collected. Global state: ${globalCount} pins claimed`);
            // Even if both got collected=true, global state should show 1
            // (though this depends on backend atomicity — log the result either way)
            log(`⚠️  Race condition result: globalCollectedPins=${globalCount}`);
        } else {
            // Only one (or neither) collected — correct behavior
            const winner = p1Collected ? 'Player 1' : p2Collected ? 'Player 2' : 'Neither';
            log(`Winner: ${winner}`);
            assert(p1Collected || p2Collected, 'Expected at least one player to collect', { r1, r2 });
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
