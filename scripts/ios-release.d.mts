/** The files a release writes its numbers into. The runtime is ios-release.mjs. */
export declare const VERSION_FILES: string[]
/** The changed paths `git status --porcelain -z` lists; a rename names both of its paths. */
export declare function changedPaths(porcelain: string): string[]
/** A version file with its numbers blanked, so two copies that differ only in those compare equal. */
export declare function withoutVersions(path: string, text: string): string
/** Whether a release may build over this change: a version file whose only change from the last commit (null when it is new) is its numbers. */
export declare function onlyNumbersChanged(path: string, committed: string | null, current: string): boolean
