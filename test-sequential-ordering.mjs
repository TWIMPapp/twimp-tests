/**
 * Test: Sequential pin ordering for custom mode trails
 *
 * Verifies that in mode='custom', only the current sequential pin
 * can be collected — not any arbitrary pin.
 */

const API = 'https://api.twimp.app';
const TRAIL_ID = 'melissa';

// Pin 0 (first pin) and Pin 5 (last pin) coordinates from the trail config
const PIN_0 = { lat: 50.77004324738618, lng: -2.012566035239951 };
const PIN_5 = { lat: 50.77125854636381, lng: -2.011097188695017 };

// A location far from all pins (middle of the ocean)
const FAR_AWAY = { lat: 51.0, lng: -2.0 };

const userId = `test_seq_${Date.now()}`;

async function post(endpoint, body) {
    const res = await fetch(`${API}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    return data.body || data;
}

async function get(endpoint) {
    const res = await fetch(`${API}/${endpoint}`);
    const data = await res.json();
    return data.body || data;
}

async function run() {
    console.log(`\n=== Sequential Ordering Test ===`);
    console.log(`Trail: ${TRAIL_ID}`);
    console.log(`User:  ${userId}\n`);

    // Step 0: Check trail mode
    const trailInfo = await get(`custom-trail/${TRAIL_ID}`);
    console.log(`Trail mode: ${trailInfo.trail?.mode}`);
    console.log(`Trail competitive: ${trailInfo.trail?.competitive}`);
    console.log(`Trail pins: ${trailInfo.trail?.pinCount}`);

    if (trailInfo.trail?.mode !== 'custom') {
        console.log(`\n⚠️  Trail mode is "${trailInfo.trail?.mode}", NOT "custom"!`);
        console.log(`   This would explain the bug — random mode allows any-order collection.`);
    }
    console.log('');

    // Step 1: Start the game (far from any pin)
    console.log(`1. Starting game from far away...`);
    const playResult = await post('play', {
        game_ref: `custom-trail-${TRAIL_ID}`,
        user_id: userId,
        lat: FAR_AWAY.lat,
        lng: FAR_AWAY.lng
    });
    console.log(`   ok=${playResult.ok}, resumed=${playResult.resumed || false}`);
    console.log(`   session.currentPinIndex=${playResult.session?.currentPinIndex}`);
    console.log(`   session.collectedPins=[${playResult.session?.collectedPins}]`);
    console.log('');

    // Step 2: AWTY near PIN 5 (last pin) — should NOT collect in sequential mode
    console.log(`2. AWTY near Pin 5 (last pin) — expecting arrived=false...`);
    const awty1 = await post('awty', {
        game_ref: `custom-trail-${TRAIL_ID}`,
        user_id: userId,
        lat: PIN_5.lat,
        lng: PIN_5.lng
    });
    console.log(`   ok=${awty1.ok}`);
    console.log(`   arrived=${awty1.arrived}`);
    console.log(`   collected=${awty1.collected || false}`);
    console.log(`   hint=${awty1.hint || 'none'}`);
    console.log(`   session.currentPinIndex=${awty1.session?.currentPinIndex}`);

    if (awty1.arrived || awty1.collected) {
        console.log(`\n   ❌ BUG CONFIRMED: Pin 5 was collected before Pin 0!`);
        console.log(`   successMessage: "${awty1.successMessage}"`);
    } else {
        console.log(`   ✅ Correct: Pin 5 was NOT collected (sequential order enforced)`);
    }
    console.log('');

    // Step 3: AWTY near PIN 0 (first pin) — SHOULD collect in sequential mode
    console.log(`3. AWTY near Pin 0 (first pin) — expecting arrived=true, collected...`);
    const awty2 = await post('awty', {
        game_ref: `custom-trail-${TRAIL_ID}`,
        user_id: userId,
        lat: PIN_0.lat,
        lng: PIN_0.lng
    });
    console.log(`   ok=${awty2.ok}`);
    console.log(`   arrived=${awty2.arrived}`);
    console.log(`   collected=${awty2.collected || false}`);
    console.log(`   session.currentPinIndex=${awty2.session?.currentPinIndex}`);

    if (awty2.collected) {
        console.log(`   ✅ Correct: Pin 0 was collected`);
        console.log(`   successMessage: "${awty2.successMessage}"`);
    } else {
        console.log(`   ❌ UNEXPECTED: Pin 0 was NOT collected`);
        console.log(`   hint=${awty2.hint || 'none'}`);
    }
    console.log('');

    // Step 4: Now try Pin 5 again — should still not work (Pin 1 is next)
    console.log(`4. AWTY near Pin 5 again — expecting arrived=false (Pin 1 is next)...`);
    const awty3 = await post('awty', {
        game_ref: `custom-trail-${TRAIL_ID}`,
        user_id: userId,
        lat: PIN_5.lat,
        lng: PIN_5.lng
    });
    console.log(`   ok=${awty3.ok}`);
    console.log(`   arrived=${awty3.arrived}`);
    console.log(`   collected=${awty3.collected || false}`);
    console.log(`   session.currentPinIndex=${awty3.session?.currentPinIndex}`);

    if (awty3.arrived || awty3.collected) {
        console.log(`\n   ❌ BUG: Pin 5 collected when Pin 1 should be next!`);
    } else {
        console.log(`   ✅ Correct: Pin 5 not collected (Pin 1 is next)`);
    }

    // Cleanup: restart the session
    console.log(`\n5. Cleaning up — restarting session...`);
    const restart = await post('next', {
        game_ref: `custom-trail-${TRAIL_ID}`,
        user_id: userId,
        action: 'restart'
    });
    console.log(`   ${restart.ok ? 'Done' : 'Failed'}`);

    console.log(`\n=== Test Complete ===\n`);
}

run().catch(console.error);
