import { inspect } from 'node:util'
import type { TestEvent } from 'node:test/reporters'
import { failureAnnotation } from './github-annotations.js'

/** Supplement the normal spec reporter with actionable GitHub check annotations. */
export default async function* report(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  for await (const event of source) {
    if (event.type === 'test:fail') yield failureAnnotation(`${event.data.name}: ${inspect(event.data.details.error, { depth: 6, colors: false })}`) + '\n'
  }
}
