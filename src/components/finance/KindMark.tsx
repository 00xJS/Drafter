import { kindEmoji, kindOf, type AccountKind } from '../../finance'
import { ACCOUNT_TYPE_META, type Account } from '../../types'

// An account's mark, beside its name. Crypto's is a gold coin with the
// Bitcoin sign, drawn in CSS (.fin-coin): no emoji carries ₿, and Apple draws
// 🪙 in silver. Every other kind is its emoji. The caller hides it from a
// screen reader wherever the name beside it already says what the account is.

/** A kind's mark; null is an investment nobody has said the holding of yet. */
export function KindMark({ kind }: { kind: AccountKind | null }) {
  if (kind === 'crypto') return <span className="fin-coin">₿</span>
  return kind ? kindEmoji(kind) : ACCOUNT_TYPE_META.investment.emoji
}

/** An account's mark: its kind's. */
export function AccountMark({ account }: { account: Pick<Account, 'type' | 'holding'> }) {
  return <KindMark kind={kindOf(account)} />
}
