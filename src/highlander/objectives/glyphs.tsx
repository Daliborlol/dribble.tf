// Small inline SVG glyphs for the Highlander HUD: condition badges, engineer building badges, objective icons and
// timeline marker shapes, plus the killfeed's weapon icon with its crit glow. No emoji, no network requests; every
// glyph scales with its `size` prop.

import React from 'react'

import { cn } from '@utils/styling'
import type { BuildingGlyph, CondGlyph } from '@highlander/hud/hudSnapshot'
import { CRIT_ICON } from '@highlander/hud/killfeedModel'

// ─── kill icon ─────────────────────────────────────────────────────────────────

/**
 * A killfeed weapon icon. A crit (2) puts TF2's red crit glow (crit.png) behind the icon, stretched to its size, as
 * the game's killfeed does; a mini-crit (1) the same glow at 60 % opacity. `bright` turns the dark icon white for
 * dark backgrounds.
 */
export const KillIcon = ({ src, alt, crit, bright, className }: { src: string; alt: string; crit: number; bright: boolean; className: string }) => (
  <span className="relative inline-flex shrink-0 items-center" title={crit === 2 ? 'Critical hit' : crit === 1 ? 'Mini-crit' : undefined}>
    {crit > 0 && CRIT_ICON && (
      <img
        src={CRIT_ICON}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute -left-[9px] -top-[5px] h-[calc(100%+10px)] w-[calc(100%+18px)] max-w-none"
        style={{ opacity: crit === 1 ? 0.6 : 1 }}
      />
    )}
    <img src={src} alt={alt} className={cn('relative', className, bright && 'brightness-[600%]')} />
  </span>
)

type SvgProps = { size?: number; className?: string; title?: string }

const Svg = ({ size = 14, className, title, children, viewBox = '0 0 16 16' }: SvgProps & { children: React.ReactNode; viewBox?: string }) => (
  <svg width={size} height={size} viewBox={viewBox} className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
    {title && <title>{title}</title>}
    {children}
  </svg>
)

// ─── conditions ────────────────────────────────────────────────────────────────

const COND_TITLES: Record<CondGlyph, string> = {
  uber: 'Ubercharged',
  kritz: 'Crit boosted',
  fire: 'Burning',
  bleed: 'Bleeding',
  jarate: 'Jarate',
  milk: 'Mad Milk',
  marked: 'Marked for death',
}

const drop = (fill: string) => (
  <path d="M8 1.5 C8 1.5 3.5 7 3.5 10 A4.5 4.5 0 0 0 12.5 10 C12.5 7 8 1.5 8 1.5 Z" fill={fill} stroke="#000" strokeOpacity="0.5" strokeWidth="0.8" />
)

export const CondIcon = React.memo(({ cond, size = 14 }: { cond: CondGlyph; size?: number }) => {
  const title = COND_TITLES[cond]
  switch (cond) {
    case 'uber':
      return (
        <Svg size={size} title={title}>
          <path d="M8 1 L14 3.5 V8 C14 11.5 11.3 14 8 15 C4.7 14 2 11.5 2 8 V3.5 Z" fill="#f2f2f2" stroke="#000" strokeOpacity="0.5" strokeWidth="0.8" />
          <path d="M8 3 L12 4.8 V8 C12 10.4 10.3 12.2 8 13 Z" fill="#c9c9c9" />
        </Svg>
      )
    case 'kritz':
      return (
        <Svg size={size} title={title}>
          <path d="M8 1 L9.9 5.6 L15 6 L11.1 9.2 L12.3 14.2 L8 11.5 L3.7 14.2 L4.9 9.2 L1 6 L6.1 5.6 Z" fill="#ffd23f" stroke="#000" strokeOpacity="0.5" strokeWidth="0.8" />
        </Svg>
      )
    case 'fire':
      return (
        <Svg size={size} title={title}>
          <path d="M8 1 C9 4 12.5 5.5 12.5 9.5 A4.5 4.5 0 0 1 3.5 9.5 C3.5 7 5 6 5.5 4.5 C6.5 6 7 6.5 7.5 7 C7.5 4.5 7 3 8 1 Z" fill="#ff7a1a" stroke="#000" strokeOpacity="0.5" strokeWidth="0.8" />
          <path d="M8 8 C8.8 9.4 10 10 10 11.4 A2 2 0 0 1 6 11.4 C6 10.4 7.2 9.6 8 8 Z" fill="#ffd23f" />
        </Svg>
      )
    case 'bleed':
      return <Svg size={size} title={title}>{drop('#d0212a')}</Svg>
    case 'jarate':
      return <Svg size={size} title={title}>{drop('#e8c31b')}</Svg>
    case 'milk':
      return <Svg size={size} title={title}>{drop('#f4f4f4')}</Svg>
    case 'marked':
      return (
        <Svg size={size} title={title}>
          <path d="M8 1.5 C4.4 1.5 2.5 4 2.5 7 C2.5 9 3.6 10.2 5 10.8 V13.5 H11 V10.8 C12.4 10.2 13.5 9 13.5 7 C13.5 4 11.6 1.5 8 1.5 Z" fill="#f2f2f2" stroke="#000" strokeOpacity="0.5" strokeWidth="0.8" />
          <circle cx="5.8" cy="7" r="1.5" fill="#222" />
          <circle cx="10.2" cy="7" r="1.5" fill="#222" />
          <path d="M7 13.5 V11.8 M9 13.5 V11.8" stroke="#222" strokeWidth="0.8" />
        </Svg>
      )
  }
})

// ─── engineer buildings ────────────────────────────────────────────────────────

/** Health share colour: green above 60 %, yellow above 30 %, red below. */
export const healthColor = (share: number) => (share > 0.6 ? '#7ed957' : share > 0.3 ? '#ffd23f' : '#ff5a4e')

const BUILDING_TITLES: Record<number, string> = { 0: 'Dispenser', 1: 'Teleporter', 2: 'Sentry' }

export const BuildingIcon = React.memo(({ b, size = 14 }: { b: BuildingGlyph; size?: number }) => {
  const color = healthColor(b.health)
  const stroke = b.sapped ? '#ff2a2a' : '#000'
  const strokeWidth = b.sapped ? 1.8 : 0.8
  // one stripe pattern per colour: duplicate ids across icons then all describe the same pattern
  const patternId = `hl-stripes-${color.slice(1)}`
  const fill = b.building ? `url(#${patternId})` : color
  const kind = b.type === 1 ? (b.mode === 1 ? 'Teleporter Exit' : 'Teleporter Entrance') : BUILDING_TITLES[b.type] ?? 'Building'
  const title = `${b.mini ? 'Mini ' : ''}${kind}${b.type !== 1 && !b.mini ? ` level ${b.level}` : ''}, ${Math.round(b.health * 100)} %${b.sapped ? ', sapped' : ''}${b.building ? ', building' : ''}${b.carried ? ', carried' : ''}`
  // a carried building (the engineer holds it) is a dimmed glyph with a dashed outline
  const dash = b.carried ? '2 1.5' : undefined
  let shape: React.ReactNode
  if (b.type === 2) shape = <path d="M8 1.5 L14.5 14 H1.5 Z" fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} strokeLinejoin="round" />
  else if (b.type === 0) shape = <rect x="2" y="2" width="12" height="12" rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} />
  else
    shape = (
      <>
        <circle cx="8" cy="8" r="6.3" fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} />
        {b.mode !== 1 && <path d="M5 8 H10.5 M8.5 5.6 L11 8 L8.5 10.4" stroke="#1a1a1a" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      </>
    )
  const showLevel = b.type !== 1 && !b.mini && b.level > 0
  return (
    <Svg size={size} title={title} className={b.carried ? 'opacity-50' : undefined}>
      <defs>
        <pattern id={patternId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill={color} />
          <rect width="2" height="4" fill="#1a1a1a" fillOpacity="0.55" />
        </pattern>
      </defs>
      {shape}
      {showLevel && (
        <text x="8" y={b.type === 2 ? 12.6 : 11.6} textAnchor="middle" fontSize="8.5" fontWeight="800" fill="#111">
          {b.level}
        </text>
      )}
    </Svg>
  )
})

// ─── objective icons ───────────────────────────────────────────────────────────

export const LockIcon = ({ size = 12, color = '#f2f2f2' }: { size?: number; color?: string }) => (
  <Svg size={size}>
    <rect x="3" y="7" width="10" height="7.5" rx="1.2" fill={color} />
    <path d="M5.2 7 V5 A2.8 2.8 0 0 1 10.8 5 V7" stroke={color} strokeWidth="1.7" fill="none" />
  </Svg>
)

export const CartIcon = ({ size = 16, color }: { size?: number; color: string }) => (
  <Svg size={size}>
    <rect x="1.5" y="6" width="13" height="5" rx="1" fill={color} stroke="#000" strokeOpacity="0.6" strokeWidth="0.8" />
    <ellipse cx="8" cy="5.2" rx="4.2" ry="2.6" fill="#2b2b2b" stroke="#000" strokeOpacity="0.6" strokeWidth="0.6" />
    <circle cx="4.5" cy="12.6" r="1.8" fill="#4a4a4a" />
    <circle cx="11.5" cy="12.6" r="1.8" fill="#4a4a4a" />
  </Svg>
)

export const Chevron = ({ size = 10, color = '#f2f2f2', reverse = false }: { size?: number; color?: string; reverse?: boolean }) => (
  <Svg size={size}>
    <path d={reverse ? 'M11 2 L5 8 L11 14' : 'M5 2 L11 8 L5 14'} stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
)

/** Vaccinator resist icons: bullet, blast, fire. */
export const ResistIcon = ({ resist, size = 12 }: { resist: number; size?: number }) => {
  if (resist === 1)
    return (
      <Svg size={size} title="Blast resist">
        <path d="M8 1 L9.6 5.2 L14 4 L11.2 7.6 L15 10.4 L10.4 10.6 L10.6 15 L8 11.6 L5.4 15 L5.6 10.6 L1 10.4 L4.8 7.6 L2 4 L6.4 5.2 Z" fill="#ffb03a" stroke="#000" strokeOpacity="0.5" strokeWidth="0.6" />
      </Svg>
    )
  if (resist === 2)
    return (
      <Svg size={size} title="Fire resist">
        <path d="M8 1 C9 4 12.5 5.5 12.5 9.5 A4.5 4.5 0 0 1 3.5 9.5 C3.5 7 5 6 5.5 4.5 C6.5 6 7 6.5 7.5 7 C7.5 4.5 7 3 8 1 Z" fill="#ff7a1a" stroke="#000" strokeOpacity="0.5" strokeWidth="0.6" />
      </Svg>
    )
  return (
    <Svg size={size} title="Bullet resist">
      <path d="M6 14.5 V7 C6 4 7 2 8 1.5 C9 2 10 4 10 7 V14.5 Z" fill="#e8c35a" stroke="#000" strokeOpacity="0.5" strokeWidth="0.6" />
      <rect x="5.5" y="11.5" width="5" height="3" fill="#b58a2a" />
    </Svg>
  )
}

/**
 * Circular capture icon: owner fill, progress arc in the capping team's colour. With a `label` (the point letter
 * or number) the letter stays and a locked point gets a padlock badge in the lower left corner; without one (the
 * KOTH point) a locked point shows a padlock in the middle. `size` is the outer diameter in px.
 */
export const PointIcon = ({
  size,
  fill,
  arcColor,
  progress,
  locked,
  label,
}: {
  size: number
  fill: string
  arcColor: string | null
  progress: number
  locked: boolean
  label?: string
}) => {
  const r = 15
  const circumference = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true" overflow="visible">
      <circle cx="18" cy="18" r="15.5" fill={fill} stroke="#000" strokeOpacity="0.55" strokeWidth="1.2" />
      {arcColor && progress > 0 && (
        <circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          stroke={arcColor}
          strokeWidth="4.5"
          strokeDasharray={`${(circumference * Math.min(1, progress)).toFixed(2)} ${circumference.toFixed(2)}`}
          transform="rotate(-90 18 18)"
        />
      )}
      {label ? (
        <>
          <text x="18" y="23" textAnchor="middle" fontSize="14" fontWeight="800" fill="#f2f2f2" stroke="#000" strokeOpacity="0.4" strokeWidth="0.6">
            {label}
          </text>
          {locked && (
            <g transform="translate(-3 21)">
              <circle cx="7.5" cy="7.5" r="7.5" fill="#1b1b1b" stroke="#f2f2f2" strokeOpacity="0.55" strokeWidth="0.8" />
              <rect x="3.6" y="6.8" width="7.8" height="5.6" rx="1" fill="#f2f2f2" />
              <path d="M5.3 6.8 V5.4 A2.2 2.2 0 0 1 9.7 5.4 V6.8" stroke="#f2f2f2" strokeWidth="1.4" fill="none" />
            </g>
          )}
        </>
      ) : (
        locked && (
          <g transform="translate(10 9)">
            <rect x="2" y="7" width="12" height="9" rx="1.5" fill="#f2f2f2" />
            <path d="M4.6 7 V4.8 A3.4 3.4 0 0 1 11.4 4.8 V7" stroke="#f2f2f2" strokeWidth="2" fill="none" />
          </g>
        )
      )}
    </svg>
  )
}
