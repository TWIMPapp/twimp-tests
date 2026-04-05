/**
 * TWIMP Test Utilities
 *
 * Shared helpers for all test suites:
 * - HTTP helpers (api, apiGet)
 * - Test runner (test, assert, runSuite)
 * - Trail factory (createTestTrail)
 * - GPS utilities (offsetCoords, metersToCoordDelta)
 */

export const API_BASE = process.env.API_URL || 'https://api.twimp.app/api';

// ============ HTTP Helpers ============

export async function api(endpoint, body) {
    const response = await fetch(`${API_BASE}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await response.json();
    return data.body || data;
}

export async function apiGet(endpoint) {
    const response = await fetch(`${API_BASE}/${endpoint}`);
    const data = await response.json();
    return data.body || data;
}

// ============ Test Runner ============

export function createSuite(name) {
    const results = [];
    const startTime = Date.now();

    async function test(testName, fn) {
        console.log(`\n🧪 ${testName}`);
        try {
            await fn();
            results.push({ name: testName, passed: true });
            console.log(`✅ ${testName}`);
        } catch (err) {
            results.push({ name: testName, passed: false, error: err.message, details: err.details });
            console.log(`❌ ${testName}`);
            console.log(`   Error: ${err.message}`);
            if (err.details) console.log(`   Details:`, JSON.stringify(err.details, null, 2));
        }
    }

    function printSummary() {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('\n' + '='.repeat(60));
        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;
        console.log(`\n📊 ${name}: ${passed} passed, ${failed} failed (${elapsed}s)\n`);

        if (failed > 0) {
            console.log('Failed tests:');
            results.filter(r => !r.passed).forEach(r => {
                console.log(`  ❌ ${r.name}: ${r.error}`);
            });
        } else {
            console.log('🎉 All tests passed!\n');
        }

        return { passed, failed, results };
    }

    return { test, results, printSummary };
}

// ============ Assertions ============

export function assert(condition, message, details) {
    if (!condition) {
        const err = new Error(message);
        err.details = details;
        throw err;
    }
}

export function assertEqual(actual, expected, message) {
    assert(actual === expected, `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function assertInRange(value, min, max, message) {
    assert(value >= min && value <= max, `${message} — expected ${value} to be between ${min} and ${max}`);
}

// ============ Trail Factory ============

const DEFAULT_START = { lat: 50.702208, lng: -1.938634 };

/**
 * Create a test trail with predictable settings.
 * Returns { ok, trail: { id, pins, ... } }
 */
export async function createTestTrail(options = {}) {
    const testRun = Date.now();
    const body = {
        creator_id: options.creator_id || `test-creator-${testRun}-${Math.random().toString(36).slice(2, 6)}`,
        theme: options.theme || 'easter',
        name: options.name || `Test Trail ${testRun}`,
        start_location: options.start_location || DEFAULT_START,
        mode: options.mode || 'random',
        competitive: options.competitive ?? false,
        has_questions: options.has_questions ?? false,
        ...(options.mode === 'custom' && options.pins
            ? { pins: options.pins }
            : { count: options.count || 5, spawn_radius: options.spawn_radius || 200 }
        ),
    };

    const result = await api('custom-trail/create', body);
    assert(result.ok === true, 'Failed to create test trail', result);
    return result;
}

/**
 * Create a trail with custom pin positions (no randomness).
 * Pins are placed at known offsets from the start location.
 */
export function generatePinGrid(center, count, spacingMeters = 60) {
    const pins = [];
    const delta = metersToLatDelta(spacingMeters);
    const cols = Math.ceil(Math.sqrt(count));

    for (let i = 0; i < count; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;
        pins.push({
            lat: center.lat + (row * delta),
            lng: center.lng + (col * delta / Math.cos(center.lat * Math.PI / 180)),
        });
    }
    return pins;
}

// ============ GPS Utilities ============

/** Approximate meters per degree of latitude */
const METERS_PER_LAT_DEG = 111_320;

/** Convert meters to approximate latitude delta */
export function metersToLatDelta(meters) {
    return meters / METERS_PER_LAT_DEG;
}

/** Convert meters to approximate longitude delta at a given latitude */
export function metersToLngDelta(meters, atLat) {
    return meters / (METERS_PER_LAT_DEG * Math.cos(atLat * Math.PI / 180));
}

/**
 * Offset a coordinate by a given number of meters north and east.
 * Positive = north/east, negative = south/west.
 */
export function offsetCoords(lat, lng, northMeters, eastMeters = 0) {
    return {
        lat: lat + metersToLatDelta(northMeters),
        lng: lng + metersToLngDelta(eastMeters, lat),
    };
}

/**
 * Haversine distance between two points in meters.
 */
export function distanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============ Game Helpers ============

/**
 * Start a play session for a player on a trail.
 */
export async function startGame(trailId, userId, location) {
    const loc = location || DEFAULT_START;
    return api('play', {
        game_ref: `custom-trail-${trailId}`,
        user_id: userId,
        lat: loc.lat,
        lng: loc.lng
    });
}

/**
 * Send an AWTY (Are We There Yet) check.
 */
export async function awty(trailId, userId, lat, lng) {
    return api('awty', {
        game_ref: `custom-trail-${trailId}`,
        user_id: userId,
        lat,
        lng
    });
}

/**
 * Collect a pin via /next endpoint (for pins with questions).
 */
export async function collectPin(trailId, userId, pinIndex, answer) {
    return api('next', {
        game_ref: `custom-trail-${trailId}`,
        user_id: userId,
        action: 'collect',
        pin_index: pinIndex,
        ...(answer !== undefined && { answer }),
    });
}

/** Helper to log indented */
export function log(msg) {
    console.log(`   ${msg}`);
}

/** Sleep for ms */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
