/**
 * Test: Dino Egg Hunt — full end-to-end flow
 *
 * Tests the complete Dino Hunt lifecycle:
 *   1. Start game (POST /play)
 *   2. Choose favorite dinosaur (POST /next, action: choose-dino)
 *   3. Walk to each of 10 eggs (POST /awty)
 *   4. Answer trivia questions (POST /next, action: answer-question)
 *   5. Name dinosaurs (POST /next, action: name-dino)
 *   6. Collect golden egg (POST /next, action: collect-golden-egg)
 *   7. Restart game (POST /next, action: restart)
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

async function run() {
    console.log(`\n=== Dino Egg Hunt Test ===\n`);
    const userId = `test-dino-${Date.now()}`;
    const playerLocation = { lat: 51.4545, lng: -2.5879 }; // Bristol

    // --------------------------------------------------
    // 1. Start game
    // --------------------------------------------------
    console.log('1. Start game');

    const startResult = await post('play', {
        game_ref: 'dino-hunt',
        user_id: userId,
        lat: playerLocation.lat,
        lng: playerLocation.lng
    });

    assert(startResult.ok, 'Start succeeded');
    assert(startResult.session?.phase === 'setup', `Phase is "setup" (got "${startResult.session?.phase}")`);
    assert(Array.isArray(startResult.favoriteOptions), 'Favorite options returned');
    console.log('');

    // --------------------------------------------------
    // 2. Choose favorite dinosaur
    // --------------------------------------------------
    console.log('2. Choose favorite dinosaur');

    const chooseResult = await post('next', {
        game_ref: 'dino-hunt',
        user_id: userId,
        action: 'choose-dino',
        dino_id: 'trex'
    });

    assert(chooseResult.ok, 'Choose dino succeeded');
    assert(chooseResult.phase === 'hunting', `Phase is "hunting" (got "${chooseResult.phase}")`);
    assert(chooseResult.favoriteDino === 'T-Rex', `Favorite dino is "T-Rex" (got "${chooseResult.favoriteDino}")`);
    assert(typeof chooseResult.introStory === 'string' && chooseResult.introStory.length > 0, 'Intro story returned');
    assert(chooseResult.introStory.includes('T-Rex'), 'Intro story mentions favorite dino');
    assert(Array.isArray(chooseResult.eggs) && chooseResult.eggs.length === 10, `10 eggs spawned (got ${chooseResult.eggs?.length})`);

    const eggs = chooseResult.eggs;
    console.log(`  Eggs spawned at ${eggs.length} locations within ${chooseResult.spawnRadius?.radiusMeters || '?'}m`);
    console.log('');

    // --------------------------------------------------
    // 3. AWTY far from eggs — should not arrive
    // --------------------------------------------------
    console.log('3. AWTY far from eggs');

    const farPos = { lat: playerLocation.lat + 0.01, lng: playerLocation.lng + 0.01 };
    const awtyFar = await post('awty', {
        game_ref: 'dino-hunt',
        user_id: userId,
        lat: farPos.lat,
        lng: farPos.lng
    });

    assert(awtyFar.ok, 'AWTY response ok');
    assert(!awtyFar.arrived, 'Not arrived when far away');
    assert(typeof awtyFar.nearestDistance === 'number', `Got nearest distance (${awtyFar.nearestDistance}m)`);
    assert(typeof awtyFar.nearestDirection === 'string', `Got direction (${awtyFar.nearestDirection})`);
    console.log('');

    // --------------------------------------------------
    // 4-6. Collect all 10 eggs (walk, answer, name)
    // --------------------------------------------------
    console.log('4. Collect all 10 eggs');

    for (let i = 0; i < 10; i++) {
        const egg = eggs[i];
        console.log(`\n  --- Egg ${i + 1}/10 (${egg.categoryId}) ---`);

        // Walk to egg location
        const awtyAtEgg = await post('awty', {
            game_ref: 'dino-hunt',
            user_id: userId,
            lat: egg.lat,
            lng: egg.lng
        });

        assert(awtyAtEgg.arrived, `Arrived at egg ${i + 1}`);
        assert(awtyAtEgg.question?.text, `Got question: "${(awtyAtEgg.question?.text || '').substring(0, 50)}..."`);
        assert(Array.isArray(awtyAtEgg.question?.options) && awtyAtEgg.question.options.length === 3,
            `Got 3 answer options`);

        // Answer the question (pick first option)
        const optionRarities = awtyAtEgg.question?._optionRarities || [];
        const answerResult = await post('next', {
            game_ref: 'dino-hunt',
            user_id: userId,
            action: 'answer-question',
            answer_index: 0,
            option_rarities: optionRarities
        });

        assert(answerResult.ok, `Answer accepted`);
        assert(answerResult.dinosaur?.name, `Got dinosaur: ${answerResult.dinosaur?.name}`);
        assert(['epic', 'rare', 'common'].includes(answerResult.dinosaur?.rarity),
            `Rarity: ${answerResult.dinosaur?.rarity}`);
        assert(typeof answerResult.dinosaur?.total === 'number', `Total score: ${answerResult.dinosaur?.total}`);
        assert(typeof answerResult.revealMessage === 'string', `Reveal message: "${answerResult.revealMessage}"`);

        // Name the dinosaur
        const nickname = `TestDino${i + 1}`;
        const nameResult = await post('next', {
            game_ref: 'dino-hunt',
            user_id: userId,
            action: 'name-dino',
            nickname,
            dino_data: answerResult.dinosaur
        });

        assert(nameResult.ok, `Named "${nickname}"`);
        assert(nameResult.collectedDino?.nickname === nickname,
            `Nickname saved: "${nameResult.collectedDino?.nickname}"`);
        assert(nameResult.collectedCount === i + 1, `Collected count: ${nameResult.collectedCount}`);

        if (i === 9) {
            assert(nameResult.goldenEggSpawned, 'Golden egg spawned after 10th egg');
            assert(nameResult.goldenEggLocation?.lat !== undefined, 'Golden egg location returned');
            assert(nameResult.phase === 'golden_egg', `Phase is "golden_egg" (got "${nameResult.phase}")`);
        }
    }
    console.log('');

    // --------------------------------------------------
    // 7. Walk to golden egg
    // --------------------------------------------------
    console.log('5. Walk to golden egg');

    const goldenAwty = await post('awty', {
        game_ref: 'dino-hunt',
        user_id: userId,
        lat: playerLocation.lat,
        lng: playerLocation.lng
    });

    assert(goldenAwty.arrived, 'Arrived at golden egg (start position)');
    assert(goldenAwty.goldenEggReady, 'Golden egg ready to collect');
    console.log('');

    // --------------------------------------------------
    // 8. Collect golden egg — get battle story
    // --------------------------------------------------
    console.log('6. Collect golden egg (battle story)');

    const battleResult = await post('next', {
        game_ref: 'dino-hunt',
        user_id: userId,
        action: 'collect-golden-egg'
    });

    assert(battleResult.ok, 'Golden egg collected');
    assert(battleResult.phase === 'victory', `Phase is "victory" (got "${battleResult.phase}")`);
    assert(typeof battleResult.battleStory === 'string' && battleResult.battleStory.length > 50,
        `Battle story generated (${battleResult.battleStory?.length} chars)`);
    assert(Array.isArray(battleResult.army) && battleResult.army.length === 10,
        `Army has 10 dinosaurs`);
    assert(typeof battleResult.totalScore === 'number' && battleResult.totalScore > 0,
        `Total score: ${battleResult.totalScore}`);
    assert(battleResult.favoriteDino === 'T-Rex', `Favorite dino preserved: ${battleResult.favoriteDino}`);

    console.log(`\n  Battle story preview: "${battleResult.battleStory?.substring(0, 100)}..."`);
    console.log('');

    // --------------------------------------------------
    // 9. Restart game
    // --------------------------------------------------
    console.log('7. Restart game');

    const restartResult = await post('next', {
        game_ref: 'dino-hunt',
        user_id: userId,
        action: 'restart'
    });

    assert(restartResult.ok, 'Restart succeeded');

    // Verify restart worked
    const afterRestart = await post('play', {
        game_ref: 'dino-hunt',
        user_id: userId,
        lat: playerLocation.lat,
        lng: playerLocation.lng
    });

    assert(afterRestart.session?.phase === 'setup', `After restart, phase is "setup" (got "${afterRestart.session?.phase}")`);
    console.log('');

    // --------------------------------------------------
    // 10. Validation tests
    // --------------------------------------------------
    console.log('8. Validation');

    // Can't answer without arriving
    const badAnswer = await post('next', {
        game_ref: 'dino-hunt',
        user_id: userId,
        action: 'answer-question',
        answer_index: 0,
        option_rarities: ['epic', 'rare', 'common']
    });
    assert(!badAnswer.ok, 'Cannot answer without arriving at egg');

    // Can't name without pending dino
    const badName = await post('next', {
        game_ref: 'dino-hunt',
        user_id: userId,
        action: 'name-dino',
        nickname: 'Test',
        dino_data: {}
    });
    assert(!badName.ok, 'Cannot name without pending dino');

    // Empty nickname rejected
    // First set up a game to test naming validation
    await post('next', {
        game_ref: 'dino-hunt',
        user_id: userId,
        action: 'restart'
    });
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
