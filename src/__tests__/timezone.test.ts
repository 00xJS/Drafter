import { describe, expect, it } from 'vitest'
import { validTimeZone } from '../../netlify/functions/lib/timezone.mjs'

// The server now adopts the device's time zone when the account has none, so
// it judges "untimed" in the owner's zone rather than UTC. Only a real IANA
// zone may ever be stored.
describe('validTimeZone', () => {
  it('accepts real IANA zones', () => {
    expect(validTimeZone('Europe/London')).toBe('Europe/London')
    expect(validTimeZone('America/Phoenix')).toBe('America/Phoenix')
    expect(validTimeZone('UTC')).toBe('UTC')
  })

  it('refuses anything else rather than storing it', () => {
    expect(validTimeZone('Mars/Olympus_Mons')).toBeNull()
    expect(validTimeZone('')).toBeNull()
    expect(validTimeZone(undefined)).toBeNull()
    expect(validTimeZone(42)).toBeNull()
    expect(validTimeZone('x'.repeat(200))).toBeNull()
  })
})
