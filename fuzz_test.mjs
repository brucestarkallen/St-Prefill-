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
 *   6. A skip leaves the request byte-identical.
 *   7. "Applied" always means at least one field was written.
 *   8. `include_reasoning` is only ever turned on, and only alongside a seed.
 *   9. Whatever the engine claims reached the tail is still there after the
 *      server has post-processed the request.
 *
 * The generator is seeded, so a failure here reproduces exactly.
 *   node fuzz_test.mjs
 */

import { applyPrefill, DEFAULT_CONFIG, RESERVED_FIELDS } from './engine.js';
import { deliver, SOURCE_BEHAVIOUR } from './st_sim.mjs';

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
const SOURCES = Object.keys(SOURCE_BEHAVIOUR);
const NAMES = [undefined, undefined, undefined, 'Seraphina'];

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
        const message = { role: pick(ROLES), content: pick(CONTENTS) };
        const name = pick(NAMES);
        if (name) message.name = name;
        messages.push(message);
    }

    const data = {
        type: pick(TYPES),
        messages,
        custom_prompt_post_processing: pick(POST),
        chat_completion_source: pick(SOURCES),
        char_name: 'Seraphina',
        include_reasoning: rand() < 0.5,
    };
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
    const beforeSnapshot = JSON.stringify(data);
    const beforeReasoning = data.include_reasoning;

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

    if (!report.applied && JSON.stringify(data) !== beforeSnapshot) {
        fail(`run ${i}: skipped with "${report.reason}" but the request changed`);
    }

    if (report.applied
        && !report.detail.flagField && !report.detail.reasoningField && !report.detail.appended) {
        fail(`run ${i}: reported applied without writing anything`);
    }

    if (data.include_reasoning !== beforeReasoning) {
        if (data.include_reasoning !== true || !report.detail.reasoningField) {
            fail(`run ${i}: include_reasoning changed to ${data.include_reasoning} without a seed`);
        }
    }

    if (report.applied && report.detail.reasoningField) {
        const seeded = data.messages[report.detail.index][report.detail.reasoningField];
        if (typeof seeded !== 'string' || !seeded.length) {
            fail(`run ${i}: reasoning field is ${JSON.stringify(seeded)}`);
        }
    }

    // Wire pass: does what the engine wrote survive the server?
    //
    // Multimodal content used to be excluded here on the grounds that the server
    // rebuilds it through random tokens. That exclusion hid a real failure: a
    // message carrying media is flattened to text and merged like any other, so
    // "the engine cannot model it" was never the same statement as "nothing was
    // lost". detail.mergeRisk now covers that case, so the exclusion is gone and
    // every applied run the engine did not flag is asserted on the wire.
    if (report.applied && !report.detail.mergeRisk) {
        let wire;
        try {
            wire = deliver(data);
        } catch (error) {
            fail(`run ${i}: server simulator threw: ${error.message}`);
            continue;
        }
        const tail = wire.messages[wire.messages.length - 1];
        if (report.detail.reasoningField && tail[report.detail.reasoningField] === undefined) {
            fail(`run ${i}: reasoning lost in post-processing (${data.custom_prompt_post_processing}/${data.chat_completion_source})`);
        }
        if (report.detail.flagField && tail[report.detail.flagField] !== true) {
            fail(`run ${i}: flag lost in post-processing (${data.custom_prompt_post_processing}/${data.chat_completion_source})`);
        }
    }
}

if (threw || violations) {
    console.error(`\nFAIL — ${threw} throws, ${violations} invariant violations across ${RUNS} runs (seed ${SEED}):\n`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
}
console.log(`PASS — ${RUNS} fuzz runs clean (seed ${SEED})`);
