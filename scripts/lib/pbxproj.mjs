// Read ios/App/App.xcodeproj/project.pbxproj as data rather than as text.
//
// The project has two targets since the widget (App, and DrafterWidgets, which
// is embedded in it), and App Store Connect refuses an upload whose extension
// carries a different version or build number from its app. So the version
// scripts and the tests ask the project per target, which a regex over the
// whole file cannot: it only ever saw "the first MARKETING_VERSION".
//
// The file is an old-style (OpenStep) property list: { key = value; },
// ( a, b, ), strings bare or quoted, and /* comments */.

/**
 * @param {string} text the whole project.pbxproj
 * @returns {any} the root dictionary: { archiveVersion, objects, rootObject, … }
 */
export function parsePbxproj(text) {
  let at = 0

  const fail = (/** @type {string} */ why) => {
    throw new Error(`project.pbxproj: ${why} at offset ${at}`)
  }

  const skip = () => {
    for (;;) {
      while (at < text.length && /\s/.test(text[at])) at++
      if (text.startsWith('/*', at)) {
        const end = text.indexOf('*/', at + 2)
        if (end === -1) fail('unclosed comment')
        at = end + 2
      } else if (text.startsWith('//', at)) {
        const end = text.indexOf('\n', at)
        at = end === -1 ? text.length : end + 1
      } else return
    }
  }

  const expect = (/** @type {string} */ ch) => {
    skip()
    if (text[at] !== ch) fail(`expected "${ch}"`)
    at++
  }

  const string = () => {
    skip()
    if (text[at] === '"') {
      let out = ''
      at++
      while (at < text.length && text[at] !== '"') {
        if (text[at] === '\\') {
          const next = text[at + 1]
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next
          at += 2
        } else out += text[at++]
      }
      if (text[at] !== '"') fail('unclosed string')
      at++
      return out
    }
    const bare = /[^\s{}()=;,"]+/y
    bare.lastIndex = at
    const m = bare.exec(text)
    if (!m) fail('expected a value')
    at += m[0].length
    return m[0]
  }

  /** @returns {any} */
  const value = () => {
    skip()
    if (text[at] === '{') {
      at++
      /** @type {Record<string, any>} */
      const dict = {}
      for (;;) {
        skip()
        if (text[at] === '}') {
          at++
          return dict
        }
        const key = string()
        expect('=')
        dict[key] = value()
        expect(';')
      }
    }
    if (text[at] === '(') {
      at++
      const list = []
      for (;;) {
        skip()
        if (text[at] === ')') {
          at++
          return list
        }
        list.push(value())
        skip()
        if (text[at] === ',') at++
      }
    }
    return string()
  }

  const root = value()
  skip()
  if (at < text.length) fail('trailing content')
  return root
}

/**
 * The project's native targets, each with its build settings per configuration.
 * @param {any} project what parsePbxproj returned
 * @returns {{ id: string, name: string, productType: string, target: any, configurations: Record<string, Record<string, any>> }[]}
 */
export function nativeTargets(project) {
  const objects = project.objects
  return Object.entries(objects)
    .filter(([, o]) => o.isa === 'PBXNativeTarget')
    .map(([id, target]) => {
      const list = objects[target.buildConfigurationList]
      const configurations = Object.fromEntries(list.buildConfigurations.map(cid => [objects[cid].name, objects[cid].buildSettings ?? {}]))
      return { id, name: target.name, productType: target.productType, target, configurations }
    })
}

/**
 * Where the targets' versions disagree: every configuration of every target
 * must carry the same MARKETING_VERSION and the same CURRENT_PROJECT_VERSION.
 * An empty list when they are in step.
 * @param {any} project what parsePbxproj returned
 * @returns {string[]}
 */
export function versionDrift(project) {
  const rows = nativeTargets(project).flatMap(t =>
    Object.entries(t.configurations).map(([config, settings]) => ({
      where: `${t.name} ${config}`,
      marketing: settings.MARKETING_VERSION,
      build: settings.CURRENT_PROJECT_VERSION,
    })),
  )
  if (rows.length === 0) return ['no targets']
  const [first] = rows
  const problems = []
  for (const row of rows) {
    if (row.marketing !== first.marketing) problems.push(`${row.where} has MARKETING_VERSION ${row.marketing}, ${first.where} has ${first.marketing}`)
    if (row.build !== first.build) problems.push(`${row.where} has CURRENT_PROJECT_VERSION ${row.build}, ${first.where} has ${first.build}`)
  }
  return problems
}
