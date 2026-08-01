/**
 * Prefill Control — parity gate.
 *
 * `st_sim.mjs` is a port of SillyTavern's server-side prompt pipeline, and every
 * guard in `engine.js` is a prediction about the code it ports. A wrong port
 * reports success while the prefill is merged away, so "faithful port" cannot be
 * an assertion in a comment — it has to be measured.
 *
 * This runs two checks against a real SillyTavern checkout:
 *
 *   1. Parity. `st_sim.mjs` and `src/prompt-converters.js` are run side by side
 *      over randomised inputs across every post-processing type, asserting
 *      byte-identical output.
 *   2. End to end. `engine.js` output is run through the real server code with
 *      the `/generate` route ordering reproduced, asserting that a reported flag
 *      and a reported reasoning seed actually arrive, and that a skip mutates
 *      nothing at all.
 *
 * Needs a checkout, so it is not part of `npm run gate`:
 *
 *   git clone --depth 1 -b staging https://github.com/SillyTavern/SillyTavern.git /tmp/st
 *   cd /tmp/st && npm install yaml --no-save
 *   ST=/tmp/st node parity_test.mjs
 *
 * Without ST set it skips and says so, rather than passing silently.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import {
    applyPrefill,
    DEFAULT_CONFIG,
} from './engine.js';
import * as sim from './st_sim.mjs';

const ST = process.env.ST ? resolve(process.env.ST) : null;

if (!ST) {
    console.log('SKIP — parity gate needs a SillyTavern checkout. See the header of this file.');
    process.exit(0);
}
for (const required of ['src/util.js', 'src/prompt-converters.js', 'default/config.yaml']) {
    if (!existsSync(`${ST}/${required}`)) {
        console.error(`FAIL — ${ST} does not look like a SillyTavern checkout (missing ${required}).`);
        process.exit(1);
    }
}

const { setConfigFilePath } = await import(`${ST}/src/util.js`);
setConfigFilePath(`${ST}/default/config.yaml`);
const real = await import(`${ST}/src/prompt-converters.js`);

// ---------------------------------------------------------------- randomness

let seed = Number(process.env.SEED || 20260801);
const startSeed = seed;
function rnd() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
}
const pick = (list) => list[Math.floor(rnd() * list.length) % list.length];
const chance = (p) => rnd() < p;

const failures = [];
function fail(message) {
    if (failures.length < 6) {
        failures.push(message);
    }
}

/**
 * Masks the media placeholder tokens so two runs are comparable.
 *
 * The server uses crypto.randomBytes(32).toString('base64'); the port uses its
 * own token because it also runs in the browser. Both rebuild media into content
 * objects before returning, so a surviving token is a real difference — this
 * masks the token text, it does not hide a token that should not be there.
 *
 * @param {*} value Any value
 * @returns {string|undefined} Comparable text
 */
function mask(value) {
    const text = JSON.stringify(value);
    if (text === undefined) {
        return text;
    }
    return text
        .replace(/\\u0000pfc-media-\d+-[a-z0-9]+\\u0000/g, '<<TOKEN>>')
        .replace(/[A-Za-z0-9+/]{43}=/g, '<<TOKEN>>');
}

// ---------------------------------------------------------------- 1. parity

const ROLES = ['system', 'user', 'assistant', 'tool'];
const BODIES = ['', 'Hello.', 'He stepped through.', 'line one\n\nline two', '   ', 'Nyx: already prefixed'];
const NAMES = [undefined, 'Nyx', 'LO', 'example_assistant', 'example_user'];
const ALL_TYPES = ['', 'claude', 'merge', 'merge_tools', 'semi', 'semi_tools', 'strict', 'strict_tools', 'single', 'not_a_type'];

function randomMessage() {
    const message = { role: pick(ROLES) };
    if (chance(0.12)) {
        const parts = [];
        const count = 1 + Math.floor(rnd() * 3);
        for (let i = 0; i < count; i++) {
            parts.push(chance(0.5)
                ? { type: 'text', text: pick(BODIES) }
                : { type: pick(['image_url', 'video_url', 'audio_url']), url: `data:x;base64,AAA${i}` });
        }
        message.content = parts;
    } else if (chance(0.08)) {
        message.content = pick([undefined, null, '']);
    } else {
        message.content = pick(BODIES);
    }
    const name = pick(NAMES);
    if (name !== undefined) {
        message.name = name;
    }
    if (chance(0.1)) {
        message.tool_calls = [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }];
    }
    if (message.role === 'tool' && chance(0.8)) {
        message.tool_call_id = 'call_1';
    }
    // The fields this extension writes have to survive the round trip too.
    if (chance(0.25)) message.partial = true;
    if (chance(0.25)) message.reasoning_content = 'seeded thought';
    if (chance(0.1)) message.prefix = true;
    return message;
}

const PARITY_RUNS = Number(process.env.PARITY_RUNS || 40000);
const typesSeen = new Set();

for (let i = 0; i < PARITY_RUNS && failures.length === 0; i++) {
    const body = {
        messages: Array.from({ length: Math.floor(rnd() * 7) }, randomMessage),
        char_name: chance(0.6) ? pick(['Nyx', 'Argent', '']) : '',
        user_name: chance(0.6) ? pick(['LO', 'Jovan', '']) : '',
        group_names: chance(0.2) ? ['Nyx', 'Argent'] : [],
    };
    const type = pick(ALL_TYPES);
    typesSeen.add(type);

    const realBody = structuredClone(body);
    const simBody = structuredClone(body);

    let realOut, simOut;
    try {
        realOut = real.postProcessPrompt(realBody.messages, type, real.getPromptNames({ body: realBody }));
    } catch (error) {
        fail(`run ${i}: real postProcessPrompt threw where the port did not: ${error.message}`);
        break;
    }
    try {
        simOut = sim.postProcessPrompt(simBody.messages, type, sim.getPromptNames(simBody));
    } catch (error) {
        fail(`run ${i}: the port threw where the server did not: ${error.message}`);
        break;
    }

    if (mask(realOut) !== mask(simOut)) {
        fail(`run ${i}: post-processing differs (${type || 'none'})\n    server: ${mask(realOut)}\n    port:   ${mask(simOut)}\n    input:  ${JSON.stringify(body.messages)}`);
        break;
    }

    for (const property of ['partial', 'prefix']) {
        const a = structuredClone(realOut);
        const b = structuredClone(simOut);
        real.addAssistantPrefix(a, [], property);
        sim.addAssistantPrefix(b, [], property);
        if (mask(a) !== mask(b)) {
            fail(`run ${i}: addAssistantPrefix("${property}") differs\n    server: ${mask(a)}\n    port:   ${mask(b)}`);
            break;
        }
    }
}

// ---------------------------------------------------------------- 2. end to end

/**
 * The `/generate` route ordering, read from
 * src/endpoints/backends/chat-completions.js. The user's post-processing choice
 * is applied first for every source, then the per-source handler may apply its
 * own regardless of that choice.
 *
 * @param {object} generateData The object the hook was handed
 * @returns {object[]} Messages as the provider receives them
 */
function serverRoute(generateData) {
    const body = JSON.parse(JSON.stringify(generateData));
    const names = real.getPromptNames({ body });
    const { PROMPT_PROCESSING_TYPE: T } = real;

    if (Array.isArray(body.messages) && body.custom_prompt_post_processing) {
        body.messages = real.postProcessPrompt(body.messages, body.custom_prompt_post_processing, names);
    }
    switch (String(body.chat_completion_source || 'custom')) {
        case 'deepseek':
            body.messages = real.postProcessPrompt(body.messages, T.SEMI_TOOLS, names);
            real.addAssistantPrefix(body.messages, body.tools ?? [], 'prefix');
            break;
        case 'minimax':
            body.messages = real.postProcessPrompt(body.messages, T.MERGE_TOOLS, names);
            break;
        case 'perplexity':
            body.messages = real.postProcessPrompt(body.messages, T.STRICT, names);
            break;
        case 'moonshot':
            if (!body.json_schema) {
                real.addAssistantPrefix(body.messages, [], 'partial');
            }
            break;
        default:
            break;
    }
    return body.messages;
}

const SOURCES = ['custom', 'openrouter', 'moonshot', 'deepseek', 'minimax', 'perplexity', 'zai', 'openai'];
const SEEDS = [
    '<think>I should continue the story.',
    '<think>Check the injected context first.</think>He stepped through.',
    'Plain content prefill.',
    '<think></think>',
    '   <think>  spaced  </think>  tail  ',
];

/**
 * Prompt shapes, constructed rather than sampled.
 *
 * Random generation concentrates on the common case. An earlier version of this
 * file drew message content from a list of strings and so reached a multimodal
 * message zero times in 60000 runs — which meant the one merge risk that
 * survives the guard was never exercised, and a mutation reintroducing the
 * original bug passed. Each shape below exists because a guard is about it.
 */
const SHAPES = [
    'random',                  // ordinary traffic
    'assistant_run',           // two assistant turns: the classic merge risk
    'assistant_run_long',      // four: the premerge has to loop, not fold once
    'multimodal_predecessor',  // the guard cannot fold this; the server merges anyway
    'multimodal_tail',         // refused outright while the guard is on
    'named_tail',              // the name fold makes an emptied tail mergeable again
    'user_tail',               // nothing to merge into; exercises the append path
];

/**
 * @param {string} shape One of SHAPES
 * @returns {object[]} A prompt of that shape
 */
function buildMessages(shape) {
    const messages = [{ role: 'system', content: 'You are narrating.' }];
    for (let j = 0, n = Math.floor(rnd() * 3); j < n; j++) {
        const message = { role: pick(['user', 'assistant']), content: pick(['Go on.', 'He waited.', 'line\n\nline']) };
        if (chance(0.3)) message.name = pick(['Nyx', 'LO']);
        messages.push(message);
    }
    const media = () => [
        { type: 'text', text: 'He waited.' },
        { type: pick(['image_url', 'video_url', 'audio_url']), url: 'data:x;base64,AAA' },
    ];

    switch (shape) {
        case 'assistant_run':
            messages.push({ role: 'assistant', content: 'He waited by the gate.' });
            messages.push({ role: 'assistant', content: pick(SEEDS) });
            break;
        case 'assistant_run_long':
            messages.push({ role: 'assistant', content: 'First.' });
            messages.push({ role: 'assistant', content: 'Second.' });
            messages.push({ role: 'assistant', content: 'Third.' });
            messages.push({ role: 'assistant', content: pick(SEEDS) });
            break;
        case 'multimodal_predecessor':
            messages.push({ role: 'assistant', content: media() });
            messages.push({ role: 'assistant', content: pick(SEEDS) });
            break;
        case 'multimodal_tail':
            messages.push({ role: 'assistant', content: 'He waited by the gate.' });
            messages.push({ role: 'assistant', content: media() });
            break;
        case 'named_tail':
            messages.push({ role: 'assistant', content: 'He waited by the gate.', name: 'Nyx' });
            messages.push({ role: 'assistant', content: pick(SEEDS), name: 'Nyx' });
            break;
        case 'user_tail':
            messages.push({ role: 'user', content: 'Continue.' });
            break;
        default:
            if (chance(0.45)) {
                const tail = { role: 'assistant', content: pick(SEEDS) };
                if (chance(0.3)) tail.name = 'Nyx';
                messages.push(tail);
            } else if (chance(0.5)) {
                messages.push({ role: 'user', content: 'Continue.' });
            }
            break;
    }
    return messages;
}

let riskCalls = 0;
let riskUnnecessary = 0;
const shapesSeen = new Set();
const WIRE_RUNS = Number(process.env.WIRE_RUNS || 60000);

for (let i = 0; i < WIRE_RUNS && failures.length === 0; i++) {
    const shape = pick(SHAPES);
    shapesSeen.add(shape);

    const data = {
        type: pick(['normal', 'swipe', 'regenerate', 'continue', 'impersonate', 'quiet']),
        messages: buildMessages(shape),
        chat_completion_source: pick(SOURCES),
        custom_prompt_post_processing: pick(['', 'merge', 'merge_tools', 'semi', 'semi_tools', 'strict', 'strict_tools', 'single', 'claude']),
        include_reasoning: chance(0.5),
        char_name: chance(0.5) ? 'Nyx' : '',
        user_name: chance(0.5) ? 'LO' : '',
        group_names: [],
    };
    if (chance(0.06)) data.json_schema = { name: 's', value: {} };
    if (chance(0.06)) data.tools = [{ type: 'function', function: { name: 'f' } }];

    // The tag pair usually matches the seed text, so the split actually happens.
    // Drawing tags independently makes most runs a no-op split, which hides
    // everything downstream of it.
    const matched = chance(0.8);
    const cfg = {
        ...DEFAULT_CONFIG,
        enabled: true,
        source: pick(['extension', 'preset']),
        text: pick(SEEDS),
        // An empty flag is the default on OpenRouter's generic mapping and on
        // custom endpoints, so it is drawn twice as often as any single name.
        flagField: pick(['partial', 'prefix', '', '', 'continue_flag']),
        reasoningField: pick(['reasoning_content', 'reasoning', '', 'thought']),
        thinkingEnabled: chance(0.9),
        openTag: matched ? '<think>' : pick(['<thinking>', '']),
        closeTag: matched ? '</think>' : pick(['</thinking>', '']),
        ensureThinking: chance(0.8),
        applyToContinue: chance(0.7),
        applyToImpersonate: chance(0.3),
        applyToQuiet: chance(0.2),
        skipOnTools: chance(0.8),
        skipOnJsonSchema: chance(0.8),
        mergeGuard: chance(0.5),
    };

    const before = JSON.stringify(data);
    let report;
    try {
        report = applyPrefill(data, cfg);
    } catch (error) {
        fail(`run ${i}: engine threw: ${error.message}\n    data=${before}\n    cfg=${JSON.stringify(cfg)}`);
        break;
    }

    // A skip mutates nothing at all.
    if (!report.applied) {
        if (JSON.stringify(data) !== before) {
            fail(`run ${i}: skip (${report.reason}) mutated the request\n    before=${before}\n    after =${JSON.stringify(data)}`);
        }
        continue;
    }

    const wire = serverRoute(data);
    if (!Array.isArray(wire) || wire.length === 0) {
        fail(`run ${i}: the server produced an empty prompt\n    before=${before}`);
        continue;
    }

    const flagArrived = !report.detail.flagField
        || wire.some(m => m?.[report.detail.flagField] === true);
    const seedArrived = !report.detail.reasoningField
        || wire.some(m => typeof m?.[report.detail.reasoningField] === 'string' && m[report.detail.reasoningField].length > 0);

    if (report.detail.mergeRisk) {
        // A predicted loss is allowed to be lost. Count the cases where the
        // conservative call turned out to be unnecessary, so the cost of being
        // conservative stays visible instead of drifting.
        riskCalls++;
        if (flagArrived && seedArrived) {
            riskUnnecessary++;
        }
        continue;
    }

    if (!flagArrived) {
        fail(`run ${i}: flag "${report.detail.flagField}" did not arrive and was not predicted lost\n    detail=${JSON.stringify(report.detail)}\n    before=${before}\n    cfg=${JSON.stringify(cfg)}\n    wire=${JSON.stringify(wire)}`);
    }
    if (!seedArrived) {
        fail(`run ${i}: reasoning field "${report.detail.reasoningField}" did not arrive and was not predicted lost\n    detail=${JSON.stringify(report.detail)}\n    before=${before}\n    cfg=${JSON.stringify(cfg)}\n    wire=${JSON.stringify(wire)}`);
    }
}

// ---------------------------------------------------------------- result

if (failures.length) {
    console.error(`\nFAIL — parity gate found ${failures.length} problem(s) (seed ${startSeed}):\n`);
    for (const f of failures) {
        console.error(`  ✗ ${f}\n`);
    }
    process.exit(1);
}

// Coverage is reported, not assumed. A generator that stops reaching a shape is
// a gate that quietly stops testing it, which is how the guard-on merge risk
// went unexercised in the first version of this file.
if (shapesSeen.size !== SHAPES.length) {
    console.error(`FAIL — only ${shapesSeen.size} of ${SHAPES.length} prompt shapes were generated.`);
    process.exit(1);
}
if (riskCalls === 0) {
    console.error('FAIL — no run reached the merge-risk path, so nothing about it was tested.');
    process.exit(1);
}

console.log(`PASS — ${PARITY_RUNS} parity runs over ${typesSeen.size} post-processing types, `
    + `${WIRE_RUNS} end-to-end runs through the real server across ${shapesSeen.size} prompt shapes (seed ${startSeed})`);
console.log(`       merge risk called ${riskCalls} times, ${riskUnnecessary} of those survived anyway`);
