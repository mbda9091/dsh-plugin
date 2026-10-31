import { createServer as tcpServer } from 'node:net'
import type { CommandContext } from './command-context.js'
import { developmentPaths, readDevelopmentOwner, validateDevelopmentPaths } from './development.js'
import { createWebProcessControl, stopWebProcess, webProcessStatus } from './web-process.js'

function scope(context: CommandContext) {
  return { runtime: developmentPaths(context.root).runtime, owner: readDevelopmentOwner(context).id,
    validate: () => validateDevelopmentPaths(context) }
}

export const developmentStatus = (context: CommandContext) => webProcessStatus(scope(context))
export const stopDevelopment = (context: CommandContext) => stopWebProcess(scope(context))
export const createDevelopmentControl = (context: CommandContext, stop: () => void) => createWebProcessControl(scope(context), stop)

/** Refuse an occupied port; DSH must never pick a different port silently. */
export async function checkDevelopmentPort(port: number, host: string): Promise<void> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535')
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('development Web must listen on loopback')
  await new Promise<void>((resolve, reject) => {
    const server = tcpServer()
    server.once('error', () => reject(new Error(`development port ${port} is occupied or unavailable; no process was stopped`)))
    server.listen(port, host, () => server.close(error => error ? reject(error) : resolve()))
  })
}
