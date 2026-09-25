import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SUBJECT_LIFT_MAX_BYTES } from '../native'

/*
 * The subject-lifting plugin lives in the app's own target, not in
 * node_modules, so nothing Capacitor generates keeps its two halves in step:
 * a renamed method, a new result key or a file missing from the Xcode project
 * fails only on the phone. They are read against each other here, the way
 * launchscreen.test.ts and links.test.ts read the rest of ios/.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const APP = 'ios/App/App'
const plugin = read(`${APP}/SubjectLiftPlugin.swift`)
const core = read(`${APP}/SubjectLift.swift`)
// the bridge subclass is the light theme's, in SceneDelegate.swift, and registers both plugins
const scene = read(`${APP}/SceneDelegate.swift`)
const project = read('ios/App/App.xcodeproj/project.pbxproj')
const plist = read(`${APP}/Info.plist`)
const native = read('src/native.ts')

/** The body of a Swift func, from its `{` to the matching `}`. */
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

/** The member names of an interface in native.ts. */
function tsMembers(name: string): string[] {
  const body = new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(native)?.[1] ?? ''
  return [...body.matchAll(/^ {2}(\w+)\??[(:]/gm)].map(m => m[1])
}

describe('the plugin and its wrapper agree', () => {
  it('on the name', () => {
    expect(/jsName = "(\w+)"/.exec(plugin)?.[1]).toBe('SubjectLift')
    expect(native).toContain("registerPlugin<SubjectLiftPlugin>('SubjectLift')")
    expect(native).toContain("Capacitor.isPluginAvailable('SubjectLift')")
  })

  it('on the methods, isAvailable and lift', () => {
    const methods = [...plugin.matchAll(/CAPPluginMethod\(name: "(\w+)", returnType: CAPPluginReturnPromise\)/g)].map(m => m[1])
    expect(methods).toEqual(['isAvailable', 'lift'])
    expect(tsMembers('SubjectLiftPlugin')).toEqual(methods)
    for (const m of methods) expect(plugin).toMatch(new RegExp(`@objc func ${m}\\(_ call: CAPPluginCall\\)`))
  })

  it('on the keys a lift resolves with', () => {
    const resolved = /call\.resolve\(\[([\s\S]*?)\]\)/.exec(swiftFunc(plugin, 'lift'))?.[1] ?? ''
    const keys = [...resolved.matchAll(/"(\w+)":/g)].map(m => m[1])
    expect(keys.sort()).toEqual(tsMembers('SubjectLiftPayload').sort())
    // the frame as a JPEG, every subject's mask as a PNG's alpha, and the
    // instance mask the web view chooses among them with
    expect(keys).toEqual(['alpha', 'found', 'height', 'image', 'instanceMask', 'maskHeight', 'maskWidth', 'width'])
  })

  it('on the transport: a JPEG of the frame and a PNG of the mask, not a PNG of the subjects', () => {
    const lift = swiftFunc(core, 'lift')
    expect(lift).toContain('generateScaledMaskForImage(forInstances: observation.allInstances, from: handler)')
    expect(lift).not.toContain('generateMaskedImage')
    expect(swiftFunc(core, 'jpeg')).toContain('jpegRepresentation(of: CIImage(cgImage: frame), colorSpace: srgb')
    // the mask is the PNG's alpha, which no colour management touches, written by ImageIO
    const png = swiftFunc(core, 'alphaPNG')
    expect(png).toContain('CGImageAlphaInfo.last')
    expect(png).toContain('"public.png"')
    expect(native).toContain("frame: new Blob([base64ToBytes(r.image)], { type: 'image/jpeg' })")
    expect(native).toContain("alpha: new Blob([base64ToBytes(r.alpha)], { type: 'image/png' })")
  })

  it('on the codes a lift rejects with', () => {
    const codes = [...plugin.matchAll(/call\.reject\("[^"]*", "([A-Z_]+)"/g)].map(m => m[1])
    expect(new Set(codes)).toEqual(new Set(['BAD_IMAGE', 'TOO_LARGE', 'NO_SUBJECT', 'VISION_FAILED', 'ENCODE_FAILED']))
    for (const code of ['NO_SUBJECT', 'TOO_LARGE', 'UNAVAILABLE']) expect(native).toContain(`code === '${code}'`)
  })

  it('on the size cap: Swift refuses nothing the web view is allowed to send', () => {
    const maxBase64 = Number(/maxBase64 = ([\d_]+)/.exec(plugin)?.[1].replace(/_/g, ''))
    expect(maxBase64).toBeGreaterThanOrEqual(Math.ceil(SUBJECT_LIFT_MAX_BYTES / 3) * 4)
  })
})

describe('the plugin is in the app', () => {
  const sources = /\/\* Begin PBXSourcesBuildPhase section \*\/([\s\S]*?)\/\* End PBXSourcesBuildPhase section \*\//.exec(project)?.[1] ?? ''
  const group = /504EC3061FED79650016851F \/\* App \*\/ = \{[\s\S]*?children = \(([\s\S]*?)\);/.exec(project)?.[1] ?? ''

  it.each(['SubjectLift.swift', 'SubjectLiftPlugin.swift', 'SceneDelegate.swift'])('compiles %s in the App target', name => {
    const ref = new RegExp(`(\\w{24}) /\\* ${name} \\*/ = \\{isa = PBXFileReference; lastKnownFileType = sourcecode\\.swift; path = ${name}; sourceTree = "<group>"; \\};`).exec(project)?.[1]
    expect(ref, `${name} file reference`).toBeTruthy()
    expect(group).toContain(`${ref} /* ${name} */`)
    const build = new RegExp(`(\\w{24}) /\\* ${name} in Sources \\*/ = \\{isa = PBXBuildFile; fileRef = ${ref} /\\* ${name} \\*/; \\};`).exec(project)?.[1]
    expect(build, `${name} build file`).toBeTruthy()
    expect(sources).toContain(`${build} /* ${name} in Sources */`)
  })

  it('keeps the deployment target at iOS 16', () => {
    // the project's two configurations, the app's two and the widget's two
    expect([...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(m => m[1])).toEqual(['16.0', '16.0', '16.0', '16.0', '16.0', '16.0'])
  })

  it('registers the plugin before the page loads, from the root view controller', () => {
    expect(scene).toMatch(/window\?\.rootViewController = DrafterBridgeViewController\(\)/)
    expect(scene).not.toMatch(/= CAPBridgeViewController\(\)/)
    // one bridge subclass for both of the target's plugins, declared once, in SceneDelegate.swift
    expect(scene.match(/class DrafterBridgeViewController: CAPBridgeViewController \{/g)).toHaveLength(1)
    expect(project).not.toContain('DrafterBridgeViewController.swift')
    const didLoad = swiftFunc(scene, 'capacitorDidLoad')
    expect(didLoad).toContain('bridge?.registerPluginInstance(AppearancePlugin())')
    expect(didLoad).toContain('bridge?.registerPluginInstance(SubjectLiftPlugin())')
  })

  it('is the only bridge: no storyboard makes a window, and a bridge, of its own', () => {
    // SceneDelegate builds the scene's window itself; a storyboard named in
    // Info.plist had UIKit build one first, with a second bridge inside it
    const plist = read(`${APP}/Info.plist`)
    expect(plist).not.toMatch(/UISceneStoryboardFile|UIMainStoryboardFile/)
    expect(project).not.toContain('Main.storyboard')
    expect(scene).toMatch(/window = UIWindow\(windowScene: windowScene\)/)
  })
})

describe('the Swift itself', () => {
  it('keeps the core free of UIKit and Capacitor, so it builds and runs on a Mac', () => {
    expect([...core.matchAll(/^import (\w+)$/gm)].map(m => m[1]).sort()).toEqual(['CoreImage', 'Foundation', 'ImageIO', 'Vision'])
    expect(core).toContain('@available(iOS 17.0, macOS 14.0, *)')
  })

  it('answers from the Simulator without asking Vision, in both methods', () => {
    for (const method of ['isAvailable', 'lift']) expect(swiftFunc(plugin, method), method).toContain('#if targetEnvironment(simulator)')
    expect(swiftFunc(plugin, 'isAvailable')).toContain('"reason": "simulator"')
    expect(swiftFunc(plugin, 'lift')).toMatch(/#if targetEnvironment\(simulator\)\s*call\.unavailable\(/)
  })

  it('lifts off Capacitor’s one plugin queue', () => {
    expect(plugin).toContain('DispatchQueue(label: "app.drafter.subject-lift", qos: .userInitiated)')
    expect(swiftFunc(plugin, 'lift')).toMatch(/queue\.async \{[\s\S]*autoreleasepool/)
  })
})

describe('the camera', () => {
  it('has a usage string, or Take Photo ends the app', () => {
    const text = /<key>NSCameraUsageDescription<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1]
    expect(text).toBe('Drafter uses the camera to photograph clothes for your wardrobe, and photos for your notes and tasks.')
  })
})
