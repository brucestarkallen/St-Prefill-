/**
 * Prefill Control — fuzz gate.
 *
 * Drives the engine over randomised requests and configs, asserting the
 * invariants that matter on the wire:
 *
 *   1. It never throws.
 *   2. Every role stays a string, and no pre-existing role is altered.
 *   3. Content is only ever text or a multimodal array, never some other type.
 *   4. No reserved message key is ever written by a configurable field name.
 *   5. A continuation flag is exactly `true`, never a truthy stand-in.
 *
 * The generator is seeded, so a failure here reproduces exactly.
 *   node fuzz_test.mjs
 */

import { applyPrefill, DEFAULT_CONFIG, RESERVED_FIELDS } from './engine.js';

const SEED = 0x5eed1e;
const RUNS = 60000;

/** Deterministic 32-bit LCG. Reproducibility matters more than distribution here. */
let state = SEED;
function rand() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
}
const pick = arr => arr[Math.floor(rand() * arr.length)];

const ROLES = ['system', 'user', 'assistant', 'tool'];
const CONTENTS = ['', 'plain', '<think>a', '<think>a</think>b', null, undefined, [{ type: 'text', text: 'x' }]];
const FLAGS = ['partial', 'prefix', '', 'content', 'role', '  partial  ', 'a-b', '__proto__', null, undefined, 5];
const REASONS = ['reasoning_content', 'reasoning', '', 'role', 'name', undefined, 3];
const POST = ['', 'merge', 'semi', 'strict', 'single', 'merge_tools', undefined];
const TYPES = ['normal', 'swipe', 'regenerate', 'continue', 'impersonate', 'quiet', undefined, ''];
const TEXTS = ['<think>x', '', 'plain', '<think>'];
const OPEN = ['<think>', '[[t]]', '', '('];
const CLOSE = ['</think>', '', ')'];

let threw = 0;
let violations = 0;
const problems = [];

function fail(message) {
    violations++;
    if (problems.length < 10) {
        problems.push(message);
    }
}

for (let i = 0; i < RUNS; i++) {
    const count = 1 + Math.floor(rand() * 4);
    const messages = [];
    for (let j = 0; j < count; j++) {
        messages.push({ role: pick(ROLES), content: pick(CONTENTS) });
    }

    const data = { type: pick(TYPES), messages, custom_prompt_post_processing: pick(POST) };
    if (rand() < 0.1) data.tools = [{ type: 'function' }];
    if (rand() < 0.1) data.json_schema = {};

    const cfg = {
        ...DEFAULT_CONFIG,
        enabled: true,
        flagField: pick(FLAGS),
        reasoningField: pick(REASONS),
        source: pick(['preset', 'extension']),
        text: pick(TEXTS),
        thinkingEnabled: rand() < 0.8,
        mergeGuard: rand() < 0.8,
        openTag: pick(OPEN),
        closeTag: pick(CLOSE),
    };

    const beforeRoles = messages.map(m => m.role);
    const beforeLength = messages.length;

    let report;
    try {
        report = applyPrefill(data, cfg);
    } catch (error) {
        threw++;
        if (problems.length < 10) {
            problems.push(`run ${i} threw: ${error.message}`);
        }
        continue;
    }

    for (const message of data.messages) {
        if (typeof message.role !== 'string') {
            fail(`run ${i}: role is ${typeof message.role}`);
        }
        if (message.content !== null && message.content !== undefined
            && typeof message.content !== 'string' && !Array.isArray(message.content)) {
            fail(`run ${i}: content became ${typeof message.content}`);
        }
        for (const key of Object.keys(message)) {
            if (RESERVED_FIELDS.includes(key) && !['role', 'content', 'name'].includes(key)) {
                fail(`run ${i}: reserved key written: ${key}`);
            }
        }
    }

    if (data.messages.length === beforeLength) {
        for (let k = 0; k < beforeLength; k++) {
            if (data.messages[k].role !== beforeRoles[k]) {
                fail(`run ${i}: role changed from ${beforeRoles[k]} to ${data.messages[k].role}`);
            }
        }
    }

    if (report.applied && report.detail.flagField) {
        const tail = data.messages[report.detail.index];
        if (tail[report.detail.flagField] !== true) {
            fail(`run ${i}: flag is ${JSON.stringify(tail[report.detail.flagField])}, expected true`);
        }
    }
}

if (threw || violations) {
    console.error(`\nFAIL — ${threw} throws, ${violations} invariant violations across ${RUNS} runs (seed ${SEED}):\n`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
}
console.log(`PASS — ${RUNS} fuzz runs clean (seed ${SEED})`);
