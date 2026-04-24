# pi-context-cap

[![npm version](https://img.shields.io/npm/v/pi-context-cap.svg)](https://www.npmjs.com/package/pi-context-cap)
[![license](https://img.shields.io/npm/l/pi-context-cap.svg)](./LICENSE)

A tiny [pi](https://github.com/badlogic/pi-mono) extension that caps model `contextWindow` values so pi's built-in auto-compaction triggers earlier than the model's native limit. Zero-config defaults for 1M-window Claude models; fully configurable for anything else.

## What it does

Pi's auto-compaction trigger is:

```
contextTokens > contextWindow - reserveTokens
```

For a Claude model with a native 1,000,000-token window and the default `reserveTokens = 16384`, that means compaction doesn't fire until **~983,616 tokens** — which is probably not what you want for day-to-day use. Sessions that actually approach 1M are slow per turn, carry a lot of noise the model has to attend to, and cost a lot each time they round-trip.

This extension caps `contextWindow` in pi's in-memory model registry at session start, so compaction fires at a user-chosen ceiling (default 200,000) instead. Everything else in pi's compaction machinery — the summarizer model, the prompt, the recovery flow, `/compact`, `session_before_compact` hooks — is unchanged.

On Opus 4.7 or Sonnet 4.6 you'll see:

```
Context: 182,411 / 200,000 (91%)
```

…and compaction kicks in at the normal time, as if you were on a natively-200k model.

## Install

```bash
# From npm (recommended)
pi install npm:pi-context-cap

# Or directly from git
pi install git:github.com/AlexWootton/pi-context-cap

# Or local clone for development
git clone https://github.com/AlexWootton/pi-context-cap
pi install ./pi-context-cap
```

**Default behavior:** any model whose `id` contains `"anthropic"` or `"claude"` and whose native `contextWindow > 200_000` is capped at exactly `200_000`. All other models are left alone.

## Why you might want this

- **Shorter working memory per turn.** Every turn pays for every token currently in context. Capping at 200k instead of 1M means each turn is billed against a smaller working set, and pi summarizes older history rather than carrying it at full fidelity.
- **Honest `/context` meter.** A meter that fills toward 1M tells you very little; a meter that fills toward the ceiling *you chose* actually tells you when compaction is coming.
- **Predictable pacing.** You picked the ceiling, so you know the upper bound on what a full-context turn costs. No being surprised by a 900k-token turn because you forgot how large the window was.
- **No server-side equivalent for "Opus 4.7 capped at 200k."** Anthropic's API doesn't expose a wire-level "serve this model in 200k mode" toggle — the model identifier determines the mode. If you want to *stay on 4.7/4.6* but use less of its window, this extension does that client-side.

### What this is *not*

- **Not a pricing-tier change.** Current 1M-context Claude models (Opus 4.6, Opus 4.7, Sonnet 4.6) are billed at standard rates across the full window. Capping doesn't move you off any tier.
- **Not a serving-mode switch.** There is no wire-level negotiation that routes a capped request to a different serving path. The model identifier determines the mode; a client-side cap only shrinks what you send.
- **Not a latency guarantee.** Any speed benefit is strictly downstream of sending fewer tokens per turn.

If you want a same-family model that is natively 200k (different serving characteristics, not just a smaller client-side window), look at the 4.5 generation: `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`. That's a model-selection choice, orthogonal to this extension.

## Configure

Drop a JSON file at either path:

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/context-cap.json` | Global |
| `<project>/.pi/extensions/context-cap.json` | Project (overrides global) |

### Schema

```jsonc
{
  "cap": 200000,                               // Target contextWindow for affected models.
  "appliesOver": 200000,                       // Only cap models whose native window exceeds this.
  "matchPatterns": ["anthropic", "claude"],    // id-substring match (case-insensitive). Use "*" to match all.
  "models": {                                  // Per-model-id overrides. Always win over pattern matching.
    "claude-opus-4-7": 180000
  }
}
```

All keys are optional. Values shown are the defaults.

### Examples

**More conservative buffer below 200k:**

```json
{ "cap": 180000 }
```

**Extend the default Anthropic cap to also cap Gemini at 500k:**

```json
{
  "cap": 200000,
  "matchPatterns": ["anthropic", "claude"],
  "models": {
    "google/gemini-2-5-pro": 500000,
    "google/gemini-2-5-flash": 500000
  }
}
```

**Only cap a specific model, leave everything else alone:**

```json
{
  "matchPatterns": [],
  "models": {
    "us.anthropic.claude-opus-4-7": 200000
  }
}
```

**Apply the same cap to every model in the registry (aggressive):**

```json
{
  "cap": 150000,
  "appliesOver": 150000,
  "matchPatterns": ["*"]
}
```

Model IDs match `model.id` exactly; run `pi --list-models` to see them. Unknown IDs in `models` are silently ignored.

## Other use cases

The mechanism is general:

- **Per-model tuning** — different models summarise context differently. Set `"claude-opus-4-7": 200000` and `"claude-sonnet-4-6": 150000` if you want more headroom on one than the other.
- **Long-window non-Anthropic models** — a Gemini or Grok model advertising a 1M/2M window can be capped to something you actually want to pay for per turn.
- **Testing and dev** — force compaction at a predictable point without burning through real tokens.

All of these are one-file config changes.

## What it does and doesn't do

**Does:**
- Cap `contextWindow` on matching models so pi's built-in auto-compaction fires at the cap point.
- Emit a `capped N model(s)` notification once on session start.
- Work with all of pi's compaction machinery (including `session_before_compact` hooks, manual `/compact`, and compaction error recovery) without modification.
- Apply project config on top of global config.

**Does not:**
- Replace or duplicate pi's compaction logic.
- Touch token billing, API requests, or the messages array.
- Cap any model if `matchPatterns` is empty *and* `models` has no entries (you've told it to do nothing).
- Prevent a *single* turn from crossing the cap if that turn's new content exceeds the reserve buffer — see **Caveats**.

## Caveats

Pi's compaction trigger checks the **previous assistant's** reported input-token usage. So if one turn adds more than `reserveTokens` (default ~16k tokens) of fresh content — say, three large file reads plus a long bash dump — the next request may be sent with more input tokens than the cap despite this extension being active.

For typical conversational coding, this is rare. For stricter guarantees:

- Set `cap` below your actual ceiling (e.g. `180000` to stay well under 200k).
- Or bump `compaction.reserveTokens` in `~/.pi/agent/settings.json` (affects *all* models, not just the capped ones).

## See also

- [`pi-custom-compaction`](https://www.npmjs.com/package/pi-custom-compaction) — swaps pi's compaction model, template, *and* trigger point. Its `trigger.maxTokens` option overlaps with this extension's core function. Choose `pi-custom-compaction` if you also want to swap the summarizer model or get per-project compaction-policy control; choose `pi-context-cap` if you only want per-model trigger caps with zero-config defaults and `/context` that honestly reflects your working ceiling.
- [`pi-model-aware-compaction`](https://www.npmjs.com/package/pi-model-aware-compaction) — per-model **percent-based** compaction thresholds using a different mechanism (inflating reported token counts to trigger pi's compaction). Good when you think in percentages; this extension is better when you think in absolute tokens.
- [`pi-budget-guard`](https://www.npmjs.com/package/pi-budget-guard) — tracks **dollar spend** per session and blocks tool calls at a `$` threshold. Complementary (dollars ≠ tokens); safe to run alongside.

## How it works

Pi's `ModelRegistry.getAll()` returns a live array of `Model` objects. The extension mutates `model.contextWindow` on each matching entry at `session_start` before any LLM request is built. Pi's [`shouldCompact()`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) reads this value directly:

```typescript
export function shouldCompact(contextTokens, contextWindow, settings) {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}
```

So the cap flows through to every existing compaction code path automatically. The extension itself is under 50 lines of logic.

### A note on extension load order

Extensions are loaded in this order:

1. Installed packages (from `settings.json`'s `packages` array)
2. Ad-hoc extensions passed via `--extension` / `-e`

Each extension's `session_start` handler fires in the same order. If you combine this extension with another loaded via `-e` that reads `contextWindow` in its own `session_start` handler, the other extension may see the *pre-cap* value. Mitigations:

- Read `contextWindow` in `before_agent_start` or later — by then the cap is applied.
- Or install both extensions as packages (order within packages is settings-file order).
- Or pass this one first when using `-e`: `pi -e path/to/context-cap.ts -e path/to/other.ts`.

For typical single-extension usage this is a non-issue.

## Uninstall

```bash
pi remove npm:pi-context-cap
```

Fully reversible. Pi's ModelRegistry is rebuilt on each launch from pi-ai's canonical model list, so removing the extension restores every affected model's native window on the next startup.

## License

MIT. See [LICENSE](./LICENSE).
