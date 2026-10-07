# TODOS

## Zen Tidy

### Optional AI endpoint (Ollama / OpenAI-compatible)

**What:** Add an optional endpoint with `naming-only` and `cluster-and-name` modes, API key stored in the Firefox login manager.

**Why:** Fallback if Firefox's on-device topic model gives poor folder names.

**Context:** Left out of v1 until the on-device labels prove too weak in real use. Send titles and domains only, never full URLs. Needs timeout, JSON validation and auth error handling.

**Effort:** M
**Priority:** P2
**Depends on:** Feedback on label quality

### Multi-window Tidy and Undo

**What:** Allow Tidy and Undo when several windows show the same space.

**Why:** v1 refuses to run in that case to avoid cross-window undo bugs.

**Context:** Zen already mirrors folder creation and removal across windows. What's missing is undo expiry that notices edits made in another window, and tab identity that works across windows (see Zen's `ZenWindowSync.sys.mjs`).

**Effort:** M
**Priority:** P3
**Depends on:** None

### Tune title-token matching

**What:** Choose a minimum token length and stop-word list for matching tabs to existing folders by label words.

**Why:** Short words like "pr" or "new" over-match titles.

**Context:** Collect a few real Tidies and check which title words caused wrong matches before picking thresholds.

**Effort:** S
**Priority:** P3
**Depends on:** A few real Tidies
