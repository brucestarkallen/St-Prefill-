/**
 * Prefill Control — SillyTavern wiring.
 *
 * Hooks CHAT_COMPLETION_SETTINGS_READY, which fires on the fully-built
 * `generate_data` object one statement before JSON.stringify(). Everything
 * decided here reaches the provider untouched, because the server copies
 * `request.body.messages` verbatim into the outbound body.
 *
 * No SillyTavern source file is modified. Nothing needs reapplying after an update.
 */

import { applyPrefill, DEFAULT_CONFIG, PROFILES, REASON } from './engine.js';
import { deliver } from './st_sim.mjs';

const MODULE = 'prefillControl';
const EXTENSION_VERSION = '1.4.0';
const UI = 'pfc';

/** @returns {object} SillyTavern context */
function ctx() {
    return globalThis.SillyTavern.getContext();
}

/** @returns {object} Live settings object for this module */
function settings() {
    const store = ctx().extensionSettings;
    if (!store[MODULE]) {
        store[MODULE] = { ...DEFAULT_CONFIG };
    }
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
        if (!(key in store[MODULE])) {
            store[MODULE][key] = value;
        }
    }
    return store[MODULE];
}

function persist() {
    ctx().saveSettingsDebounced();
}

// ---------------------------------------------------------------- reset

const RESET_ARM_MS = 4000;
let resetArmed = false;
let resetTimer = null;

function disarmReset() {
    resetArmed = false;
    if (resetTimer !== null) {
        globalThis.clearTimeout(resetTimer);
        resetTimer = null;
    }
    const button = document.getElementById(`${UI}_reset`);
    if (button) {
        button.textContent = 'Reset to defaults';
        button.classList.remove(`${UI}_armed`);
    }
}

/**
 * Restores every setting to its shipped default.
 *
 * The stored object is emptied and refilled in place rather than replaced. Event
 * handlers captured a reference to it at bind time; swapping the reference would
 * leave every control writing to an object nothing reads.
 */
function resetToDefaults() {
    const store = settings();
    for (const key of Object.keys(store)) {
        delete store[key];
    }
    Object.assign(store, DEFAULT_CONFIG);
    persist();
    disarmReset();
    syncFromSettings();
}

function onResetClick() {
    if (resetArmed) {
        resetToDefaults();
        return;
    }
    resetArmed = true;
    const button = document.getElementById(`${UI}_reset`);
    if (button) {
        button.textContent = 'Tap again to confirm';
        button.classList.add(`${UI}_armed`);
    }
    resetTimer = globalThis.setTimeout(disarmReset, RESET_ARM_MS);
    resetTimer?.unref?.();
}

// ---------------------------------------------------------------- decision log

const LOG_LIMIT = 10;
const LOG_FIELD_CHARS = 400;

/** @type {Array<{at: string, type: string, reason: string, tail: object|null}>} */
const decisionLog = [];

/**
 * Truncates one field for the log.
 *
 * Objects and arrays are flattened to text rather than kept by reference. A
 * multimodal message holds base64 image data; storing it live would paint tens
 * of thousands of characters into the panel and pin the payload in memory for
 * as long as the entry survives.
 *
 * @param {*} value Field value
 * @returns {*} Bounded, reference-free value
 */
function summariseValue(value) {
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
        return value;
    }
    let text;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch {
            text = '[value could not be read]';
        }
    }
    return text.length > LOG_FIELD_CHARS
        ? `${text.slice(0, LOG_FIELD_CHARS)}… (+${text.length - LOG_FIELD_CHARS} chars)`
        : text;
}

/**
 * Copies a message with every field bounded, so the log stays readable on a
 * phone and never holds a second copy of the prompt.
 * @param {object} message Wire message
 * @returns {object} Truncated copy
 */
function summariseMessage(message) {
    const out = {};
    for (const [key, value] of Object.entries(message)) {
        out[key] = summariseValue(value);
    }
    return out;
}

/**
 * Records one decision, newest first.
 * @param {object} report Engine report
 * @param {object} generateData The request as it will be sent
 */
function record(report, generateData) {
    const messages = generateData?.messages;
    const tail = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
    decisionLog.unshift({
        at: new Date().toLocaleTimeString(),
        type: String(generateData?.type ?? 'normal'),
        reason: report.reason,
        tail: tail && typeof tail === 'object' ? summariseMessage(tail) : null,
    });
    if (decisionLog.length > LOG_LIMIT) {
        decisionLog.length = LOG_LIMIT;
    }
}

/**
 * Formats the log for display and for the clipboard.
 * @returns {string} Rendered log
 */
function formatLog() {
    if (!decisionLog.length) {
        return 'No requests seen yet. Send a message.';
    }
    return decisionLog.map(entry => {
        const body = entry.tail ? JSON.stringify(entry.tail, null, 2) : '(request had no messages)';
        return `[${entry.at}]  ${entry.type}  →  ${entry.reason}\nfinal message on the wire:\n${body}`;
    }).join('\n\n────────────\n\n');
}

// ---------------------------------------------------------------- observed request shape

/**
 * What real requests on this install actually look like.
 *
 * The self test is only worth running if it reflects the user's own setup. A
 * probe built from invented defaults would happily report success on a
 * configuration they do not have. These are read from live requests, and until
 * one has been seen the test says so instead of guessing.
 */
const observed = {
    seen: false,
    source: '',
    postProcessing: '',
    includeReasoning: null,
    charName: '',
};

/**
 * @param {object} generateData Live request
 */
function observe(generateData) {
    observed.seen = true;
    observed.source = String(generateData?.chat_completion_source ?? '');
    observed.postProcessing = String(generateData?.custom_prompt_post_processing ?? '');
    observed.includeReasoning = Boolean(generateData?.include_reasoning);
    observed.charName = String(generateData?.char_name ?? '');
}

// ---------------------------------------------------------------- the hook

let lastReport = null;

/**
 * @param {object} generateData SillyTavern generate_data
 */
function onSettingsReady(generateData) {
    let report;
    try {
        report = applyPrefill(generateData, settings());
    } catch (error) {
        console.error('[Prefill Control] engine threw, request left untouched:', error);
        return;
    }

    lastReport = report;
    observe(generateData);
    record(report, generateData);
    renderStatus();
    renderLog();

    if (settings().logToConsole) {
        const messages = generateData?.messages;
        const tail = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
        console.info('[Prefill Control]', report.reason, report.detail, tail);
    }
}

// ---------------------------------------------------------------- UI

const STATUS_TEXT = {
    [REASON.APPLIED]: 'Applied to the last request.',
    [REASON.DISABLED]: 'Off.',
    [REASON.NO_MESSAGES]: 'Last request had no messages.',
    [REASON.TYPE_EXCLUDED]: 'Skipped: generation type is excluded.',
    [REASON.DRY_RUN]: 'Skipped: dry run.',
    [REASON.TOOLS_PRESENT]: 'Skipped: request carries tools.',
    [REASON.JSON_SCHEMA]: 'Skipped: request uses a JSON schema.',
    [REASON.SINGLE_POST_PROCESSING]: 'Skipped: post-processing is "Single user message".',
    [REASON.NO_ASSISTANT_TAIL]: 'Skipped: prompt does not end in an assistant message.',
    [REASON.EMPTY_PREFILL]: 'Skipped: prefill text is empty.',
    [REASON.NOTHING_TO_DO]: 'Skipped: both the flag field and thinking split are off.',
    [REASON.BAD_FIELD_NAME]: 'Skipped: unusable field name.',
};

function renderStatus() {
    const el = document.getElementById(`${UI}_status`);
    if (!el || !lastReport) {
        return;
    }
    const text = STATUS_TEXT[lastReport.reason] || lastReport.reason;
    const bits = [];
    if (lastReport.detail?.flagField) bits.push(`${lastReport.detail.flagField}: true`);
    if (lastReport.detail?.reasoningField) bits.push(`${lastReport.detail.reasoningField} (${lastReport.detail.reasoningLength} chars)`);
    if (lastReport.detail?.premerged) bits.push('merged into previous assistant turn');
    if (lastReport.detail?.appended) bits.push('prefill appended by extension');
    if (lastReport.detail?.error) bits.push(lastReport.detail.error);
    el.textContent = bits.length ? `${text} — ${bits.join(', ')}` : text;
    el.classList.toggle(`${UI}_ok`, lastReport.applied);
}

function renderLog() {
    const el = document.getElementById(`${UI}_log`);
    if (el) {
        el.textContent = formatLog();
    }
}

// ---------------------------------------------------------------- self test

/**
 * Builds a probe request shaped like a real one on this install.
 *
 * @param {boolean} withAssistantTail Whether the prompt already ends in an assistant turn
 * @returns {object} A generate_data lookalike
 */
function buildProbe(withAssistantTail) {
    const messages = [
        { role: 'system', content: 'You are narrating a story.' },
        { role: 'user', content: 'Go on.' },
    ];
    if (withAssistantTail) {
        messages.push({ role: 'assistant', content: '<think>Consider the guard.</think>He stepped through.' });
    }
    return {
        type: 'normal',
        messages,
        chat_completion_source: observed.source || 'custom',
        custom_prompt_post_processing: observed.postProcessing || '',
        include_reasoning: observed.includeReasoning === null ? true : observed.includeReasoning,
        char_name: observed.charName || '',
    };
}

/**
 * Runs one probe end to end: the real engine, then the real server pipeline.
 *
 * The verdict is taken from the delivered message rather than the engine's own
 * report, because the failure worth catching is the one where the engine
 * applied something correctly and the server discarded it.
 *
 * @param {string} title Scenario name
 * @param {boolean} withAssistantTail Whether the prompt ends in an assistant turn
 * @returns {string} Rendered result
 */
function runProbe(title, withAssistantTail) {
    const data = buildProbe(withAssistantTail);
    let report;
    try {
        report = applyPrefill(data, settings());
    } catch (error) {
        return `${title}\n  FAILED — the engine threw: ${error.message}`;
    }

    let wire;
    try {
        wire = deliver(data);
    } catch (error) {
        return `${title}\n  FAILED — could not model the request: ${error.message}`;
    }

    const tail = wire.messages[wire.messages.length - 1];
    const lines = [title];

    if (!report.applied) {
        lines.push(`  NOT PREFILLED — ${STATUS_TEXT[report.reason] || report.reason}`);
        if (report.detail?.error) {
            lines.push(`  ${report.detail.error}`);
        }
        lines.push('  The request goes out exactly as SillyTavern built it.');
        return lines.join('\n');
    }

    const arrived = [];
    const lost = [];
    if (report.detail.flagField) {
        (tail?.[report.detail.flagField] === true ? arrived : lost).push(`${report.detail.flagField}: true`);
    }
    if (report.detail.reasoningField) {
        const value = tail?.[report.detail.reasoningField];
        (typeof value === 'string' && value.length ? arrived : lost).push(report.detail.reasoningField);
    }
    if (report.detail.appended) {
        arrived.push('a final assistant message was added for you');
    }

    if (lost.length) {
        lines.push(`  PREFILLED, BUT ${lost.join(' and ')} WILL NOT ARRIVE.`);
        lines.push('  SillyTavern\u2019s server merges it into the message before it.');
        lines.push('  Turn the merge guard on.');
    } else {
        lines.push(`  WORKS \u2014 ${arrived.join(', ')}.`);
    }
    if (report.detail.premerged) {
        lines.push('  The merge guard combined the last two assistant turns, as it should.');
    }
    if (report.detail.thinkingForced) {
        lines.push('  Thinking was switched on for this request, because a reasoning seed needs an open channel.');
    }
    if (wire.thinkingEnabled === false && report.detail.reasoningField) {
        lines.push('  WARNING: the thinking channel is off, so the seed will be ignored.');
    }
    lines.push('  This is the final message as the provider receives it:');
    lines.push(indent(JSON.stringify(tail, null, 2)));
    return lines.join('\n');
}

/**
 * @param {string} text Block of text
 * @returns {string} The same text, indented
 */
function indent(text) {
    return text.split('\n').map(line => `    ${line}`).join('\n');
}

/**
 * @returns {string} The whole self-test report
 */
function selfTest() {
    const s = settings();
    const header = [];
    if (!s.enabled) {
        header.push('Prefill is switched off. This is what would happen with it on.');
    }
    header.push(observed.seen
        ? `Modelled on your last real request: source "${observed.source || 'custom'}", `
          + `post-processing "${observed.postProcessing || 'none'}", `
          + `thinking ${observed.includeReasoning ? 'on' : 'off'}.`
        : 'No real request seen yet, so this assumes an OpenAI-compatible endpoint '
          + 'with no post-processing. Send one message, then run this again for an exact answer.');

    return [
        header.join('\n'),
        '',
        runProbe('1. A normal chat, where the prompt ends with your message:', false),
        '',
        runProbe('2. A prompt that already ends with an assistant message:', true),
    ].join('\n');
}

function renderSelfTest() {
    const el = document.getElementById(`${UI}_testOut`);
    if (el) {
        el.textContent = selfTest();
    }
}

function template() {
    const profileOptions = Object.entries(PROFILES)
        .map(([key, p]) => `<option value="${key}">${p.label}</option>`)
        .join('');

    return `
<div class="${UI}_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Prefill Control</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <label class="checkbox_label" for="${UI}_enabled">
        <input id="${UI}_enabled" type="checkbox">
        <span>Enabled</span>
      </label>
      <div id="${UI}_status" class="${UI}_status">Off.</div>

      <details class="${UI}_guide">
        <summary>What all of this means</summary>

        <p><b>Prefill</b> puts words in the model's mouth. A request normally ends
        with your message and the model starts its reply from nothing. Prefill adds
        one more message — an <i>assistant</i> message — at the very end, so the
        model continues that text instead of starting its own.</p>

        <p><b>The continuation flag</b> is the mark that tells the provider "this
        assistant turn is not finished, keep writing it". Moonshot and Kimi call it
        <code>partial</code>. DeepSeek's beta endpoint calls it <code>prefix</code>.
        Most providers have no such flag and will continue a trailing assistant
        message anyway — leave the box empty for those. If you use SillyTavern's
        built-in Moonshot or DeepSeek source, the server already sets this itself,
        so the box changes nothing there.</p>

        <p><b>Content prefill vs thinking prefill.</b> A content prefill is words in
        the reply itself. It works, but the model did not write them, and they sit
        exactly where it decides what kind of task this is — so it locks in style and
        any claim they contain. A <b>thinking prefill</b> puts the seed in the
        model's reasoning channel and leaves the reply empty. The model keeps
        reasoning normally; you have only nudged the first line of its scratchpad.
        That is the lighter touch, and it is what this extension is mainly for.</p>

        <p>SillyTavern cannot express a pure thinking prefill on its own: prompt
        assembly throws away any message with empty content, so it never survives to
        be sent. This extension does the split afterwards, where it sticks.</p>

        <p><b>How the split works.</b> Write your seed starting with the open tag:</p>
        <pre class="${UI}_sample">&lt;think&gt;I should continue the story.</pre>
        <p>Everything from the tag to the closing tag — or to the end if you leave it
        open — is moved into the reasoning field. Whatever is left stays in the
        reply. In that example nothing is left, so the reply goes out empty and only
        the scratchpad is seeded. That is the shape you want.</p>

        <p><b>Every setting, briefly:</b></p>
        <ul>
          <li><b>Field mapping</b> — fills in the two field names for a known
          provider. It is a shortcut, not a behaviour: nothing is guessed from your
          model name when the request is sent.</li>
          <li><b>Continuation flag</b> — the field name for the flag above. Empty
          writes none.</li>
          <li><b>Reasoning field</b> — where the seed goes. Empty turns the split
          off. It must not be the same as the flag field.</li>
          <li><b>Prefill comes from</b> — <i>This extension</i> appends the text box
          below whenever the prompt does not already end with an assistant message,
          so nothing in your preset needs editing. <i>The preset's final assistant
          message</i> uses what your preset already put there and adds nothing.</li>
          <li><b>Split a leading thinking tag</b> — the move described above. Off
          means the whole text is sent as an ordinary content prefill.</li>
          <li><b>Open / close tag</b> — the markers the split looks for. The close
          tag is optional.</li>
          <li><b>Keep the thinking channel open</b> — a reasoning seed only means
          something if the provider is actually reasoning. If SillyTavern has
          reasoning switched off, the model ignores the seed or continues it as
          ordinary reply text. This turns it back on for requests that carry a seed,
          and only those.</li>
          <li><b>Apply to Continue</b> — marks the reply you are extending as
          unfinished. Usually what you want.</li>
          <li><b>Apply to Impersonate</b> — impersonation writes as you, not as the
          character, so a character-voiced prefill is wrong there. Off by default.</li>
          <li><b>Apply to utility generations</b> — summaries and other extensions'
          background calls. A story prefill welded onto a summarisation request
          corrupts the summary. Leave this off.</li>
          <li><b>Skip when tools are in play / on JSON schema</b> — providers reject a
          continuation flag alongside either. Leave both on.</li>
          <li><b>Merge guard</b> — SillyTavern's server can merge two assistant
          messages in a row into one, and the <i>earlier</i> one survives, which
          throws away the flag written on the later one. The guard does that merge
          here first so the flag lands on the message that survives. Leave it on.</li>
        </ul>

        <p><b>How to check it is working.</b> Use <i>Check it works</i> below: it runs
        your real settings through the same code the request will take and shows the
        exact message the provider receives. Then send a message and read the
        decision log at the bottom, which shows what actually went out. If the log
        says <i>Applied</i> and the final message carries your flag and reasoning
        field, it is working.</p>
      </details>

      <hr>
      <label for="${UI}_profile">Field mapping</label>
      <select id="${UI}_profile" class="text_pole">
        <option value="">— pick one to fill the fields below —</option>
        ${profileOptions}
      </select>
      <small class="${UI}_hint">Selecting a mapping writes the two fields below. Nothing is guessed from the model name at send time.</small>

      <div class="${UI}_row">
        <div class="${UI}_col">
          <label for="${UI}_flagField">Continuation flag</label>
          <input id="${UI}_flagField" class="text_pole" type="text" placeholder="partial">
        </div>
        <div class="${UI}_col">
          <label for="${UI}_reasoningField">Reasoning field</label>
          <input id="${UI}_reasoningField" class="text_pole" type="text" placeholder="reasoning_content">
        </div>
      </div>

      <hr>
      <label for="${UI}_source">Prefill comes from</label>
      <select id="${UI}_source" class="text_pole">
        <option value="preset">The preset's final assistant message</option>
        <option value="extension">This extension (appended when the prompt has no assistant tail)</option>
      </select>
      <textarea id="${UI}_text" class="text_pole textarea_compact" rows="3"
        placeholder="&lt;think&gt;I should continue the story."></textarea>

      <hr>
      <label class="checkbox_label" for="${UI}_thinkingEnabled">
        <input id="${UI}_thinkingEnabled" type="checkbox">
        <span>Split a leading thinking tag into the reasoning field</span>
      </label>
      <div class="${UI}_row">
        <div class="${UI}_col">
          <label for="${UI}_openTag">Open tag</label>
          <input id="${UI}_openTag" class="text_pole" type="text" placeholder="&lt;think&gt;">
        </div>
        <div class="${UI}_col">
          <label for="${UI}_closeTag">Close tag (optional)</label>
          <input id="${UI}_closeTag" class="text_pole" type="text" placeholder="&lt;/think&gt;">
        </div>
      </div>
      <label class="checkbox_label" for="${UI}_ensureThinking">
        <input id="${UI}_ensureThinking" type="checkbox">
        <span>Keep the thinking channel open for seeded requests</span>
      </label>
      <small class="${UI}_hint">A reasoning seed is ignored when the provider is not reasoning. This switches thinking on for requests that carry a seed, and only those.</small>

      <hr>
      <label class="checkbox_label" for="${UI}_applyToContinue">
        <input id="${UI}_applyToContinue" type="checkbox"><span>Apply to Continue</span>
      </label>
      <label class="checkbox_label" for="${UI}_applyToImpersonate">
        <input id="${UI}_applyToImpersonate" type="checkbox"><span>Apply to Impersonate</span>
      </label>
      <label class="checkbox_label" for="${UI}_applyToQuiet">
        <input id="${UI}_applyToQuiet" type="checkbox"><span>Apply to utility generations (summaries, extensions)</span>
      </label>
      <small class="${UI}_hint">Leave the last one off. A story prefill on a summarisation call corrupts the summary.</small>

      <hr>
      <label class="checkbox_label" for="${UI}_skipOnTools">
        <input id="${UI}_skipOnTools" type="checkbox"><span>Skip when tools are in play</span>
      </label>
      <label class="checkbox_label" for="${UI}_skipOnJsonSchema">
        <input id="${UI}_skipOnJsonSchema" type="checkbox"><span>Skip when a JSON schema is requested</span>
      </label>
      <label class="checkbox_label" for="${UI}_mergeGuard">
        <input id="${UI}_mergeGuard" type="checkbox"><span>Merge guard for server-side prompt post-processing</span>
      </label>

      <hr>
      <div class="${UI}_logbar">
        <b>Check it works</b>
        <div id="${UI}_selfTest" class="menu_button" title="Run a probe request through the engine">Run test</div>
      </div>
      <pre id="${UI}_testOut" class="${UI}_log">Tap Run test. Nothing is sent anywhere — this builds a request locally, puts it through the same code a real one takes, and shows you the result.</pre>

      <hr>
      <div class="${UI}_logbar">
        <b>Decision log</b>
        <div>
          <div id="${UI}_logCopy" class="menu_button" title="Copy the log">Copy</div>
          <div id="${UI}_logClear" class="menu_button" title="Clear the log">Clear</div>
        </div>
      </div>
      <pre id="${UI}_log" class="${UI}_log">No requests seen yet. Send a message.</pre>
      <small class="${UI}_hint">The last ${LOG_LIMIT} requests, newest first, showing the final message exactly as it goes on the wire. This is the log — you do not need a browser console.</small>
      <label class="checkbox_label" for="${UI}_logToConsole">
        <input id="${UI}_logToConsole" type="checkbox"><span>Also write each decision to the browser console</span>
      </label>


      <hr>
      <div id="${UI}_reset" class="menu_button ${UI}_reset">Reset to defaults</div>
      <small class="${UI}_hint">Restores every setting above. Tap twice to confirm. The decision log is history, not a setting, and is left alone — use Clear for that.</small>

      <small class="${UI}_hint">Prefill Control v${EXTENSION_VERSION}</small>
    </div>
  </div>
</div>`;
}

const CHECKBOXES = [
    'enabled', 'thinkingEnabled', 'ensureThinking', 'applyToContinue', 'applyToImpersonate',
    'applyToQuiet', 'skipOnTools', 'skipOnJsonSchema', 'mergeGuard', 'logToConsole',
];
const TEXTS = ['flagField', 'reasoningField', 'openTag', 'closeTag', 'text', 'source'];

function syncFromSettings() {
    const s = settings();
    for (const key of CHECKBOXES) {
        const el = document.getElementById(`${UI}_${key}`);
        if (el) el.checked = Boolean(s[key]);
    }
    for (const key of TEXTS) {
        const el = document.getElementById(`${UI}_${key}`);
        if (el) el.value = s[key] ?? '';
    }
    renderStatus();
    renderLog();
}

function bind() {
    const s = settings();

    for (const key of CHECKBOXES) {
        document.getElementById(`${UI}_${key}`)?.addEventListener('change', (e) => {
            s[key] = e.target.checked;
            persist();
            renderStatus();
        });
    }

    for (const key of TEXTS) {
        document.getElementById(`${UI}_${key}`)?.addEventListener('input', (e) => {
            s[key] = e.target.value;
            persist();
        });
    }

    document.getElementById(`${UI}_reset`)?.addEventListener('click', onResetClick);

    document.getElementById(`${UI}_selfTest`)?.addEventListener('click', renderSelfTest);

    document.getElementById(`${UI}_logClear`)?.addEventListener('click', () => {
        decisionLog.length = 0;
        renderLog();
    });

    document.getElementById(`${UI}_logCopy`)?.addEventListener('click', async () => {
        const text = formatLog();
        try {
            await globalThis.navigator.clipboard.writeText(text);
        } catch {
            const el = document.getElementById(`${UI}_log`);
            const selection = globalThis.getSelection?.();
            if (el && selection) {
                const range = document.createRange();
                range.selectNodeContents(el);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }
    });

    document.getElementById(`${UI}_profile`)?.addEventListener('change', (e) => {
        const profile = PROFILES[e.target.value];
        if (!profile) return;
        s.flagField = profile.flagField;
        s.reasoningField = profile.reasoningField;
        persist();
        syncFromSettings();
    });
}

// ---------------------------------------------------------------- init

const MOUNT_FLAG = '__prefillControlMounted';
const POLL_MS = 200;
const CONTEXT_TIMEOUT_MS = 60000;
const HOST_TIMEOUT_MS = 60000;

function sleep(ms) {
    return new Promise((resolve) => {
        const timer = globalThis.setTimeout(resolve, ms);
        timer?.unref?.();
    });
}

/**
 * Waits for a condition, polling until it holds or the deadline passes.
 * @param {Function} predicate Condition to test
 * @param {number} timeoutMs Deadline in milliseconds
 * @returns {Promise<boolean>} Whether the condition held
 */
async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) {
            return true;
        }
        if (Date.now() >= deadline) {
            return false;
        }
        await sleep(POLL_MS);
    }
}

/**
 * Registers the hook as soon as a context exists, then mounts the UI once
 * SillyTavern has created its settings container.
 *
 * Both are polled rather than assumed. Extension load order is not guaranteed,
 * and reading the context before it exists throws — which would leave the
 * extension permanently dead with no hook, no UI, and no retry.
 *
 * @returns {Promise<boolean>} Whether the hook was registered
 */
async function start() {
    if (globalThis[MOUNT_FLAG]) {
        console.warn('[Prefill Control] already loaded; skipping duplicate initialisation.');
        return false;
    }
    globalThis[MOUNT_FLAG] = true;

    const haveContext = await waitFor(() => Boolean(globalThis.SillyTavern?.getContext), CONTEXT_TIMEOUT_MS);
    if (!haveContext) {
        globalThis[MOUNT_FLAG] = false;
        console.error('[Prefill Control] SillyTavern context never appeared; extension inactive.');
        return false;
    }

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
    console.info(`[Prefill Control] v${EXTENSION_VERSION} ready.`);

    const haveHost = await waitFor(() => Boolean(document.getElementById('extensions_settings')), HOST_TIMEOUT_MS);
    if (!haveHost) {
        console.warn('[Prefill Control] settings container never appeared; prefill is active but has no UI.');
        return true;
    }

    document.getElementById('extensions_settings').insertAdjacentHTML('beforeend', template());
    syncFromSettings();
    bind();
    return true;
}

const ready = start();

export { applyPrefill, EXTENSION_VERSION, MODULE, ready };
