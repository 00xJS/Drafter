import type { IngredientLine } from '../../../shared/recipes.mts'
import type { Take } from './ratelimit.mjs'

export declare const IMPORT_LIMITS: Readonly<{
  timeoutMs: number
  maxBytes: number
  maxRedirects: number
  textMax: number
  urlMax: number
  ingredientsMax: number
  stepsMax: number
}>

export declare class ImportError extends Error {
  constructor(message: string, status?: number)
  status: number
}

export declare function parseImportUrl(raw: unknown): URL
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

export interface FetchOptions {
  resolve?: Resolver
  transport?: Transport
  isAllowed?: (ip: string) => boolean
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

export declare function nodeTransport(req: TransportRequest): Promise<TransportResponse>
export declare function fetchPage(start: URL, opts?: FetchOptions): Promise<{ url: URL; html: string }>

export declare function decodeEntities(text: unknown): string
export declare function pageTitle(html: string): string
export declare function readableText(html: string, max?: number): string
export declare function jsonLdBlocks(html: string): unknown[]
export declare function findRecipes(root: unknown): Record<string, unknown>[]

/** A recipe as read from a page: what the app's editor fills in. */
export interface ImportedRecipe {
  name: string
  servings?: number
  ingredients: IngredientLine[]
  steps: string[]
}
export declare function recipeFromJsonLd(node: unknown): ImportedRecipe
export declare function recipeFromHtml(html: string): ImportedRecipe | null

export type ImportResult = { recipe: ImportedRecipe; sourceUrl: string } | { text: string; title: string; sourceUrl: string }
export declare function importRecipe(rawUrl: unknown, opts?: FetchOptions): Promise<ImportResult>

export declare function recipeImportHandler(
  opts?: FetchOptions & { limit?: number; perUser?: { take(key: string): Take | Promise<Take> } },
): (req: Request) => Promise<Response>
