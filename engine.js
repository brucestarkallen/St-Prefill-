/**
 * Prefill Control — engine.
 *
 * Pure logic. No SillyTavern imports, no DOM, no jQuery. Everything in here is
 * driven by a plain `generate_data` object and a plain config object so the gate
 * can execute it headlessly.
 *
 * Contract with SillyTavern (verified against staging @ 380e31e):
 *   public/scripts/openai.js  createGenerationParameters() builds `generate_data`
 *                             with `messages` being the exact array returned by
 *                             ChatCompletion.getChat().
 *   public/scripts/openai.js  sendOpenAIRequest() emits CHAT_COMPLETION_SETTINGS_READY
 *                             with that object, then JSON.stringify()s it.
 *   src/endpoints/backends/chat-completions.js  /generate applies
 *                             custom_prompt_post_processing, then copies
 *                             `request.body.messages` verbatim into the outbound body.
 *
 * Therefore any field written onto a message object here reaches the provider.
 */

export const ENGINE_VERSION = '1.0.0';

/** Generation types SillyTavern can hand to sendOpenAIRequest. */
export const GEN_TYPE = {
    NORMAL: 'normal',
    SWIPE: 'swipe',
    REGENERATE: 'regenerate',
    CONTINUE: 'continue',
    IMPERSONATE: 'impersonate',
    QUIET: 'quiet',
};

/**
 * Server-side post-processing types that collapse the whole prompt into a single
 * user message. A continuation flag is meaningless there.
 */
export const SINGLE_POST_PROCESSING = 'single';

export const DEFAULT_CONFIG = Object.freeze({
    enabled: false,

    /**
     * 'preset'    — use the assistant message already at the end of the prompt.
     * 'extension' — append `text` as a final assistant message when one is not
     *               already there. Lets you express an empty-content pure
     *               thinking prefill, which getChat() would otherwise drop.
     */
    source: 'preset',
    text: '<think>I should continue the story.',

    /** Continuation flag written on the final assistant message. '' writes none. */
    flagField: 'partial',

    /** Thinking channel. */
    thinkingEnabled: true,
    reasoningField: 'reasoning_content',
    openTag: '<think>',
    closeTag: '</think>',

    /** Which generation types are eligible. */
    applyToContinue: true,
    applyToImpersonate: false,
    applyToQuiet: false,

    /** Safety. */
    skipOnTools: true,
    skipOnJsonSchema: true,
    mergeGuard: true,

    logToConsole: false,
});

/** Reason codes. Stable strings — the gate asserts on these. */
export const REASON = {
    APPLIED: 'applied',
    DISABLED: 'disabled',
    NO_MESSAGES: 'no-messages',
    TYPE_EXCLUDED: 'type-excluded',
    DRY_RUN: 'dry-run',
    TOOLS_PRESENT: 'tools-present',
    JSON_SCHEMA: 'json-schema',
    SINGLE_POST_PROCESSING: 'post-processing-single',
    NO_ASSISTANT_TAIL: 'no-assistant-tail',
    EMPTY_PREFILL: 'empty-prefill',
    NOTHING_TO_DO: 'nothing-to-do',
};

/**
 * Escapes a string for literal use inside a RegExp.
 * @param {string} value Raw string
 * @returns {string} Escaped string
 */
export function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the reasoning-extraction pattern from configured tags.
 * Matches an opening tag at the very start of the content and captures
 * everything up to the closing tag, or to the end if the tag is left open.
 * @param {string} openTag Opening tag
 * @param {string} closeTag Closing tag, may be empty
 * @returns {RegExp} Extraction pattern
 */
export function buildReasoningPattern(openTag, closeTag) {
    const open = escapeRegExp(openTag);
    const close = closeTag ? `${escapeRegExp(closeTag)}|$` : '$';
    return new RegExp(`^\\s*${open}([\\s\\S]*?)(?:${close})`);
}

/**
 * Decides whether a generation type is eligible for prefilling.
 * @param {string} type Generation type from generate_data.type
 * @param {object} cfg Config
 * @returns {boolean} True if eligible
 */
export function isEligibleType(type, cfg) {
    const normalized = String(type ?? '').toLowerCase();
    switch (normalized) {
        case GEN_TYPE.QUIET:
            return Boolean(cfg.applyToQuiet);
        case GEN_TYPE.IMPERSONATE:
            return Boolean(cfg.applyToImpersonate);
        case GEN_TYPE.CONTINUE:
            return Boolean(cfg.applyToContinue);
        default:
            return true;
    }
}

/**
 * Reports whether the server will merge consecutive same-role messages for this
 * request. Any non-empty custom_prompt_post_processing value routes through
 * mergeMessages(); the empty string is the only pass-through.
 * @param {string} postProcessing custom_prompt_post_processing value
 * @returns {boolean} True if the server merges
 */
export function serverWillMerge(postProcessing) {
    return Boolean(postProcessing);
}

/**
 * Applies prefill semantics to a generate_data object, in place.
 *
 * @param {object} data SillyTavern generate_data
 * @param {object} userConfig Partial config, merged over DEFAULT_CONFIG
 * @returns {{applied: boolean, reason: string, detail: object}} Report
 */
export function applyPrefill(data, userConfig) {
    const cfg = { ...DEFAULT_CONFIG, ...(userConfig || {}) };
    const detail = {};

    if (!cfg.enabled) {
        return { applied: false, reason: REASON.DISABLED, detail };
    }
    if (!data || !Array.isArray(data.messages) || data.messages.length === 0) {
        return { applied: false, reason: REASON.NO_MESSAGES, detail };
    }
    if (data.dryRun === true) {
        return { applied: false, reason: REASON.DRY_RUN, detail };
    }
    if (!isEligibleType(data.type, cfg)) {
        return { applied: false, reason: REASON.TYPE_EXCLUDED, detail: { type: data.type } };
    }
    if (cfg.skipOnJsonSchema && data.json_schema) {
        return { applied: false, reason: REASON.JSON_SCHEMA, detail };
    }
    if (cfg.skipOnTools && hasTools(data)) {
        return { applied: false, reason: REASON.TOOLS_PRESENT, detail };
    }
    if (String(data.custom_prompt_post_processing || '') === SINGLE_POST_PROCESSING) {
        return { applied: false, reason: REASON.SINGLE_POST_PROCESSING, detail };
    }

    const messages = data.messages;
    let index = messages.length - 1;

    // Source resolution.
    if (messages[index]?.role !== 'assistant') {
        if (cfg.source !== 'extension') {
            return { applied: false, reason: REASON.NO_ASSISTANT_TAIL, detail };
        }
        const text = String(cfg.text ?? '');
        if (!text.trim()) {
            return { applied: false, reason: REASON.EMPTY_PREFILL, detail };
        }
        messages.push({ role: 'assistant', content: text });
        index = messages.length - 1;
        detail.appended = true;
    }

    let target = messages[index];

    // Thinking split. Only meaningful for string content; multimodal arrays are
    // left alone and only receive the continuation flag.
    if (cfg.thinkingEnabled && cfg.reasoningField && typeof target.content === 'string') {
        const pattern = buildReasoningPattern(cfg.openTag, cfg.closeTag);
        const match = target.content.match(pattern);
        if (match) {
            target[cfg.reasoningField] = match[1].trim();
            target.content = target.content.replace(pattern, '').trimStart();
            detail.reasoningField = cfg.reasoningField;
            detail.reasoningLength = target[cfg.reasoningField].length;
        }
    }

    // Merge guard.
    //
    // The server merges a message into its predecessor when the roles match and
    // the message's own content is truthy — and the predecessor is the object
    // that survives. A flag written on our message would be discarded. Rather
    // than hoping the tail is unmergeable, perform the merge here so the
    // server's merge becomes a no-op and the flag lands on the surviving object.
    const previous = messages[index - 1];
    const wouldBeMerged = cfg.mergeGuard
        && serverWillMerge(data.custom_prompt_post_processing)
        && previous?.role === 'assistant'
        && typeof target.content === 'string'
        && target.content.length > 0
        && typeof previous.content === 'string';

    if (wouldBeMerged) {
        previous.content = `${previous.content}\n\n${target.content}`;
        if (cfg.reasoningField && target[cfg.reasoningField]) {
            const carried = target[cfg.reasoningField];
            previous[cfg.reasoningField] = previous[cfg.reasoningField]
                ? `${previous[cfg.reasoningField]}\n\n${carried}`
                : carried;
        }
        messages.splice(index, 1);
        index -= 1;
        target = previous;
        detail.premerged = true;
    }

    // Continuation flag.
    if (cfg.flagField) {
        target[cfg.flagField] = true;
        detail.flagField = cfg.flagField;
    }

    if (!cfg.flagField && !detail.reasoningField && !detail.appended) {
        return { applied: false, reason: REASON.NOTHING_TO_DO, detail };
    }

    detail.index = index;
    return { applied: true, reason: REASON.APPLIED, detail };
}

/**
 * Reports whether the request carries tool definitions or tool results.
 * Providers reject a continuation flag alongside tools.
 * @param {object} data generate_data
 * @returns {boolean} True if tools are in play
 */
export function hasTools(data) {
    if (Array.isArray(data.tools) && data.tools.length > 0) {
        return true;
    }
    return data.messages.some(m => m?.role === 'tool' || Array.isArray(m?.tool_calls));
}

/** Ready-made field mappings. Selecting one writes the fields; nothing is inferred at send time. */
export const PROFILES = Object.freeze({
    moonshot: {
        label: 'Moonshot / Kimi (direct)',
        flagField: 'partial',
        reasoningField: 'reasoning_content',
    },
    openrouter_moonshot: {
        label: 'OpenRouter → Moonshot provider',
        flagField: 'partial',
        reasoningField: 'reasoning_content',
    },
    deepseek: {
        label: 'DeepSeek (beta prefix)',
        flagField: 'prefix',
        reasoningField: 'reasoning_content',
    },
    openrouter_generic: {
        label: 'OpenRouter (generic)',
        flagField: '',
        reasoningField: 'reasoning',
    },
    openai_compatible: {
        label: 'Custom / OpenAI-compatible',
        flagField: '',
        reasoningField: 'reasoning_content',
    },
    claude: {
        label: 'Anthropic (prefill is native)',
        flagField: '',
        reasoningField: '',
    },
});
