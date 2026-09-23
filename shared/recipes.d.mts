/** One ingredient as the app stores it, less its row id: a name a shop would know, and a quantity and unit only when given. */
export interface IngredientLine {
  name: string
  qty?: number
  unit?: string
}

export declare function parseQuantity(v: unknown): number | undefined
export declare function canonicalUnit(raw: unknown): string | null
export declare function ingredientName(text: unknown): string
export declare function parseIngredientLine(line: unknown): IngredientLine | null
