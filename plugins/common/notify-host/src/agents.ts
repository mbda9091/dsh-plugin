import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'

/** Resolve live roots through the host's subagent tree, not fork lineage. */
export function rootAgents(ctx: Context): Agent[] {
  try {
    const agents = ctx.get('agents')?.list() ?? []
    const subagents = ctx.get('subagents')
    return agents.filter(agent => {
      try {
        return subagents === undefined
          ? agent.session.header.origin !== 'subagent'
          : subagents.rootOf(agent) === agent
      } catch {
        // Detached or unavailable tree ownership is not positive root evidence.
        return false
      }
    })
  } catch {
    return []
  }
}
