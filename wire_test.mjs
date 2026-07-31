/**
 * Prefill Control — wire gate.
 *
 * Every other gate asks whether the engine did what it meant to. This one asks
 * whether the provider received it, by running the engine's output through
 * `st_sim.mjs` — a port of the SillyTavern server code that a request passes
 * through after the hook fires.
 *
 * It exists because the engine's guards are predictions about that code, and a
 * wrong prediction reports success while the flag is merged away.
 *   node wire_test.mjs
 */

import { applyPrefill, DEFAULT_CONFIG, REASON } from './engine.js';
import { deliver } from './st_sim.mjs';

let passed = 0;
const failures = [];

function check(name, condition, extra) {
    if (condition) {
        passed++;
        return;
    }
    failures.push(extra === undefined ? name : `${name} :: ${JSON.stringify(extra)}`);
}

const ON = { ...DEFAULT_CONFIG, enabled: true };

/** Strips everything the extension is allowed to add, leaving the text shape. */
function textShape(messages) {
    return messages.map(m => ({ role: m.role, content: m.content }));
}

// ---------------------------------------------------------------- the five proven defects

// A reasoning prefill must survive a source that runs its own post-processing
// even though the user selected "None".
{
    const data = {
        type: 'normal', chat_completion_source: 'deepseek', custom_prompt_post_processing: '',
        include_reasoning: true,
        messages: [
            { role: 'user', content: 'Go on.' },
            { role: 'assistant', content: 'The gate creaked.' },
            { role: 'assistant', content: '<think>Consider the guard.</think>He stepped through.' },
        ],
    };
    const report = applyPrefill(data, { ...ON, source: 'preset', flagField: 'prefix' });
    const wire = deliver(data);
    const tail = wire.messages.at(-1);
    check('deepseek: engine applied', report.applied, report);
    check('deepseek: reasoning reaches the provider', tail.reasoning_content === 'Consider the guard.', tail);
    check('deepseek: flag reaches the provider', tail.prefix === true, tail);
}

// A named message is name-folded by the server before the merge test runs, so an
// emptied tail is not empty by the time it is squashed.
{
    const data = {
        type: 'normal', chat_completion_source: 'custom', custom_prompt_post_processing: 'merge',
        char_name: 'Seraphina', include_reasoning: true,
        messages: [
            { role: 'user', content: 'Go on.' },
            { role: 'assistant', content: 'The gate creaked.', name: 'Seraphina' },
            { role: 'assistant', content: '<think>Consider the guard.', name: 'Seraphina' },
        ],
    };
    applyPrefill(data, { ...ON, source: 'preset' });
    const tail = deliver(data).messages.at(-1);
    check('named tail: flag reaches the provider', tail.partial === true, tail);
    check('named tail: reasoning reaches the provider', tail.reasoning_content === 'Consider the guard.', tail);
}

// Colliding field names must be refused, never written one over the other.
{
    const data = {
        type: 'normal', chat_completion_source: 'custom', include_reasoning: true,
        messages: [{ role: 'user', content: 'Go on.' }],
    };
    const report = applyPrefill(data, { ...ON, flagField: 'reasoning_content', reasoningField: 'reasoning_content' });
    check('collision: refused', report.reason === REASON.FIELD_COLLISION, report);
    check('collision: request untouched', data.messages.length === 1, data.messages);
}

// Seeding a reasoning channel the request has switched off is the failure that
// looks like success.
{
    const data = {
        type: 'normal', chat_completion_source: 'moonshot', include_reasoning: false,
        messages: [{ role: 'user', content: 'Go on.' }],
    };
    const report = applyPrefill(data, ON);
    const wire = deliver(data);
    check('thinking: channel opened when a reasoning field is written', wire.thinkingEnabled === true, wire);
    check('thinking: reported', report.detail.thinkingForced === true, report.detail);
}

// ...and must not be opened when no reasoning field is written.
{
    const data = {
        type: 'normal', chat_completion_source: 'moonshot', include_reasoning: false,
        messages: [{ role: 'user', content: 'Go on.' }, { role: 'assistant', content: 'He stepped' }],
    };
    const report = applyPrefill(data, { ...ON, source: 'preset', thinkingEnabled: false });
    check('thinking: left alone when nothing is seeded', deliver(data).thinkingEnabled === false, report.detail);
    check('thinking: no include_reasoning key invented', data.include_reasoning === false, data.include_reasoning);
}

// ---------------------------------------------------------------- matrix

const SOURCES = ['custom', 'deepseek', 'minimax', 'perplexity', 'moonshot', 'zai', 'openrouter'];
const POST = ['', 'merge', 'semi', 'strict', 'merge_tools'];
const TAILS = {
    'user tail': [{ role: 'user', content: 'Go on.' }],
    'one assistant': [{ role: 'user', content: 'Go on.' }, { role: 'assistant', content: 'He stepped' }],
    'two assistants': [
        { role: 'user', content: 'Go on.' },
        { role: 'assistant', content: 'The gate creaked.' },
        { role: 'assistant', content: 'He stepped' },
    ],
    'three assistants': [
        { role: 'user', content: 'Go on.' },
        { role: 'assistant', content: 'One.' },
        { role: 'assistant', content: 'Two.' },
        { role: 'assistant', content: 'Three.' },
    ],
};

let matrixRuns = 0;

for (const source of SOURCES) {
    for (const post of POST) {
        for (const [tailName, tail] of Object.entries(TAILS)) {
            for (const named of [false, true]) {
                for (const src of ['preset', 'extension']) {
                    matrixRuns++;
                    const build = () => ({
                        type: 'normal',
                        chat_completion_source: source,
                        custom_prompt_post_processing: post,
                        char_name: 'Seraphina',
                        include_reasoning: true,
                        messages: tail.map(m => (named && m.role === 'assistant'
                            ? { ...m, name: 'Seraphina' }
                            : { ...m })),
                    });
                    const label = `${source}/${post || 'none'}/${tailName}/${named ? 'named' : 'plain'}/${src}`;

                    const pristine = build();
                    const data = build();
                    const report = applyPrefill(data, { ...ON, source: src });
                    const wire = deliver(data);
                    const tailMsg = wire.messages.at(-1);

                    if (report.applied) {
                        if (report.detail.flagField) {
                            check(`${label}: flag on the wire`,
                                tailMsg[report.detail.flagField] === true, tailMsg);
                        }
                        if (report.detail.reasoningField) {
                            check(`${label}: reasoning on the wire`,
                                typeof tailMsg[report.detail.reasoningField] === 'string'
                                && tailMsg[report.detail.reasoningField].length > 0, tailMsg);
                        }
                        check(`${label}: tail is still an assistant turn`,
                            tailMsg.role === 'assistant', tailMsg);
                        // "Applied" has to mean something was applied.
                        check(`${label}: applied means a field was written`,
                            Boolean(report.detail.flagField || report.detail.reasoningField || report.detail.appended),
                            report.detail);
                    } else {
                        // A skip must leave the request exactly as it arrived.
                        check(`${label}: skip left the request untouched`,
                            JSON.stringify(data) === JSON.stringify(pristine),
                            { reason: report.reason });
                    }

                    // The extension must never rewrite the conversation text. Run
                    // the same request through the server with no extension and
                    // compare the text shape; only added keys are permitted.
                    if (src === 'preset') {
                        const alone = deliver(build());
                        const withExt = deliver((() => {
                            const d = build();
                            applyPrefill(d, { ...ON, source: 'preset', thinkingEnabled: false });
                            return d;
                        })());
                        check(`${label}: text shape unchanged`,
                            JSON.stringify(textShape(withExt.messages)) === JSON.stringify(textShape(alone.messages)),
                            { withExt: textShape(withExt.messages), alone: textShape(alone.messages) });
                    }
                }
            }
        }
    }
}

// A request with nothing to write must come back byte-identical, even where the
// merge guard would otherwise have had work to do.
{
    const data = {
        type: 'normal', chat_completion_source: 'custom', custom_prompt_post_processing: 'merge',
        include_reasoning: true,
        messages: [
            { role: 'user', content: 'Go on.' },
            { role: 'assistant', content: 'The gate creaked.' },
            { role: 'assistant', content: 'He stepped' },
        ],
    };
    const before = JSON.stringify(data);
    const report = applyPrefill(data, { ...ON, source: 'preset', flagField: '', thinkingEnabled: false });
    check('nothing to do: reported as a skip', report.reason === REASON.NOTHING_TO_DO, report);
    check('nothing to do: request byte-identical', JSON.stringify(data) === before, data.messages);
}

// ---------------------------------------------------------------- multimodal

{
    const data = {
        type: 'normal', chat_completion_source: 'custom', custom_prompt_post_processing: 'merge',
        include_reasoning: true,
        messages: [
            { role: 'user', content: 'Go on.' },
            { role: 'assistant', content: 'The gate creaked.' },
            { role: 'assistant', content: [{ type: 'text', text: 'Look.' }, { type: 'image_url', image_url: { url: 'data:...' } }] },
        ],
    };
    const before = JSON.stringify(data);
    const report = applyPrefill(data, { ...ON, source: 'preset' });
    check('multimodal tail behind a merging server is refused',
        report.reason === REASON.MULTIMODAL_MERGE, report);
    check('multimodal refusal leaves the request untouched', JSON.stringify(data) === before);
}

{
    // Without a merging server the same tail is fine — flag only, no split.
    const data = {
        type: 'normal', chat_completion_source: 'custom', custom_prompt_post_processing: '',
        include_reasoning: true,
        messages: [
            { role: 'user', content: 'Go on.' },
            { role: 'assistant', content: [{ type: 'text', text: 'Look.' }] },
        ],
    };
    const report = applyPrefill(data, { ...ON, source: 'preset' });
    check('multimodal tail is flagged when nothing will merge it', report.applied, report);
    check('multimodal content is left as an array',
        Array.isArray(deliver(data).messages.at(-1).content));
}

// ---------------------------------------------------------------- result

if (failures.length) {
    console.error(`\nFAIL — ${failures.length} of ${passed + failures.length} wire checks failed:\n`);
    for (const f of failures.slice(0, 25)) console.error(`  ✗ ${f}`);
    if (failures.length > 25) console.error(`  … and ${failures.length - 25} more`);
    process.exit(1);
}
console.log(`PASS — ${passed} wire checks green (${matrixRuns} matrix combinations)`);
