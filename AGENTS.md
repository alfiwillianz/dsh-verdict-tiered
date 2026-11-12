# AGENTS.md

## General

- Language convention: code comments, docs, CHANGELOG entries and release notes are written in English. Do not mass-rewrite existing Chinese content — convert when a file is touched anyway.
- Technical writing uses precise standard terminology; do not invent colloquial metaphors. If a concept needs a short form, use the standard term or annotate its meaning in parentheses on first use.
- YOU MUST: keep docs in sync with behavior — README.md / CHANGELOG.md (`[Unreleased]`) / CONTEXT.md for terminology / docs/adr/ for architecture decisions / the config template and docs/configuration.md.

## Project

This repository is **dsh-verdict-tiered**, the DeepSeek Harness (dsh) fork of [jesset/pi-verdict](https://github.com/jesset/pi-verdict): a minimal permission gate plugin (rule layer + model classifier). Read `CONTEXT.md` (glossary) and `docs/adr/` before touching domain terms or design decisions; design conclusions are backed by the measurements under `research/`.

The upstream targets pi's extension API; this fork targets DSH's Cordis plugin surface. The adjudication pipeline (`src/verdict.ts`) is host-neutral and carried over; the host seam (`src/index.ts`) is DSH-specific.

### Layout

| Path | Role |
|---|---|
| `src/verdict.ts` | Pure pipeline: rule layer, self-protection, denyPaths, audit, classifier contract |
| `src/index.ts` | DSH host seam: `tools/pre-execute`, the `auto` preset, `/automode`, TUI footer |
| `src/classifiers/` | Tier 1 local ONNX triage — reserved, not yet ported; the archived omp fork's copy is the source |
| `tests/` | Offline tests; no network, no real model |

### Gate self-reference (ADR-0001)

The plugin's own security boundary is guarded by the plugin itself, which constrains the development workflow:

- The agent cannot write `<dshHome>/dsh-verdict.json` or its own installed copy under `<dshHome>/profiles/<profile>/node_modules/dsh-verdict-tiered/` — the self-protection layer always denies, and no configuration exempts it
- Testing a new version = the user installs it from a terminal and restarts; user-rule edits are manual only

### Release

- Release sequence: a `chore(release): bump version` commit, an annotated tag, and a GitHub Release
- Publishing runs from the tag-driven `Publish` workflow

## Agent skills

### Issue tracker

Issues live as GitHub issues in this repo, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five default triage labels — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` — each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: a root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Git conventions

- Feature branch naming: `feat/description-with-dash-separated-and-MAY-contain-an-issue-number`
- YOU MUST: always use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) when committing
- YOU MUST: update CHANGELOG before merging to main, following <https://keepachangelog.com/>
- YOU MUST: never commit code changes without the user's permission

## Tools

- When you need to read source from a GitHub project, you can always use the locally installed GitHub CLI (`gh api`).
- When you need to temporarily clone open-source code, use `/Volumes/RamDisk` instead of `/tmp` as the temporary directory.
