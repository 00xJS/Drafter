import type { IngredientLine } from '../../../shared/recipes.mts'
import type { Take } from './ratelimit.mjs'
import type { Resolver, Transport } from './safefetch.mjs'

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

// the guard and the transport live in safefetch.mjs; the importer re-exports them
export { isPublicIPv4, ipv6Groups, isPublicIPv6, isPublicAddress, nodeTransport } from './safefetch.mjs'
export type { ResolvedAddress, Resolver, TransportRequest, TransportResponse, Transport } from './safefetch.mjs'

export interface FetchOptions {
  resolve?: Resolver
  transport?: Transport
  isAllowed?: (ip: string) => boolean
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

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
