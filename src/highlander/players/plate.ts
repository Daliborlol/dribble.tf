// Look of the Highlander nameplate items (contract section 5 F1), used by src/components/Scene/Nameplate.tsx.

import { useSyncExternalStore } from 'react'

import { TEAM_FX, TEAM_HUD } from '@highlander/constants'

/** URL of a kill icon in src/assets/kill_icons/ (the same lookup as the killfeed). */
export const killIconUrl = (name: string) => new URL(`/src/assets/kill_icons/${name}.png`, import.meta.url).href

//
// ─── WEAPON ICONS ───────────────────────────────────────────────────────────────
//
// The kill icons are dark olive silhouettes. On a nameplate over the map they are drawn white with a dark edge,
// like the plate's name text. A CSS filter (invert plus drop-shadow) did that per frame for every plate and cost
// about 1 ms per frame at 9v9 while the plates move, so each icon is recoloured once on a canvas instead.

const iconUrls = new Map<string, string>() // icon -> recoloured data URL ('' when the icon failed to load)
const iconLoading = new Set<string>()
const iconListeners = new Set<() => void>()
let iconVersion = 0

function notifyIcons() {
  iconVersion++
  for (const listener of iconListeners) listener()
}

function recolour(image: HTMLImageElement): string {
  const pad = 2
  const w = image.naturalWidth + pad * 2
  const h = image.naturalHeight + pad * 2
  const silhouette = (colour: string) => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const g = canvas.getContext('2d')
    if (!g) return canvas
    g.drawImage(image, pad, pad)
    g.globalCompositeOperation = 'source-in'
    g.fillStyle = colour
    g.fillRect(0, 0, w, h)
    return canvas
  }
  const dark = silhouette('rgba(0, 0, 0, 0.9)')
  const light = silhouette('#ffffff')
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const g = out.getContext('2d')
  if (!g) return ''
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) g.drawImage(dark, dx, dy)
  g.drawImage(light, 0, 0)
  return out.toDataURL('image/png')
}

function loadIcon(name: string) {
  if (iconLoading.has(name) || typeof document === 'undefined') return
  iconLoading.add(name)
  const image = new Image()
  image.onload = () => {
    let url = ''
    try {
      url = recolour(image)
    } catch {
      url = ''
    }
    iconUrls.set(name, url)
    iconLoading.delete(name)
    notifyIcons()
  }
  image.onerror = () => {
    iconUrls.set(name, '')
    iconLoading.delete(name)
    notifyIcons()
  }
  image.src = killIconUrl(name)
}

const subscribeIcons = (listener: () => void) => {
  iconListeners.add(listener)
  return () => {
    iconListeners.delete(listener)
  }
}
const iconSnapshot = () => iconVersion

/** The recoloured kill icon of `name`; undefined while it loads, for unknown icons and without a name. */
export function useWeaponIconUrl(name: string | undefined): string | undefined {
  useSyncExternalStore(subscribeIcons, iconSnapshot)
  if (!name) return undefined
  const url = iconUrls.get(name)
  if (url === undefined) {
    loadIcon(name)
    return undefined
  }
  return url || undefined
}

//
// ─── BARS, TAGS, BADGES ─────────────────────────────────────────────────────────
//

export const CLOAK_BAR_COLOR = '#c8d7ff'
export const CHARGE_BAR_COLOR = '#e0c040'

const teamColor = (team: string, palette: { red: string; blue: string }) =>
  team === 'red' ? palette.red : team === 'blue' ? palette.blue : '#666666'

type TagStyle = { background: string; color: string }
const tagStyles = new Map<string, TagStyle>()

function makeTagStyle(tag: string, team: string): TagStyle {
  switch (tag) {
    case 'UBER':
    case 'QF':
    case 'VACC':
      return { background: teamColor(team, TEAM_HUD), color: '#ffffff' }
    case 'CRIT':
      return { background: teamColor(team, TEAM_FX), color: '#ffffff' }
    case 'BONK':
    case 'STUN':
      return { background: '#e0c040', color: '#1a1a1a' }
    case 'MARKED':
      return { background: '#7a1414', color: '#ffffff' }
    case 'GAS':
      return { background: '#5d6b3f', color: '#ffffff' }
    case 'BANNER':
    case 'MMMPH':
    case 'FOCUS':
      return { background: '#b0641c', color: '#ffffff' }
    case 'DECLOAK':
      return { background: CLOAK_BAR_COLOR, color: '#14213d' }
    case 'MEDIC!':
      return { background: '#d63a3a', color: '#ffffff' }
    default:
      return { background: 'rgba(0, 0, 0, 0.6)', color: '#ffffff' }
  }
}

/** Background and text colour of a tag pill (a shared object per tag and team). Team tags take the shown team. */
export function tagStyle(tag: string, team: string): TagStyle {
  const key = `${tag}|${team}`
  let style = tagStyles.get(key)
  if (!style) tagStyles.set(key, (style = makeTagStyle(tag, team)))
  return style
}

export const badgeBorder = (team: number) => (team === 2 ? TEAM_HUD.red : team === 3 ? TEAM_HUD.blue : '#777777')
