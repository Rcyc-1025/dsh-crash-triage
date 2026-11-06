# dsh-crash-triage

**Turn one MLIR crash into a reproducible command, a minimal IR, the failing pass, a sanitizer stack and a handoff report.**

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)

One tool, `crash_triage`, four actions:

| action | what it does |
| --- | --- |
| `diagnose` (default) | reproduce → minimize with `mlir-reduce` → bisect passes → write report |
| `reduce` | IR minimization only |
| `bisect` | find the first pass that crashes |
| `parse` | parse a sanitizer report only — no `mlir-opt`, no reproduce/reduce/bisect |

The plugin never throws `ENOENT` at the model: missing tools, missing IR, out-of-workspace output dirs, timeouts and cancellation all come back as `ok:false` with a Chinese `hint` and a `stage`.

## Not in scope (v1)

No core dumps, no symbolization (sanitizer reports are supplied by the caller), no automatic bug fixing, no compiling MLIR, no arbitrary shell. Only `mlir-opt`, `mlir-reduce` and the testers `node` are spawned, always as argv arrays.

## Requirements

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0-0`
- `mlir-opt` (required) and `mlir-reduce` (minimization only); LLVM 23.1.4 is what this repo is verified against.
- `node` for the reducer tester is resolved by the plugin itself.

Without `mlir-reduce` the plugin still loads, but asking for minimization (the default) makes both `diagnose` and `reduce` return `TOOL_NOT_FOUND`; pass `reduce: { enabled: false }` to diagnose without it (reproduction + pass bisect still run).

## Install

```bash
dsh plugin --profile desktop add ./dsh-crash-triage
dsh plugin --profile desktop remove dsh-crash-triage   # uninstall
```

The bundled `cordis.patch.yml` self-registers the plugin. Inside a `workspace-write` sandboxed session the profile directory may live outside the workspace — install from a normal terminal or approve the escalation.

## Configuration

Tool resolution order: explicit `mlirOptPath` / `mlirReducePath` (no PATH fallback, so failures surface early) → `toolchainJson` or auto-discovered `<cwd>/mlir-lang/toolchain.json` / `<cwd>/toolchain.json` → PATH.

| key | default | notes |
| --- | --- | --- |
| `timeoutMs` | `120000` | per subprocess |
| `graceMs` | `5000` | grace before killing a timed-out child |
| `maxTotalMs` | `900000` | whole tool call budget |
| `maxIrBytes` | `33554432` | input limit → `IR_TOO_LARGE` |
| `maxOutputBytes` | `1048576` | excerpt limit (full output still on disk) |
| `maxReduceIterations` | `200` | advisory only |
| `maxReduceTimeMs` | `600000` | reduction budget |
| `maxBisectRuns` | `64` | bisect run cap |
| `workDir` | `'.crash-triage'` | artifact root, relative to the session cwd |
| `keepWorkDir` | `true` | `false` deletes artifacts only on success |
| `toolchainJson` | `''` | explicit toolchain file |
| `mlirOptPath` / `mlirReducePath` | `''` | explicit executables |
| `sanitizerMode` | `'auto'` | `auto` / `off` / `asan` / `ubsan` |
| `maxFrames` | `10` | sanitizer frames kept |
| `crashExitCodes` | Win: 3221225477, 3221225725, 3221226505, 3221225501, 2147483651; Unix: 134, 139, 132, 136 | crash codes |
| `crashPatterns` | `LLVM ERROR:`, `Assertion failed:`, `PLEASE submit a bug report`, `Stack dump:`, `AddressSanitizer:`, `UndefinedBehaviorSanitizer:`, `runtime error:` | crash markers |

Environment overrides: `CRASH_TRIAGE_TIMEOUT_MS`, `CRASH_TRIAGE_MAX_OUTPUT_BYTES`, `CRASH_TRIAGE_TOOLCHAIN_JSON`.

## Tool `crash_triage`

Key parameters: `action`, `irPath` (resolved against `cwd`), `stdin` (inline IR text), `pipeline`, `passList` (top-level passes; also the bisect split), `runnerArgs`, `cwd`, `env`, `timeoutMs`, `outputDir` (must stay inside the session cwd), `keepWorkDir`, `sanitizer{ mode, reportPath, inline, maxFrames }`, `reduce{ enabled, maxIterations, maxTimeMs, maxCandidates, testArgs }`, `bisect{ enabled, maxRuns, strategy, stopAtFirst }`, `report{ format, includeStderr }`.

```json
{ "irPath": "tests/crash.mlir", "pipeline": "builtin.module(func.func(canonicalize,cse),canonicalize)" }
```

```json
{ "action": "bisect", "irPath": "tests/crash.mlir", "passList": ["func.func(cse)", "func.func(canonicalize)", "cse"] }
```

```json
{ "irPath": "tests/crash.mlir", "sanitizer": { "mode": "asan", "reportPath": "logs/asan.txt" } }
```

```json
{ "action": "parse", "sanitizer": { "inline": "==1==ERROR: AddressSanitizer: heap-use-after-free ..." } }
```

`status` is one of `diagnosed` / `reduced` / `bisected` / `parsed` / `partial` / `failed`. `ok` is `true` only when every requested stage succeeded; in `diagnose` a failed reduction still lets pass bisect run, and the result comes back as `ok:false, status:"partial"` with the earlier stages kept. A single nested top-level pass yields `PASS_NESTED` the same way (`partial`, `bisect.attempted:false`).

Success shape: `{ ok, status, action, input{ irPath, sha256, pipeline }, crash{ reproduced, stable, attempts, exitCode, kind, signature{ key }, sanitizer }, reducer{ attempted, ok, reductionPercent, outputPath }, bisect{ attempted, ok, failingPass, failingIndex, passingPrefix, evidence }, reproducer{ command, text }, artifacts{ workDir, reportPath, ... }, warnings, hints }`. Failures carry `error{ code, message, hint, stage }` and still write `result.json` / `report.md`.

## Artifacts

`<workDir>/<YYYYMMDD-HHMMSS>-<ir-name>/` contains `input.mlir`, `baseline.stdout.log`, `baseline.stderr.log`, `sanitizer.log`, `minimized.mlir` / `last-good.mlir`, `tester.log`, `reduce.log`, `passes.log`, `reproducer.txt`, `result.json` and `report.md` (one-line conclusion, reproducer, input, crash, minimal IR, failing pass, sanitizer stack, artifacts, next steps, warnings, hints).

## Classification and signature

Order: sanitizer output > crash exit codes/signals > crash patterns > other non-zero exits with only `error:` / verifier diagnostics → `NOT_A_CRASH`. Exit code 0 with a crash marker still counts as a crash. Three runs (1 + 2 retries) must agree on `key = kind|errorType|topFrame|exitCode` for `stable:true`; addresses, PIDs, temp dirs, CRLF and ANSI colors are normalized away.

## Reducer tester protocol (differs from the spec)

Spec 3.7.3 says "tester exit 1 = not interesting". The MLIR source (`mlir/lib/Reducer/Tester.cpp`) does the opposite:

- `exit 1` = **interesting** (candidate still crashes with the same signature);
- `exit 0` = not interesting;
- a broken tester also exits 0 but logs an `error` line → reported as `REDUCE_TESTER_PROTOCOL`.

```
mlir-reduce <input.mlir> -reduction-tree=test=<node.exe> test-arg=<tester.mjs> test-arg=<tester.json> -o <out.mlir>
```

The tester child receives `<node.exe> <tester.mjs> <test-arg…> <candidate mlir>` — the candidate is always last. After reduction the plugin re-verifies the minimal IR with the original pipeline; a signature mismatch falls back to `last-good.mlir` and reports `REDUCE_UNSTABLE`.

## Error codes

`INVALID_ARGUMENT`, `PIPELINE_INVALID`, `PASS_LIST_INVALID`, `TOOL_NOT_FOUND`, `IR_NOT_FOUND`, `IR_READ_FAILED`, `IR_TOO_LARGE`, `OUTPUT_DIR_ESCAPE`, `WORKDIR_FAILED`, `CRASH_TIMEOUT`, `NOT_A_CRASH`, `NOT_REPRODUCED`, `FLAKY_CRASH`, `SANITIZER_NOT_FOUND`, `REDUCE_FAILED`, `REDUCE_TIMEOUT`, `REDUCE_UNSTABLE`, `REDUCE_TESTER_PROTOCOL`, `BISECT_FAILED`, `BISECT_INCONCLUSIVE`, `PASS_NESTED`, `CANCELLED`.

## Limitations

Parse-stage crashes (e.g. very deep nesting) also crash @@mlir-reduce@@ itself before it ever calls the tester, leaving an empty @@reduced.mlir@@ — reported as @@REDUCE_FAILED@@ (with mlir-reduce's exit code), not @@REDUCE_UNSTABLE@@. No symbolization; nested pipelines are not split (`func.func(a,b)` counts as one top-level segment); `mlir-reduce` has no iteration cap so `maxIterations` / `maxCandidates` only warn; the signature is derived from process output only; bisect uses prefix search plus `print-ir` cross-check, and conflicting evidence is kept with a warning.

## Tests

```bash
npm test        # 43 unit tests, mock runner, no LLVM needed
npm run smoke   # real mlir-opt; prints SKIP and exits 0 when the binary is absent
```

`CRASH_TRIAGE_MLIR_OPT` / `CRASH_TRIAGE_MLIR_REDUCE` point the smoke test at your build (default `D:\Code\llvm-build\bin\`). Fixtures include a real 4000-level nested `scf.execute_region` crash (access violation, empty stderr) and non-crashing deep/verifier/pass-error IRs.

## License

MIT — see [LICENSE](LICENSE).
