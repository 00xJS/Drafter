/** An Xcode project file's root dictionary, as parsePbxproj reads it. */
export interface Pbxproj {
  archiveVersion: string
  objectVersion: string
  rootObject: string
  objects: Record<string, Record<string, any>>
}

export interface NativeTarget {
  id: string
  name: string
  productType: string
  target: Record<string, any>
  /** Build settings by configuration name (Debug, Release). */
  configurations: Record<string, Record<string, any>>
}

export declare function parsePbxproj(text: string): Pbxproj
export declare function nativeTargets(project: Pbxproj): NativeTarget[]
export declare function versionDrift(project: Pbxproj): string[]
