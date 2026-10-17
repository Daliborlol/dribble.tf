/**
 * build-items.mjs
 *
 * Builds src/constants/items.json: a compact map of TF2 *weapon* item definition index ->
 * placeholder/viewer metadata, generated from Valve's public item schema text
 * (items_game.txt + tf_english.txt + tf_proto_obj_defs_english.txt as tracked by
 * SteamDatabase/GameTracking-TF2). Text metadata only - no models, textures or other assets.
 *
 * Output entry (all keys short to keep the bundle small):
 *   n   readable English name ("Rocket Launcher", "Woodland Warrior Rocket Launcher")
 *   c   item_class as written in the schema ("tf_weapon_rocketlauncher", "saxxy", ...)
 *   s   default item_slot (primary/secondary/melee/pda/pda2/building/action)
 *   u   used_by_classes, TF class-index order (scout, sniper, soldier, demoman, medic,
 *       heavy, pyro, spy, engineer)
 *   k   placeholder viewmodel category (see CATEGORY_BY_CLASS below)
 *   i   best-guess kill icon basename that exists in src/assets/kill_icons/ (omitted if none)
 * Optional keys (only written when present):
 *   cs  per-class slot overrides, e.g. multi-class shotgun { soldier: 'secondary', ... }
 *   wm  "set_weapon_mode" attribute (medigun 2=quick-fix, 3=vaccinator; watch 1=dead ringer,
 *       2=cloak and dagger; flare gun 1=detonator, 2=manmelter, 3=scorch shot; ...)
 *   ct  "set_charge_type" (medigun: 1=kritz crit, 2=quick-fix megaheal, 3=vaccinator resist)
 *   bt  "set_buff_type" (banner: 1=buff banner, 2=battalion's backup, 3=concheror, ...)
 *   pt  "override_projectile_type" (ProjectileType_t, e.g. 19 festive arrow)
 *   o   "min_viewmodel_offset" ("x y z" used by tf_use_min_viewmodels)
 *
 * Usage:
 *   node scripts/build-items.mjs [--items <items_game.txt>] [--lang <tf_english.txt>]
 *     [--proto-lang <tf_proto_obj_defs_english.txt>] [--out <path>] [--pretty] [--report]
 * Inputs that are not given are downloaded from raw.githubusercontent.com
 * (SteamDatabase/GameTracking-TF2, branch master).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const GT_BASE = 'https://raw.githubusercontent.com/SteamDatabase/GameTracking-TF2/master/tf'
const SOURCES = {
  items: `${GT_BASE}/scripts/items/items_game.txt`,
  lang: `${GT_BASE}/resource/tf_english.txt`,
  'proto-lang': `${GT_BASE}/resource/tf_proto_obj_defs_english.txt`,
}

const CLASS_ORDER = [
  'scout',
  'sniper',
  'soldier',
  'demoman',
  'medic',
  'heavy',
  'pyro',
  'spy',
  'engineer',
]
const WEAPON_SLOTS = new Set(['primary', 'secondary', 'melee', 'pda', 'pda2', 'building'])

// Placeholder viewmodel category per schema item_class (before TranslateWeaponEntForClass).
const CATEGORY_BY_CLASS = {
  tf_weapon_rocketlauncher: 'rocket_launcher',
  tf_weapon_rocketlauncher_directhit: 'rocket_launcher',
  tf_weapon_rocketlauncher_airstrike: 'rocket_launcher',
  tf_weapon_particle_cannon: 'rocket_launcher',
  tf_weapon_rocketlauncher_fireball: 'flamethrower',
  tf_weapon_flamethrower: 'flamethrower',
  tf_weapon_shotgun: 'shotgun',
  tf_weapon_shotgun_primary: 'shotgun',
  tf_weapon_shotgun_soldier: 'shotgun',
  tf_weapon_shotgun_hwg: 'shotgun',
  tf_weapon_shotgun_pyro: 'shotgun',
  tf_weapon_sentry_revenge: 'shotgun',
  tf_weapon_shotgun_building_rescue: 'shotgun',
  tf_weapon_drg_pomson: 'shotgun',
  tf_weapon_scattergun: 'scattergun',
  tf_weapon_soda_popper: 'scattergun',
  tf_weapon_pep_brawler_blaster: 'scattergun',
  tf_weapon_handgun_scout_primary: 'pistol',
  tf_weapon_handgun_scout_secondary: 'pistol',
  tf_weapon_pistol: 'pistol',
  tf_weapon_pistol_scout: 'pistol',
  tf_weapon_flaregun: 'pistol',
  tf_weapon_flaregun_revenge: 'pistol',
  tf_weapon_raygun: 'pistol',
  tf_weapon_smg: 'smg',
  tf_weapon_charged_smg: 'smg',
  tf_weapon_sniperrifle: 'sniper_rifle',
  tf_weapon_sniperrifle_decap: 'sniper_rifle',
  tf_weapon_sniperrifle_classic: 'sniper_rifle',
  tf_weapon_compound_bow: 'bow',
  tf_weapon_crossbow: 'crossbow',
  tf_weapon_minigun: 'minigun',
  tf_weapon_grenadelauncher: 'grenade_launcher',
  tf_weapon_cannon: 'grenade_launcher',
  tf_weapon_pipebomblauncher: 'sticky_launcher',
  tf_weapon_medigun: 'medigun',
  tf_weapon_syringegun_medic: 'syringe_gun',
  tf_weapon_revolver: 'revolver',
  tf_weapon_knife: 'knife',
  tf_weapon_invis: 'watch',
  tf_weapon_sapper: 'sapper',
  tf_weapon_wrench: 'wrench',
  tf_weapon_robot_arm: 'fists',
  tf_weapon_fists: 'fists',
  tf_weapon_slap: 'fists',
  tf_weapon_bat: 'melee_blunt',
  tf_weapon_bat_wood: 'melee_blunt',
  tf_weapon_bat_fish: 'melee_blunt',
  tf_weapon_bat_giftwrap: 'melee_blunt',
  tf_weapon_bottle: 'melee_blunt',
  tf_weapon_shovel: 'melee_blunt',
  tf_weapon_stickbomb: 'melee_blunt',
  tf_weapon_breakable_sign: 'melee_blunt',
  saxxy: 'melee_blunt',
  tf_weapon_fireaxe: 'melee_blade',
  tf_weapon_bonesaw: 'melee_blade',
  tf_weapon_club: 'melee_blade',
  tf_weapon_sword: 'melee_blade',
  tf_weapon_katana: 'melee_blade',
  tf_weapon_lunchbox: 'lunchbox',
  tf_weapon_lunchbox_drink: 'lunchbox',
  tf_weapon_jar: 'jar',
  tf_weapon_jar_milk: 'jar',
  tf_weapon_jar_gas: 'jar',
  tf_weapon_cleaver: 'jar',
  tf_weapon_throwable: 'jar',
  tf_weapon_buff_item: 'banner',
  tf_wearable_demoshield: 'shield',
  tf_weapon_parachute: 'parachute',
  tf_weapon_parachute_primary: 'parachute',
  tf_weapon_parachute_secondary: 'parachute',
  tf_weapon_pda: 'pda',
  tf_weapon_pda_engineer_build: 'pda',
  tf_weapon_pda_engineer_destroy: 'pda',
  tf_weapon_pda_spy: 'pda',
  tf_weapon_laser_pointer: 'pda',
}

// Kill icon used by the stock weapon of a class; fallback for reskins/war paints/botkillers.
const ICON_BY_CLASS = {
  tf_weapon_rocketlauncher: 'rocket_launcher',
  tf_weapon_rocketlauncher_directhit: 'direct_hit',
  tf_weapon_rocketlauncher_airstrike: 'airstrike',
  tf_weapon_particle_cannon: 'cow_mangler',
  tf_weapon_flamethrower: 'flamethrower',
  tf_weapon_shotgun: 'shotgun',
  tf_weapon_shotgun_primary: 'shotgun',
  tf_weapon_shotgun_soldier: 'shotgun',
  tf_weapon_shotgun_hwg: 'shotgun',
  tf_weapon_shotgun_pyro: 'shotgun',
  tf_weapon_scattergun: 'scattergun',
  tf_weapon_pistol: 'pistol',
  tf_weapon_pistol_scout: 'pistol',
  tf_weapon_smg: 'smg',
  tf_weapon_sniperrifle: 'sniperrifle',
  tf_weapon_compound_bow: 'huntsman',
  tf_weapon_crossbow: 'crusaders_crossbow',
  tf_weapon_minigun: 'minigun',
  tf_weapon_grenadelauncher: 'grenade_launcher',
  tf_weapon_pipebomblauncher: 'stickybomb_launcher',
  tf_weapon_syringegun_medic: 'syringe_gun',
  tf_weapon_revolver: 'revolver',
  tf_weapon_knife: 'knife',
  tf_weapon_wrench: 'wrench',
  tf_weapon_bat: 'bat',
  tf_weapon_bottle: 'bottle',
  tf_weapon_shovel: 'shovel',
  tf_weapon_fireaxe: 'fire_axe',
  tf_weapon_bonesaw: 'bonesaw',
  tf_weapon_club: 'kukri',
  tf_weapon_fists: 'fists',
  tf_weapon_sword: 'eyelander',
  tf_weapon_flaregun: 'flaregun',
  tf_weapon_cannon: 'loose_cannon',
  tf_weapon_jar_gas: 'gas_passer',
}

const BLADE_NAME = /(blade|sword|machete|katana|saber|sabre|axe|kukri|shiv|claymore|zatoichi|eyelander|headtaker|skullcutter|persian|scimitar|cleaver|saw)/i

const parseArgs = argv => {
  const args = new Map()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args.set(arg.slice(2), next)
      i++
    } else {
      args.set(arg.slice(2), 'true')
    }
  }
  return args
}

/**
 * Minimal Valve KeyValues (text) parser. Keys are lower-cased because KeyValues lookups are
 * case-insensitive. For duplicate keys the first scalar wins (KeyValues::FindKey semantics)
 * and duplicate blocks are merged. "[$CONDITION]" suffixes are ignored.
 */
export const parseKeyValues = text => {
  let i = 0
  const n = text.length
  const skipSpaceAndComments = () => {
    for (;;) {
      while (i < n && text.charCodeAt(i) <= 32) i++
      if (text.charCodeAt(i) === 47 && text.charCodeAt(i + 1) === 47) {
        const end = text.indexOf('\n', i)
        i = end < 0 ? n : end + 1
        continue
      }
      return
    }
  }
  const nextToken = () => {
    skipSpaceAndComments()
    if (i >= n) return null
    const ch = text[i]
    if (ch === '{' || ch === '}') {
      i++
      return { type: ch }
    }
    if (ch === '[') {
      const end = text.indexOf(']', i)
      i = end < 0 ? n : end + 1
      return { type: 'cond' }
    }
    if (ch === '"') {
      i++
      let out = ''
      let start = i
      while (i < n) {
        const c = text[i]
        if (c === '\\' && i + 1 < n) {
          out += text.slice(start, i)
          const e = text[i + 1]
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === '"' || e === '\\' ? e : '\\' + e
          i += 2
          start = i
          continue
        }
        if (c === '"') break
        i++
      }
      out += text.slice(start, i)
      i++
      return { type: 'str', value: out }
    }
    const start = i
    while (i < n && text.charCodeAt(i) > 32 && !'{}"'.includes(text[i])) i++
    return { type: 'str', value: text.slice(start, i) }
  }
  const insert = (obj, key, value) => {
    if (!(key in obj)) {
      obj[key] = value
    } else if (typeof obj[key] === 'object' && typeof value === 'object') {
      for (const k of Object.keys(value)) insert(obj[key], k, value[k])
    }
  }
  const parseBlock = () => {
    const obj = Object.create(null)
    for (;;) {
      let tok = nextToken()
      while (tok && tok.type === 'cond') tok = nextToken()
      if (!tok || tok.type === '}') return obj
      if (tok.type !== 'str') throw new Error(`KeyValues: unexpected '${tok.type}' at ${i}`)
      const key = tok.value.toLowerCase()
      let val = nextToken()
      while (val && val.type === 'cond') val = nextToken()
      if (!val) return obj
      if (val.type === '{') insert(obj, key, parseBlock())
      else if (val.type === 'str') insert(obj, key, val.value)
      else throw new Error(`KeyValues: unexpected '${val.type}' after key '${key}' at ${i}`)
    }
  }
  return parseBlock()
}

const loadText = async (args, key) => {
  const local = args.get(key)
  if (local) return fs.readFileSync(path.resolve(local), 'utf8')
  const url = SOURCES[key]
  process.stderr.write(`Downloading ${url}\n`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return await res.text()
}

// RecursiveInheritKeyValues + MergeDefinitionPrefab (econ_item_schema.cpp): prefabs listed in
// "prefab" are applied last-to-first, then the item's own keys; blocks merge recursively.
const inherit = (out, src) => {
  for (const key of Object.keys(src)) {
    const value = src[key]
    if (typeof value === 'object') {
      if (typeof out[key] !== 'object') out[key] = Object.create(null)
      inherit(out[key], value)
    } else {
      out[key] = value
    }
  }
}
export const mergeDefinition = (out, src, prefabs, depth = 0) => {
  if (depth > 32) throw new Error('prefab recursion too deep')
  const prefabNames = typeof src.prefab === 'string' ? src.prefab.split(/\s+/).filter(Boolean) : []
  for (let p = prefabNames.length - 1; p >= 0; p--) {
    const prefab = prefabs[prefabNames[p].toLowerCase()]
    if (prefab) mergeDefinition(out, prefab, prefabs, depth + 1)
  }
  inherit(out, src)
  return out
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const outPath = path.resolve(repoRoot, args.get('out') || 'src/constants/items.json')
  const iconsDir = path.resolve(repoRoot, 'src/assets/kill_icons')
  const aliasesPath = path.resolve(repoRoot, 'src/constants/killIconAliases.ts')

  const schema = parseKeyValues(await loadText(args, 'items')).items_game
  const lang = parseKeyValues(await loadText(args, 'lang')).lang?.tokens || {}
  const protoLang = parseKeyValues(await loadText(args, 'proto-lang')).lang?.tokens || {}
  if (!schema?.items || !schema?.prefabs) throw new Error('items_game.txt: missing items/prefabs')

  // attribute name -> attribute_class (static_attrs are keyed by attribute *name*)
  const attrClassByName = Object.create(null)
  for (const def of Object.values(schema.attributes || {})) {
    if (def && typeof def === 'object' && def.name) {
      attrClassByName[def.name.toLowerCase()] = (def.attribute_class || def.name).toLowerCase()
    }
  }

  const icons = new Set(
    fs
      .readdirSync(iconsDir)
      .filter(f => f.endsWith('.png'))
      .map(f => f.slice(0, -4))
  )
  const aliases = {}
  for (const m of fs.readFileSync(aliasesPath, 'utf8').matchAll(/^\s*([\w'-]+)\s*:\s*'([^']+)'/gm)) {
    aliases[m[1]] = m[2]
  }
  // also match ignoring punctuation/underscores ("Scorch Shot" -> scorchshot.png)
  const compact = s => s.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, '')
  const iconsByCompact = new Map()
  for (const icon of icons) if (!iconsByCompact.has(compact(icon))) iconsByCompact.set(compact(icon), icon)
  const iconFor = name => {
    if (!name) return null
    const key = name.toLowerCase()
    if (icons.has(key)) return key
    if (aliases[key] && icons.has(aliases[key])) return aliases[key]
    return iconsByCompact.get(compact(key)) || null
  }

  const localize = token => {
    if (typeof token !== 'string' || !token) return null
    if (!token.startsWith('#')) return token
    const v = lang[token.slice(1).toLowerCase()]
    return typeof v === 'string' ? v : null
  }
  const cleanName = s => s.replace(/\s+/g, ' ').trim()

  const attrValues = def => {
    const out = Object.create(null)
    for (const a of Object.values(def.attributes || {})) {
      if (a && typeof a === 'object' && a.attribute_class) out[a.attribute_class.toLowerCase()] = a.value
    }
    for (const [name, value] of Object.entries(def.static_attrs || {})) {
      if (typeof value !== 'string') continue
      out[attrClassByName[name] || name] ??= value
    }
    return out
  }

  const items = {}
  const report = { noIcon: [], categories: {} }
  const defIndices = Object.keys(schema.items)
    .filter(k => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b)

  for (const defIndex of defIndices) {
    const raw = schema.items[String(defIndex)]
    if (!raw || typeof raw !== 'object') continue
    const def = mergeDefinition(Object.create(null), raw, schema.prefabs)
    const itemClass = def.item_class
    const slot = def.item_slot
    if (typeof itemClass !== 'string' || typeof slot !== 'string') continue
    const isWeaponClass = itemClass.startsWith('tf_weapon_') || itemClass === 'saxxy'
    const isWeaponWearable = itemClass.startsWith('tf_wearable') && WEAPON_SLOTS.has(slot)
    if (!(isWeaponClass && (WEAPON_SLOTS.has(slot) || slot === 'action')) && !isWeaponWearable) {
      continue
    }

    // name
    let name = localize(def.item_name) || def.name || String(defIndex)
    const paintKit = def.static_attrs?.paintkit_proto_def_index
    if (paintKit !== undefined) {
      const paintName = protoLang[`9_${paintKit}_field { field_number: 2 }`]
      if (paintName) name = `${paintName} ${name}`
    }
    name = cleanName(name)

    // classes / per-class slots
    const ubc = def.used_by_classes || {}
    const classes = CLASS_ORDER.filter(c => c in ubc)
    const classSlots = {}
    for (const c of classes) {
      const v = ubc[c]
      if (typeof v === 'string' && v !== '1' && v !== slot) classSlots[c] = v
    }

    // category
    let category = CATEGORY_BY_CLASS[itemClass] || 'other'
    if (itemClass === 'tf_weapon_builder') category = classes.includes('spy') ? 'sapper' : 'pda'
    if (slot === 'melee' && (category === 'melee_blunt' || category === 'other') && BLADE_NAME.test(name)) {
      category = 'melee_blade'
    }
    if (category === 'other' && slot === 'melee') category = 'melee_blunt'

    // kill icon guess
    const strippedName = name
      .replace(/^(the|festive|festivized|strange|australium|gold|silver|rust|blood|carbonado|diamond)\s+/gi, '')
      .replace(/^(botkiller)\s+/i, '')
      .replace(/\s+mk\.\s*i+$/i, '')
    const nameKey = s => s.toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, '_')
    const icon =
      iconFor(def.item_iconname) ||
      iconFor(nameKey(name)) ||
      iconFor(nameKey(strippedName)) ||
      iconFor(def.item_logname) ||
      iconFor(ICON_BY_CLASS[itemClass]) ||
      (itemClass.startsWith('tf_weapon_') ? iconFor(itemClass.slice('tf_weapon_'.length)) : null)

    const entry = { n: name, c: itemClass, s: slot, u: classes, k: category }
    if (icon) entry.i = icon
    if (Object.keys(classSlots).length) entry.cs = classSlots

    const attrs = attrValues(def)
    const num = v => (v === undefined ? undefined : Number(v))
    if (attrs.set_weapon_mode !== undefined) entry.wm = num(attrs.set_weapon_mode)
    if (attrs.set_charge_type !== undefined) entry.ct = num(attrs.set_charge_type)
    if (attrs.set_buff_type !== undefined) entry.bt = num(attrs.set_buff_type)
    if (attrs.override_projectile_type !== undefined) entry.pt = num(attrs.override_projectile_type)
    if (attrs.min_viewmodel_offset !== undefined) entry.o = attrs.min_viewmodel_offset

    items[defIndex] = entry
    report.categories[category] = (report.categories[category] || 0) + 1
    if (!icon) report.noIcon.push(`${defIndex} ${name} (${itemClass})`)
  }

  const json = args.has('pretty') ? JSON.stringify(items, null, 1) : JSON.stringify(items)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, json + '\n')
  process.stderr.write(
    `Wrote ${Object.keys(items).length} weapon items (${(json.length / 1024).toFixed(1)} KiB) to ${path.relative(repoRoot, outPath)}\n`
  )
  if (args.has('report')) {
    process.stderr.write(`Categories: ${JSON.stringify(report.categories)}\n`)
    process.stderr.write(`No kill icon (${report.noIcon.length}):\n  ${report.noIcon.join('\n  ')}\n`)
  }
}

// Run only when executed directly (the parser/merge helpers can be imported for analysis).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
