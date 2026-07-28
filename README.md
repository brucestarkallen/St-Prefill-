# Prefill Control

Prefill support for SillyTavern chat completions, including **thinking prefill** — seeding a model's reasoning scratchpad instead of its visible output.

No SillyTavern source file is modified. Nothing to reapply after an update.

---

## What prefill is

A chat completion normally ends with a user turn, and the model starts a fresh assistant turn from nothing. Prefill appends a final **assistant** message and marks it as unfinished, so the model continues *your* text instead of beginning its own.

The flag differs by provider:

| Provider | Continuation flag | Reasoning field |
| --- | --- | --- |
| Moonshot / Kimi (direct) | `partial` | `reasoning_content` |
| OpenRouter → Moonshot provider | `partial` | `reasoning_content` |
| DeepSeek (beta) | `prefix` | `reasoning_content` |
| OpenRouter (generic) | — | `reasoning` |
| Custom / OpenAI-compatible | — | `reasoning_content` |
| Anthropic | native, none needed | — |

**Thinking prefill** is the interesting case. Reasoning models emit two channels: `content` (what you read) and a reasoning channel (the scratchpad). Send a seed in the reasoning channel with `content` left empty and the model **continues the thought** rather than replacing its own reasoning:

```json
{ "role": "assistant", "content": "", "reasoning_content": "I should continue the story.", "partial": true }
```

SillyTavern cannot express that on its own — `ChatCompletion.getChat()` drops messages with empty content, so a pure thinking prefill never survives prompt assembly. This extension performs the split after assembly, where it sticks.

---

## Install

SillyTavern → **Extensions** → **Install extension** → paste:

```
https://github.com/brucestarkallen/St-Prefill-
```

Settings appear under **Extensions → Prefill Control**. It ships **disabled**.

---

## Use

1. Pick a **field mapping** matching your provider. This writes the two field names below it — nothing is inferred from the model name at request time.
2. Choose where the prefill comes from:
   - **Preset** — your preset already ends with an assistant message. Put the seed there.
   - **Extension** — the text box below is appended as a final assistant message when the prompt has no assistant tail. Use this for pure thinking prefills, which a preset cannot express.
3. Write the seed with the thinking tag first:

   ```
   <think>I should continue the story.
   ```

   Everything after the tag up to `</think>` (or end of string) goes into the reasoning field; the remainder stays in `content`.
4. Enable.

The status line under the toggle reports what happened on the last request — applied, or which guard skipped it and why.

---

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Enabled | off | Master switch |
| Field mapping | — | Writes the two fields below; not a runtime behaviour |
| Continuation flag | `partial` | Empty writes no flag |
| Reasoning field | `reasoning_content` | Empty disables the split |
| Prefill comes from | preset | `preset` or `extension` |
| Split leading thinking tag | on | Moves the tagged span into the reasoning field |
| Open / close tag | `<think>` / `</think>` | Close tag optional; both are regex-escaped |
| Apply to Continue | on | Marks the existing partial reply as a continuation |
| Apply to Impersonate | off | Impersonation writes as the user, not the character |
| Apply to utility generations | **off** | See below |
| Skip when tools are in play | on | Providers reject continuation flags alongside tools |
| Skip on JSON schema | on | Same |
| Merge guard | on | See below |
| Log every decision | off | Console trace of each request |

### Utility generations

Summaries, keyword extraction, and other extension-driven calls reach the API as `type: 'quiet'`. A story prefill welded onto a summarisation request corrupts the summary. These are excluded by default and the setting exists only so you can opt in deliberately.

Extensions calling `ConnectionManagerRequestService.sendRequest` use a separate code path that never emits the hooked event, so those are untouched regardless of this setting.

### Merge guard

SillyTavern's server-side prompt post-processing merges consecutive same-role messages, and the **earlier** object is the one that survives. A continuation flag written on a later assistant message would be silently discarded whenever the prompt tail happens to be two assistant turns.

With the guard on, the merge is performed here first, so the flag lands on the surviving object and the server's merge becomes a no-op. Turn it off only if you have a reason to want two assistant messages on the wire.

Post-processing set to **Single user message** collapses the whole prompt into one user turn. Prefill is impossible there; the extension skips and says so rather than writing a flag onto a user message.

---

## Does prefill degrade the model?

Partly, and it depends entirely on which channel you use and how much you write.

**Content prefill degrades.** The text is off-policy — the model did not generate it — and it occupies the opening tokens, which is where the model decides what kind of task it is looking at and what plan to follow. It also locks in style and any claim it contains, because the model treats its own turn as a prior commitment. On a reasoning model, a prefilled `content` can suppress the reasoning pass outright.

**Thinking prefill is much lighter.** With `content` empty, the reasoning budget and the analysis are intact; you have nudged the first sentence of the scratchpad and the model keeps thinking normally from there.

Severity scales with length, channel, and how much conclusion you pre-commit. Six tokens in the scratchpad is close to free. Two hundred tokens of style and permission rules in `content` is not.

One thing worth weighing if you run continuity extensions: a seed like *"I should continue the story"* is a **permission** prefill, and it biases the opening of the scratchpad away from *"check the injected context first."* Seeding procedure costs the same and pushes the other way.

---

## How it works

The hook is `CHAT_COMPLETION_SETTINGS_READY`, which fires on the assembled `generate_data` object one statement before `JSON.stringify()`. Verified against SillyTavern staging `380e31e`:

- `ChatCompletion.getChat()` returns the array that becomes `generate_data.messages`
- `sendOpenAIRequest()` emits the event on that object, then serialises it
- `/api/backends/chat-completions/generate` copies `request.body.messages` **verbatim** into the outbound provider request

So a field written on a message object here reaches the provider unchanged, for every source routed through the generic OpenAI-compatible path.

---

## Gates

```
node test.mjs           # engine logic
node load_test.mjs      # real module against a mocked SillyTavern + jsdom
node negative_test.mjs  # reintroduces each bug and proves the gates catch it
npx eslint engine.js index.js
```

`negative_test.mjs` runs an unmutated control tree through every gate first. If a control run does not exit 0, the harness fails rather than reporting mutations as caught.

---

## Changelog

### 1.0.0

- Initial release.
- Continuation flag and reasoning-field split, both with configurable field names.
- Provider field mappings for Moonshot, OpenRouter, DeepSeek, Anthropic, and generic OpenAI-compatible endpoints.
- Prefill sourced from the preset or supplied by the extension.
- Generation-type filter excluding utility and impersonation requests by default.
- Guards for tools, JSON schema, and single-message post-processing.
- Merge guard for server-side prompt post-processing.
- 89 engine checks, 51 load checks, 25 proven mutations, 2 control runs.

---

## Licence

AGPL-3.0-or-later.
