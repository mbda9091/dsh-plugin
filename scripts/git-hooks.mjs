import { launch } from './launch.mjs'

// Pushing never rebuilds shared scripts output while tests may be using it.
if (process.argv[2] === 'pre-push') {
  try {
    const { main } = await import('./.build/git-hooks.js')
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(`pre-push: test cleanup unavailable; push may continue: ${error.message}`)
    process.exitCode = 0
  }
} else {
  await launch('git-hooks.js')
}
