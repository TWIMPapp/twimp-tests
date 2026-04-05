/**
 * Test: Secret Valentine — full end-to-end flow
 *
 * Tests the complete Valentine lifecycle:
 *   1. Create a valentine (POST /valentine/create)
 *   2. Send email (POST /valentine/send)
 *   3. Recipient opens trail (POST /play)
 *   4. Recipient walks to pin and collects it (POST /awty)
 *   5. Validation: missing fields, invalid email, message too long
 */

const API = 'https://api.twimp.app';

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.log(`  ❌ ${label}`);
        failed++;
    }
}

async function post(endpoint, body) {
    const res = await fetch(`${API}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json().then(d => d.body || d);
}

async function get(endpoint) {
    const res = await fetch(`${API}/${endpoint}`);
    return res.json().then(d => d.body || d);
}

async function run() {
    console.log(`\n=== Secret Valentine Test ===\n`);

    // --------------------------------------------------
    // 1. Validation tests
    // --------------------------------------------------
    console.log('1. Validation — missing/invalid fields');

    const noName = await post('valentine/create', { message: 'Hello' });
    assert(!noName.success, 'Rejects missing recipientName');

    const noMsg = await post('valentine/create', { recipientName: 'Test' });
    assert(!noMsg.success, 'Rejects missing message');

    const emptyName = await post('valentine/create', { recipientName: '', message: 'Hello' });
    assert(!emptyName.success, 'Rejects empty recipientName');

    const emptyMsg = await post('valentine/create', { recipientName: 'Test', message: '' });
    assert(!emptyMsg.success, 'Rejects empty message');

    const longMsg = await post('valentine/create', {
        recipientName: 'Test',
        message: 'x'.repeat(201)
    });
    assert(!longMsg.success, 'Rejects message over 200 chars');

    const okMsg = await post('valentine/create', {
        recipientName: 'Test',
        message: 'x'.repeat(200)
    });
    assert(okMsg.success, 'Accepts message at exactly 200 chars');
    // Clean up — this trail will expire naturally
    console.log('');

    // --------------------------------------------------
    // 2. Create a valentine
    // --------------------------------------------------
    console.log('2. Create valentine');

    const createResult = await post('valentine/create', {
        recipientName: 'TestRecipient',
        message: 'Happy Valentine\'s Day! This is a test message.'
    });

    assert(createResult.success, `Create succeeded`);
    assert(typeof createResult.trailId === 'string' && createResult.trailId.length === 4,
        `Trail ID is 4 chars: "${createResult.trailId}"`);

    const trailId = createResult.trailId;
    console.log('');

    // --------------------------------------------------
    // 3. Verify trail was created correctly
    // --------------------------------------------------
    console.log('3. Verify trail config');

    const trailInfo = await get(`custom-trail/${trailId}`);
    assert(trailInfo.trail !== undefined, 'Trail exists');
    assert(trailInfo.trail?.mode === 'random', `Mode is "random" (dynamic trail)`);
    assert(trailInfo.trail?.competitive === false, 'Not competitive');
    // Dynamic trails report pinCount from config (1) even before pins are generated
    assert(trailInfo.trail?.pinCount === 1,
        `Pin count matches config (pinCount=${trailInfo.trail?.pinCount})`);
    assert(trailInfo.trail?.name?.includes('TestRecipient'),
        `Trail name contains recipient: "${trailInfo.trail?.name}"`);
    console.log('');

    // --------------------------------------------------
    // 4. Email validation
    // --------------------------------------------------
    console.log('4. Email validation');

    const badEmail = await post('valentine/send', {
        trailId,
        recipientEmail: 'not-an-email'
    });
    assert(!badEmail.success, 'Rejects invalid email');

    const noTrailId = await post('valentine/send', {
        recipientEmail: 'test@example.com'
    });
    assert(!noTrailId.success, 'Rejects missing trailId');

    const noEmail = await post('valentine/send', {
        trailId
    });
    assert(!noEmail.success, 'Rejects missing recipientEmail');
    console.log('');

    // --------------------------------------------------
    // 5. Send email
    // --------------------------------------------------
    console.log('5. Send email');

    const sendResult = await post('valentine/send', {
        trailId,
        recipientEmail: 'test@example.com'
    });
    assert(sendResult.success, 'Email sent successfully');
    console.log('');

    // --------------------------------------------------
    // 6. Recipient opens trail — play from a location
    // --------------------------------------------------
    console.log('6. Recipient opens trail (play)');

    const playerLocation = { lat: 51.4545, lng: -2.5879 }; // Bristol
    const userId = `valentine_test_${Date.now()}`;

    const playResult = await post('play', {
        game_ref: `custom-trail-${trailId}`,
        user_id: userId,
        lat: playerLocation.lat,
        lng: playerLocation.lng
    });

    assert(playResult.ok, 'Play started');
    assert(playResult.session !== undefined, 'Session returned');
    assert(playResult.session?.currentPinIndex === 0, 'Starting at pin 0');

    // Save pin coordinates from play response (needed for step 9)
    const generatedPins = playResult.trail?.pins;
    assert(generatedPins?.length === 1, `Play response includes 1 generated pin`);
    const pinLocation = generatedPins?.[0];
    if (pinLocation) {
        console.log(`  Pin generated at (${pinLocation.lat.toFixed(6)}, ${pinLocation.lng.toFixed(6)})`);
    }
    console.log('');

    // --------------------------------------------------
    // 7. Check trail now has pins (generated dynamically)
    // --------------------------------------------------
    console.log('7. Verify dynamic pin generation');

    const trailAfterPlay = await get(`custom-trail/${trailId}`);
    const pinCount = trailAfterPlay.trail?.pinCount ?? trailAfterPlay.trail?.pins?.length ?? 0;
    assert(pinCount === 1, `Trail now has 1 pin (dynamic generation worked)`);
    console.log('');

    // --------------------------------------------------
    // 8. AWTY far away — should get hint
    // --------------------------------------------------
    console.log('8. AWTY far from pin — expect hint');

    const farPos = { lat: playerLocation.lat + 0.01, lng: playerLocation.lng + 0.01 };
    const awtyFar = await post('awty', {
        game_ref: `custom-trail-${trailId}`,
        user_id: userId,
        lat: farPos.lat,
        lng: farPos.lng
    });

    assert(awtyFar.ok, 'AWTY response ok');
    assert(!awtyFar.collected, 'Not collected when far away');
    assert(!awtyFar.arrived, 'Not arrived when far away');
    // Random mode returns nearestDistance instead of hint
    const gotDirection = typeof awtyFar.hint === 'string' || typeof awtyFar.nearestDistance === 'number';
    assert(gotDirection, `Got distance info (nearestDistance=${awtyFar.nearestDistance}m)`);
    console.log('');

    // --------------------------------------------------
    // 9. AWTY at pin location — should collect
    // --------------------------------------------------
    console.log('9. AWTY at pin location — expect collection');

    if (!pinLocation) {
        assert(false, 'No pin location available — cannot test collection');
    } else {
        // Walk to the exact pin location
        console.log(`  Walking to pin at (${pinLocation.lat.toFixed(6)}, ${pinLocation.lng.toFixed(6)})...`);

        const awtyAtPin = await post('awty', {
            game_ref: `custom-trail-${trailId}`,
            user_id: userId,
            lat: pinLocation.lat,
            lng: pinLocation.lng
        });

        assert(awtyAtPin.collected, 'Collected pin at its location');
        assert(awtyAtPin.completed, 'Trail completed (only 1 pin)');
        assert(typeof awtyAtPin.successMessage === 'string' && awtyAtPin.successMessage.length > 0,
            `Got success message: "${(awtyAtPin.successMessage || '').substring(0, 60)}..."`);
    }
    console.log('');

    // --------------------------------------------------
    // Summary
    // --------------------------------------------------
    console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
        console.log('SOME TESTS FAILED');
        process.exit(1);
    } else {
        console.log('ALL TESTS PASSED');
    }
}

run().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
