/** `1.0` and `1.0.0` are the same version; the stored form is always three parts. */
export function parseVersion(value) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value).trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
}

export function formatVersion(parts) {
  return `${parts[0]}.${parts[1]}.${parts[2]}`
}

export function bumpVersion(value, kind) {
  const parts = parseVersion(value)
  if (!parts) return null
  if (kind === 'major') return formatVersion([parts[0] + 1, 0, 0])
  if (kind === 'minor') return formatVersion([parts[0], parts[1] + 1, 0])
  if (kind === 'patch') return formatVersion([parts[0], parts[1], parts[2] + 1])
  return null
}
