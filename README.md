# dsh-fs-allowlist

[English](README.md) | [中文](README.zh.md)

DSH plugin: **approval-free writes into whitelisted directories**. Let the `write`/`edit` file tools modify configured whitelist directories (e.g. your Obsidian vault) directly — no more "sandbox denial → escalation retry → manual approval" — plus a **Settings → Plugins → Directory Allowlist** GUI and **automatic approval for bash escalations** that touch whitelisted paths. Behavior everywhere else stays exactly as before.

## Features

| Layer | Mechanism | Covers |
|---|---|---|
| write/edit tools | Wraps the `ctx.fs.checkedTarget` fence; whitelisted paths pass early | Approval-free vault reads/writes |
| bash commands | `tools/pre-execute` indexes the command text; `approval/request` auto-answers `allowed-once` when the command or escalation reason hits a whitelisted path (recursive check) | Approval-free bash writes (command text first; misses fall back to manual approval) |
| Settings GUI | `settings.plugins.tab` section + server-side HTTP management routes | Add/remove directories, toggle bash auto-approve visually |

Configuration is **hot-reloaded**: GUI edits apply instantly; manual edits to the config file are picked up within 3 seconds. No DSH restart needed.

## How it works

### write/edit layer

Every write/edit tool call passes through the `ctx.fs.checkedTarget()` fence mounted by `dsh-fs-sandbox` (outside the workspace → `FS_SANDBOX_DENIED` → model retries with escalation → approval prompt). This plugin wraps that fence:

- If the canonically-resolved target lands inside a whitelisted root → pass it through early (same fresh-target semantics as the fence);
- Otherwise (miss / `read-only` mode / resolution failure) → delegate to the original fence untouched.

File semantics — atomic writes, version guards, read-before-write checks, diff events — live in the parent `dsh-fs-local` provider below the fence and are not touched. Whitelist matching uses the same realpath (deepest existing ancestor) semantics as the fence, so symlink redirection cannot escape the allowlist.

### bash layer (approval auto-answer)

bash runs under the Seatbelt process sandbox, whose profile cannot be extended from a plugin. Instead two listeners cooperate: `tools/pre-execute` records each bash call's command text by callId, and the `approval/request` answerer looks it up and matches the command text plus the escalation reason against the allowlist — path-like tokens are extracted, `~` is expanded to home, then recursively checked under whitelisted roots (**a parent entry covers all its children**). The command text almost always contains the target path, so approval no longer depends on the model writing it in the justification. Misses always fall back to the human prompt (fail-safe). Toggle it off any time in the settings page.

## Install

```bash
dsh plugin --profile web add /path/to/dsh-fs-allowlist
```

or from GitHub after release:

```bash
dsh plugin --profile web add "github:wangzhaonan16/dsh-fs-allowlist#main"
```

Installs into `$DSH_HOME/profiles/web`; **restart DSH Desktop** to take effect (refreshing the browser is not enough). The profile links the source directory, so editing the source only needs a restart — no reinstall.

## Configuration

`$DSH_HOME/fs-allowlist.json` (default: `~/Library/Application Support/dsh-desktop/harness/fs-allowlist.json` on macOS; the resolver also understands `$DSH_HOME`, Windows `%APPDATA%`, Linux XDG paths, and the open-source `~/.dsh` layout):

```json
{
  "extraWritableRoots": [
    "/Users/you/ObsidianVault"
  ],
  "bashAutoApprove": true
}
```

- Prefer the **Settings → Plugins → Directory Allowlist** page — no hand editing;
- Missing file / invalid JSON / empty list → empty allowlist, the plugin is fully transparent (= uninstalled behavior): one-step rollback;
- `bashAutoApprove` defaults to `true` when absent.

## Behavior matrix

| Scenario | Behavior |
|---|---|
| write/edit inside the workspace | approval-free (native, unchanged) |
| write/edit inside a whitelisted root | **approval-free** |
| write/edit anywhere else | deny → escalate → approval (unchanged) |
| read-only mode writing a whitelisted root | still denied (stricter knob wins) |
| bash touching a whitelisted root (command or reason matches) | **auto-approved, no prompt** |
| any other bash escalation (no match) | normal approval prompt |

## Known limitations

1. The bash auto-answer matches the command text plus the justification against the allowlist (recursive path check + substring fallback) — still a heuristic: if neither mentions a whitelisted path, a prompt appears (fail-safe); a match approves that one call.
2. `checkedTarget` is an internal seam of the shipped bundle: if a DSH upgrade refactors it, the plugin degrades loudly to "warn + transparent" (equivalent to today's behavior) without breaking sessions; adapt per release.
3. A whitelist entry means the agent may write there without asking — keep the list deliberately narrow.

## Rollback

`dsh plugin --profile web remove dsh-fs-allowlist` (or empty `fs-allowlist.json`) + restart DSH.

## License

MIT
