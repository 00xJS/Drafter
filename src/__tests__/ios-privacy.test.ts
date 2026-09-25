import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { nativeTargets, parsePbxproj } from '../../scripts/lib/pbxproj.mjs'

// The iPhone app's privacy manifest. Apple refuses an upload whose own code
// calls a "required reason" API without saying why in PrivacyInfo.xcprivacy,
// and SceneDelegate keeps the Light / Dark / System choice in UserDefaults.
// So the manifest names that category with CA92.1 (read and written by the
// app itself), says the app tracks nobody and collects nothing for anyone,
// and is copied into the app's bundle. The widget calls no such API, so it
// carries none.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, 'utf8')
const MANIFEST = 'ios/App/App/PrivacyInfo.xcprivacy'
const manifest = read(MANIFEST)
const project = parsePbxproj(read('ios/App/App.xcodeproj/project.pbxproj'))
const objects = project.objects
const targets = nativeTargets(project)

/** The file names a target copies into its bundle. */
function resources(name: string): string[] {
  const target = targets.find(t => t.name === name)!
  const phase = (target.target.buildPhases as string[]).map(id => objects[id]).find(p => p.isa === 'PBXResourcesBuildPhase')
  return ((phase?.files ?? []) as string[]).map(id => objects[objects[id].fileRef].path as string)
}

/** A key's value as the plist writes it: the XML between the key and the next key. */
const valueOf = (key: string) => new RegExp(`<key>${key}</key>\\s*(<array/>|<array>[\\s\\S]*?</array>|<true/>|<false/>|<string>[^<]*</string>)`).exec(manifest)?.[1]

/** Every Swift file a target compiles, read. */
function swiftOf(folder: string): string {
  return readdirSync(`${ROOT}ios/App/${folder}`)
    .filter(f => f.endsWith('.swift'))
    .map(f => read(`ios/App/${folder}/${f}`))
    .join('\n')
}

describe('the app’s privacy manifest', () => {
  it('says why the app reads UserDefaults: CA92.1, its own settings', () => {
    expect(manifest).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    const types = valueOf('NSPrivacyAccessedAPITypes') ?? ''
    expect(types).toMatch(/<key>NSPrivacyAccessedAPIType<\/key>\s*<string>NSPrivacyAccessedAPICategoryUserDefaults<\/string>/)
    expect(types).toMatch(/<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>\s*<string>CA92\.1<\/string>\s*<\/array>/)
    // …because the app's own code does
    expect(swiftOf('App')).toMatch(/\bUserDefaults\b/)
  })

  it('tracks nobody and collects nothing', () => {
    expect(valueOf('NSPrivacyTracking')).toBe('<false/>')
    expect(valueOf('NSPrivacyTrackingDomains')).toBe('<array/>')
    expect(valueOf('NSPrivacyCollectedDataTypes')).toBe('<array/>')
  })

  it('is copied into the app’s bundle, and the widget, which calls no such API, has none', () => {
    expect(resources('App')).toContain('PrivacyInfo.xcprivacy')
    expect(resources('DrafterWidgets')).not.toContain('PrivacyInfo.xcprivacy')
    expect(swiftOf('DrafterWidgets')).not.toMatch(/\bUserDefaults\b/)
  })

  it('reaches Xcode Cloud: git does not ignore it', () => {
    // exit 1 is "not ignored"
    expect(spawnSync('git', ['check-ignore', '-q', MANIFEST], { cwd: ROOT }).status).toBe(1)
  })
})

// iOS ends the app on the spot, with no message, when it reaches for something
// private whose reason Info.plist does not give: Save to Photos on a long-pressed
// picture, or Save Image in the share sheet, without the photo-library string,
// and Take Photo or Video → Video on "+ Attach a file" without the microphone's.
// So every feature the app uses that iOS asks about is paired here with the
// sentence iOS shows, and the code that reaches for it.
describe('the app’s Info.plist says why, for everything it asks iOS for', () => {
  const plist = read('ios/App/App/Info.plist')
  const reason = (key: string) => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1] ?? ''
  const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }

  const uses: [key: string, why: string, used: () => boolean][] = [
    // every file field offers Take Photo; the attachments' one takes any file, video too
    ['NSCameraUsageDescription', 'a file field offers Take Photo', () => /type="file"/.test(read('src/components/taskeditor/Images.tsx'))],
    ['NSMicrophoneUsageDescription', '“+ Attach a file” takes any file, so Take Video too', () => /type="file"\s+multiple\s+hidden/.test(read('src/components/taskeditor/Attachments.tsx'))],
    // the web view offers Save to Photos on any picture it shows, and the share sheet Save Image
    ['NSPhotoLibraryAddUsageDescription', 'a long-pressed picture offers Save to Photos', () => /<img\b/.test(read('src/components/taskeditor/Images.tsx'))],
    ['NSFaceIDUsageDescription', 'the lock asks for Face ID', () => '@aparajita/capacitor-biometric-auth' in pkg.dependencies],
    ['NSLocationWhenInUseUsageDescription', 'the forecast and I’m here ask where you are', () => /navigator\.geolocation\.getCurrentPosition/.test(read('src/geo.ts'))],
  ]

  it.each(uses)('gives %s, because %s', (key, _why, used) => {
    expect(used(), `${key}: the feature is still in the code`).toBe(true)
    const text = reason(key)
    // a sentence about Drafter, in plain words, as iOS puts it in the prompt
    expect(text, key).toMatch(/^[A-Z].{30,}\.$/)
    expect(text, key).toMatch(/\bDrafter\b/)
  })

  it('says when it saves to Photos and records sound: only when you ask', () => {
    expect(reason('NSPhotoLibraryAddUsageDescription')).toMatch(/only when you choose Save to Photos or Save Image/)
    expect(reason('NSMicrophoneUsageDescription')).toMatch(/only when you record a video to attach/)
  })

  it('asks nothing for dictation, which the shell leaves to the keyboard (src/speech.ts)', () => {
    expect(plist).not.toContain('NSSpeechRecognitionUsageDescription')
    expect(read('src/speech.ts')).toMatch(/function ctor\(\): Ctor \| null \{\s*if \(isNative\(\)\) return null/)
  })
})
