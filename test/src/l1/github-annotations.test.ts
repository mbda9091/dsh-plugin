import assert from 'node:assert/strict'
import { it } from 'node:test'
import { failureAnnotation } from '../../../scripts/.build/core/github-annotations.js'

it('L1 CI annotations preserve diagnostics while redacting tokens and escaping workflow commands', () => {
  const result = failureAnnotation('failed 50%\r\n::warning::injected\nhttp://localhost/?token=PRIVATE_TOKEN Bearer PRIVATE_BEARER')
  assert.match(result, /^::error title=Test failure::failed 50%25%0D%0A::warning::injected%0A/)
  assert.doesNotMatch(result, /[\r\n]|PRIVATE_TOKEN|PRIVATE_BEARER/)
})
