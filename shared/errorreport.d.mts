export declare const MESSAGE_MAX: number
export declare const STACK_MAX: number
export declare const PATH_MAX: number
export declare const BUILD_MAX: number
export declare const VIEW_MAX: number
export declare const COUNT_MAX: number
export declare const PLATFORMS: readonly string[]

export type ReportPlatform = 'web' | 'ios'

/** A report as the app sends it and the server stores it (public.client_errors). */
export interface CleanReport {
  fingerprint: string
  message: string
  stack: string | null
  build: string | null
  platform: ReportPlatform | null
  view: string | null
  path: string | null
  count: number
}

export declare function stripQueries(text: unknown): string
export declare function scrubText(text: unknown, max: number): string
export declare function cleanPath(path: unknown): string | null
export declare function cleanView(view: unknown): string | null
export declare function cleanBuild(build: unknown): string | null
export declare function cleanPlatform(platform: unknown): ReportPlatform | null
export declare function cleanCount(count: unknown): number
export declare function fingerprintOf(report: { message: string; stack?: string | null; platform?: string | null }): string
export declare function cleanReport(report: unknown): CleanReport | null
