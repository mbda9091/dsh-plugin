# Real Web/macOS approval probe

## Two input modes

**M4 fixed-artifact acceptance (Web/macOS only):** use the current fixed manifest produced by the release owner. The probe does not build, pack, or substitute source code:

```text
node scripts/bootstrap.mjs approval-host-probe --manifest dist/batches/<batch>/manifest.json --timeout 45000
```

The full original manifest is checked by `loadArtifacts`, including current-batch/source freshness, every archive's SHA-256 and package contracts. It must contain a Web/macOS-compatible `@local/approval-allowlist`. `artifactPrerequisites` checks imports, then `installArtifactPackages` installs only that named package through the existing artifact harness into a fresh profile. Selection does not construct a subset manifest or a new manifest hash. `checkInstalledPackage` rejects source links, missing/extra/changed installed files, and missing tarball bundle registration. The probe loads the verified **installed package entry**, never the repository's `approval-allowlist/lib`. The manager-installed default row is disabled in the run-owned overlay to avoid running two instances; the configured probe row uses the installed entry. Inputs and installed bytes are rechecked before/after both modes and at completion. Invalid/missing/stale/incompatible manifests fail closed; there is no source fallback. A pack/consumption lock excludes concurrent artifact commands.

Each artifact run writes `artifact-binding.json` with the full manifest SHA-256, package SHA-256/version, batch/source SHA-256, installed package/entry paths, and `mac`/`web` scope. Both `evidence/{observe,allow}/result.json` and persisted event exports carry the same `artifactBinding`; lifecycle report steps include both hashes. Default cleanup retains this evidence while removing the owned profile. This is additional programmatic real-host evidence, **not** a replacement for `verify-artifacts`, and does not authorize stable installation by itself.

**Development-source probe (not M4 fixed-artifact acceptance):** the original no-manifest entry remains available after building:

```text
node scripts/bootstrap.mjs build
node scripts/bootstrap.mjs approval-host-probe --keep
```

Only this development mode loads the repository's built `approval-allowlist/lib/index.js` without installing a package. Its result is marked `inputKind: development-source`; fixed runs use `inputKind: fixed-artifact`.

The TypeScript command and fixture live in `scripts/src/commands/approval-host-probe.ts` and `scripts/src/probes/approval-host-fixture.ts`. They reuse `runIsolatedTest`, `initProfile`, `childEnv` and `serveAndCheck`. The host is the exact workspace development DSH, with a fresh `.tmp/approval-host-probe/run-*/dsh-home`, explicit `web` profile and port `0`. No existing home, credential file, environment's Web URL, or port 3080 is used. Both modes use a run-owned `--patch` overlay and the compiled test fixture. Launcher options precede Web application options.

## What this proves (and what it does not)

This is explicitly **programmatic-host-probe**, not an LLM-generated or human-user tool conversation. The fixture creates real root Agents with the shipped `standard` preset. The test driver records its own turn/step boundaries, **synthetic assistant tool advertisements**, `tool/call`, and actual `tool/result`, dispatching through the mounted `ToolRuntime`. V4 storage requires each tool call to be advertised by an assistant message; its source is deliberately `synthetic-host-probe-no-llm` / `synthetic-lifecycle-advertisement`, with no model stream. This is synthetic lifecycle scaffolding, not model output. No LLM adapter, shell provider or filesystem provider is installed or replaced. The temporary overlay disables only `api-remotes` (the UI answer-forwarding seam): without a browser that seam waits for remote answers rather than falling through. The actual approval service, preset tools, FS provider and shell provider remain mounted. `ApprovalService` itself writes `approval/asked` and `approval/decided`. The test-only terminal waterfall answerer returns `rejected`; it never claims to be a human or grants permission. Matching grants must be answered by the actual plugin before reaching this fallback.

Evidence records the live and persisted Session header (`cwd`, `id`, preset), raw registered schemas, exact cases/results, and the matching plugin audit JSONL. After calls finish, the fixture flushes `sessionPersistence`, opens real read handles and compares stored events and header against the live session before exporting evidence. A missing or failing durability check fails the run.

Covered scenarios:

- `observe`: matching `write`, `edit`, and `bash` continue to the rejection answerer without mutation; `read` remains possible.
- `allow`: exact structured `write` and `edit`, and complete `bash` command/workdir/mode rules produce `allowed-once` and actual run-owned external-file mutations.
- Unmatched and revoked file grants reject without mutation. Revocation is direct editing of the **test-owned** authorization file, not a claim that management-tool approval was exercised.
- A project grant fails in a different actual Session cwd; a separate permanent grant succeeds from that other project.
- Separate bash negative cases alter the exact command, workdir, or sandbox mode and remain rejected without side effects.
- The real `approval_list` tool is registered and executes. `approval_allow` reaches independent approval, is rejected, and leaves the authorization file byte-for-byte unchanged.
- A call approved from standing `read-only` to one-shot `workspace-write` still receives the real filesystem provider's `FS_SANDBOX_DENIED` when targeting a run-owned sibling of the Session workspace. The denial marker and absence of the file are asserted. The denied operation is not retried or rerouted.
- Standing policy remains `read-only` after approved calls.

Limits: no real LLM request; no browser UI click/visual check; no simulated provider; no Windows/Desktop acceptance; no management-tool **successful human-approved mutation** acceptance (only real management list and rejected mutation are covered). `danger-full-access` deliberately removes confinement for that call: do not describe it as a directory-limited grant. The real FS provider's in-process fence is not macOS kernel confinement; shell acceptance and FS denial are separately identified. Unmatched requests terminate that operation; independent test cases have distinct targets.

## Targeted harness regressions

`test/src/l3/approval-host-probe.test.ts` covers malformed/missing/future manifests, absent approval package, modified selected **and unselected** tarballs, incompatible surface/platform, superseded batch/source drift, changed manifest during consumption, no source fallback or profile initialization after manifest failure, subset install selection, installed-byte corruption, and source-link rejection. Its synthetic USTAR fixtures and fake manager only test harness gates; they do not count as real-host acceptance.

```text
node node_modules/typescript/bin/tsc -p scripts/tsconfig.json
node node_modules/typescript/bin/tsc -p test/tsconfig.json
node --test test/.build/l3/approval-host-probe.test.js
```

## Historical development-source run (2026-11-03, Asia/Shanghai)

This earlier no-manifest run is **not fixed-artifact M4 evidence**. A new fixed-manifest probe and `verify-artifacts` are required for M4 acceptance.

`node scripts/bootstrap.mjs approval-host-probe --timeout 45000` passed all lifecycle phases on macOS / ordinary Node v24.16.0 / workspace DSH 0.2.1-rc.2. Run: `.tmp/approval-host-probe/run-WMIOxL`; durable report: `report.json`; detailed cases, raw schemas and audit: `evidence/{observe,allow}/result.json` and `audit.jsonl`; each `programmatic-approval-probe-*.json` contains the real storage-read header and event log. Observe: four calls (three explicit rejections and one successful read). Allow: fourteen calls (including all negative cases and management checks). Default cleanup removed the owned home, shim and fixture workspace; evidence and logs remain. Earlier corrected failures were not counted as success: launcher flag placement, remote UI waiting, missing step/advertised lifecycle, and the storage header's default `delegationDepth: 0`.

This establishes **real-host integration field and provider behavior**, not real-LLM end-to-end acceptance. Persistent approval pairs are host-generated and matched by id and callId; lifecycle scaffolding is synthetic and identified as such in every export.

Reports/logs/evidence remain under the run directory. By default lifecycle cleanup removes only the owned home, shim and workspace; `--keep` retains them. Failed runs retain their evidence. Launch logs can contain a one-time launch token and must stay local. Raw argument logging is enabled only in this disposable test profile; the test does not claim production audit redaction coverage.
