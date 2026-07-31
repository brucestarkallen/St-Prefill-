/**
 * Prefill Control — SillyTavern server simulator.
 *
 * A faithful port of the server-side pipeline a request passes through *after*
 * CHAT_COMPLETION_SETTINGS_READY fires. The engine's guards are all predictions
 * about this code; without it the gate can only assert that the engine did what
 * it meant to, never that the provider received it.
 *
 * Ported verbatim from SillyTavern staging:
 *   src/prompt-converters.js            mergeMessages(), postProcessPrompt(),
 *                                       addAssistantPrefix(), PROMPT_PROCESSING_TYPE
 *   src/endpoints/backends/chat-completions.js
 *                                       router.post('/generate') ordering,
 *                                       per-source forced post-processing,
 *                                       include_reasoning → thinking mapping
 *
 * Keep this a port. If a behaviour here is not in the SillyTavern source, it is
 * a bug in the simulator, and a guard tuned against it is a guard tuned against
 * fiction.
 */

const PROMPT_PLACEHOLDER = 'Let\'s get started.';

export const PROMPT_PROCESSING_TYPE = {
    NONE: '',
    CLAUDE: 'claude',
    MERGE: 'merge',
    MERGE_TOOLS: 'merge_tools',
    SEMI: 'semi',
    SEMI_TOOLS: 'semi_tools',
    STRICT: 'strict',
    STRICT_TOOLS: 'strict_tools',
    SINGLE: 'single',
};

/**
/**
 * Stands in for the server's crypto.randomBytes() placeholder token. Only
 * opacity and uniqueness matter; this file is also loaded in the browser by the
 * settings panel's self test, so it carries no Node dependency.
 * @returns {string} Opaque token
 */
let tokenCounter = 0;
function randomToken() {
    tokenCounter += 1;
    return `\u0000pfc-media-${tokenCounter}-${Math.random().toString(36).slice(2)}\u0000`;
}

/**
 * Builds the name helper the server derives from the request body.
 * @param {object} body Request body
 * @returns {object} Prompt names
 */
export function getPromptNames(body) {
    return {
        charName: String(body.char_name || ''),
        userName: String(body.user_name || ''),
        groupNames: Array.isArray(body.group_names) ? body.group_names.map(String) : [],
        startsWithGroupName: function (message) {
            return this.groupNames.some(name => message.startsWith(`${name}: `));
        },
    };
}

/**
 * Sets the continuation flag on a trailing assistant message.
 * @param {any[]} prompt Prompt messages array
 * @param {any[]} tools Tool definitions
 * @param {string} property Property to set
 * @returns {any[]} The same array
 */
export function addAssistantPrefix(prompt, tools, property) {
    if (!prompt.length) {
        return prompt;
    }
    const hasAnyTools = (Array.isArray(tools) && tools.length > 0) || prompt.some(x => x.role === 'tool');
    if (!hasAnyTools && prompt[prompt.length - 1].role === 'assistant') {
        prompt[prompt.length - 1][property] = true;
    }
    return prompt;
}

/**
 * Squashes consecutive same-role messages, folding names into content first.
 * @param {object[]} messages Messages
 * @param {object} names Prompt names
 * @param {object} options Merge options
 * @returns {object[]} Merged messages
 */
export function mergeMessages(messages, names, { strict = false, placeholders = false, single = false, tools = false } = {}) {
    const mergedMessages = [];
    const contentTokens = new Map();

    messages.forEach((message) => {
        if (!message.content) {
            message.content = '';
        }
        if (Array.isArray(message.content)) {
            const text = message.content.map((content) => {
                if (content.type === 'text') {
                    return content.text;
                }
                if (['image_url', 'video_url', 'audio_url'].includes(content.type)) {
                    const token = randomToken();
                    contentTokens.set(token, content);
                    return token;
                }
                return '';
            }).join('\n\n');
            message.content = text;
        }
        if (message.role === 'system' && message.name === 'example_assistant') {
            if (names.charName && !message.content.startsWith(`${names.charName}: `) && !names.startsWithGroupName(message.content)) {
                message.content = `${names.charName}: ${message.content}`;
            }
        }
        if (message.role === 'system' && message.name === 'example_user') {
            if (names.userName && !message.content.startsWith(`${names.userName}: `)) {
                message.content = `${names.userName}: ${message.content}`;
            }
        }
        if (message.name && message.role !== 'system') {
            if (!message.content.startsWith(`${message.name}: `)) {
                message.content = `${message.name}: ${message.content}`;
            }
        }
        if (message.role === 'tool' && !tools) {
            message.role = 'user';
        }
        if (single) {
            if (message.role === 'assistant') {
                if (names.charName && !message.content.startsWith(`${names.charName}: `) && !names.startsWithGroupName(message.content)) {
                    message.content = `${names.charName}: ${message.content}`;
                }
            }
            if (message.role === 'user') {
                if (names.userName && !message.content.startsWith(`${names.userName}: `)) {
                    message.content = `${names.userName}: ${message.content}`;
                }
            }
            message.role = 'user';
        }
        delete message.name;
        if (!tools) {
            delete message.tool_calls;
            delete message.tool_call_id;
        }
    });

    messages.forEach((message) => {
        if (mergedMessages.length > 0 && mergedMessages[mergedMessages.length - 1].role === message.role && message.content && message.role !== 'tool') {
            mergedMessages[mergedMessages.length - 1].content += '\n\n' + message.content;
        } else {
            mergedMessages.push(message);
        }
    });

    if (mergedMessages.length === 0) {
        mergedMessages.unshift({ role: 'user', content: PROMPT_PLACEHOLDER });
    }

    if (contentTokens.size > 0) {
        mergedMessages.forEach((message) => {
            const hasValidToken = Array.from(contentTokens.keys()).some(token => message.content.includes(token));
            if (hasValidToken) {
                const splitContent = message.content.split('\n\n');
                const mergedContent = [];
                splitContent.forEach((content) => {
                    if (contentTokens.has(content)) {
                        mergedContent.push(contentTokens.get(content));
                    } else if (mergedContent.length > 0 && mergedContent[mergedContent.length - 1].type === 'text') {
                        mergedContent[mergedContent.length - 1].text += `\n\n${content}`;
                    } else {
                        mergedContent.push({ type: 'text', text: content });
                    }
                });
                message.content = mergedContent;
            }
        });
    }

    if (strict) {
        for (let i = 0; i < mergedMessages.length; i++) {
            if (i > 0 && mergedMessages[i].role === 'system') {
                mergedMessages[i].role = 'user';
            }
        }
        if (mergedMessages.length && placeholders) {
            if (mergedMessages[0].role === 'system' && (mergedMessages.length === 1 || mergedMessages[1].role !== 'user')) {
                mergedMessages.splice(1, 0, { role: 'user', content: PROMPT_PLACEHOLDER });
            } else if (mergedMessages[0].role !== 'system' && mergedMessages[0].role !== 'user') {
                mergedMessages.unshift({ role: 'user', content: PROMPT_PLACEHOLDER });
            }
        }
        return mergeMessages(mergedMessages, names, { strict: false, placeholders, single: false, tools });
    }

    return mergedMessages;
}

/**
 * Applies one post-processing type.
 * @param {object[]} messages Messages
 * @param {string} type Post-processing type
 * @param {object} names Prompt names
 * @returns {object[]} Processed messages
 */
export function postProcessPrompt(messages, type, names) {
    switch (type) {
        case PROMPT_PROCESSING_TYPE.MERGE:
        case PROMPT_PROCESSING_TYPE.CLAUDE:
            return mergeMessages(messages, names, { strict: false, placeholders: false, single: false, tools: false });
        case PROMPT_PROCESSING_TYPE.MERGE_TOOLS:
            return mergeMessages(messages, names, { strict: false, placeholders: false, single: false, tools: true });
        case PROMPT_PROCESSING_TYPE.SEMI:
            return mergeMessages(messages, names, { strict: true, placeholders: false, single: false, tools: false });
        case PROMPT_PROCESSING_TYPE.SEMI_TOOLS:
            return mergeMessages(messages, names, { strict: true, placeholders: false, single: false, tools: true });
        case PROMPT_PROCESSING_TYPE.STRICT:
            return mergeMessages(messages, names, { strict: true, placeholders: true, single: false, tools: false });
        case PROMPT_PROCESSING_TYPE.STRICT_TOOLS:
            return mergeMessages(messages, names, { strict: true, placeholders: true, single: false, tools: true });
        case PROMPT_PROCESSING_TYPE.SINGLE:
            return mergeMessages(messages, names, { strict: true, placeholders: false, single: true, tools: false });
        default:
            return messages;
    }
}

/**
 * Sources whose handler runs its own post-processing regardless of the user's
 * `custom_prompt_post_processing` choice, and any flag the handler sets itself.
 * Read from the source; each entry cites its handler.
 */
export const SOURCE_BEHAVIOUR = Object.freeze({
    // sendDeepSeekRequest()
    deepseek: { forced: PROMPT_PROCESSING_TYPE.SEMI_TOOLS, prefixProperty: 'prefix', thinkingFromIncludeReasoning: true },
    // sendMinimaxRequest()
    minimax: { forced: PROMPT_PROCESSING_TYPE.MERGE_TOOLS, prefixProperty: null, thinkingFromIncludeReasoning: false },
    // router.post('/generate'), PERPLEXITY branch
    perplexity: { forced: PROMPT_PROCESSING_TYPE.STRICT, prefixProperty: null, thinkingFromIncludeReasoning: false },
    // router.post('/generate'), MOONSHOT branch
    moonshot: { forced: null, prefixProperty: 'partial', thinkingFromIncludeReasoning: true },
    // router.post('/generate'), ZAI branch
    zai: { forced: null, prefixProperty: null, thinkingFromIncludeReasoning: true },
    // router.post('/generate'), OPENROUTER branch — reasoning.exclude
    openrouter: { forced: null, prefixProperty: null, thinkingFromIncludeReasoning: true },
    // router.post('/generate'), CUSTOM branch — no handler post-processing
    custom: { forced: null, prefixProperty: null, thinkingFromIncludeReasoning: false },
});

/**
 * Runs a generate_data object through the server exactly as `/generate` does,
 * and reports what the provider receives.
 *
 * @param {object} generateData The object emitted with CHAT_COMPLETION_SETTINGS_READY
 * @returns {{messages: object[], thinkingEnabled: (boolean|null)}} Outbound payload
 */
export function deliver(generateData) {
    // JSON round-trip: the client serialises, so the server sees a deep copy and
    // nothing survives by reference.
    const body = JSON.parse(JSON.stringify(generateData));
    const names = getPromptNames(body);
    const source = String(body.chat_completion_source || 'custom');
    const behaviour = SOURCE_BEHAVIOUR[source] ?? SOURCE_BEHAVIOUR.custom;

    // router.post('/generate') applies the user's choice first, for every source.
    if (Array.isArray(body.messages) && body.custom_prompt_post_processing) {
        body.messages = postProcessPrompt(body.messages, body.custom_prompt_post_processing, names);
    }

    // Then the per-source handler runs, and several run their own unconditionally.
    if (behaviour.forced !== null) {
        body.messages = postProcessPrompt(body.messages, behaviour.forced, names);
    }
    if (behaviour.prefixProperty && !body.json_schema) {
        addAssistantPrefix(body.messages, body.tools ?? [], behaviour.prefixProperty);
    }

    return {
        messages: body.messages,
        thinkingEnabled: behaviour.thinkingFromIncludeReasoning ? Boolean(body.include_reasoning) : null,
    };
}
