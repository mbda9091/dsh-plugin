import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChildProcess } from 'node:child_process'

const current = new AsyncLocalStorage<OwnedProcesses>()

/** A rejected command does not prove that its OS process tree has stopped. */
export class OwnedProcesses {
  private readonly pending = new Map<ChildProcess, () => Promise<void>>()
  private closing = false

  run<T>(body: () => T): T {
    this.assertOpen()
    return current.run(this, body)
  }

  assertOpen(): void {
    if (this.closing) throw new Error('owned process scope is closing')
  }

  track(child: ChildProcess, stop: () => Promise<void>): void {
    this.assertOpen()
    this.pending.set(child, stop)
  }

  confirmed(child: ChildProcess): void { this.pending.delete(child) }

  assertIdle(): void {
    if (this.pending.size) throw new Error('owned process tree exit is unconfirmed')
  }

  async settle(): Promise<void> {
    this.closing = true
    const failures: unknown[] = []
    for (const stop of [...this.pending.values()]) {
      try { await stop() } catch (error) { failures.push(error) }
    }
    if (this.pending.size || failures.length) throw new AggregateError(failures, 'owned process tree exit is unconfirmed; retain the shared host lock')
  }
}

export const currentOwnedProcesses = () => current.getStore()
