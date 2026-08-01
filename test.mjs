/**
 * Prefill Control — gate.
 *
 * Runs the real engine against real generate_data shapes. Exits 1 on any failure.
 *   node test.mjs
 */

import {
    normaliseFieldName,
    RESERVED_FIELDS,
    applyPrefill,
    buildReasoningPattern,
    escapeRegExp,
    hasTools,
    isEligibleType,
    serverWillMerge,
    serverWillCollapse,
    targetWillBeMergedAway,
    serverPostProcessingChain,
    DEFAULT_CONFIG,
    ENGINE_VERSION,
    PROFILES,
    REASON,
} from './engine.js';

let passed = 0;
const failures = [];

function check(name, condition, extra) {
    if (condition) {
        passed++;
        return;
    }
    failures.push(extra === undefined ? name : `${name} :: ${JSON.stringify(extra)}`);
}

function eq(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    check(name, a === e, { actual: a, expected: e });
}

/** Minimal generate_data resembling what createGenerationParameters() produces. */
function makeData(overrides = {}) {
    return {
        type: 'normal',
        messages: [
            { role: 'system', content: 'You are a narrator.' },
            { role: 'user', content: 'Jovan draws his blade.' },
        ],
        model: 'some-model',
        chat_completion_source: 'custom',
        custom_prompt_post_processing: '',
        stream: true,
        ...overrides,
    };
}

const ON = { ...DEFAULT_CONFIG, enabled: true };

// ---------------------------------------------------------------- helpers

eq('escapeRegExp escapes metacharacters', escapeRegExp('<a.b*c>'), '<a\\.b\\*c>');
check('buildReasoningPattern returns RegExp', buildReasoningPattern('<think>', '</think>') instanceof RegExp);
check('pattern matches closed tag', '<think>hello</think>rest'.match(buildReasoningPattern('<think>', '</think>'))[1] === 'hello');
check('pattern matches unclosed tag', '<think>hello'.match(buildReasoningPattern('<think>', '</think>'))[1] === 'hello');
check('pattern tolerates leading whitespace', '\n  <think>hi</think>'.match(buildReasoningPattern('<think>', '</think>')) !== null);
check('pattern rejects mid-string tag', 'text <think>hi</think>'.match(buildReasoningPattern('<think>', '</think>')) === null);
check('pattern spans newlines', '<think>a\nb</think>'.match(buildReasoningPattern('<think>', '</think>'))[1] === 'a\nb');
check('pattern with regex-hostile tag', '[[t]]x'.match(buildReasoningPattern('[[t]]', ''))[1] === 'x');

check('serverWillMerge false on empty', serverWillMerge({ custom_prompt_post_processing: '' }) === false);
check('serverWillMerge true on merge', serverWillMerge({ custom_prompt_post_processing: 'merge' }) === true);
check('serverWillMerge true on semi', serverWillMerge({ custom_prompt_post_processing: 'semi' }) === true);
check('serverWillMerge true on strict', serverWillMerge({ custom_prompt_post_processing: 'strict' }) === true);
check('serverWillMerge true on a source that forces its own',
    serverWillMerge({ custom_prompt_post_processing: '', chat_completion_source: 'deepseek' }) === true);
check('serverWillMerge false on a source that does not',
    serverWillMerge({ custom_prompt_post_processing: '', chat_completion_source: 'custom' }) === false);
eq('post-processing chain is user choice then source-forced',
    serverPostProcessingChain({ custom_prompt_post_processing: 'merge', chat_completion_source: 'deepseek' }),
    ['merge', 'semi_tools']);
eq('post-processing chain is empty when nothing applies',
    serverPostProcessingChain({ custom_prompt_post_processing: '', chat_completion_source: 'custom' }), []);
eq('post-processing chain carries a forced pass with no user choice',
    serverPostProcessingChain({ custom_prompt_post_processing: '', chat_completion_source: 'perplexity' }), ['strict']);
check('serverWillCollapse only on single',
    serverWillCollapse({ custom_prompt_post_processing: 'single' }) === true
    && serverWillCollapse({ custom_prompt_post_processing: 'merge' }) === false);

check('type normal eligible', isEligibleType('normal', ON) === true);
check('type undefined eligible', isEligibleType(undefined, ON) === true);
check('type swipe eligible', isEligibleType('swipe', ON) === true);
check('type regenerate eligible', isEligibleType('regenerate', ON) === true);
check('type quiet excluded by default', isEligibleType('quiet', ON) === false);
check('type impersonate excluded by default', isEligibleType('impersonate', ON) === false);
check('type continue included by default', isEligibleType('continue', ON) === true);
check('type quiet opt-in', isEligibleType('quiet', { ...ON, applyToQuiet: true }) === true);
check('type QUIET case-insensitive', isEligibleType('QUIET', ON) === false);

check('hasTools false on plain', hasTools(makeData()) === false);
check('hasTools true on tools array', hasTools(makeData({ tools: [{ type: 'function' }] })) === true);
check('hasTools true on tool role', hasTools(makeData({
    messages: [{ role: 'tool', content: 'x', tool_call_id: '1' }],
})) === true);
check('hasTools true on tool_calls', hasTools(makeData({
    messages: [{ role: 'assistant', content: '', tool_calls: [{ id: '1' }] }],
})) === true);

// ---------------------------------------------------------------- gating

eq('disabled is a no-op', applyPrefill(makeData(), DEFAULT_CONFIG).reason, REASON.DISABLED);
eq('no messages', applyPrefill(makeData({ messages: [] }), ON).reason, REASON.NO_MESSAGES);
eq('null data', applyPrefill(null, ON).reason, REASON.NO_MESSAGES);
eq('dry run', applyPrefill(makeData({ dryRun: true }), ON).reason, REASON.DRY_RUN);
eq('quiet excluded', applyPrefill(makeData({ type: 'quiet' }), ON).reason, REASON.TYPE_EXCLUDED);
eq('impersonate excluded', applyPrefill(makeData({ type: 'impersonate' }), ON).reason, REASON.TYPE_EXCLUDED);
eq('json schema excluded', applyPrefill(makeData({ json_schema: { value: {} } }), ON).reason, REASON.JSON_SCHEMA);
eq('tools excluded', applyPrefill(makeData({ tools: [{ type: 'function' }] }), ON).reason, REASON.TOOLS_PRESENT);
eq('single post-processing excluded', applyPrefill(
    makeData({ custom_prompt_post_processing: 'single' }), ON).reason, REASON.SINGLE_POST_PROCESSING);
eq('no assistant tail in preset mode', applyPrefill(
    makeData(), { ...ON, source: 'preset' }).reason, REASON.NO_ASSISTANT_TAIL);
eq('default source works without preset editing', DEFAULT_CONFIG.source, 'extension');
eq('default appends rather than skipping', applyPrefill(makeData(), ON).reason, REASON.APPLIED);
eq('empty prefill text in extension mode', applyPrefill(
    makeData(), { ...ON, source: 'extension', text: '   ' }).reason, REASON.EMPTY_PREFILL);

{
    const cfg = { ...ON, flagField: '', thinkingEnabled: false };
    const data = makeData();
    data.messages.push({ role: 'assistant', content: 'x' });
    eq('nothing to do when both channels off', applyPrefill(data, cfg).reason, REASON.NOTHING_TO_DO);
}

// ---------------------------------------------------------------- thinking prefill

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: '<think>I should continue the story.' });
    const report = applyPrefill(data, { ...ON, flagField: 'partial', reasoningField: 'reasoning_content' });
    const tail = data.messages.at(-1);
    eq('thinking prefill applied', report.reason, REASON.APPLIED);
    eq('reasoning_content extracted', tail.reasoning_content, 'I should continue the story.');
    eq('content emptied', tail.content, '');
    eq('partial flag set', tail.partial, true);
    eq('role untouched', tail.role, 'assistant');
    check('no stray think tag left', !JSON.stringify(tail).includes('<think>'));
    eq('exact wire shape', Object.keys(tail).sort(), ['content', 'partial', 'reasoning_content', 'role']);
}

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: '<think>Reason first.</think>Then the prose.' });
    applyPrefill(data, ON);
    const tail = data.messages.at(-1);
    eq('closed tag splits both channels (reasoning)', tail.reasoning_content, 'Reason first.');
    eq('closed tag splits both channels (content)', tail.content, 'Then the prose.');
}

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: 'Plain content prefill.' });
    applyPrefill(data, ON);
    const tail = data.messages.at(-1);
    eq('content prefill keeps content', tail.content, 'Plain content prefill.');
    eq('content prefill has no reasoning field', tail.reasoning_content, undefined);
    eq('content prefill still flagged', tail.partial, true);
}

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: '<think>x' });
    applyPrefill(data, { ...ON, thinkingEnabled: false });
    const tail = data.messages.at(-1);
    eq('thinking disabled leaves content intact', tail.content, '<think>x');
    eq('thinking disabled writes no reasoning', tail.reasoning_content, undefined);
}

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: '<think>x' });
    applyPrefill(data, { ...ON, flagField: '' });
    const tail = data.messages.at(-1);
    eq('empty flagField writes no flag', tail.partial, undefined);
    eq('empty flagField still splits reasoning', tail.reasoning_content, 'x');
}

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: '<think>x' });
    applyPrefill(data, { ...ON, flagField: 'prefix' });
    eq('deepseek prefix flag', data.messages.at(-1).prefix, true);
}

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: '[[reason]]deep' });
    applyPrefill(data, { ...ON, openTag: '[[reason]]', closeTag: '' });
    eq('custom open tag, no close tag', data.messages.at(-1).reasoning_content, 'deep');
}

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'multimodal' }] });
    const report = applyPrefill(data, ON);
    const tail = data.messages.at(-1);
    eq('array content still applies', report.reason, REASON.APPLIED);
    eq('array content untouched', tail.content, [{ type: 'text', text: 'multimodal' }]);
    eq('array content flagged', tail.partial, true);
}

// ---------------------------------------------------------------- extension-sourced prefill

{
    const data = makeData();
    const report = applyPrefill(data, { ...ON, source: 'extension', text: '<think>Seeded.' });
    const tail = data.messages.at(-1);
    eq('extension mode appends', report.reason, REASON.APPLIED);
    eq('extension mode length', data.messages.length, 3);
    eq('extension mode reasoning', tail.reasoning_content, 'Seeded.');
    eq('extension mode empty content', tail.content, '');
    eq('extension mode flag', tail.partial, true);
}

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: 'Existing partial reply' });
    applyPrefill(data, { ...ON, source: 'extension', text: '<think>Should not appear.' });
    eq('extension mode does not append over an assistant tail', data.messages.length, 3);
    eq('extension mode preserves existing continue text', data.messages.at(-1).content, 'Existing partial reply');
    eq('extension mode flags the existing tail', data.messages.at(-1).partial, true);
}

// ---------------------------------------------------------------- merge guard

{
    const data = makeData({ custom_prompt_post_processing: 'merge' });
    data.messages.push({ role: 'assistant', content: 'Earlier assistant turn.' });
    data.messages.push({ role: 'assistant', content: 'Continue like this.' });
    const report = applyPrefill(data, ON);
    const tail = data.messages.at(-1);
    eq('merge guard fires', report.detail.premerged, true);
    eq('merge guard collapses tail', data.messages.length, 3);
    eq('merge guard concatenates', tail.content, 'Earlier assistant turn.\n\nContinue like this.');
    eq('merge guard flags survivor', tail.partial, true);
}

{
    const data = makeData({ custom_prompt_post_processing: 'merge' });
    data.messages.push({ role: 'assistant', content: 'Earlier assistant turn.' });
    data.messages.push({ role: 'assistant', content: '<think>Seeded thought.' });
    const report = applyPrefill(data, ON);
    eq('empty content after split is unmergeable', report.detail.premerged, undefined);
    eq('unmergeable tail stays separate', data.messages.length, 4);
    eq('unmergeable tail keeps reasoning', data.messages.at(-1).reasoning_content, 'Seeded thought.');
}

{
    const data = makeData({ custom_prompt_post_processing: '' });
    data.messages.push({ role: 'assistant', content: 'Earlier assistant turn.' });
    data.messages.push({ role: 'assistant', content: 'Continue like this.' });
    const report = applyPrefill(data, ON);
    eq('no merge guard without post-processing', report.detail.premerged, undefined);
    eq('no merge guard keeps both', data.messages.length, 4);
}

{
    const data = makeData({ custom_prompt_post_processing: 'merge' });
    data.messages.push({ role: 'assistant', content: 'Earlier assistant turn.' });
    data.messages.push({ role: 'assistant', content: 'Continue like this.' });
    const report = applyPrefill(data, { ...ON, mergeGuard: false });
    eq('merge guard can be disabled', report.detail.premerged, undefined);
    eq('merge guard disabled keeps both', data.messages.length, 4);
}

{
    const data = makeData({ custom_prompt_post_processing: 'merge' });
    data.messages.push({ role: 'user', content: 'Last user turn.' });
    data.messages.push({ role: 'assistant', content: 'Continue like this.' });
    const report = applyPrefill(data, ON);
    eq('merge guard ignores non-assistant predecessor', report.detail.premerged, undefined);
    eq('merge guard leaves user turn alone', data.messages.length, 4);
}

// ---------------------------------------------------------------- merge risk is a property of the message

{
    // The flag and the reasoning seed live on the same object and are discarded
    // together. Risk is therefore reported for the message, not for whichever
    // field happened to be configured.
    const base = () => {
        const data = makeData({ custom_prompt_post_processing: 'merge' });
        data.messages.push({ role: 'assistant', content: 'Earlier assistant turn.' });
        data.messages.push({ role: 'assistant', content: '<think>Seed.</think>Leftover text.' });
        return data;
    };

    const withFlag = applyPrefill(base(), { ...ON, mergeGuard: false });
    eq('risk reported with a flag configured', withFlag.detail.mergeRisk, true);

    const noFlag = applyPrefill(base(), { ...ON, mergeGuard: false, flagField: '' });
    eq('risk reported with no flag configured', noFlag.detail.mergeRisk, true);
    eq('the seed at risk is still named', noFlag.detail.reasoningField, 'reasoning_content');

    const guarded = applyPrefill(base(), ON);
    eq('the guard removes the risk', guarded.detail.mergeRisk, undefined);
    eq('the guard folded the run', guarded.detail.premerged, true);
}

{
    // An emptied tail is not merged by the server, because the squash tests the
    // message's own content for truthiness. That is not a risk and must not be
    // reported as one.
    const data = makeData({ custom_prompt_post_processing: 'merge' });
    data.messages.push({ role: 'assistant', content: 'Earlier assistant turn.' });
    data.messages.push({ role: 'assistant', content: '<think>Seeded thought.' });
    const report = applyPrefill(data, { ...ON, mergeGuard: false });
    eq('an emptied tail is not reported at risk', report.detail.mergeRisk, undefined);
}

{
    // ...but the name fold makes it non-empty again, so it is.
    const data = makeData({ custom_prompt_post_processing: 'merge', char_name: 'Nyx' });
    data.messages.push({ role: 'assistant', content: 'Earlier assistant turn.' });
    data.messages.push({ role: 'assistant', content: '<think>Seeded thought.', name: 'Nyx' });
    const report = applyPrefill(data, { ...ON, mergeGuard: false });
    eq('a folded name makes an emptied tail mergeable', report.detail.mergeRisk, true);
}

{
    // The guard cannot reproduce the server's media flattening, so it stands
    // down — and the server merges anyway. That is the one risk that exists
    // with the guard switched on, and it has to be reported.
    const data = makeData({ custom_prompt_post_processing: 'merge' });
    data.messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: 'He waited.' }, { type: 'image_url', image_url: { url: 'data:x;base64,AAA' } }],
    });
    data.messages.push({ role: 'assistant', content: '<think>Seed.</think>He stepped through.' });
    const report = applyPrefill(data, ON);
    eq('a multimodal predecessor defeats the guard', report.detail.premerged, undefined);
    eq('and that is reported as a risk', report.detail.mergeRisk, true);
}

{
    // No post-processing anywhere: nothing merges, nothing is at risk.
    const data = makeData({ custom_prompt_post_processing: '' });
    data.messages.push({ role: 'assistant', content: 'Earlier assistant turn.' });
    data.messages.push({ role: 'assistant', content: '<think>Seed.</think>Leftover.' });
    const report = applyPrefill(data, { ...ON, mergeGuard: false });
    eq('no merging server, no risk', report.detail.mergeRisk, undefined);
}

{
    // A source that post-processes on its own is a merging server even when the
    // user selected None.
    const data = makeData({ custom_prompt_post_processing: '', chat_completion_source: 'deepseek' });
    data.messages.push({ role: 'assistant', content: 'Earlier assistant turn.' });
    data.messages.push({ role: 'assistant', content: '<think>Seed.</think>Leftover.' });
    const report = applyPrefill(data, { ...ON, mergeGuard: false, flagField: 'prefix' });
    eq('forced post-processing counts as merging', report.detail.mergeRisk, true);
}

{
    // A seed that will not arrive is not a seed. Opening the provider's
    // thinking channel for it changes behaviour with nothing to show for it.
    const data = makeData({ custom_prompt_post_processing: 'merge' });
    data.include_reasoning = false;
    data.messages.push({ role: 'assistant', content: 'Earlier assistant turn.' });
    data.messages.push({ role: 'assistant', content: '<think>Seed.</think>Leftover text.' });
    const report = applyPrefill(data, { ...ON, mergeGuard: false });
    eq('a doomed seed is reported at risk', report.detail.mergeRisk, true);
    eq('a doomed seed does not open the thinking channel', data.include_reasoning, false);
    eq('and does not claim it did', report.detail.thinkingForced, undefined);
}

{
    // The same request with the guard on does open it, because the seed arrives.
    const data = makeData({ custom_prompt_post_processing: 'merge' });
    data.include_reasoning = false;
    data.messages.push({ role: 'assistant', content: 'Earlier assistant turn.' });
    data.messages.push({ role: 'assistant', content: '<think>Seed.</think>Leftover text.' });
    applyPrefill(data, ON);
    eq('a surviving seed opens the thinking channel', data.include_reasoning, true);
}

{
    // targetWillBeMergedAway is the single predicate. Exercise it directly.
    const merging = { custom_prompt_post_processing: 'merge' };
    const run = [{ role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' }];
    eq('predicate: mergeable run', targetWillBeMergedAway(merging, run, 1), true);
    eq('predicate: index 0 has no predecessor', targetWillBeMergedAway(merging, run, 0), false);
    eq('predicate: non-merging server',
        targetWillBeMergedAway({ custom_prompt_post_processing: '' }, run, 1), false);
    eq('predicate: user predecessor',
        targetWillBeMergedAway(merging, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], 1), false);
    eq('predicate: empty target survives',
        targetWillBeMergedAway(merging, [{ role: 'assistant', content: 'a' }, { role: 'assistant', content: '' }], 1), false);
    eq('predicate: unpredictable content counts as at risk',
        targetWillBeMergedAway(merging, [{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: 'b' }], 1), true);
    eq('predicate: missing message is not a risk', targetWillBeMergedAway(merging, run, 9), false);
}

// ---------------------------------------------------------------- non-mutation of unrelated turns

{
    const data = makeData();
    const before = JSON.stringify(data.messages.slice(0, 2));
    data.messages.push({ role: 'assistant', content: '<think>x' });
    applyPrefill(data, ON);
    eq('earlier turns untouched', JSON.stringify(data.messages.slice(0, 2)), before);
}

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: '<think>x' });
    const keysBefore = Object.keys(data).sort().join(',');
    applyPrefill(data, ON);
    const added = Object.keys(data).filter(k => !keysBefore.split(',').includes(k));
    eq('engine adds no top-level key other than include_reasoning', added, ['include_reasoning']);
}

// ---------------------------------------------------------------- idempotence

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: '<think>Once.' });
    applyPrefill(data, ON);
    const first = JSON.stringify(data.messages);
    applyPrefill(data, ON);
    eq('second pass is a no-op', JSON.stringify(data.messages), first);
}

// ---------------------------------------------------------------- field name validation

for (const reserved of RESERVED_FIELDS) {
    check(`reserved field rejected: ${reserved}`, normaliseFieldName(reserved).valid === false);
}
check('empty field name is valid and means "none"', normaliseFieldName('').valid === true);
eq('whitespace-only field name normalises to none', normaliseFieldName('   ').name, '');
eq('surrounding whitespace trimmed', normaliseFieldName('  partial  ').name, 'partial');
check('inner space rejected', normaliseFieldName('has space').valid === false);
check('leading digit rejected', normaliseFieldName('1partial').valid === false);
check('hyphen rejected', normaliseFieldName('reasoning-content').valid === false);
check('underscore accepted', normaliseFieldName('reasoning_content').valid === true);
check('leading underscore accepted', normaliseFieldName('_x').valid === true);

for (const bad of ['content', 'role', '__proto__', 'tool_calls', 'has space']) {
    const data = makeData();
    data.messages.push({ role: 'assistant', content: '<think>seed' });
    const before = JSON.stringify(data.messages);
    const report = applyPrefill(data, { ...ON, flagField: bad });
    eq(`bad flag field skips: ${bad}`, report.reason, REASON.BAD_FIELD_NAME);
    eq(`bad flag field leaves the request untouched: ${bad}`, JSON.stringify(data.messages), before);
    check(`bad flag field explains itself: ${bad}`, typeof report.detail.error === 'string' && report.detail.error.length > 0);
}

for (const bad of ['role', 'content', 'name']) {
    const data = makeData();
    data.messages.push({ role: 'assistant', content: '<think>seed' });
    const before = JSON.stringify(data.messages);
    const report = applyPrefill(data, { ...ON, reasoningField: bad });
    eq(`bad reasoning field skips: ${bad}`, report.reason, REASON.BAD_FIELD_NAME);
    eq(`bad reasoning field leaves the request untouched: ${bad}`, JSON.stringify(data.messages), before);
}

{
    const data = makeData();
    data.messages.push({ role: 'assistant', content: '<think>seed' });
    applyPrefill(data, { ...ON, flagField: '  partial  ', reasoningField: ' reasoning_content ' });
    eq('field names are trimmed before use',
        Object.keys(data.messages.at(-1)).sort(), ['content', 'partial', 'reasoning_content', 'role']);
}

// ---------------------------------------------------------------- profiles

check('every profile has both fields', Object.values(PROFILES).every(
    p => typeof p.flagField === 'string' && typeof p.reasoningField === 'string' && typeof p.label === 'string'));
eq('moonshot profile', [PROFILES.moonshot.flagField, PROFILES.moonshot.reasoningField], ['partial', 'reasoning_content']);
eq('deepseek profile', [PROFILES.deepseek.flagField, PROFILES.deepseek.reasoningField], ['prefix', 'reasoning_content']);
eq('claude profile is native', [PROFILES.claude.flagField, PROFILES.claude.reasoningField], ['', '']);
check('no profile mentions a specific model version', Object.values(PROFILES).every(
    p => !/k2|k3|glm-|gpt-|sonnet|opus/i.test(p.label + p.flagField + p.reasoningField)));
check('every profile field name is usable', Object.values(PROFILES).every(
    p => normaliseFieldName(p.flagField).valid && normaliseFieldName(p.reasoningField).valid));

// ---------------------------------------------------------------- version stamp

{
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile('./manifest.json', 'utf8'));
    const index = await (await import('node:fs/promises')).readFile('./index.js', 'utf8');
    eq('manifest version matches engine', manifest.version, ENGINE_VERSION);
    check('index.js stamps the same version', index.includes(`EXTENSION_VERSION = '${ENGINE_VERSION}'`),
        { engine: ENGINE_VERSION });
}

// ---------------------------------------------------------------- result

if (failures.length) {
    console.error(`\nFAIL — ${failures.length} of ${passed + failures.length} checks failed:\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
}
console.log(`PASS — ${passed} checks green (engine ${ENGINE_VERSION})`);
