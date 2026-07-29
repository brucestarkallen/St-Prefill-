# AGENTS.md

Working notes for anyone — human or model — changing this repository.

## Run the gate before every push

```bash
node test.mjs           # engine logic          → 131 checks
node load_test.mjs      # module + DOM + wiring → 100 checks
node fuzz_test.mjs      # 60000 seeded runs over wire invariants
node negative_test.mjs  # 47 mutations, 3 control runs
npx eslint engine.js index.js
```

All four must be clean. `npm run gate` chains them.

`negative_test.mjs` links `node_modules` into each scratch tree and runs an
unmutated control through every gate first. Without that link a missing
dependency exits 1 and every mutation reads as caught while nothing is being
proven. If you add a gate with dependencies, keep the control run.

## Version discipline

Three places must agree, and `test.mjs` fails if they drift:

- `engine.js` → `ENGINE_VERSION`
- `index.js` → `EXTENSION_VERSION`
- `manifest.json` → `version`

Bump on every push. Add a `README.md` changelog entry in the same commit.

## Layout

| File | Role |
| --- | --- |
| `engine.js` | Pure logic. No SillyTavern imports, no DOM, no jQuery. |
| `index.js` | Hook registration, settings UI, persistence. |
| `test.mjs` | Drives `engine.js` on realistic `generate_data` shapes. |
| `load_test.mjs` | Imports `index.js` against a mocked context and jsdom. |
| `fuzz_test.mjs` | Seeded fuzz over engine invariants. |
| `negative_test.mjs` | Mutation harness. |

Keep the split. Anything decision-shaped belongs in `engine.js` where the gate
can reach it without a DOM.

## Invariants

**Hook at `CHAT_COMPLETION_SETTINGS_READY`, nowhere else.** It fires on the
assembled `generate_data` one statement before `JSON.stringify()`. Earlier hooks
sit before fields that matter are populated; there is no later one.

**Never infer provider behaviour from the model name.** Field mappings are a
user choice written into settings. A model-name check would break the moment an
endpoint proxies or renames, and it makes presets non-portable.

**Utility generations stay clean.** `type: 'quiet'` covers summarisation and
extension-driven calls. Prefilling those corrupts downstream state. Default off,
and keep it that way.

**Never throw into SillyTavern.** `onSettingsReady` wraps the engine. A failure
degrades to "no prefill", never to a killed generation. `load_test.mjs` proves
this with a frozen message object — a malformed-input test does not exercise the
catch, because the engine handles malformed input by design.

**Every new guard gets a mutation.** Add the entry to `MUTATIONS` in
`negative_test.mjs` and confirm the run count rises. A guard with no mutation is
an unproven guard.

**The log lives in the settings panel, not the console.** SillyTavern is
routinely run on a phone, where devtools are unreachable. Any diagnostic added
here must be visible in the UI. A console-only affordance is not a diagnostic.

**Reset refills the settings object in place; it never replaces it.** `bind()`
captures a reference at mount time. Swapping `extensionSettings[MODULE]` for a
fresh object leaves every control writing to something nothing reads — a bug
that looks like "settings do not save" long after the reset that caused it.

**Field names are user input, so validate before mutating.** `flagField` and
`reasoningField` are free-text boxes. Writing to `content` or `role` replaces
part of the message; an untrimmed name serialises as a key the provider ignores
while the UI still reports success. `normaliseFieldName()` runs before anything
is touched, and `RESERVED_FIELDS` is the list.

**Nothing enters the decision log by reference.** `summariseValue()` flattens
objects to bounded text. A multimodal message carries base64 image data, and
holding it live paints tens of thousands of characters into the panel and pins
the payload in memory.

**Initialisation polls; it never assumes.** Extension load order is not
guaranteed. Reading the SillyTavern context before it exists throws, which
leaves the extension permanently dead with no hook, no UI, and no retry. The
hook is registered as soon as the context appears, and the UI mounts separately
once the settings container appears. `MOUNT_FLAG` blocks a duplicate load.

**Reason codes are API.** `REASON` strings are asserted in the gate and shown in
the UI status line. Renaming one is a breaking change to both.

## Verified SillyTavern contract

Read against staging `380e31e`. Recheck these if a SillyTavern update changes
behaviour:

- `public/scripts/openai.js` — `ChatCompletion.getChat()` builds fresh plain
  objects and drops any message whose `content` is empty and which has no
  `tool_calls`. This is why a pure thinking prefill cannot live in a preset.
- `public/scripts/openai.js` — `createGenerationParameters()` puts that same
  array on `generate_data.messages`; `sendOpenAIRequest()` emits
  `CHAT_COMPLETION_SETTINGS_READY` then serialises.
- `src/endpoints/backends/chat-completions.js` — `/generate` copies
  `request.body.messages` verbatim into the outbound body for every source on
  the generic OpenAI-compatible path.
- `src/prompt-converters.js` — `mergeMessages()` merges a message into its
  predecessor when roles match and the message's own content is truthy, and the
  **predecessor object survives**. Hence the merge guard.
- `src/prompt-converters.js` — `PROMPT_PROCESSING_TYPE.NONE` is the empty
  string; every other value merges. `SINGLE` collapses everything to one user
  turn.
- `public/scripts/custom-request.js` — `ChatCompletionService` emits neither
  prompt-ready nor settings-ready, so `ConnectionManagerRequestService` traffic
  is structurally out of reach.

## Not implemented, on purpose

**Preserved Thinking** — sending prior turns' reasoning back on every assistant
message. The blocker is identity: `getChat()` produces fresh objects carrying no
link back to the chat entry that produced them, so reattaching stored
`extra.reasoning` would mean matching on message content. Content matching is
fragile and fails silently on regex-edited or swiped messages. Doing it properly
needs an identifier carried through prompt assembly, which is a SillyTavern
change, not an extension one. Do not ship a content-matching version.
