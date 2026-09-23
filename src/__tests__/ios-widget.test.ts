import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// The widget is a second target, added to project.pbxproj by hand, and its two
// halves — the web view that writes the snapshot and the extension that reads
// it — are compiled by different tools that never see each other. So what
// Xcode is told is read here as data (scripts/lib/pbxproj.mjs), and the keys
// each side writes and reads are held to each other, the way
// subjectlift-ios.test.ts holds the cut-out's plugin to its wrapper.

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web', isPluginAvailable: () => false },
  registerPlugin: () => ({}),
}))

import { nativeTargets, parsePbxproj } from '../../scripts/lib/pbxproj.mjs'
import type { Task } from '../types'
import { CAPTURES_QUEUED, buildWidgetSnapshot, parseCaptures } from '../widgetbridge'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, 'utf8')
const PROJECT_DIR = 'ios/App'
const pbxText = read(`${PROJECT_DIR}/App.xcodeproj/project.pbxproj`)
const project = parsePbxproj(pbxText)
const objects = project.objects
const targets = nativeTargets(project)
const app = targets.find(t => t.name === 'App')!
const widget = targets.find(t => t.name === 'DrafterWidgets')!

/** A file reference's path from ios/App, through the groups that hold it. */
function pathOf(id: string): string {
  const ref = objects[id]
  const parent = Object.entries(objects).find(([, o]) => o.isa === 'PBXGroup' && (o.children as string[]).includes(id))
  const own = ref.path ?? ''
  if (!parent || ref.sourceTree !== '<group>') return own
  const above = pathOf(parent[0])
  return above ? `${above}/${own}` : own
}

/** The files in one of a target's build phases, as paths from ios/App. */
function phase(target: typeof app, isa: string): { paths: string[]; phase: Record<string, any> } {
  const found = (target.target.buildPhases as string[]).map(id => objects[id]).find(p => p.isa === isa)
  expect(found, `${target.name} has a ${isa}`).toBeTruthy()
  return { paths: (found!.files as string[]).map(id => pathOf(objects[id].fileRef)), phase: found! }
}

/** The values of an array key in a plist or entitlements file. */
function plistStrings(xml: string, key: string): string[] {
  const body = new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(xml)?.[1] ?? ''
  return [...body.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1])
}

describe('the widget target', () => {
  it('is an app extension in the project, with its product', () => {
    expect(targets.map(t => t.name).sort()).toEqual(['App', 'DrafterWidgets'])
    expect(widget.productType).toBe('com.apple.product-type.app-extension')
    expect(objects[widget.target.productReference].path).toBe('DrafterWidgets.appex')
    expect(objects[project.rootObject].targets).toContain(widget.id)
  })

  it('is signed like the app, automatically, by the same team, under the app’s bundle id', () => {
    for (const name of ['Debug', 'Release']) {
      const own = widget.configurations[name]
      const parent = app.configurations[name]
      expect(own.PRODUCT_BUNDLE_IDENTIFIER, name).toBe('app.drafter.ios.widgets')
      expect(own.PRODUCT_BUNDLE_IDENTIFIER.startsWith(`${parent.PRODUCT_BUNDLE_IDENTIFIER}.`)).toBe(true)
      expect(own.DEVELOPMENT_TEAM, name).toBe(parent.DEVELOPMENT_TEAM)
      expect(own.CODE_SIGN_STYLE, name).toBe('Automatic')
      expect(own.CODE_SIGN_IDENTITY, name).toBe(parent.CODE_SIGN_IDENTITY)
      expect(own.SKIP_INSTALL, name).toBe('YES')
      expect(own.IPHONEOS_DEPLOYMENT_TARGET, name).toBe(parent.IPHONEOS_DEPLOYMENT_TARGET)
      expect(own.SWIFT_VERSION, name).toBe(parent.SWIFT_VERSION)
      // App Store Connect refuses an extension whose numbers are not its app's
      expect(own.MARKETING_VERSION, name).toBe(parent.MARKETING_VERSION)
      expect(own.CURRENT_PROJECT_VERSION, name).toBe(parent.CURRENT_PROJECT_VERSION)
      expect(own.LD_RUNPATH_SEARCH_PATHS, name).toContain('@executable_path/../../Frameworks')
    }
  })

  it('has an Info.plist that makes it a WidgetKit extension, and carries the app’s numbers', () => {
    const file = widget.configurations.Release.INFOPLIST_FILE
    expect(widget.configurations.Debug.INFOPLIST_FILE).toBe(file)
    const plist = read(`${PROJECT_DIR}/${file}`)
    expect(plist).toMatch(/<key>NSExtension<\/key>\s*<dict>\s*<key>NSExtensionPointIdentifier<\/key>\s*<string>com\.apple\.widgetkit-extension<\/string>/)
    expect(plist).toMatch(/<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/)
    expect(plist).toMatch(/<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/)
    expect(plist).toMatch(/<key>CFBundlePackageType<\/key>\s*<string>\$\(PRODUCT_BUNDLE_PACKAGE_TYPE\)<\/string>/)
  })

  it('is embedded in the app and built before it', () => {
    const embed = (app.target.buildPhases as string[]).map(id => objects[id]).find(p => p.isa === 'PBXCopyFilesBuildPhase')
    expect(embed?.name).toBe('Embed Foundation Extensions')
    // 13 is the app's PlugIns folder, where iOS looks for extensions
    expect(embed?.dstSubfolderSpec).toBe('13')
    const [file] = embed!.files as string[]
    expect(objects[file].fileRef).toBe(widget.target.productReference)
    expect(objects[file].settings.ATTRIBUTES).toContain('RemoveHeadersOnCopy')
    const [dependency] = app.target.dependencies as string[]
    expect(objects[dependency].target).toBe(widget.id)
    expect(objects[objects[dependency].targetProxy].remoteGlobalIDString).toBe(widget.id)
  })

  it('compiles every Swift file in its folder, and the one it shares with the app', () => {
    const { paths } = phase(widget, 'PBXSourcesBuildPhase')
    const folder = readdirSync(`${ROOT}${PROJECT_DIR}/DrafterWidgets`).filter(f => f.endsWith('.swift'))
    expect(paths.sort()).toEqual([...folder.map(f => `DrafterWidgets/${f}`), 'App/SharedContainer.swift'].sort())
    for (const p of paths) expect(existsSync(`${ROOT}${PROJECT_DIR}/${p}`), p).toBe(true)
    // linked against the frameworks it draws with
    expect(phase(widget, 'PBXFrameworksBuildPhase').paths.sort()).toEqual(['System/Library/Frameworks/SwiftUI.framework', 'System/Library/Frameworks/WidgetKit.framework'])
  })

  it('leaves the app compiling its plugin, the Siri intents and the queue they share', () => {
    const { paths } = phase(app, 'PBXSourcesBuildPhase')
    for (const name of ['WidgetBridgePlugin.swift', 'CaptureQueue.swift', 'DrafterIntents.swift', 'SharedContainer.swift']) {
      expect(paths, name).toContain(`App/${name}`)
      expect(existsSync(`${ROOT}${PROJECT_DIR}/App/${name}`), name).toBe(true)
    }
  })

  it('names one App Group on the app, both of its entitlements files, and the widget', () => {
    const group = /static let groupIdentifier = "([^"]+)"/.exec(read(`${PROJECT_DIR}/App/SharedContainer.swift`))?.[1]
    expect(group).toBe('group.app.drafter.ios')
    const files = [
      `App/App.entitlements`,
      `App/App.paid.entitlements`,
      widget.configurations.Release.CODE_SIGN_ENTITLEMENTS,
    ]
    expect(widget.configurations.Debug.CODE_SIGN_ENTITLEMENTS).toBe(files[2])
    for (const file of files) expect(plistStrings(read(`${PROJECT_DIR}/${file}`), 'com.apple.security.application-groups'), file).toEqual([group])
  })

  it('keeps Capacitor’s package on iOS 16: cap sync reads the first deployment target in the file', () => {
    // getMajoriOSVersion in @capacitor/cli writes CapApp-SPM's platform from it
    expect(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/.exec(pbxText)?.[1]).toBe('16.0')
    expect(read(`${PROJECT_DIR}/CapApp-SPM/Package.swift`)).toContain('platforms: [.iOS(.v16)]')
  })

  it('reaches Xcode Cloud: nothing it builds from is ignored by git', () => {
    for (const file of ['DrafterWidgets/Info.plist', 'DrafterWidgets/DrafterWidgets.entitlements', ...phase(widget, 'PBXSourcesBuildPhase').paths]) {
      // exit 1 is "not ignored"; the generated web assets are the ones that are
      const ignored = spawnSync('git', ['check-ignore', '-q', `${PROJECT_DIR}/${file}`], { cwd: ROOT })
      expect(ignored.status, file).toBe(1)
    }
  })
})

describe('the widget’s two halves agree', () => {
  const swiftSnapshot = read(`${PROJECT_DIR}/DrafterWidgets/WidgetSnapshot.swift`)
  /** The stored properties of a Swift struct: name → optional or not. */
  const fields = (name: string) => {
    const body = new RegExp(`struct ${name}: Decodable[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(swiftSnapshot)?.[1] ?? ''
    return new Map([...body.matchAll(/^ {4}let (\w+): ([\w[\]]+)(\?)?$/gm)].map(m => [m[1], !!m[3]]))
  }
  const task = (over: Partial<Task>): Task => ({ kind: 'task', id: 't', title: 'Bins out', description: '', status: 'todo', priority: 'normal', tags: [], createdAt: '', updatedAt: '', ...over })
  const now = new Date(2026, 8, 22, 10)
  const snap = buildWidgetSnapshot(
    {
      tasks: [task({ dueAt: new Date(2026, 8, 22, 18).toISOString() })],
      entries: [],
      meals: [{ kind: 'meal', id: 'm', date: '2026-09-22', slot: 'dinner', title: 'Soup', createdAt: '', updatedAt: '' }],
      recipes: [],
      myId: null,
    },
    { now, generic: false },
  )

  /** Every key the page writes is one the widget reads, and every one the widget needs is written. */
  const agree = (swift: Map<string, boolean>, written: object) => {
    const keys = Object.keys(written)
    for (const key of keys) expect(swift.has(key), `the widget does not read "${key}"`).toBe(true)
    for (const [key, optional] of swift) if (!optional) expect(keys, `the page does not write "${key}"`).toContain(key)
  }

  it('on the snapshot, each day, each line and the dinner', () => {
    agree(fields('WidgetSnapshot'), snap)
    agree(fields('WidgetDay'), snap.days[0])
    agree(fields('WidgetItem'), snap.days[0].items[0])
    agree(fields('WidgetDinner'), snap.days[0].dinner!)
    // the one version each side knows
    expect(/static let version = (\d+)/.exec(swiftSnapshot)?.[1]).toBe(String(snap.v))
  })

  it('on the day key and the widget’s kind', () => {
    // dateKey's form, which the widget matches the day on
    expect(snap.days[0].day).toBe('2026-09-22')
    expect(swiftSnapshot).toContain('String(format: "%04d-%02d-%02d"')
    expect(read(`${PROJECT_DIR}/DrafterWidgets/DrafterWidgets.swift`)).toContain('StaticConfiguration(kind: SharedContainer.widgetKind')
  })

  it('on the captures Siri queues', () => {
    const queue = read(`${PROJECT_DIR}/App/CaptureQueue.swift`)
    const plugin = read(`${PROJECT_DIR}/App/WidgetBridgePlugin.swift`)
    const kindEnum = /enum Kind: String, Codable \{([\s\S]*?)\n {4}\}/.exec(queue)?.[1] ?? ''
    const kinds = [...kindEnum.matchAll(/^ {8}case (\w+)$/gm)].map(m => m[1])
    expect(kinds).toEqual(['task', 'grocery'])
    const sent = /\["id": capture\.id, "kind": capture\.kind\.rawValue, "text": capture\.text, "at": capture\.at\]/.exec(plugin)
    expect(sent, 'drainCaptures sends id, kind, text and at').toBeTruthy()
    const at = '2026-09-22T17:00:00.123Z'
    expect(parseCaptures(kinds.map(kind => ({ id: 'x', kind, text: 'Milk', at })))).toEqual(kinds.map(kind => ({ id: 'x', kind, text: 'Milk', at })))
  })

  it('on the plugin: its name, its two methods, and its registration before the page loads', () => {
    const plugin = read(`${PROJECT_DIR}/App/WidgetBridgePlugin.swift`)
    expect(/jsName = "(\w+)"/.exec(plugin)?.[1]).toBe('WidgetBridge')
    expect([...plugin.matchAll(/CAPPluginMethod\(name: "(\w+)", returnType: CAPPluginReturnPromise\)/g)].map(m => m[1])).toEqual(['setSnapshot', 'drainCaptures'])
    for (const m of ['setSnapshot', 'drainCaptures']) expect(plugin).toMatch(new RegExp(`@objc func ${m}\\(_ call: CAPPluginCall\\)`))
    expect(plugin).toContain('call.getString("json")')
    expect(plugin).toContain('WidgetCenter.shared.reloadAllTimelines()')
    // the event that drains a capture made while the app is open, sent after each append
    expect(/notifyListeners\("(\w+)"/.exec(plugin)?.[1]).toBe(CAPTURES_QUEUED)
    expect(plugin).toContain('name: CaptureQueue.queued')
    expect(read(`${PROJECT_DIR}/App/CaptureQueue.swift`)).toMatch(/try write\(queue, to: url\)\n {8}\}\n {8}NotificationCenter\.default\.post\(name: queued, object: nil\)/)
    expect(read(`${PROJECT_DIR}/App/SceneDelegate.swift`)).toContain('bridge?.registerPluginInstance(WidgetBridgePlugin())')
  })

  it('on the links the widget opens: Today, and an empty capture', () => {
    const views = read(`${PROJECT_DIR}/DrafterWidgets/TodayWidgetView.swift`)
    const scene = read(`${PROJECT_DIR}/App/SceneDelegate.swift`)
    const quick = (type: string) => new RegExp(`case "${type}":\\s*(?:\\/\\/[^\\n]*\\n\\s*)*return URL\\(string: "([^"]+)"\\)`).exec(scene)?.[1]
    expect(/static let today = URL\(string: "([^"]+)"\)/.exec(views)?.[1]).toBe(quick('today'))
    expect(/static let capture = URL\(string: "([^"]+)"\)/.exec(views)?.[1]).toBe(quick('new'))
    expect(read(`${PROJECT_DIR}/App/DrafterIntents.swift`)).toContain(`URL(string: "${quick('today')}")`)
  })
})

describe('Siri', () => {
  const intents = read(`${PROJECT_DIR}/App/DrafterIntents.swift`)

  it('offers the three intents as App Shortcuts, each phrase naming the app', () => {
    const shortcuts = [...intents.matchAll(/AppShortcut\(\s*intent: (\w+)\(\),\s*phrases: \[([\s\S]*?)\]/g)]
    expect(shortcuts.map(m => m[1])).toEqual(['AddTaskIntent', 'AddGroceryIntent', 'OpenTodayIntent'])
    for (const [, intent, list] of shortcuts) {
      const phrases = [...list.matchAll(/"([^"]+)"/g)].map(m => m[1])
      expect(phrases.length, intent).toBeGreaterThan(1)
      for (const phrase of phrases) expect(phrase, intent).toContain('\\(.applicationName)')
    }
  })

  it('adds without opening the app or the network, and says it will sync later', () => {
    for (const [intent, kind] of [
      ['AddTaskIntent', 'task'],
      ['AddGroceryIntent', 'grocery'],
    ]) {
      const body = new RegExp(`struct ${intent}: AppIntent \\{([\\s\\S]*?)\\n\\}`).exec(intents)?.[1] ?? ''
      expect(body, intent).toContain('static let openAppWhenRun = false')
      expect(body, intent).toContain(`try CaptureQueue.append(.${kind}, text: text)`)
      expect(body, intent).toContain("it'll sync when Drafter next opens")
      expect(body, intent).not.toMatch(/URLSession|fetch/)
    }
    expect(/struct OpenTodayIntent: AppIntent \{[\s\S]*?static let openAppWhenRun = true/.test(intents)).toBe(true)
  })
})
