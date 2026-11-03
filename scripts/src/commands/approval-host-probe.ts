import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import type { CommandContext } from '../core/command-context.js'
import { runIsolatedTest } from '../core/test-run.js'
import { ensurePnpmShim, initProfile, serveAndCheck } from '../core/web-harness.js'
import { sleep } from '../core/exec.js'
import { isRecord } from '../core/json.js'
import { artifactLock, assertArtifactsUnchanged, assertConsumed, loadArtifacts } from '../core/artifacts.js'
import { artifactPrerequisites, installArtifactPackages } from '../core/artifact-harness.js'
import { checkInstalledPackage } from '../core/artifact-package.js'

const APPROVAL_PACKAGE = '@local/approval-allowlist'

export interface ApprovalProbeArtifactBinding {
  manifestPath: string; manifestSha256: string; batch: string; sourceSha256: string
  packageName: string; packageVersion: string; packageSha256: string
  installedPackage: string; installedEntry: string; platform: 'mac'; surface: 'web'
}

/** Keep the complete manifest and its freshness/content gates, even though only one package is installed. */
export function loadApprovalProbeArtifacts(root: string, manifest: string) {
  const set = loadArtifacts(root, manifest)
  const item = set.manifest.packages.find(p => p.name === APPROVAL_PACKAGE)
  assert.ok(item, `manifest must contain ${APPROVAL_PACKAGE}`)
  assert.ok(item.surfaces.includes('web') && item.platforms.includes('mac'), `${APPROVAL_PACKAGE} is incompatible with Web/macOS`)
  const pkg = set.packages.get(APPROVAL_PACKAGE)!
  return { set, item, pkg }
}

/** Real Web services/providers, driven by a disclosed same-process test driver, never an LLM. */
export async function runApprovalHostProbe(options: { keep: boolean; timeoutMs: number; manifest?: string | undefined }, settings: CommandContext): Promise<number> {
  const release = options.manifest !== undefined ? artifactLock(settings.root) : () => {}
  try {
    // Reject invalid manifests before any profile or host operation; never fall back to source.
    const artifacts = options.manifest !== undefined ? loadApprovalProbeArtifacts(settings.root, options.manifest) : undefined
    return await runIsolatedTest('approval-host-probe', settings, options, async context => {
      let binding: ApprovalProbeArtifactBinding | undefined
      await context.step('prerequisites', async () => {
        assert.equal(process.platform, 'darwin', 'this acceptance entry targets Web/macOS only')
        if (artifacts) artifactPrerequisites(context, artifacts.set)
        else {
          assert.ok(existsSync(join(settings.root, 'approval-allowlist/lib/index.js')), 'build approval-allowlist before running this development probe')
          ensurePnpmShim(context)
        }
        mkdirSync(join(context.runDir, 'workspace'), { recursive: true })
        return artifacts ? `fixed artifacts; manifest SHA-256 ${artifacts.set.hash}; package SHA-256 ${artifacts.item.sha256}`
          : 'development source probe (NOT fixed-artifact acceptance); workspace-locked DSH; no daily home, credentials, provider substitution, or port 3080'
      })
      await context.step('profile-init', () => initProfile(context, 'profile-init', context.home))
      if (artifacts) await context.step('install-artifacts', async () => {
        const detail = await installArtifactPackages(context, artifacts.set, [APPROVAL_PACKAGE])
        const installedPackage = checkInstalledPackage(artifacts.pkg, join(context.home, 'profiles/web'), settings.root)
        binding = { manifestPath: artifacts.set.path, manifestSha256: artifacts.set.hash, batch: artifacts.set.manifest.batch,
          sourceSha256: artifacts.set.manifest.source.sha256, packageName: artifacts.item.name, packageVersion: artifacts.item.version,
          packageSha256: artifacts.item.sha256, installedPackage, installedEntry: join(installedPackage, artifacts.pkg.entry), platform: 'mac', surface: 'web' }
        writeFileSync(join(context.runDir, 'artifact-binding.json'), `${JSON.stringify(binding, null, 2)}\n`)
        return detail
      })
      const checkFixedInputs = () => {
        if (!artifacts) return
        assertArtifactsUnchanged(artifacts.set)
        assertConsumed(artifacts.set, artifacts.item, join(context.runDir, 'inputs', artifacts.item.path))
        assert.equal(checkInstalledPackage(artifacts.pkg, join(context.home, 'profiles/web'), settings.root), binding!.installedPackage)
      }
      for (const mode of ['observe', 'allow'] as const) {
        checkFixedInputs()
        const evidenceDir = join(context.runDir, 'evidence', mode)
        mkdirSync(evidenceDir, { recursive: true })
        const overlay = join(context.runDir, `${mode}.patch.yml`)
        writeFileSync(overlay, stringify([
          { id: 'sandbox-policy', config: { mode: 'read-only' } },
          { id: 'approval', config: { policy: 'ask' } },
          // No browser answerer is attached to this programmatic probe. Keep the real
          // ApprovalService, replacing only the UI forwarding seam with a rejecting test answerer.
          { id: 'api-remotes', disabled: true },
          // The manager's bundle row must not activate a second, default-configured instance.
          ...(binding ? [{ id: 'approval-allowlist', disabled: true }] : []),
          { insert: [
            { id: 'approval-probe-allowlist', name: artifacts ? binding!.installedEntry : join(settings.root, 'approval-allowlist/lib/index.js'), config: {
              mode, grantsFile: `approval-allowlist/${mode}-grants.json`, log: true, logArguments: true,
              logFile: join(evidenceDir, 'audit.jsonl'), rootOnly: true,
            } },
            { id: 'approval-host-probe', name: fileURLToPath(new URL('../probes/approval-host-fixture.js', import.meta.url)), config: {
              mode, runDir: context.runDir, evidenceDir, home: context.home,
              ...(binding ? { artifactBinding: binding } : {}),
            } },
          ] },
        ]))
        const runner = context.runner
        const withOverlay = { ...context, runner: { ...runner, build: (args: readonly string[]) => runner.build(['--profile', 'web', '--patch', overlay, ...args.slice(1)]) } }
        await context.step(`real-web-${mode}`, () => serveAndCheck(withOverlay, mode, async (_url, stderr) => {
          if (/did not activate/.test(stderr)) throw new Error(`loader activation failed: ${stderr}`)
          // File trigger keeps the probe outside loader activation: preset.mount waits for loader settlement.
          writeFileSync(join(evidenceDir, 'start'), 'programmatic-host-probe\n')
          const output = join(evidenceDir, 'result.json')
          const deadline = Date.now() + options.timeoutMs
          while (!existsSync(output)) {
            context.signal?.throwIfAborted()
            if (Date.now() >= deadline) throw new Error(`probe timeout; inspect ${evidenceDir}`)
            await sleep(100)
          }
          const result: unknown = JSON.parse(readFileSync(output, 'utf8'))
          assert.ok(isRecord(result) && result.provenance === 'programmatic-host-probe')
          assert.equal(result.ok, true, JSON.stringify(result, null, 2))
          if (binding) assert.deepEqual(result.artifactBinding, binding, 'probe result must bind the consumed fixed package')
          checkFixedInputs()
          return `${mode}: real tools, waterfall, persisted event readback; NOT LLM-generated calls; ${output}${binding ? `; manifest SHA-256 ${binding.manifestSha256}; package SHA-256 ${binding.packageSha256}` : '; development source only'}`
        }))
      }
      if (artifacts) await context.step('artifact-integrity', async () => {
        checkFixedInputs()
        return `manifest SHA-256 ${artifacts.set.hash}; package SHA-256 ${artifacts.item.sha256}; installed bytes unchanged after both probes`
      })
    })
  } finally { release() }
}
