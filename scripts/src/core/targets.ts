export type Surface = 'desktop' | 'web'
export type Platform = 'windows' | 'mac'

export interface Target {
  readonly surface: Surface
  readonly platform: Platform
}

export interface TargetOptions {
  readonly surface?: string | undefined
  readonly platform?: string | undefined
  readonly profile?: string | undefined
}

/**
 * Resolves the target a command should act on. Explicit values win; otherwise
 * the current OS and the profile name (desktop/web) provide defaults.
 */
export function resolveTarget(options: TargetOptions = {}): Target {
  let platform = options.platform ?? ''
  let surface = options.surface ?? ''

  if (platform === '') {
    if (process.platform === 'win32') platform = 'windows'
    else if (process.platform === 'darwin') platform = 'mac'
    else if (process.platform === 'linux') throw new Error('Linux is reserved; only windows and mac targets are enabled.')
    else throw new Error('Unsupported current platform; pass --platform windows|mac.')
  }

  if (surface === '') {
    const name = options.profile ?? process.env['DSH_PROFILE'] ?? ''
    if (name === 'desktop') surface = 'desktop'
    else if (name === 'web') surface = 'web'
    else throw new Error(`Cannot infer surface from profile '${name}'; pass --surface desktop|web.`)
  }

  if (surface !== 'desktop' && surface !== 'web') throw new Error(`Unsupported surface '${surface}'; use desktop or web.`)
  if (platform !== 'windows' && platform !== 'mac') throw new Error(`Unsupported platform '${platform}'; use windows or mac.`)

  return { surface, platform }
}

export function isTargetCompatible(plugin: { readonly surfaces: readonly string[]; readonly platforms: readonly string[] }, target: Target): boolean {
  return plugin.surfaces.includes(target.surface) && plugin.platforms.includes(target.platform)
}

export function formatPluginTarget(plugin: { readonly surfaces: readonly string[]; readonly platforms: readonly string[] }): string {
  return `${plugin.surfaces.join('+')}/${plugin.platforms.join('+')}`
}

export function surfaceLabel(surfaces: readonly string[], language: 'zh' | 'en'): string {
  const hasDesktop = surfaces.includes('desktop')
  const hasWeb = surfaces.includes('web')
  if (hasDesktop && hasWeb) return language === 'zh' ? '通用' : 'Universal'
  if (hasDesktop) return language === 'zh' ? '桌面' : 'Desktop'
  if (hasWeb) return 'Web'
  return language === 'zh' ? '未声明' : 'Undeclared'
}

export function platformLabel(platforms: readonly string[], language: 'zh' | 'en'): string {
  const hasWindows = platforms.includes('windows')
  const hasMac = platforms.includes('mac')
  if (hasWindows && hasMac) return language === 'zh' ? '通用平台' : 'All platforms'
  if (hasWindows) return 'Windows'
  if (hasMac) return 'macOS'
  return language === 'zh' ? '未声明' : 'Undeclared'
}
