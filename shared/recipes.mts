// Reading a recipe's ingredient lines: "1 1/2 cups flour, sifted" as the app
// stores it — { name: 'flour', qty: 1.5, unit: 'cup' }. Shared by the recipe
// import on the server (netlify/functions/lib/recipeimport.mjs) and the app's
// ✨ Fill in (src/recipefill.ts), so a line reads the same whoever wrote it.
// Dependency-free ESM.

/** One ingredient as the app stores it, less its row id: a name a shop would know, and a quantity and unit only when given. */
export interface IngredientLine {
  name: string
  qty?: number
  unit?: string
}

/** Quantities a shopping list can add up: a real, positive, sane number, as the recipe editor allows. */
const QTY_MAX = 10_000

const VULGAR: Record<string, number> = {
  '½': 1 / 2,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 1 / 4,
  '¾': 3 / 4,
  '⅕': 1 / 5,
  '⅖': 2 / 5,
  '⅗': 3 / 5,
  '⅘': 4 / 5,
  '⅙': 1 / 6,
  '⅚': 5 / 6,
  '⅛': 1 / 8,
  '⅜': 3 / 8,
  '⅝': 5 / 8,
  '⅞': 7 / 8,
}
const VULGAR_CLASS = `[${Object.keys(VULGAR).join('')}]`

// one quantity: "1½", "1 ½", "1 1/2", "1/2", "1.5", "1,5", "½"
const NUMBER = '\\d+(?:[.,]\\d+)?'
const QTY = `(?:${NUMBER}\\s*${VULGAR_CLASS}|${NUMBER}\\s+\\d+\\s*\\/\\s*\\d+|\\d+\\s*\\/\\s*\\d+|${NUMBER}|${VULGAR_CLASS})`
// …or a range, of which the first is taken: "2-3", "2 to 3", "2 or 3"
const RANGE = `(?:\\s*(?:-|–|—|to\\b|or\\b)\\s*(?:${QTY}))?`
const LEADING_QTY = new RegExp(`^(${QTY})${RANGE}`, 'i')
const WHOLE_QTY = new RegExp(`^(${QTY})${RANGE}$`, 'i')

const round2 = (n: number): number => Math.round(n * 100) / 100

/** A decimal written either way, "1.5" or "1,5"; a comma before three digits separates thousands. */
function decimal(text: string): number {
  const s = String(text)
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g, ''))
  return Number(s.replace(',', '.'))
}

/** The value of one quantity token, or NaN. */
function quantityValue(token: string): number {
  const q = String(token).trim()
  let m = new RegExp(`^(${NUMBER})\\s*(${VULGAR_CLASS})$`).exec(q)
  if (m) return decimal(m[1]) + VULGAR[m[2]]
  m = new RegExp(`^(${NUMBER})\\s+(\\d+)\\s*\\/\\s*(\\d+)$`).exec(q)
  if (m) return Number(m[3]) ? decimal(m[1]) + Number(m[2]) / Number(m[3]) : NaN
  m = /^(\d+)\s*\/\s*(\d+)$/.exec(q)
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : NaN
  if (new RegExp(`^${NUMBER}$`).test(q)) return decimal(q)
  return VULGAR[q] ?? NaN
}

const sane = (n: number): number | undefined => (Number.isFinite(n) && n > 0 && n <= QTY_MAX ? round2(n) : undefined)

/**
 * A quantity as a number the grocery list can add up, or undefined: 2, "2",
 * "1/2", "1 1/2", "1½", "½", "2-3" (the first of a range). Anything else — "a
 * pinch", 0, a negative, ten thousand kilos — is no quantity at all, because a
 * wrong one quietly doubles a grocery line.
 */
export function parseQuantity(v: unknown): number | undefined {
  if (typeof v === 'number') return sane(v)
  if (typeof v !== 'string') return undefined
  const m = WHOLE_QTY.exec(v.trim())
  return m ? sane(quantityValue(m[1])) : undefined
}

// Every spelling of a unit, and the one the app writes. The grocery list adds
// lines up by name AND unit (ingredientKey in shared/kitchen.mts), so "cups"
// in one recipe and "cup" in another must be one unit or they stay two lines.
const UNIT_SPELLINGS: Record<string, string[]> = {
  cup: ['cup', 'cups', 'c'],
  tbsp: ['tbsp', 'tbsps', 'tbs', 'tbl', 'tablespoon', 'tablespoons'],
  tsp: ['tsp', 'tsps', 'teaspoon', 'teaspoons'],
  lb: ['lb', 'lbs', 'pound', 'pounds'],
  oz: ['oz', 'ounce', 'ounces'],
  'fl oz': ['fl oz', 'fl. oz', 'floz', 'fluid ounce', 'fluid ounces'],
  g: ['g', 'gr', 'gram', 'grams', 'gramme', 'grammes'],
  kg: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'],
  ml: ['ml', 'mls', 'milliliter', 'milliliters', 'millilitre', 'millilitres'],
  l: ['l', 'liter', 'liters', 'litre', 'litres'],
  pint: ['pint', 'pints', 'pt'],
  quart: ['quart', 'quarts', 'qt'],
  gallon: ['gallon', 'gallons', 'gal'],
  clove: ['clove', 'cloves'],
  can: ['can', 'cans', 'tin', 'tins'],
  jar: ['jar', 'jars'],
  package: ['package', 'packages', 'pkg', 'pkgs', 'packet', 'packets', 'pack', 'packs'],
  bag: ['bag', 'bags'],
  box: ['box', 'boxes'],
  bottle: ['bottle', 'bottles'],
  bunch: ['bunch', 'bunches'],
  head: ['head', 'heads'],
  stalk: ['stalk', 'stalks'],
  sprig: ['sprig', 'sprigs'],
  slice: ['slice', 'slices'],
  stick: ['stick', 'sticks'],
  pinch: ['pinch', 'pinches'],
  dash: ['dash', 'dashes'],
  handful: ['handful', 'handfuls'],
  piece: ['piece', 'pieces', 'pc', 'pcs'],
}
const UNITS = new Map(Object.entries(UNIT_SPELLINGS).flatMap(([unit, spellings]) => spellings.map(s => [s, unit])))
// the units written as two words, longest first, so "fl oz" is not read as "fl" then "oz"
const TWO_WORD_UNITS = [...UNITS.keys()].filter(s => s.includes(' ')).sort((a, b) => b.length - a.length)

/** The units a line may put after the name: "4 garlic cloves" is 4 cloves of garlic. */
const TRAILING_UNITS = new Set(['clove', 'stalk', 'sprig', 'bunch', 'slice', 'head', 'stick'])

/** Words about the size of a thing, not the thing you look for in a shop: "2 large onions" buys onions. */
const SIZE_WORDS = new Set(['small', 'medium', 'large', 'extra-large', 'extra large', 'jumbo', 'big'])

/**
 * The app's spelling of a unit — "Tablespoons" is "tbsp", "cups" is "cup" —
 * '' for no unit (a size word such as "large" included), and null when it is
 * not a unit this knows.
 */
export function canonicalUnit(raw: unknown): string | null {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
  if (!key) return ''
  if (SIZE_WORDS.has(key)) return ''
  return UNITS.get(key) ?? null
}

/** A "(14.5 oz)" or "(15-ounce)" at the front: the size of a can, not part of its name. */
const PAREN = /^\([^()]{0,40}\)\s*/
/** A second measure added to the first: "+ 1 teaspoon", "plus 2 tbsp". */
const PLUS = new RegExp(`^(?:\\+|plus\\b)\\s*(?:${QTY})\\s*`, 'i')

/** The unit the text starts with, as written and as the app spells it, and what is left after it. */
function leadingUnit(text: string): { unit: string | undefined; word: string; rest: string } | null {
  const lower = text.toLowerCase()
  for (const s of TWO_WORD_UNITS) {
    if (lower.startsWith(s) && !/\p{L}/u.test(lower.charAt(s.length))) return { unit: UNITS.get(s), word: text.slice(0, s.length), rest: text.slice(s.length) }
  }
  // a word, maybe with its abbreviation's full stop ("lbs."), ended by a space, a comma, a bracket or the line
  const m = /^(\p{L}+)(\.)?(?=[\s,()]|$)/u.exec(text)
  const unit = m ? UNITS.get(m[1].toLowerCase()) : undefined
  return m && unit ? { unit, word: m[1], rest: text.slice(m[0].length) } : null
}

/**
 * What a comma usually brings after an ingredient: how to prepare it, not
 * what to buy. "onions, finely chopped" is onions, but "boneless, skinless
 * chicken breasts" is still the chicken, so only these end the name.
 */
const PREPARATION = new Set(
  (
    'chopped diced minced sliced cut peeled seeded deseeded cored drained rinsed softened melted divided beaten lightly grated ' +
    'shredded crushed finely roughly coarsely thinly thickly cubed halved quartered trimmed torn mashed juiced zested julienned ' +
    'deveined patted pitted stemmed washed cleaned thawed warmed cooled chilled packed sifted separated whisked toasted crumbled ' +
    'broken reserved removed dissolved squeezed scrubbed shelled at room to or plus about for such preferably if optional as ' +
    'cooked uncooked in into with without and but then see more'
  ).split(' '),
)

function dropPreparation(text: string): string {
  const parts = text.split(',')
  let out = parts[0]
  for (let i = 1; i < parts.length; i++) {
    const first = (parts[i].trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z-]/g, '')
    if (!first || PREPARATION.has(first)) break
    out += `,${parts[i]}`
  }
  return out
}

/**
 * An ingredient's name as a shop would know it: no preparation after a comma,
 * no size, no "to taste" — "large onions, finely chopped" is "onions".
 */
export function ingredientName(text: unknown): string {
  return shopName(String(text ?? ''))
}

function shopName(text: string): string {
  let name = dropPreparation(String(text).replace(/\s+/g, ' ').trim())
    // "(about 2 cups)", "(optional)"
    .replace(/\s*\([^()]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // "sugar plus 2 tbsp for dusting": the extra is still sugar
    .replace(/\s+(?:\+|plus\b).*$/i, '')
    .replace(/\s+(?:to taste|as needed|for serving|for garnish|optional)$/i, '')
    .replace(/^(?:[-–—]\s*)?(?:of\s+)?/i, '')
    .trim()
  for (;;) {
    const m = /^(extra[- ]large|small|medium|large|jumbo|big)\s+/i.exec(name)
    if (!m) break
    name = name.slice(m[0].length)
  }
  return name.trim()
}

/**
 * One ingredient line — "2 large onions, diced", "1 (14-ounce) can coconut
 * milk", "½ tsp salt", "200g flour", "Salt and pepper to taste" — as the app
 * stores an ingredient: a name you would look for in a shop, and a quantity
 * and unit only when the line gives them. Null for a line that is no
 * ingredient: empty, or a heading such as "For the sauce:".
 */
export function parseIngredientLine(line: unknown): IngredientLine | null {
  let text = String(line ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—•*·▪◦]+/, '')
    .trim()
  if (!text) return null
  if (/:$/.test(text) && !/\d/.test(text)) return null

  let qty: number | undefined
  let unit: string | undefined
  let unitWord = ''
  const lead = LEADING_QTY.exec(text)
  if (lead) {
    qty = sane(quantityValue(lead[1]))
    text = text.slice(lead[0].length).trim()
    // "1-inch piece ginger", "14-ounce can tomatoes": that number was a size.
    // One of the unit after it, if there is one; otherwise no count at all.
    const size = /^-\s*\p{L}+\.?\s*/u.exec(text)
    if (size) {
      text = text.slice(size[0].length)
      qty = leadingUnit(text) ? 1 : undefined
    }
  } else {
    // "a pinch of salt", "an 8-ounce block": one, when a unit follows
    const a = /^an?\s+/i.exec(text)
    if (a && leadingUnit(text.slice(a[0].length))) {
      qty = 1
      text = text.slice(a[0].length)
    }
  }
  if (qty !== undefined || lead) {
    text = text.replace(PAREN, '')
    const u = leadingUnit(text)
    if (u) {
      unit = u.unit
      unitWord = u.word
      text = u.rest.trim().replace(PAREN, '')
      // "2 tbsp + 1 tsp soy sauce": the first measure is the one kept
      const plus = PLUS.exec(text)
      const second = plus ? leadingUnit(text.slice(plus[0].length)) : null
      if (second) text = second.rest.trim()
    }
  }
  let name = shopName(text).slice(0, 80).trim()
  // "4 garlic cloves", "2 celery stalks": the unit came after the name
  if (qty !== undefined && !unit) {
    const trailing = /\s(\p{L}+)$/u.exec(name)
    const after = trailing ? UNITS.get(trailing[1].toLowerCase()) : undefined
    if (trailing && after && TRAILING_UNITS.has(after)) {
      unit = after
      name = name.slice(0, trailing.index).trim()
    }
  }
  // "4 cloves" is the spice, not a unit of nothing
  if (!name && unitWord) {
    name = unitWord
    unit = undefined
  }
  if (!name) return null
  return { name, ...(qty !== undefined ? { qty } : {}), ...(unit ? { unit } : {}) }
}
