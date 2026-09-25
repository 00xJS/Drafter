import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The iOS shell's own settings, read as data: what Info.plist lets the app do.
// None of it runs in node, and a wrong value fails nothing in the build — an
// iPhone just turns sideways, or opens on a second copy of the bridge — so the
// values are held here.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, 'utf8')
const plist = read('ios/App/App/Info.plist')
const scene = read('ios/App/App/SceneDelegate.swift')
const project = read('ios/App/App.xcodeproj/project.pbxproj')

/** A Swift func's body, braces and all: from its name to the brace that closes it. */
function swiftFunc(src: string, name: string): string {
  const start = src.search(new RegExp(`func ${name}\\b`))
  expect(start, `func ${name}`).toBeGreaterThanOrEqual(0)
  const open = src.indexOf('{', start)
  for (let i = open, depth = 0; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

/** Whether the App target compiles `name`: its file reference, in the App group, built in the Sources phase. */
function compiledInApp(name: string): boolean {
  const ref = new RegExp(`(\\w{24}) /\\* ${name} \\*/ = \\{isa = PBXFileReference; lastKnownFileType = sourcecode\\.swift; path = ${name}; sourceTree = "<group>"; \\};`).exec(project)?.[1]
  const build = ref && new RegExp(`(\\w{24}) /\\* ${name} in Sources \\*/ = \\{isa = PBXBuildFile; fileRef = ${ref} /\\* ${name} \\*/; \\};`).exec(project)?.[1]
  const group = /504EC3061FED79650016851F \/\* App \*\/ = \{[\s\S]*?children = \(([\s\S]*?)\);/.exec(project)?.[1] ?? ''
  const sources = /504EC3001FED79650016851F \/\* Sources \*\/ = \{[\s\S]*?files = \(([\s\S]*?)\);/.exec(project)?.[1] ?? ''
  return !!ref && !!build && group.includes(`${ref} /* ${name} */`) && sources.includes(`${build} /* ${name} in Sources */`)
}

/** The strings of an array key in the plist, in order. Null when the key is not there. */
function strings(key: string): string[] | null {
  const body = new RegExp(`<key>${key.replace(/[~.]/g, '\\$&')}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(plist)?.[1]
  return body === undefined ? null : [...body.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1])
}

describe('orientation', () => {
  it('holds an iPhone upright: sideways it got the desktop layout, 36px controls and a sliver above the keyboard', () => {
    expect(strings('UISupportedInterfaceOrientations')).toEqual(['UIInterfaceOrientationPortrait'])
  })

  it('leaves an iPad every way round, as Split View and Stage Manager need', () => {
    expect(strings('UISupportedInterfaceOrientations~ipad')?.sort()).toEqual(
      ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight', 'UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown'].sort(),
    )
  })

  it('is read by the bridge from the same key, so the web view never turns on its own', () => {
    // CAPBridgeViewController.setScreenOrientationDefaults builds
    // supportedInterfaceOrientations from this key (iOS hands an iPad its ~ipad copy)
    const bridge = read('node_modules/@capacitor/ios/Capacitor/Capacitor/CAPBridgeViewController.swift')
    expect(bridge).toMatch(/plist\["UISupportedInterfaceOrientations"\] as\? \[String\]/)
    expect(read('ios/App/App/SceneDelegate.swift')).not.toMatch(/supportedInterfaceOrientations/)
  })
})

describe('the privacy cover leaves a system alert the page asked for in context', () => {
  const plugin = read('ios/App/App/ShellPlugin.swift')

  it('is a plugin the app compiles and registers before the page loads', () => {
    expect(compiledInApp('ShellPlugin.swift')).toBe(true)
    expect(swiftFunc(scene, 'capacitorDidLoad')).toContain('bridge?.registerPluginInstance(ShellPlugin())')
    expect(/public let jsName = "(\w+)"/.exec(plugin)?.[1]).toBe('Shell')
  })

  it('puts the word in place on the main thread before answering, so iOS is asked only after it', () => {
    const method = swiftFunc(plugin, 'expectSystemPrompt')
    expect(method).toMatch(/DispatchQueue\.main\.async \{\s*SystemPrompt\.expect\(\)\s*call\.resolve\(\)\s*\}/)
  })

  it('skips one resign-active cover within three seconds of the word, and uses the word up', () => {
    expect(plugin).toMatch(/static let window: TimeInterval = 3\b/)
    const consume = swiftFunc(plugin, 'consume')
    // used up whatever the answer: one alert, one pass
    expect(consume).toMatch(/defer \{ until = nil \}/)
    expect(consume).toMatch(/return now < until/)
    expect(swiftFunc(scene, 'sceneWillResignActive')).toMatch(/coverGeneration \+= 1\s*if SystemPrompt\.consume\(\) \{ return \}\s*showPrivacyCover\(\)/)
  })

  it('still covers every time the app goes to the background', () => {
    const background = swiftFunc(scene, 'sceneDidEnterBackground')
    expect(background).toContain('showPrivacyCover(force: true)')
    expect(background).not.toContain('SystemPrompt')
    // and nothing else lets the word through
    expect([...scene.matchAll(/SystemPrompt\.\w+/g)].map(m => m[0])).toEqual(['SystemPrompt.consume'])
  })
})

describe('the badge, set by the page and nothing else', () => {
  const plugin = read('ios/App/App/ShellPlugin.swift')
  const native = read('src/native.ts')

  it('is one method on the shell’s plugin, called as the page names it', () => {
    const methods = [...plugin.matchAll(/CAPPluginMethod\(name: "(\w+)", returnType: CAPPluginReturnPromise\)/g)].map(m => m[1])
    expect(methods).toEqual(['expectSystemPrompt', 'setBadge'])
    const members = /interface ShellPlugin \{([\s\S]*?)\n\}/.exec(native)?.[1] ?? ''
    expect([...members.matchAll(/^ {2}(\w+)\(/gm)].map(m => m[1])).toEqual(methods)
    expect(native).toMatch(/plugin\.setBadge\(\{ count: Math\.max\(0, Math\.floor\(count\)\) \}\)/)
    expect(swiftFunc(plugin, 'setBadge')).toMatch(/let count = max\(0, call\.getInt\("count"\) \?\? 0\)\s*UNUserNotificationCenter\.current\(\)\.setBadgeCount\(count\)/)
  })

  it('leaves Notification Centre alone: nothing in the app empties it', () => {
    const sources = (dir: string): string[] =>
      readdirSync(`${ROOT}${dir}`, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? (e.name === '__tests__' ? [] : sources(`${dir}/${e.name}`)) : /\.tsx?$/.test(e.name) ? [read(`${dir}/${e.name}`)] : [],
      )
    const code = [...sources('src'), plugin, scene].join('\n')
    expect(code).not.toMatch(/removeAllDeliveredNotifications/)
  })
})
