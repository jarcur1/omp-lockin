# omp-lockin

`omp-lockin` is an [OMP](https://omp.sh) extension that temporarily raises the reasoning effort of an active workflow without changing how that workflow normally runs.

Type `/lockin` before difficult work. The extension requests the highest reasoning level for the main session and participating child sessions. Type `/lockin` again when the difficult work is finished, and each live session returns to the reasoning level it had before lock-in was enabled.

## What it does

Lock-in is an in-memory, process-local toggle:

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
| `/lockin` | Toggle lock-in on or off. |
| `/lockin on` | Enable lock-in. Safe to repeat. |
| `/lockin off` | Disable lock-in and restore recorded levels. Safe to repeat. |
| `/lockin status` | Show whether lock-in is enabled and how many live workflow sessions it tracks. |

Example:

```text
/lockin on

orchestrate the database migration and verify every consumer

/lockin off
```

## Installation

### Requirements

- OMP 18.6 or newer in the 18.x release line
- Git, for installation directly from GitHub
- Node.js 24 or newer only for local development and tests; installing the plugin does not require Node.js

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

Restart OMP after installation. In an already-running session, `/reload-plugins` can load newly installed plugin sources.

Verify the command:

```text
/lockin status
```

### Install for local development

```sh
git clone https://github.com/jarcur1/omp-lockin.git
cd omp-lockin
npm install
npm run check
omp plugin link .
```

Restart OMP or run `/reload-plugins`. `omp plugin link` uses a directory junction on Windows and a symbolic link on Unix-like systems, so source edits are available without reinstalling the package.

To load the extension for one OMP process without installing or linking it:

```sh
omp --extension ./src/index.ts
```

PowerShell:

```powershell
omp --extension .\\src\\index.ts
```

### Uninstall

```sh
omp plugin uninstall omp-lockin
```

Restart OMP or run `/reload-plugins` afterward.

## Scope and limitations

- A provider request already in flight cannot change reasoning effort. Enabling or disabling lock-in takes effect on the next request made by each session.
- Task and eval subagents receive independent extension bindings and are tracked directly.
- OMP's advisor runtime does not currently receive an independent extension binding, so advisor turns are outside the guaranteed toggle coverage. An advisor request already in flight cannot be changed.
- Models without a controllable reasoning surface continue to run normally.
- State is local to one OMP process. Starting another OMP process starts with lock-in off.
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
