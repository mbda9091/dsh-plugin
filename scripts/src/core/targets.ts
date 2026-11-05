export type Surface = 'desktop' | 'web'
export type Platform = 'windows' | 'mac' | 'linux'

export function platformFromNode(platform: string = process.platform): Platform {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'mac'
  if (platform === 'linux') return 'linux'
  throw new Error(`Unsupported current platform '${platform}'.`)
}

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

  if (platform === '') platform = platformFromNode()

  if (surface === '') {
    const name = options.profile ?? process.env['DSH_PROFILE'] ?? ''
    if (name === 'desktop') surface = 'desktop'
    else if (name === 'web') surface = 'web'
    else throw new Error(`Cannot infer surface from profile '${name}'; pass --surface desktop|web.`)
  }

  if (surface !== 'desktop' && surface !== 'web') throw new Error(`Unsupported surface '${surface}'; use desktop or web.`)
  if (platform !== 'windows' && platform !== 'mac' && platform !== 'linux') throw new Error(`Unsupported platform '${platform}'; use windows, mac or linux.`)

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
  const labels = [['windows', 'Windows'], ['mac', 'macOS'], ['linux', 'Linux']] as const
  if (labels.every(([platform]) => platforms.includes(platform))) return language === 'zh' ? '通用平台' : 'All platforms'
  return labels.filter(([platform]) => platforms.includes(platform)).map(([, label]) => label).join(' / ')
    || (language === 'zh' ? '未声明' : 'Undeclared')
}
