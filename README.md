# dsh-verdict-tiered

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A permission gate for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): every tool call is checked before it runs — allow, deny, or ask you first.**

> **Fork notice.** This is `dsh-verdict-tiered`, a fork of [jesset/pi-verdict](https://github.com/jesset/pi-verdict) by **Jesset**, re-targeted from pi's extension API onto DSH's Cordis plugin surface. All credit for the design, the rule floor, the self-protection layer, and the research behind them belongs to the original author. See [Attribution](#attribution).

- Built-in danger rules and your own allow/deny rules settle the clear cases first, at zero latency
- Everything else goes to a model classifier that sees the conversation context
- Any uncertainty or failure fails closed; nothing ever runs silently
- Self-protection: the gate guards itself against snooping and tampering
- Selectable as the **`auto`** permission preset, so it composes with DSH's own permission model instead of replacing it

## The problem

DSH decides permissions per preset: a sandbox mode plus an approval policy. That is a sound default, but it cannot tell a routine `npm test` from a destructive `rm -rf` — both are "workspace-write" actions. This plugin adds the missing judgment: a model decides whether each call should run, based on the conversation context and your intent.

## Why three states

**A verdict is an adjudication, not a switch.** Most classifiers in this space output a binary allow/block. Three states matter: `ask` routes genuinely ambiguous actions to a human, so "not sure" never silently becomes "go ahead" — the goal is safe automation, not maximum automation: both approval fatigue and silent unsafe execution lose.

DSH already owns the human channel: the gate returns `ask` and DSH's approval seam consults the configured answerers, failing closed when none exist. The plugin implements no UI of its own.

## Design principles

- **Fail closed** — uncertainty produces friction, never permission.
- **Deterministic floor before AI** — hard denies are never overridden by the classifier or user allow rules.
- **Semantics over syntax** — the classifier judges what an action *does*, not how long it is.
- **Judgments, not proofs** — a classifier `allow` is an informed opinion; the floor exists because that is all it is.
- **Minimal trusted input** — no tool results in the transcript, zero path plaintext to the classifier ([ADR-0002](docs/adr/0002-deny-paths-deterministic-ask.md)).
- **Canonical identity** — lexical + realpath dual-form matching; a workspace-*looking* path is not trusted as one.
- **The gate guards itself** — self-protection that no configuration can disable ([ADR-0001](docs/adr/0001-self-protection-layer.md)).
- **A permission gate, not a sandbox** — stack OS isolation on top; this gate never replaces it.

## How it plugs into DSH

| Seam | Use |
|---|---|
| `tools/pre-execute` (prepended) | Adjudicates every native call before its body; returns allow / deny / ask |
| `permissionPresets.registerAuto()` | Publishes the `auto` preset, so `/permission auto` selects the gate and the picker lists it |
| `ctx.llm.stream()` | The classifier call, using the session's own route unless a model is configured |
| `ctx.approval` | The `ask` outcome; DSH answers it and fails closed without an answerer |
| `ctx.commands` | `/automode` — status and on/off |
| `ctx.tuiStatus.setField()` | The `auto mode on` / `auto mode off` footer field, when dsh-tui is composed |

The preset **is** the master switch: the gate is active only while the session's preset is `auto`. Every other preset leaves DSH's own permission model in charge.

## Install

The plugin is a DSH bundle: `package.json` declares `dsh.bundle.patch`, so installing it into a profile also mounts its row.

```bash
# from a checkout
pnpm build
dsh plugin --profile dsh-tui add "$PWD"
```

Then restart. `/permission auto` selects the gate; `/automode` reports status and switches it on or off.

Requires Node `^22.19 || >=24`. The classifier needs a reachable model route; without one, gray-zone calls fail closed.

## Configuration

Two layers, deliberately separated:

**User rules** live in `<dshHome>/dsh-verdict.json` and are self-protected — the agent cannot edit them, only you, by hand. The file is created with a starter template on first run.

```jsonc
{
  "allow": ["^ls\\b"],          // regexes matched against the bash command / file path
  "deny": [],                    // wins over allow
  "denyPaths": ["~/.ssh/"],      // path-semantic declarations; a hit asks, never silently allows
  "ignoreTools": ["todo_write"], // no-side-effect tools exempt from adjudication
  "builtinDenyFloor": true,      // the built-in danger floor; false is at your own risk
  "classifierModel": null,       // "provider/model[:level]"; null inherits the session route
  "audit": false,                // opt-in JSONL decision records under <dshHome>/verdicts/
  "notifyAllows": false
}
```

**Composition knobs** live in the profile patch row and are schema-validated:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Gate calls while the preset is `auto` |
| `debug` | `false` | Notify every verdict, including allows |
| `classifierModel` | `""` | Route override; empty inherits the session route |

## Status

This is a **port in progress**, not a finished product.

| Area | State |
|---|---|
| Rule layer, self-protection, denyPaths, audit, redaction | Ported and tested |
| Classifier (chat prompt contract over `ctx.llm`) | Ported and tested |
| DSH host seam, `auto` preset, `/automode` | Ported; typechecked against the shipped DSH packages |
| dsh-tui footer field | Ported; feature-detected, no-ops without the TUI |
| Tier 1 local ONNX triage | **Not yet ported** — the archived omp fork's `src/classifiers/` is the source |
| Native judgment-classifier backend (ADR-0005) | **Dropped** — DSH exposes no judgment channel; the chat path is the only backend |
| Upstream test suite (3.8k lines) | **Not ported** — the pi harness mocks do not apply; the pure-layer subset is ported instead |

Two upstream behaviours change by construction, and are documented rather than hidden:

- **Confidence floor is inert.** `classifierMinConfidence` keys on protocol-native confidence, which only a judgment model provides. With the chat path as the only backend, the floor cannot fire.
- **Ask degradation is DSH's job.** The pipeline reports `hasUI: true` and emits `ask`; DSH's approval seam fails closed when no answerer is composed, which is the same guarantee with one owner instead of two.

## Attribution

Original project: [jesset/pi-verdict](https://github.com/jesset/pi-verdict) by **Jesset** — design, rule floor, self-protection layer, and the research corpus under `research/`. The tiered adjudication line (ADR-0009, LANCET-Nano Tier 1) was developed in the `omp-verdict-tiered` fork, now archived; its classifier modules are the intended source for this fork's Tier 1.

MIT licensed, as upstream.
