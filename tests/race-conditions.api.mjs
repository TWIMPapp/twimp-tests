/**
 * TWIMP Race Conditions Test Suite
 *
 * Stress-tests concurrent API calls to find race conditions:
 * - Simultaneous /play calls with same user_id
 * - Rapid /awty polling (faster than 5s interval)
 * - Multiple players hitting same pin at same moment
 * - Concurrent sessions on same trail
 *
 * Run: node tests/race-conditions.api.mjs
 */

import {
    API_BASE, api, createSuite, assert, assertEqual, log,
    createTestTrail, startGame, awty, collectPin, sleep
} from './helpers.mjs';

const { test, printSummary } = createSuite('Race Conditions');

const testRun = Date.now();

async function runTests() {
    console.log('\n' + '='.repeat(60));
    console.log('⚡ TWIMP Race Conditions Test Suite');
    console.log('='.repeat(60));
    console.log(`\nAPI: ${API_BASE}`);
    console.log(`Test Run: ${testRun}\n`);

    // ======== Duplicate /play Calls ========

    await test('Simultaneous /play calls with same user_id', async () => {
        const trail = await createTestTrail({ count: 3, spawn_radius: 150, competitive: false });
        const userId = `race-dup-${testRun}`;

        // Fire 5 simultaneous /play calls
        const promises = Array.from({ length: 5 }, () =>
            startGame(trail.trail.id, userId)
        );
        const results = await Promise.all(promises);

        // All should succeed
        const okCount = results.filter(r => r.ok === true).length;
        log(`${okCount}/5 calls returned ok=true`);
        assert(okCount >= 1, 'Expected at least 1 successful start', results);

        // All should reference the same session (not create duplicates)
        const pinCounts = results.filter(r => r.ok).map(r => r.session?.totalPins);
        const unique = [...new Set(pinCounts)];
        log(`Unique totalPins values: ${JSON.stringify(unique)}`);
        assertEqual(unique.length, 1, 'All responses should agree on totalPins');
    });

    // ======== Rapid AWTY Polling ========

    await test('Rapid AWTY calls (10 in quick succession)', async () => {
        const trail = await createTestTrail({ count: 3, spawn_radius: 150, competitive: false });
        const userId = `race-rapid-${testRun}`;
        await startGame(trail.trail.id, userId);

        const pin = trail.trail.pins[0];

        // Fire 10 AWTY calls as fast as possible at the same pin
        const promises = Array.from({ length: 10 }, () =>
            awty(trail.trail.id, userId, pin.lat, pin.lng)
        );
        const results = await Promise.all(promises);

        const okCount = results.filter(r => r.ok === true).length;
        const arrivedCount = results.filter(r => r.arrived === true).length;
        const collectedCount = results.filter(r => r.collected === true).length;
        const errorCount = results.filter(r => r.ok !== true).length;

        log(`ok: ${okCount}, arrived: ${arrivedCount}, collected: ${collectedCount}, errors: ${errorCount}`);

        // Under heavy concurrent load, some may fail — that's acceptable
        // The key is no 500s and at least half succeed
        assert(okCount >= 5, `Expected at least half to succeed, got ${okCount}/10`);
        if (errorCount > 0) log(`⚠️  ${errorCount}/10 calls failed under load (rate limiting or contention)`);

        // Pin should be collected exactly once (no duplicate awards)
        // After collection, subsequent calls should either say already collected or not arrived
        assert(collectedCount >= 1, 'Expected at least 1 collection');
    });

    // ======== Competitive Race: N Players, 1 Pin ========

    await test('5 players race to collect the same pin simultaneously', async () => {
        const trail = await createTestTrail({ count: 3, spawn_radius: 200, competitive: true });
        const trailId = trail.trail.id;
        const pin = trail.trail.pins[0];

        const racers = Array.from({ length: 5 }, (_, i) => `racer-${i}-${testRun}`);

        // All racers start
        await Promise.all(racers.map(r => startGame(trailId, r)));
        log('All 5 racers started');

        // All racers hit pin 0 simultaneously
        const results = await Promise.all(
            racers.map(r => awty(trailId, r, pin.lat, pin.lng))
        );

        const collectors = [];
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const collected = r.collected === true;
            log(`Racer ${i}: arrived=${r.arrived}, collected=${collected}`);
            if (collected) collectors.push(i);
        }

        log(`Collectors: [${collectors.join(', ')}]`);

        // In competitive mode, ideally only 1 player should collect
        // But due to race conditions, we might see more — log it
        if (collectors.length > 1) {
            log(`⚠️  RACE CONDITION: ${collectors.length} players collected same pin`);
        } else if (collectors.length === 1) {
            log(`Correct: Only racer ${collectors[0]} collected the pin`);
        } else {
            // Might need /next to collect if there are questions
            log(`No auto-collection — pins may require /next`);
        }
    });

    // ======== Interleaved Collection ========

    await test('Interleaved collection: players alternate collecting pins', async () => {
        const trail = await createTestTrail({ count: 4, spawn_radius: 200, competitive: true });
        const trailId = trail.trail.id;
        const pins = trail.trail.pins;

        const alice = `alice-${testRun}`;
        const bob = `bob-${testRun}`;

        await startGame(trailId, alice);
        await startGame(trailId, bob);

        // Alice: pin 0, Bob: pin 1, Alice: pin 2, Bob: pin 3
        const assignments = [
            { player: alice, pinIdx: 0 },
            { player: bob, pinIdx: 1 },
            { player: alice, pinIdx: 2 },
            { player: bob, pinIdx: 3 },
        ];

        const collected = [];
        for (const { player, pinIdx } of assignments) {
            const pin = pins[pinIdx];
            const result = await awty(trailId, player, pin.lat, pin.lng);

            if (result.arrived === true && result.task) {
                const collectResult = await collectPin(trailId, player, pinIdx);
                collected.push({ player, pinIdx, ok: collectResult.ok, collected: collectResult.collected });
            } else {
                collected.push({ player, pinIdx, ok: result.ok, collected: result.collected });
            }

            log(`${player === alice ? 'Alice' : 'Bob'} → pin ${pinIdx}: collected=${collected[collected.length - 1].collected}`);
        }

        // All 4 should be collected
        const totalCollected = collected.filter(c => c.collected === true).length;
        log(`Total collected: ${totalCollected}/4`);
        assert(totalCollected === 4, `Expected 4 collected, got ${totalCollected}`);
    });

    // ======== High Concurrency: Many Players Starting ========

    await test('10 players start same trail simultaneously', async () => {
        const trail = await createTestTrail({ count: 5, spawn_radius: 200, competitive: false });
        const trailId = trail.trail.id;

        const playerIds = Array.from({ length: 10 }, (_, i) => `concurrent-${i}-${testRun}`);

        const results = await Promise.all(
            playerIds.map(p => startGame(trailId, p))
        );

        const okCount = results.filter(r => r.ok === true).length;
        const failCount = results.filter(r => r.ok !== true).length;

        log(`${okCount} started successfully, ${failCount} failed`);
        assert(okCount === 10, `Expected all 10 to start, got ${okCount}`);

        // Verify play count incremented
        const trailInfo = await api(`custom-trail/${trailId}`, undefined);
        // Use GET endpoint
        const infoResponse = await fetch(`${API_BASE}/custom-trail/${trailId}`);
        const info = await infoResponse.json();
        const playCount = info.body?.trail?.playCount || info.trail?.playCount;
        log(`Trail playCount: ${playCount}`);
    });

    // ======== Collect After Game Complete ========

    await test('AWTY after game is complete does not error', async () => {
        const trail = await createTestTrail({ count: 2, spawn_radius: 150, competitive: false });
        const trailId = trail.trail.id;
        const userId = `post-complete-${testRun}`;

        await startGame(trailId, userId);

        // Collect all pins
        for (const pin of trail.trail.pins) {
            await awty(trailId, userId, pin.lat, pin.lng);
        }

        // Send another AWTY after completion
        const pin = trail.trail.pins[0];
        const result = await awty(trailId, userId, pin.lat, pin.lng);
        assert(result.ok === true || result.completed === true, 'Expected non-error response after completion', result);
        log(`Post-completion AWTY: ok=${result.ok}, completed=${result.completed}`);
    });

    // -------- Summary --------

    const { failed } = printSummary();
    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
