/** `1.0` and `1.0.0` are the same version; the stored form is always three parts. */
export declare function parseVersion(value: string): [number, number, number] | null
export declare function formatVersion(parts: readonly number[]): string
export declare function bumpVersion(value: string, kind: 'major' | 'minor' | 'patch'): string | null
