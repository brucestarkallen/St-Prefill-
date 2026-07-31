/**
 * Prefill Control — negative gate.
 *
 * A guard that has never failed is unproven. This reintroduces each bug in a
 * scratch tree and asserts the gate rejects it with exit code 1.
 *   node negative_test.mjs
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Each mutation is [name, file, exactOldString, newString, gate]. */
const MUTATIONS = [
    ['quiet generations are no longer skipped', 'engine.js',
        'return Boolean(cfg.applyToQuiet);', 'return true;'],
    ['impersonation is no longer skipped', 'engine.js',
        'return Boolean(cfg.applyToImpersonate);', 'return true;'],
    ['tool requests are no longer skipped', 'engine.js',
        'if (cfg.skipOnTools && hasTools(data)) {', 'if (false) {'],
    ['tool_calls no longer count as tools', 'engine.js',
        "return data.messages.some(m => m?.role === 'tool' || Boolean(m?.tool_calls));",
        "return data.messages.some(m => m?.role === 'tool');"],
    ['json schema requests are no longer skipped', 'engine.js',
        'if (cfg.skipOnJsonSchema && data.json_schema) {', 'if (false) {'],
    ['single post-processing is no longer skipped', 'engine.js',
        'if (serverWillCollapse(data)) {', 'if (false) {'],
    ['dry runs are no longer skipped', 'engine.js',
        'if (data.dryRun === true) {', 'if (false) {'],
    ['merge guard no longer fires', 'engine.js',
        'if (cfg.mergeGuard && serverWillMerge(data)) {', 'if (false) {'],
    ['merge guard fires without post-processing', 'engine.js',
        'if (cfg.mergeGuard && serverWillMerge(data)) {', 'if (cfg.mergeGuard) {'],
    ['merge guard ignores predecessor role', 'engine.js',
        "            if (previous?.role !== 'assistant') {", '            if (previous === undefined) {'],
    ['reasoning pattern is no longer anchored to the start', 'engine.js',
        'return new RegExp(`^\\\\s*${open}([\\\\s\\\\S]*?)(?:${close})`);',
        'return new RegExp(`\\\\s*${open}([\\\\s\\\\S]*?)(?:${close})`);'],
    ['reasoning tag is no longer escaped', 'engine.js',
        'const open = escapeRegExp(openTag);', 'const open = openTag;'],
    ['content is not emptied after the split', 'engine.js',
        'target.content = target.content.replace(pattern, \'\').trimStart();',
        'target.content = target.content;'],
    ['continuation flag is never written', 'engine.js',
        'target[flag.name] = true;', 'void flag.name;'],
    ['extension mode overwrites an existing assistant tail', 'engine.js',
        '    if (!tailIsAssistant) {', '    if (true) {'],
    ['empty prefill text is accepted', 'engine.js',
        "if (!String(cfg.text ?? '').trim()) {", 'if (false) {'],
    ['version stamp drifts', 'manifest.json',
        '"version": "1.4.0"', '"version": "9.9.9"'],
    ['the default stops working without preset editing', 'engine.js',
        "source: 'extension',", "source: 'preset',"],

    // index.js — proven by the load gate.
    ['the hook is never registered', 'index.js',
        'eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);',
        'void onSettingsReady;', 'load_test.mjs'],
    ['the hook is registered twice', 'index.js',
        'eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);',
        'eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);'
        + ' eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);', 'load_test.mjs'],
    ['the UI is never mounted', 'index.js',
        "document.getElementById('extensions_settings').insertAdjacentHTML('beforeend', template());",
        'void template;', 'load_test.mjs'],
    ['engine exceptions escape into SillyTavern', 'index.js',
        'try {\n        report = applyPrefill(generateData, settings());\n    } catch (error) {',
        'try {\n        report = applyPrefill(generateData, settings());\n    } catch (error) {\n        throw error;\n    }\n    if (false) {', 'load_test.mjs'],
    ['the extension ships switched on', 'engine.js',
        'enabled: false,', 'enabled: true,', 'load_test.mjs'],
    ['a control loses its pfc_ prefix', 'index.js',
        'id="${UI}_mergeGuard"', 'id="mergeGuard"', 'load_test.mjs'],
    ['settings changes stop persisting', 'index.js',
        '            s[key] = e.target.checked;\n            persist();',
        '            s[key] = e.target.checked;', 'load_test.mjs'],
    ['the profile dropdown stops writing fields', 'index.js',
        's.flagField = profile.flagField;', 'void profile.flagField;', 'load_test.mjs'],
    ['the decision log is never recorded', 'index.js',
        'record(report, generateData);', 'void record;', 'load_test.mjs'],
    ['the decision log never repaints after a request', 'index.js',
        'record(report, generateData);\n    renderStatus();\n    renderLog();',
        'record(report, generateData);\n    renderStatus();', 'load_test.mjs'],
    ['the log stops truncating long fields', 'index.js',
        'return text.length > LOG_FIELD_CHARS', 'return false', 'load_test.mjs'],
    ['the log grows without bound', 'index.js',
        'if (decisionLog.length > LOG_LIMIT) {', 'if (false) {', 'load_test.mjs'],
    ['clearing the log stops working', 'index.js',
        'decisionLog.length = 0;', 'void decisionLog;', 'load_test.mjs'],
    // Defects found in the 1.3.0 audit.
    ['reserved field names are accepted again', 'engine.js',
        'if (RESERVED_FIELDS.includes(name)) {', 'if (false) {'],
    ['reserved field names slip past the fuzz invariants', 'engine.js',
        'if (RESERVED_FIELDS.includes(name)) {', 'if (false) {', 'fuzz_test.mjs'],
    ['a truthy stand-in is written instead of true', 'engine.js',
        'target[flag.name] = true;', "target[flag.name] = 1;", 'fuzz_test.mjs'],
    ['field names are no longer shape-checked', 'engine.js',
        'if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {', 'if (false) {'],
    ['field names are no longer trimmed', 'engine.js',
        "const name = String(raw ?? '').trim();", "const name = String(raw ?? '');"],
    ['validation runs after the request is already mutated', 'engine.js',
        'if (!flag.valid || !reasoning.valid) {', 'if (false) {'],
    ['the log keeps object fields by reference', 'index.js',
        "    let text;\n    if (typeof value === 'string') {\n        text = value;\n    } else {\n        try {\n            text = JSON.stringify(value);\n        } catch {\n            text = '[value could not be read]';\n        }\n    }",
        "    if (typeof value !== 'string') {\n        return value;\n    }\n    const text = value;", 'load_test.mjs'],
    ['a second load mounts a duplicate copy', 'index.js',
        'if (globalThis[MOUNT_FLAG]) {', 'if (false) {', 'load_test.mjs'],
    ['reset fires on a single tap with no confirmation', 'index.js',
        'if (resetArmed) {', 'if (true) {', 'load_test.mjs'],
    ['reset swaps the settings object instead of refilling it', 'index.js',
        '    const store = settings();\n    for (const key of Object.keys(store)) {\n        delete store[key];\n    }\n    Object.assign(store, DEFAULT_CONFIG);',
        '    ctx().extensionSettings[MODULE] = { ...DEFAULT_CONFIG };\n    const store = ctx().extensionSettings[MODULE];\n    void store;', 'load_test.mjs'],
    ['reset leaves stale keys from older versions behind', 'index.js',
        '    for (const key of Object.keys(store)) {\n        delete store[key];\n    }\n', '', 'load_test.mjs'],
    ['reset does not persist', 'index.js',
        'Object.assign(store, DEFAULT_CONFIG);\n    persist();',
        'Object.assign(store, DEFAULT_CONFIG);', 'load_test.mjs'],
    ['reset does not repaint the inputs', 'index.js',
        'disarmReset();\n    syncFromSettings();', 'disarmReset();', 'load_test.mjs'],
    ['reset stays armed after firing', 'index.js',
        'persist();\n    disarmReset();', 'persist();', 'load_test.mjs'],
    ['reset wipes the decision log too', 'index.js',
        'Object.assign(store, DEFAULT_CONFIG);\n    persist();',
        'Object.assign(store, DEFAULT_CONFIG);\n    decisionLog.length = 0;\n    persist();', 'load_test.mjs'],
    ['copy throws when no clipboard exists', 'index.js',
        '            await globalThis.navigator.clipboard.writeText(text);\n        } catch {',
        '            await globalThis.navigator.clipboard.writeText(text);\n        } finally {\n            void 0;\n        }\n        if (false) {',
        'load_test.mjs'],

    // Defects found in the 1.4.0 audit, each proven against the server simulator.
    ['the merge guard goes blind to source-forced post-processing', 'engine.js',
        "    const forced = SOURCE_FORCED_POST_PROCESSING[String(data?.chat_completion_source || '')];\n    if (forced) {\n        chain.push(forced);\n    }\n",
        '', 'wire_test.mjs'],
    ['the name fold is dropped from server-visible content', 'engine.js',
        '    return content.startsWith(`${name}: `) ? content : `${name}: ${content}`;',
        '    return content;', 'wire_test.mjs'],
    ['the premerge stops folding the name', 'engine.js',
        'const targetContent = serverVisibleContent(target);',
        'const targetContent = typeof target.content === \'string\' ? target.content : null;', 'wire_test.mjs'],
    ['the premerge collapses one turn instead of the run', 'engine.js',
        '            detail.premerged = true;\n        }',
        '            detail.premerged = true;\n            break;\n        }', 'wire_test.mjs'],
    ['colliding flag and reasoning names are accepted', 'engine.js',
        'if (flag.name && flag.name === reasoning.name) {', 'if (false) {', 'wire_test.mjs'],
    ['the thinking channel is no longer opened for a seed', 'engine.js',
        'if (cfg.ensureThinking && detail.reasoningField && !data.include_reasoning) {',
        'if (false) {', 'wire_test.mjs'],
    ['the thinking channel is opened when nothing was seeded', 'engine.js',
        'if (cfg.ensureThinking && detail.reasoningField && !data.include_reasoning) {',
        'if (cfg.ensureThinking && !data.include_reasoning) {', 'wire_test.mjs'],
    ['a multimodal tail behind a merging server is flagged anyway', 'engine.js',
        '        && serverVisibleContent(messages[messages.length - 1]) === null) {',
        '        && false) {', 'wire_test.mjs'],
    ['the skip path is allowed to mutate before returning', 'engine.js',
        '    if (!flag.name && !willSplit && !willAppend) {\n        return { applied: false, reason: REASON.NOTHING_TO_DO, detail };\n    }',
        '    if (false) {\n        return { applied: false, reason: REASON.NOTHING_TO_DO, detail };\n    }',
        'wire_test.mjs'],
    ['an unsurvivable flag is reported as a clean success', 'engine.js',
        'if (!cfg.mergeGuard && serverWillMerge(data) && messages[index - 1]?.role === \'assistant\') {',
        'if (false) {', 'fuzz_test.mjs'],
    ['the reasoning field is written even when empty', 'engine.js',
        '        if (extracted) {', '        if (true) {', 'fuzz_test.mjs'],
];

const source = process.cwd();
const TREE_FILES = ['engine.js', 'index.js', 'test.mjs', 'load_test.mjs', 'fuzz_test.mjs',
    'wire_test.mjs', 'st_sim.mjs', 'manifest.json', 'package.json'];

/**
 * Builds a scratch copy of the extension. node_modules is linked rather than
 * copied so gates with real dependencies resolve them; without this a missing
 * dependency exits 1 and every mutation reads as caught when nothing was.
 * @returns {string} Scratch directory path
 */
function scratchTree() {
    const dir = mkdtempSync(join(tmpdir(), 'pfc-neg-'));
    for (const f of TREE_FILES) {
        cpSync(join(source, f), join(dir, f));
    }
    symlinkSync(join(source, 'node_modules'), join(dir, 'node_modules'), 'dir');
    return dir;
}

/**
 * Runs a gate in a directory and returns its exit code.
 * @param {string} dir Working directory
 * @param {string} gate Gate filename
 * @returns {number} Exit code
 */
function runGate(dir, gate) {
    try {
        execFileSync(process.execPath, [gate], { cwd: dir, stdio: 'pipe' });
        return 0;
    } catch (error) {
        return error.status ?? -1;
    }
}

let proven = 0;
const unproven = [];
const controlCount = new Set(MUTATIONS.map(m => m[4] || 'test.mjs')).size;

// Control. An unmutated scratch tree must pass every gate this harness drives.
// If it does not, a mutation exiting 1 proves nothing about the mutation.
for (const gate of [...new Set(MUTATIONS.map(m => m[4] || 'test.mjs'))]) {
    const dir = scratchTree();
    try {
        const code = runGate(dir, gate);
        if (code === 0) {
            proven++;
        } else {
            unproven.push(`CONTROL ${gate} :: unmutated tree returned ${code}, expected 0 — this harness cannot prove anything`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

if (unproven.length) {
    console.error(`\nFAIL — harness control run failed:\n`);
    for (const u of unproven) console.error(`  \u2717 ${u}`);
    process.exit(1);
}

for (const [name, file, oldStr, newStr, gate = 'test.mjs'] of MUTATIONS) {
    const dir = scratchTree();
    try {
        const target = join(dir, file);
        const content = readFileSync(target, 'utf8');
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences !== 1) {
            unproven.push(`${name} :: anchor matched ${occurrences} times in ${file}, expected exactly 1`);
            continue;
        }
        writeFileSync(target, content.replace(oldStr, newStr));

        const exitCode = runGate(dir, gate);

        if (exitCode === 1) {
            proven++;
        } else {
            unproven.push(`${name} :: ${gate} returned ${exitCode}, expected 1 — this bug ships undetected`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

if (unproven.length) {
    console.error(`\nFAIL — ${unproven.length} of ${MUTATIONS.length} mutations went undetected:\n`);
    for (const u of unproven) console.error(`  ✗ ${u}`);
    process.exit(1);
}
console.log(`PASS — ${proven - controlCount} mutations caught, ${controlCount} control runs clean`);
