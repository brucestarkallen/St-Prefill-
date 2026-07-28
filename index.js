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

const MODULE = 'prefillControl';
const EXTENSION_VERSION = '1.0.0';
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
    renderStatus();

    if (settings().logToConsole) {
        const tail = generateData?.messages?.at(-1);
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
    el.textContent = bits.length ? `${text} — ${bits.join(', ')}` : text;
    el.classList.toggle(`${UI}_ok`, lastReport.applied);
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
      <label class="checkbox_label" for="${UI}_logToConsole">
        <input id="${UI}_logToConsole" type="checkbox"><span>Log every decision to the console</span>
      </label>

      <small class="${UI}_hint">Prefill Control v${EXTENSION_VERSION}</small>
    </div>
  </div>
</div>`;
}

const CHECKBOXES = [
    'enabled', 'thinkingEnabled', 'applyToContinue', 'applyToImpersonate',
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

function init() {
    const host = document.getElementById('extensions_settings');
    if (!host) {
        console.warn('[Prefill Control] extensions_settings not found; UI not mounted.');
    } else {
        host.insertAdjacentHTML('beforeend', template());
        syncFromSettings();
        bind();
    }

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
    console.info(`[Prefill Control] v${EXTENSION_VERSION} ready.`);
}

if (globalThis.SillyTavern?.getContext) {
    init();
} else {
    globalThis.addEventListener('DOMContentLoaded', init, { once: true });
}

export { applyPrefill, EXTENSION_VERSION, MODULE };
