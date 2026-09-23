// Types for safefetch.mjs: what the functions and src/'s tests import from it.
// The runtime is safefetch.mjs; Netlify bundles the .mjs and never reads this.

export type FetchFailure =
  | 'not_a_link'
  | 'scheme'
  | 'credentials'
  | 'port'
  | 'refused'
  | 'not_found'
  | 'encoding'
  | 'redirects'
  | 'redirect_nowhere'
  | 'redirect_bad'
  | 'http'
  | 'type'
  | 'too_big'
  | 'timeout'
  | 'failed'

export declare const FETCH_FAILURES: Readonly<Record<FetchFailure, { status: number; message: string }>>

/** A refusal or failure, by code, with the status its endpoint answers with. */
export declare class SafeFetchError extends Error {
  constructor(code: FetchFailure, detail?: string | number)
  code: FetchFailure
  status: number
  /** The site's own status for 'http', the content type for 'type'. */
  detail?: string | number
}

export declare const WEB_PORTS: ReadonlySet<string>
export declare function checkUrl(raw: unknown, opts?: { ports?: ReadonlySet<string>; maxLength?: number }): URL

export declare function isPublicIPv4(ip: string): boolean
export declare function ipv6Groups(ip: string): number[] | null
export declare function isPublicIPv6(ip: string): boolean
export declare function isPublicAddress(ip: string): boolean

export interface ResolvedAddress {
  address: string
  family: number
}
export type Resolver = (host: string) => Promise<ResolvedAddress[]>

export declare function publicAddressOf(hostname: string, opts?: { resolve?: Resolver; isAllowed?: (ip: string) => boolean }): Promise<ResolvedAddress>

export interface TransportRequest {
  url: URL
  address: string
  family: number
  signal: AbortSignal
  headers: Record<string, string>
}
export interface TransportResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array | string>
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>

export declare function nodeTransport(req: TransportRequest): Promise<TransportResponse>

export interface SafeGetOptions {
  resolve?: Resolver
  transport?: Transport
  isAllowed?: (ip: string) => boolean
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  ports?: ReadonlySet<string>
  headers?: Record<string, string>
  /** Refuse a content type the caller cannot use, before any of the body is read. */
  accept?: (contentType: string) => boolean
}

export interface SafeGetResult {
  url: URL
  /** 2xx, or 304 for a conditional request answered "not modified" (and then an empty body). */
  status: number
  header(name: string): string
  body: Buffer
}

export declare function safeGet(start: URL, opts?: SafeGetOptions): Promise<SafeGetResult>
