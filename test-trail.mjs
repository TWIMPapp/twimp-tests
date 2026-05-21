/**
 * Generic trail walker — walks any TWIMP Trail end-to-end via the live API.
 *
 * Usage:
 *   node test-trail.mjs <trail-ref>          walk every reachable path
 *   node test-trail.mjs <trail-ref> --first  walk one path only (smoke test)
 *   node test-trail.mjs --list               list available trails
 *
 * Strategy:
 *   - Load the trail definition fresh from backend/src/data/games/<File>.ts
 *     (strip TS imports/annotation, dynamic-import as ESM). Always current.
 *   - Resolve locationIds → lat/lng from the trail's locations[] table.
 *   - Drive POST /play → POST /awty / POST /next on api.twimp.app, choosing
 *     the next action by consulting the local trail structure.
 *   - Fork at decision points (map task with >1 marker, question_single with
 *     >1 positive option) by replaying from start with a fresh user_id.
 *   - Cycle detection: per-path Set of "stepIndex:taskIndex:state" keys;
 *     hard cap on walk length and on total walks per trail.
 *
 * What this does NOT do:
 *   - Reimplement the engine. The walker reads the API's responses to know
 *     what task it's on; it only reads source for the things the API hides
 *     (question_single options) and for decision enumeration.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// -------------------------------------------------------------- Config

const API = 'https://api.twimp.app';
const GAMES_DIR = join(import.meta.dirname, '..', 'backend', 'src', 'data', 'games');
const MAX_WALKS_PER_TRAIL = 20;
const MAX_STEPS_PER_WALK = 50;
const AWTY_COOLDOWN_MS = 5100; // engine enforces 5s, add a touch of slack
const ACCURACY = 5;            // tight, so the inRange test never bites

// -------------------------------------------------------------- Trail loader

/**
 * Build a kebab-case-ref → file-path map by reading games/index.ts and
 * pairing each game file's contents to its `ref`. We read each file's first
 * ~40 lines and look for `"ref": "..."` to avoid having to maintain a
 * separate kebab→PascalCase mapping.
 */
async function discoverTrails() {
    const indexSrc = await readFile(join(GAMES_DIR, 'index.ts'), 'utf8');
    const fileNames = [...indexSrc.matchAll(/from '\.\/(\w+)'/g)].map(m => m[1] + '.ts');
    const result = new Map();
    for (const fileName of fileNames) {
        const src = await readFile(join(GAMES_DIR, fileName), 'utf8');
        const refMatch = src.match(/["']ref["']\s*:\s*["']([^"']+)["']/);
        if (refMatch) result.set(refMatch[1], join(GAMES_DIR, fileName));
    }
    return result;
}

/**
 * Strip TS imports + the `export const X: Trail = ` header so the rest
 * (an object literal with template strings) becomes a valid .mjs default
 * export. Write to a temp .mjs and dynamic-import.
 */
async function loadTrailFromTs(filePath) {
    let src = await readFile(filePath, 'utf8');
    src = src.replace(/^import\s.+?from\s.+?;\s*$/gm, '');
    src = src.replace(/export\s+const\s+\w+\s*:\s*Trail\s*=\s*/m, 'export default ');
    src = src.replace(/export\s+const\s+\w+\s*=\s*/m, 'export default ');

    const tmpDir = join(tmpdir(), 'twimp-trail-walker');
    if (!existsSync(tmpDir)) await mkdir(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `trail-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(tmpPath, src, 'utf8');
    const mod = await import(pathToFileURL(tmpPath).href);
    return mod.default;
}

/** Inline copy of backend/src/utils/resolveTrail.ts — hydrate step.location from locationId. */
function resolveTrail(trail) {
    const locById = new Map((trail.locations || []).map(l => [l.id, l]));
    return {
        ...trail,
        steps: trail.steps.map(step => {
            let location;
            if (step.locationId && locById.has(step.locationId)) {
                const l = locById.get(step.locationId);
                location = { lat: l.lat, lng: l.lng };
            } else if (step.location?.coordinates) {
                location = { lat: step.location.coordinates[0], lng: step.location.coordinates[1] };
            } else if (step.location?.lat) {
                location = { lat: step.location.lat, lng: step.location.lng };
            }
            return { ...step, location };
        }),
    };
}

// -------------------------------------------------------------- API helpers

async function api(path, body) {
    const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json.body ?? json };
}

function newUserId() {
    return `trail-walker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// -------------------------------------------------------------- Walker

/**
 * The walker drives one path through a trail. `decisions` is an array of
 * objects describing the choice taken at each decision point encountered
 * so far, in order. If decisions runs out before the walk ends, the walker
 * defaults to the first available option AND records the alternatives so
 * the enumerator can fork.
 */
async function walkPath(trail, decisions, log) {
    const userId = newUserId();
    const visited = new Set();
    const stepsActivated = [];
    const decisionsTaken = [];  // each: {kind, atStep, atTask, chose, alternatives}
    const events = [];          // free-form log for the report

    // Engine convention: task = stepIndex * 100 + taskIndex
    let stepIndex = -1;
    let taskIndex = 0;
    let currentTask = null;

    const startStep = trail.steps[0];
    if (!startStep?.location) {
        return { ok: false, reason: 'Trail has no startable first step', events, stepsActivated, decisionsTaken };
    }

    // Kick off with /play; first task is the default MapTask listing all visible step locations.
    const playRes = await api('/play', {
        game_ref: trail.ref, user_id: userId,
        lat: startStep.location.lat, lng: startStep.location.lng,
    });
    if (playRes.status !== 200 || !playRes.body?.ok) {
        return { ok: false, reason: `/play failed: ${JSON.stringify(playRes.body)}`, events, stepsActivated, decisionsTaken };
    }
    currentTask = playRes.body.task;
    events.push(`/play → task type=${currentTask?.type}`);

    let decisionPtr = 0;
    let stepsTaken = 0;
    let needsAwtyCooldown = false;

    while (stepsTaken++ < MAX_STEPS_PER_WALK) {
        if (!currentTask) {
            events.push('No current task — ending walk');
            break;
        }

        const cycleKey = `${stepIndex}:${taskIndex}`;
        if (visited.has(cycleKey)) {
            events.push(`Cycle detected at ${cycleKey} — aborting branch`);
            return { ok: false, reason: 'cycle', events, stepsActivated, decisionsTaken };
        }
        visited.add(cycleKey);

        const t = currentTask;

        if (t.type === 'finish') {
            events.push(`Finished at step ${stepIndex} (${trail.steps[stepIndex]?.name})`);
            return { ok: true, reason: 'finish', events, stepsActivated, decisionsTaken };
        }

        if (t.type === 'information') {
            const r = await api('/next', { game_ref: trail.ref, user_id: userId });
            if (!r.body?.ok) {
                return { ok: false, reason: `/next failed on information: ${JSON.stringify(r.body)}`, events, stepsActivated, decisionsTaken };
            }
            taskIndex += 1;
            currentTask = r.body.task ?? null;
            events.push(`/next (info) → task type=${currentTask?.type ?? 'null'}`);
            continue;
        }

        if (t.type === 'question_single' || t.type === 'question_multiple') {
            // API stripped options; consult source.
            const srcStep = trail.steps[stepIndex];
            const srcTask = srcStep?.tasks?.[taskIndex];
            const options = srcTask?.options ?? [];
            const positive = options.filter(o => o.response?.sentiment === 'positive');
            if (positive.length === 0) {
                return { ok: false, reason: `Question has no positive option (step ${stepIndex} task ${taskIndex})`, events, stepsActivated, decisionsTaken };
            }

            const dec = decisions[decisionPtr++];
            const choice = (dec && dec.kind === 'question' && positive.find(o => o.content === dec.chose)) || positive[0];
            const alternatives = positive.length > 1 ? positive.map(o => o.content).filter(c => c !== choice.content) : [];
            decisionsTaken.push({
                kind: 'question', atStep: stepIndex, atTask: taskIndex,
                chose: choice.content, alternatives,
                stepName: srcStep.name,
            });

            const r = await api('/next', { game_ref: trail.ref, user_id: userId, answer: choice.content });
            if (!r.body?.ok) {
                return { ok: false, reason: `/next failed on question: ${JSON.stringify(r.body)}`, events, stepsActivated, decisionsTaken };
            }
            taskIndex += 1;
            currentTask = r.body.task ?? null;
            events.push(`/next (q) answer="${choice.content}" → task type=${currentTask?.type ?? 'null'}`);
            continue;
        }

        if (t.type === 'map') {
            // The synthesised "where do you want to start" map (play.ts emits this when
            // task=-1) lists every visible step location — we always start at step 0
            // and ignore the others. Forking here would test the trail from arbitrary
            // mid-points, which is not what a real player does.
            const isStartMap = t.id === -1;

            // markers is either an array of locationId strings or already-resolved {lat,lng} objects.
            const rawMarkers = t.markers || [];
            const resolved = rawMarkers.map(m => {
                if (typeof m === 'string') {
                    const loc = trail.locations?.find(l => l.id === m);
                    return loc ? { id: m, name: loc.name, lat: loc.lat, lng: loc.lng } : null;
                }
                // Default-map markers have no id — synthesise one from coords for dedup.
                return { lat: m.lat, lng: m.lng, name: m.title, id: m.id ?? `${m.lat},${m.lng}` };
            }).filter(Boolean);

            if (resolved.length === 0) {
                return { ok: false, reason: 'Map task has no resolvable markers', events, stepsActivated, decisionsTaken };
            }

            let choice, alternatives;
            if (isStartMap) {
                // Always start at the first defined step's location.
                const startLoc = trail.steps[0].location;
                choice = resolved.find(m => m.lat === startLoc.lat && m.lng === startLoc.lng) || resolved[0];
                alternatives = [];
            } else {
                const dec = decisions[decisionPtr++];
                choice = (dec && dec.kind === 'map' && resolved.find(m => m.id === dec.chose)) || resolved[0];
                alternatives = resolved.length > 1 ? resolved.filter(m => m.id !== choice.id).map(m => m.id) : [];
            }
            // Don't record the start-map in decisionsTaken — it's not a real choice and
            // including it would throw off decisionPtr on replay.
            if (!isStartMap) {
                decisionsTaken.push({
                    kind: 'map', atStep: stepIndex, atTask: taskIndex,
                    chose: choice.id, alternatives,
                    choseName: choice.name,
                });
            }

            if (needsAwtyCooldown) await sleep(AWTY_COOLDOWN_MS);
            const awty = await api('/awty', {
                game_ref: trail.ref, user_id: userId,
                lat: choice.lat, lng: choice.lng, accuracy: ACCURACY,
            });
            needsAwtyCooldown = true;

            if (!awty.body?.task) {
                // /awty came back without activating a step — almost certainly a state gate
                // blocking us. The walker treats this as "branch ends here", not a hard failure.
                events.push(`/awty to ${choice.name} did not activate any step. Message: ${awty.body?.message || 'none'}`);
                return {
                    ok: false, reason: 'no-activation',
                    deadEndAt: { stepIndex, taskIndex, markerName: choice.name, markerId: choice.id },
                    events, stepsActivated, decisionsTaken,
                };
            }

            // Identify activated step by matching task.id back to source. Each step's
            // tasks[0].id is unique across the trail (engine convention: stepIndex * 100 +
            // taskIndex, so id=300 → step 3 task 0). Robust regardless of state gates.
            const taskId = String(awty.body.task.id);
            const activatedStepIndex = trail.steps.findIndex(s => String(s.tasks?.[0]?.id) === taskId);
            stepIndex = activatedStepIndex >= 0 ? activatedStepIndex : stepIndex;
            taskIndex = 0;
            currentTask = awty.body.task;
            stepsActivated.push({ index: stepIndex, name: trail.steps[stepIndex]?.name });
            events.push(`/awty activated step ${stepIndex} (${trail.steps[stepIndex]?.name}) → task type=${currentTask?.type}`);
            continue;
        }

        events.push(`Unknown task type "${t.type}" — ending walk`);
        return { ok: false, reason: `unknown task type: ${t.type}`, events, stepsActivated, decisionsTaken };
    }

    return { ok: false, reason: 'max-steps', events, stepsActivated, decisionsTaken };
}

// -------------------------------------------------------------- Enumerator

/**
 * Walk one path, then for every decision point that had alternatives, queue
 * a fresh walk that takes the next alternative at that point. Iterates until
 * the queue is empty or MAX_WALKS_PER_TRAIL is hit.
 *
 * A "decisions" array uniquely identifies a path; we dedupe queued walks by
 * serialising it.
 */
async function enumerateAllPaths(trail) {
    // Dedup by the full sequence of (atStep:atTask:chose) decisions, not by
    // individual (point,choice) pairs. The same (step, task, choice) can mean
    // different things depending on prior decisions (e.g. a marker whose target
    // step's gating depends on session state, which itself was set by an earlier
    // step's on_arrival). Two walks differ only if their decision *sequences*
    // differ — that's what we dedup on.
    const queuedPrefixSigs = new Set([JSON.stringify([])]);  // empty prefix is the seed
    const seenWalkSigs = new Set();
    const queue = [[]];
    const results = [];

    const sigOf = (decisions) =>
        decisions.map(d => `${d.atStep ?? ''}:${d.atTask ?? ''}:${d.chose}`).join('|');

    while (queue.length && results.length < MAX_WALKS_PER_TRAIL) {
        const prefix = queue.shift();

        process.stdout.write(`  walking path #${results.length + 1} (${prefix.length} prior decisions)... `);
        const t0 = Date.now();
        const result = await walkPath(trail, prefix, () => {});
        const ms = Date.now() - t0;

        const walkSig = sigOf(result.decisionsTaken);
        if (seenWalkSigs.has(walkSig)) {
            console.log('SKIP (equivalent to earlier walk)');
            continue;
        }
        seenWalkSigs.add(walkSig);

        results.push({ ...result, prefix, ms });
        console.log(`${result.ok ? 'OK' : `STOP (${result.reason})`} — ${result.stepsActivated.length} steps in ${(ms / 1000).toFixed(1)}s`);

        // Fork at every decision point with alternatives. Dedup keyed on the
        // entire prefix the fork would replay, so reaching the same fork via a
        // different earlier choice queues a separate walk.
        for (let i = 0; i < result.decisionsTaken.length; i++) {
            const d = result.decisionsTaken[i];
            for (const alt of d.alternatives) {
                const forkDecisions = [...result.decisionsTaken.slice(0, i), { ...d, chose: alt }];
                const forkSig = sigOf(forkDecisions);
                if (queuedPrefixSigs.has(forkSig)) continue;
                queuedPrefixSigs.add(forkSig);
                const newPrefix = forkDecisions.map(x => ({ kind: x.kind, chose: x.chose }));
                queue.push(newPrefix);
            }
        }
    }

    if (queue.length) console.log(`  ⚠️  queue still has ${queue.length} paths — MAX_WALKS_PER_TRAIL (${MAX_WALKS_PER_TRAIL}) reached`);
    return results;
}

// -------------------------------------------------------------- Reporter

function printReport(trail, results) {
    console.log('\n' + '='.repeat(70));
    console.log(`Trail: ${trail.name} (${trail.ref})`);
    console.log(`Steps in definition: ${trail.steps.length}`);
    console.log(`Walks attempted: ${results.length}`);
    const finished = results.filter(r => r.ok).length;
    const deadEnded = results.filter(r => r.reason === 'no-activation').length;
    const errored = results.filter(r => !r.ok && r.reason !== 'no-activation' && r.reason !== 'cycle').length;
    console.log(`Walks completed: ${finished}`);
    console.log(`Walks dead-ended (state gate, etc): ${deadEnded}`);
    console.log(`Walks errored: ${errored}`);

    // Step coverage
    const reached = new Set();
    for (const r of results) for (const s of r.stepsActivated) reached.add(s.index);
    console.log('');
    console.log('Step coverage:');
    trail.steps.forEach((step, i) => {
        const mark = reached.has(i) ? '✅' : (step.state ? `❌ (state-gated: "${step.state}")` : '❌');
        console.log(`  ${i.toString().padStart(2, ' ')}  ${mark}  ${step.name}`);
    });

    // Dead ends
    const deadEnds = results.filter(r => r.deadEndAt).map(r => r.deadEndAt);
    if (deadEnds.length) {
        console.log('');
        console.log('Dead ends (markers we walked to that did not activate any step):');
        for (const d of deadEnds) {
            console.log(`  - From step ${d.stepIndex} (${trail.steps[d.stepIndex]?.name}) to marker "${d.markerName}" (${d.markerId})`);
        }
    }

    // Per-walk summary
    console.log('');
    console.log('Walks:');
    results.forEach((r, i) => {
        const tag = r.ok ? '✅' : (r.reason === 'no-activation' ? '🚧' : '❌');
        const path = r.stepsActivated.map(s => s.name).join(' → ');
        console.log(`  ${tag} #${i + 1} [${(r.ms / 1000).toFixed(1)}s] ${path || '(no progress)'}`);
        if (!r.ok && r.reason !== 'no-activation') console.log(`       reason: ${r.reason}`);
    });
    console.log('='.repeat(70));
}

// -------------------------------------------------------------- CLI

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log('Usage: node test-trail.mjs <trail-ref> [--first] | --list');
        process.exit(0);
    }

    const trails = await discoverTrails();

    if (args.includes('--list')) {
        console.log('Available trails:');
        for (const ref of trails.keys()) console.log(`  ${ref}`);
        process.exit(0);
    }

    const ref = args[0];
    const firstOnly = args.includes('--first');

    const filePath = trails.get(ref);
    if (!filePath) {
        console.error(`Unknown trail ref "${ref}". Use --list to see options.`);
        process.exit(1);
    }

    const raw = await loadTrailFromTs(filePath);
    const trail = resolveTrail(raw);
    console.log(`Loaded ${trail.name} (${trail.ref}) — ${trail.steps.length} steps, ${trail.locations?.length ?? 0} locations`);

    let results;
    if (firstOnly) {
        const t0 = Date.now();
        const r = await walkPath(trail, [], () => {});
        results = [{ ...r, prefix: [], ms: Date.now() - t0 }];
    } else {
        results = await enumerateAllPaths(trail);
    }

    printReport(trail, results);

    const anyFatal = results.some(r => !r.ok && r.reason !== 'no-activation' && r.reason !== 'cycle');
    process.exit(anyFatal ? 1 : 0);
}

main().catch(err => {
    console.error('Walker crashed:', err);
    process.exit(2);
});
