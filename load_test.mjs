/**
 * Prefill Control — load gate.
 *
 * Executes index.js as a real ES module against a mocked SillyTavern context and
 * a jsdom document. Proves the module loads, mounts its UI, registers its hook,
 * and that the hook mutates a real generate_data object end to end.
 *   node load_test.mjs
 */

import { JSDOM } from 'jsdom';

let passed = 0;
const failures = [];

function check(name, condition, extra) {
    if (condition) { passed++; return; }
    failures.push(extra === undefined ? name : `${name} :: ${JSON.stringify(extra)}`);
}

function eq(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    check(name, a === e, { actual: a, expected: e });
}

// ---------------------------------------------------------------- mock host

const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div></body>', {
    url: 'http://127.0.0.1:8000/',
});

const handlers = new Map();
let saveCount = 0;

const context = {
    extensionSettings: {},
    saveSettingsDebounced: () => { saveCount++; },
    eventSource: {
        on(event, fn) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event).push(fn);
        },
    },
    eventTypes: {
        CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
    },
};

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.SillyTavern = { getContext: () => context };

const mod = await import('./index.js');

// ---------------------------------------------------------------- module surface

check('module loaded', typeof mod.applyPrefill === 'function');
eq('version exported', typeof mod.EXTENSION_VERSION, 'string');
eq('module id', mod.MODULE, 'prefillControl');

// ---------------------------------------------------------------- wiring

check('hook registered on CHAT_COMPLETION_SETTINGS_READY',
    (handlers.get('chat_completion_settings_ready') || []).length === 1);
check('exactly one event subscribed', handlers.size === 1);

// ---------------------------------------------------------------- UI mounted

const host = document.getElementById('extensions_settings');
check('UI mounted into extensions_settings', host.children.length === 1);

const REQUIRED_IDS = [
    'pfc_enabled', 'pfc_status', 'pfc_profile', 'pfc_flagField', 'pfc_reasoningField',
    'pfc_source', 'pfc_text', 'pfc_thinkingEnabled', 'pfc_openTag', 'pfc_closeTag',
    'pfc_applyToContinue', 'pfc_applyToImpersonate', 'pfc_applyToQuiet',
    'pfc_skipOnTools', 'pfc_skipOnJsonSchema', 'pfc_mergeGuard', 'pfc_logToConsole',
];
for (const id of REQUIRED_IDS) {
    check(`control present: ${id}`, document.getElementById(id) !== null);
}
check('every control id uses the pfc_ prefix',
    [...host.querySelectorAll('[id]')].every(el => el.id.startsWith('pfc_')));
check('no duplicate control ids',
    new Set([...host.querySelectorAll('[id]')].map(el => el.id)).size
    === [...host.querySelectorAll('[id]')].length);
check('every label targets an existing control',
    [...host.querySelectorAll('label[for]')].every(l => document.getElementById(l.getAttribute('for')) !== null));

// ---------------------------------------------------------------- settings defaults

const stored = context.extensionSettings.prefillControl;
check('settings namespace created', stored && typeof stored === 'object');
eq('ships disabled by default', stored.enabled, false);
eq('utility generations excluded by default', stored.applyToQuiet, false);
eq('impersonation excluded by default', stored.applyToImpersonate, false);
eq('merge guard on by default', stored.mergeGuard, true);
eq('checkbox reflects stored state', document.getElementById('pfc_enabled').checked, false);
eq('text field reflects stored state', document.getElementById('pfc_flagField').value, 'partial');

// ---------------------------------------------------------------- toggling persists

function fire(id, event) {
    const el = document.getElementById(id);
    el.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
}

document.getElementById('pfc_enabled').checked = true;
fire('pfc_enabled', 'change');
eq('toggle writes through to settings', stored.enabled, true);
check('toggle persists', saveCount > 0);

document.getElementById('pfc_profile').value = 'deepseek';
fire('pfc_profile', 'change');
eq('profile writes flag field', stored.flagField, 'prefix');
eq('profile writes reasoning field', stored.reasoningField, 'reasoning_content');
eq('profile refreshes the input', document.getElementById('pfc_flagField').value, 'prefix');

document.getElementById('pfc_flagField').value = 'partial';
fire('pfc_flagField', 'input');
eq('manual edit overrides profile', stored.flagField, 'partial');

// ---------------------------------------------------------------- end to end through the hook

const hook = handlers.get('chat_completion_settings_ready')[0];

const live = {
    type: 'normal',
    messages: [
        { role: 'system', content: 'Narrate.' },
        { role: 'user', content: 'Jovan steps into the rain.' },
        { role: 'assistant', content: '<think>I should continue the story.' },
    ],
    custom_prompt_post_processing: '',
};
hook(live);

const tail = live.messages.at(-1);
eq('hook set the continuation flag', tail.partial, true);
eq('hook moved the thought', tail.reasoning_content, 'I should continue the story.');
eq('hook emptied content', tail.content, '');
eq('wire shape is exactly what the provider expects',
    Object.keys(tail).sort(), ['content', 'partial', 'reasoning_content', 'role']);
check('status line updated', document.getElementById('pfc_status').textContent.includes('Applied'));

const quiet = {
    type: 'quiet',
    messages: [
        { role: 'system', content: 'Summarise the scene so far.' },
        { role: 'assistant', content: '<think>I should continue the story.' },
    ],
    custom_prompt_post_processing: '',
};
hook(quiet);
eq('utility generation left untouched', quiet.messages.at(-1).partial, undefined);
eq('utility generation content untouched', quiet.messages.at(-1).content, '<think>I should continue the story.');
check('status reports the skip', document.getElementById('pfc_status').textContent.includes('excluded'));

const malformed = { type: 'normal', messages: null };
let threw = false;
try { hook(malformed); } catch { threw = true; }
check('malformed request does not throw', threw === false);

// A frozen tail makes the engine throw for real. The hook must swallow it so a
// bug here degrades to "no prefill" rather than killing the generation.
const frozenTail = Object.freeze({ role: 'assistant', content: '<think>x' });
const hostile = { type: 'normal', messages: [{ role: 'user', content: 'go' }, frozenTail], custom_prompt_post_processing: '' };
let escaped = false;
try { hook(hostile); } catch { escaped = true; }
check('engine exception never escapes into SillyTavern', escaped === false);
eq('frozen tail left untouched', hostile.messages.at(-1).partial, undefined);

document.getElementById('pfc_enabled').checked = false;
fire('pfc_enabled', 'change');
const offData = {
    type: 'normal',
    messages: [{ role: 'assistant', content: '<think>x' }],
    custom_prompt_post_processing: '',
};
hook(offData);
eq('disabled hook is inert', offData.messages.at(-1).content, '<think>x');

// ---------------------------------------------------------------- result

if (failures.length) {
    console.error(`\nFAIL — ${failures.length} of ${passed + failures.length} checks failed:\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
}
console.log(`PASS — ${passed} load checks green`);
