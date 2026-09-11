// Types for the helpers src/ imports in tests. The runtime is timezone.mjs.
export declare function validTimeZone(tz: unknown): string | null
export declare function adoptTimeZone(userId: string, tz: unknown): Promise<boolean>
