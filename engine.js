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
 *                             ChatCompletion.getChat(), and `type` set to the
 *                             generation type.
 *   public/scripts/openai.js  sendOpenAIRequest() emits CHAT_COMPLETION_SETTINGS_READY
 *                             with that object, then JSON.stringify()s it.
 *   src/endpoints/backends/chat-completions.js  /generate applies
 *                             custom_prompt_post_processing, then hands off to a
 *                             per-source handler which may apply its own.
 *
 * Therefore any field written onto a message object here reaches the provider,
 * provided it survives the server's post-processing. Predicting that survival is
 * what most of this file is about; `st_sim.mjs` is the port of the server code
 * those predictions are checked against.
 */

export const ENGINE_VERSION = '1.5.0';

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
 * Server-side post-processing that collapses the whole prompt into a single
 * user message. A continuation flag is meaningless there.
 */
export const SINGLE_POST_PROCESSING = 'single';

/**
 * Sources whose request handler runs its own prompt post-processing regardless
 * of what the user chose in the UI. Read from
 * src/endpoints/backends/chat-completions.js; each entry cites its handler.
 *
 * This exists because `custom_prompt_post_processing` is not authoritative. A
 * merge guard keyed on that field alone believes nothing will be merged on
 * DeepSeek when the user has post-processing off, and the tail — flag,
 * reasoning and all — is merged away server-side.
 */
export const SOURCE_FORCED_POST_PROCESSING = Object.freeze({
    deepseek: 'semi_tools',   // sendDeepSeekRequest()
    minimax: 'merge_tools',   // sendMinimaxRequest()
    perplexity: 'strict',     // router.post('/generate'), PERPLEXITY branch
});

export const DEFAULT_CONFIG = Object.freeze({
    enabled: false,

    /**
     * 'preset'    — use the assistant message already at the end of the prompt.
     * 'extension' — append `text` as a final assistant message when one is not
     *               already there. Lets you express an empty-content pure
     *               thinking prefill, which getChat() would otherwise drop.
     */
    source: 'extension',
    text: '<think>I should continue the story.',

    /** Continuation flag written on the final assistant message. '' writes none. */
    flagField: 'partial',

    /** Thinking channel. */
    thinkingEnabled: true,
    reasoningField: 'reasoning_content',
    openTag: '<think>',
    closeTag: '</think>',

    /**
     * Turn the provider's thinking channel on whenever a reasoning field is
     * written. `include_reasoning` maps to thinking.type on Moonshot, DeepSeek
     * and Z.AI and to reasoning.exclude on OpenRouter; seeding a channel the
     * request has switched off is the one failure that looks like success.
     */
    ensureThinking: true,

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
    BAD_FIELD_NAME: 'bad-field-name',
    FIELD_COLLISION: 'field-collision',
    MULTIMODAL_MERGE: 'multimodal-merge',
};

/**
 * Message keys that must never be used as a continuation flag or reasoning
 * field. Writing to any of these replaces part of the message itself — a
 * `flagField` of "content" produces `content: true`, which is a type error at
 * the provider and destroys the prefill in the same stroke.
 */
export const RESERVED_FIELDS = Object.freeze([
    'role', 'content', 'name', 'tool_calls', 'tool_call_id', 'refusal',
    '__proto__', 'constructor', 'prototype',
]);

/**
 * Normalises a user-typed field name and reports whether it is usable.
 *
 * Whitespace is the quiet failure this exists for: a field named " partial "
 * serialises as a key the provider ignores, so the extension reports success
 * while nothing happens.
 *
 * @param {string} raw Raw field name from settings
 * @returns {{name: string, valid: boolean, error: string}} Normalised result
 */
export function normaliseFieldName(raw) {
    const name = String(raw ?? '').trim();
    if (!name) {
        return { name: '', valid: true, error: '' };
    }
    if (RESERVED_FIELDS.includes(name)) {
        return { name, valid: false, error: `"${name}" is part of the message itself` };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return { name, valid: false, error: `"${name}" is not a valid field name` };
    }
    return { name, valid: true, error: '' };
}

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
 * Every post-processing pass the server will run, in order.
 *
 * The `/generate` route applies the user's choice first for every source, then
 * the per-source handler may apply another unconditionally. Both matter, so
 * both are reported.
 *
 * @param {object} data generate_data
 * @returns {string[]} Non-empty post-processing types, in application order
 */
export function serverPostProcessingChain(data) {
    const chain = [];
    const chosen = String(data?.custom_prompt_post_processing || '');
    if (chosen) {
        chain.push(chosen);
    }
    const forced = SOURCE_FORCED_POST_PROCESSING[String(data?.chat_completion_source || '')];
    if (forced) {
        chain.push(forced);
    }
    return chain;
}

/**
 * Reports whether the server will merge consecutive same-role messages for this
 * request. Any post-processing pass at all routes through mergeMessages().
 * @param {object} data generate_data
 * @returns {boolean} True if the server merges
 */
export function serverWillMerge(data) {
    return serverPostProcessingChain(data).length > 0;
}

/**
 * Reports whether the server will collapse the prompt into one user turn.
 * @param {object} data generate_data
 * @returns {boolean} True if everything becomes a single user message
 */
export function serverWillCollapse(data) {
    return serverPostProcessingChain(data).includes(SINGLE_POST_PROCESSING);
}

/**
 * The content the server's mergeMessages() will see for a message, after it
 * folds `name` into the text.
 *
 * The fold happens *before* the same-role squash, so a message whose content we
 * emptied is not empty by the time the squash tests it — which is how a flag
 * written on an emptied tail gets merged away and lost. Returns null for
 * content the fold cannot be predicted for (multimodal arrays, which the server
 * flattens through random tokens and rebuilds).
 *
 * @param {object} message Wire message
 * @returns {string|null} Content as the server will read it, or null
 */
export function serverVisibleContent(message) {
    const raw = message?.content;
    if (raw === undefined || raw === null || raw === '') {
        return applyNameFold(message, '');
    }
    if (typeof raw !== 'string') {
        return null;
    }
    return applyNameFold(message, raw);
}

/**
 * Reports whether the server will merge `messages[index]` into the message
 * before it, discarding that object whole.
 *
 * This is one question, asked about the message, not about any field on it.
 * `mergeMessages()` keeps the *predecessor* and drops the merged object
 * entirely, so the continuation flag and the reasoning seed share a single
 * fate — asking separately about each invites a report where one is covered and
 * the other silently disappears.
 *
 * Unpredictable content counts as at risk, not as safe. The server flattens a
 * multimodal message to text before it squashes, so such a message does merge;
 * the premerge cannot reproduce that flattening and stands down, which leaves
 * the merge to the server. A warning that turns out to be unnecessary costs a
 * line in the panel. The opposite error costs the whole prefill, silently.
 *
 * @param {object} data generate_data
 * @param {object[]} messages Message array, as it now stands
 * @param {number} index Index of the message everything was written on
 * @returns {boolean} True if the server will discard that message
 */
export function targetWillBeMergedAway(data, messages, index) {
    if (!serverWillMerge(data)) {
        return false;
    }
    const target = messages[index];
    const previous = messages[index - 1];
    if (target?.role !== 'assistant' || previous?.role !== 'assistant') {
        return false;
    }
    const targetContent = serverVisibleContent(target);
    const previousContent = serverVisibleContent(previous);
    if (targetContent === null || previousContent === null) {
        return true;
    }
    // The squash tests the merged message's own content for truthiness, so an
    // empty one is pushed as its own object and survives.
    return targetContent.length > 0;
}

/**
 * Mirrors the name fold in mergeMessages(), including its startsWith guard,
 * which is what makes the fold idempotent when we perform it early.
 * @param {object} message Wire message
 * @param {string} content Current content
 * @returns {string} Folded content
 */
function applyNameFold(message, content) {
    const name = message?.name;
    if (!name || message.role === 'system') {
        return content;
    }
    return content.startsWith(`${name}: `) ? content : `${name}: ${content}`;
}

/**
 * Applies prefill semantics to a generate_data object, in place.
 *
 * Nothing is mutated until every reason to skip has been ruled out. A report of
 * "skipped" must mean the request was left exactly as it arrived.
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
    if (serverWillCollapse(data)) {
        return { applied: false, reason: REASON.SINGLE_POST_PROCESSING, detail };
    }

    // Field names are user-typed. Validate before touching the request, so an
    // unusable name skips cleanly instead of corrupting the message.
    const flag = normaliseFieldName(cfg.flagField);
    const reasoning = normaliseFieldName(cfg.reasoningField);
    if (!flag.valid || !reasoning.valid) {
        return {
            applied: false,
            reason: REASON.BAD_FIELD_NAME,
            detail: { error: flag.valid ? reasoning.error : flag.error },
        };
    }
    // Two names, one key: the flag is written after the split, so a collision
    // replaces the seeded reasoning with `true` and reports success.
    if (flag.name && flag.name === reasoning.name) {
        return {
            applied: false,
            reason: REASON.FIELD_COLLISION,
            detail: { error: `the flag and the reasoning field are both "${flag.name}"` },
        };
    }

    const messages = data.messages;
    const tailIsAssistant = messages[messages.length - 1]?.role === 'assistant';

    // ------------------------------------------------------------ decide

    let willAppend = false;
    if (!tailIsAssistant) {
        if (cfg.source !== 'extension') {
            return { applied: false, reason: REASON.NO_ASSISTANT_TAIL, detail };
        }
        if (!String(cfg.text ?? '').trim()) {
            return { applied: false, reason: REASON.EMPTY_PREFILL, detail };
        }
        willAppend = true;
    }

    const prospectiveContent = willAppend
        ? String(cfg.text ?? '')
        : messages[messages.length - 1].content;

    const pattern = (cfg.thinkingEnabled && reasoning.name && cfg.openTag)
        ? buildReasoningPattern(cfg.openTag, cfg.closeTag)
        : null;
    const willSplit = Boolean(pattern)
        && typeof prospectiveContent === 'string'
        && pattern.test(prospectiveContent);

    if (!flag.name && !willSplit && !willAppend) {
        return { applied: false, reason: REASON.NOTHING_TO_DO, detail };
    }

    // A multimodal tail behind a merging server cannot be premerged: the server
    // flattens media through random tokens and rebuilds the array, so anything
    // written here is discarded and cannot be carried across by hand. Say so
    // rather than report a flag that will not arrive.
    if (cfg.mergeGuard
        && !willAppend
        && serverWillMerge(data)
        && messages[messages.length - 2]?.role === 'assistant'
        && serverVisibleContent(messages[messages.length - 1]) === null) {
        return { applied: false, reason: REASON.MULTIMODAL_MERGE, detail };
    }

    // ------------------------------------------------------------ act

    if (willAppend) {
        messages.push({ role: 'assistant', content: String(cfg.text ?? '') });
        detail.appended = true;
    }
    let index = messages.length - 1;
    let target = messages[index];

    // Thinking split. The tag is always stripped from content when it matches;
    // the reasoning field is only written when there is something to put in it.
    if (willSplit) {
        const match = target.content.match(pattern);
        const extracted = match[1].trim();
        target.content = target.content.replace(pattern, '').trimStart();
        if (extracted) {
            target[reasoning.name] = extracted;
            detail.reasoningField = reasoning.name;
            detail.reasoningLength = extracted.length;
        }
    }

    // Merge guard.
    //
    // The server merges a message into its predecessor when the roles match and
    // the message's own content is truthy — and the predecessor is the object
    // that survives, so a flag written on ours would be discarded. Rather than
    // hoping the tail is unmergeable, perform the same merge here so the
    // server's becomes a no-op and the flag lands on the surviving object.
    //
    // Two details make this faithful rather than approximate. The content used
    // is the content the server will see, name already folded in, because the
    // fold decides both truthiness and the merged text. And the whole trailing
    // run of assistant messages is collapsed, not just one, because the server
    // squashes runs.
    if (cfg.mergeGuard && serverWillMerge(data)) {
        for (;;) {
            const previous = messages[index - 1];
            if (previous?.role !== 'assistant') {
                break;
            }
            const targetContent = serverVisibleContent(target);
            const previousContent = serverVisibleContent(previous);
            if (targetContent === null || previousContent === null || targetContent.length === 0) {
                break;
            }
            previous.content = `${previousContent}\n\n${targetContent}`;
            if (reasoning.name && target[reasoning.name]) {
                const carried = target[reasoning.name];
                previous[reasoning.name] = previous[reasoning.name]
                    ? `${previous[reasoning.name]}\n\n${carried}`
                    : carried;
                detail.reasoningField = reasoning.name;
            }
            messages.splice(index, 1);
            index -= 1;
            target = previous;
            detail.premerged = true;
        }
    }

    // Continuation flag.
    if (flag.name) {
        target[flag.name] = true;
        detail.flagField = flag.name;
    }

    // Everything above was written on `target`. If the server merges that
    // object into its predecessor, the predecessor survives and all of it is
    // discarded together — so the question is asked once, about the message.
    //
    // With the guard on, the loop above has already collapsed the run and this
    // is false. It is not always false: the premerge stands down when it cannot
    // reproduce the server's transform, and a multimodal predecessor is exactly
    // that case. The server flattens the media and merges regardless.
    //
    // Reporting a known failure is the point. Silence here is a panel that says
    // "Applied" about a request the provider will never see the prefill in.
    if (targetWillBeMergedAway(data, messages, index)) {
        detail.mergeRisk = true;
    }

    // The reasoning channel has to be open for a reasoning seed to mean
    // anything. `include_reasoning` is what the server maps to thinking.type on
    // Moonshot, DeepSeek and Z.AI, and to reasoning.exclude on OpenRouter.
    //
    // The rule is "open it for requests that carry a seed". A request whose seed
    // the server is about to merge away does not carry one, so flipping a
    // provider-visible parameter there changes behaviour for no benefit and
    // without the user being able to see why.
    if (cfg.ensureThinking && detail.reasoningField && !detail.mergeRisk && !data.include_reasoning) {
        data.include_reasoning = true;
        detail.thinkingForced = true;
    }

    detail.index = index;
    return { applied: true, reason: REASON.APPLIED, detail };
}

/**
 * Reports whether the request carries tool definitions or tool results.
 * Providers reject a continuation flag alongside tools, and the server's own
 * addAssistantPrefix() declines to set one for the same reason.
 * @param {object} data generate_data
 * @returns {boolean} True if tools are in play
 */
export function hasTools(data) {
    if (Array.isArray(data.tools) && data.tools.length > 0) {
        return true;
    }
    return data.messages.some(m => m?.role === 'tool' || Boolean(m?.tool_calls));
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
