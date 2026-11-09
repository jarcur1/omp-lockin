# omp-lockin

`omp-lockin` is an [OMP](https://omp.sh) extension that temporarily raises the reasoning effort of an active workflow without changing how that workflow normally runs.

Type `/lockin` before difficult work. The extension requests the highest reasoning level for the main session and participating child sessions. Type `/lockin` again when the difficult work is finished, and each live session returns to the reasoning level it had before lock-in was enabled.

Use `/lockin all` to enable maximum reasoning across **all open OMP terminals running this plugin under the same OS user/home**, including terminals in other projects. Use `/lockin all off` to restore their previous levels.

## What it does

Each OMP process keeps an in-memory lock-in state:

1. OMP starts with lock-in **off**. Your configured models, roles, and reasoning levels behave normally.
2. `/lockin` records the current reasoning level of every live session bound to the extension.
3. It requests OMP's `max` thinking level. OMP clamps that request to each model's supported ceiling, so a model may run at `high`, `xhigh`, or `max`.
4. Task and eval subagents created while lock-in is enabled are raised when their sessions start.
5. Model changes and retry fallbacks reassert the maximum request.
6. The next `/lockin` restores every surviving session's recorded level.

The extension does **not** edit `config.yml`, model-role assignments, agent files, or model definitions.

## Commands

| Command | Behavior |
| --- | --- |
| `/lockin` | Toggle lock-in in this terminal and its participating subagents. |
| `/lockin on` | Enable lock-in in this terminal. Safe to repeat. |
| `/lockin off` | Restore recorded levels in this terminal. Safe to repeat. |
| `/lockin status` | Show this terminal's lock-in state and live workflow session count. |
| `/lockin all` or `/lockin all on` | Enable lock-in in every currently participating OMP terminal. Safe to repeat. |
| `/lockin all off` | Restore recorded levels in every currently participating terminal. |
| `/lockin all status` | Show enabled/reachable terminal counts and their total live workflow sessions. |

Example:

```text
/lockin on

orchestrate the database migration and verify every consumer

/lockin off
```

### Cross-terminal coordination

Install or reload the updated plugin in **each** terminal before using `/lockin all`. Terminals without the updated plugin cannot receive the command.

Each participating process registers an authenticated, loopback-only IPC endpoint in `~/.omp/lockin/`. Cross-terminal commands discover the current endpoints and wait for acknowledgements. Unreachable terminals and failed session updates produce a warning; success is not assumed for them. Runtime files do not change OMP configuration or model defaults.

The command targets the terminals registered when it runs. A terminal opened afterward starts with lock-in off; run `/lockin all` again to include it. New subagents inside an already-enabled terminal still inherit lock-in. `/lockin off` remains local; use `/lockin all off` for a cross-terminal restore.

Reloading or closing a participating terminal unregisters it and restores its surviving sessions where graceful cleanup is available. Dead-process registry entries are ignored or removed on later broadcasts.


## Installation

### Requirements

- OMP 18.6 or newer in the 18.x release line
- Git, when installing or cloning directly from GitHub
- Bun on `PATH` only for `omp plugin install` and `omp plugin uninstall`
- Node.js 24 or newer only for local development and tests; running the plugin does not require Node.js

Check your OMP version:

```sh
omp --version
```

### Install from GitHub

```sh
omp plugin install github:jarcur1/omp-lockin
```

The full Git URL also works:

```sh
omp plugin install https://github.com/jarcur1/omp-lockin.git
```

OMP's Git/npm installer launches the external `bun` executable. If Bun is not on `PATH`, use the local-link installation below instead. After installing Bun, restart the terminal before retrying the GitHub installation.

Restart OMP after installation. In an already-running session, `/reload-plugins` can load newly installed plugin sources.

Verify the command:

```text
/lockin status
```

### Link a local clone without Bun

`omp plugin link` does not launch the external Bun executable:

```sh
git clone https://github.com/jarcur1/omp-lockin.git
omp plugin link ./omp-lockin
```

If this repository is already cloned under the default Windows agent directory:

```powershell
omp plugin link "$HOME/.omp/agent/omp-lockin"
```

Restart OMP or run `/reload-plugins`. `omp plugin link` uses a directory junction on Windows and a symbolic link on Unix-like systems, so source edits are available without reinstalling the package.

### Local development

```sh
cd omp-lockin
npm install
npm run check
```

To load the extension for one OMP process without installing or linking it:

```sh
omp --extension ./src/index.ts
```

PowerShell:

```powershell
omp --extension .\src\index.ts
```

### Disable or uninstall

Disabling works without Bun and leaves the local link in place:

```sh
omp plugin disable omp-lockin
```

With Bun on `PATH`, remove the package or link completely:

```sh
omp plugin uninstall omp-lockin
```

Restart OMP or run `/reload-plugins` afterward.

## Scope and limitations

- A provider request already in flight cannot change reasoning effort. Enabling or disabling lock-in takes effect on the next request made by each session.
- Task and eval subagents receive independent extension bindings and are tracked directly.
- OMP's advisor runtime does not currently receive an independent extension binding, so advisor turns are outside the guaranteed toggle coverage. An advisor request already in flight cannot be changed.
- Models without a controllable reasoning surface continue to run normally.
- State is local to each OMP process. Cross-terminal commands coordinate the currently registered processes without persisting a global enabled state. Starting another OMP process still starts with lock-in off.
- Graceful session switches and shutdowns restore the recorded level. A hard process termination cannot run extension cleanup; persistent OMP configuration is still untouched.

## Why not set `defaultThinkingLevel: max`?

That setting changes the normal default for future work. Lock-in is intentionally temporary: ordinary work keeps its ordinary reasoning level, while difficult stretches can opt into maximum reasoning and then return to the exact live-session baseline.

## Development

```sh
npm install
npm run typecheck
npm test
```

`npm run check` runs both type checking and the regression tests.

## License

[MIT](./LICENSE)
