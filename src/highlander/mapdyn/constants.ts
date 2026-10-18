// F6 map dynamics: sizes, colours and timings (contract section 5 F6). Shared style tokens come from
// src/highlander/constants.ts; the literals here are the ones the F6 table fixes.

/** Brush classes whose render-mode-10 nodes follow `vis` as door stand-ins (contract section 11.3). */
export const DOOR_LIKE_CLASSES = new Set([
  'func_door',
  'func_door_rotating',
  'func_movelinear',
  'func_tracktrain',
  'func_train',
  'func_rotating',
])

/** kRenderNone: not drawn in game. */
export const RENDER_MODE_NONE = 10

export const SLAB_OPACITY = 0.85
export const LOCKER_OPACITY = 0.9
/**
 * Resupply cabinet placeholder, centred on the `resupply_locker.mdl` prop origin (the origin sits at the
 * cabinet's footprint centre, 16 units in front of the wall on every HL map). Width across the doors, depth
 * along the prop's facing (+X local), height from the floor.
 */
export const LOCKER_SIZE = { width: 60, depth: 30, height: 96 }

/** item_*kit_* respawn delay (tf_gamerules.cpp ITEM_RESPAWN_TIME), used only when the instance ends first. */
export const ITEM_RESPAWN_SECONDS = 10
/**
 * Slack on that estimate: a taken kit whose instance ends less than this after the estimated return (round
 * restart, demo end) counts as "ended first"; one that lives on longer without coming back left for good.
 */
export const ITEM_RESPAWN_SLACK_SECONDS = 1
/**
 * Kits thrown or dropped by players (lunchbox throws, Candy Cane kills) live at most TF_POWERUP_LIFETIME
 * (tf_powerup.h, 30 s), so a kit-model instance that lives longer is a map kit.
 */
export const DROPPED_KIT_MAX_SECONDS = 31
/** Pickup instances whose origins lie this close are one kit spot (a map kit keeps its exact origin). */
export const KIT_SPOT_RADIUS = 4
/** A pickup within this distance of a map-meta item origin stands on that map spot. */
export const META_ITEM_RADIUS = 8

/** Health kit body [width, height] per size (small, medium, large). */
export const HEALTH_SIZE: readonly [number, number][] = [
  [14, 8],
  [20, 12],
  [26, 16],
]
/** Ammo box body [width, height] per size. */
export const AMMO_SIZE: readonly [number, number][] = [
  [12, 10],
  [16, 14],
  [22, 18],
]
export const HEALTH_BODY_COLOR = '#f2f2f2'
export const HEALTH_CROSS_COLOR = '#d02020'
export const AMMO_BODY_COLOR = '#6b6b3a'
export const AMMO_BAND_COLOR = '#e0c040'
/** Respawn ring colours (fill), health and ammo. */
export const HEALTH_RING_COLOR = '#ff6f61'
export const AMMO_RING_COLOR = '#e0c040'
export const WIRE_OPACITY = 0.15
export const RING_FILL_OPACITY = 0.95
export const RING_TRACK_OPACITY = 0.22
export const PICKUP_BOB = 2 // units, `2 * sin(tickF * 0.1)`
export const PICKUP_BOB_RATE = 0.1 // rad per tick
export const PICKUP_YAW_RATE = 0.03 // rad per tick
/** Map pickups have their origin this far above the floor (item model origin, measured on vigil). */
export const PICKUP_FLOOR_OFFSET = 11.2
/**
 * The map surface analysis (surface.ts) advances at most this many triangles per frame and per analysis,
 * so a map load or a props.glb arrival never pays the whole pass in one frame.
 */
export const SURFACE_TRIANGLES_PER_FRAME = 40000

/** Death markers (contract F6): 330 ticks, an X of two 24 x 3 x 1 bars. */
export const DEATH_MARKER_TICKS = 330
/** The marker of a mid-air death drops to the highest floor at most this far below the ragdoll origin. */
export const DEATH_MARKER_DROP = 1500
export const DEATH_MARKER_BAR = { length: 24, width: 3, height: 1 }
export const DEATH_MARKER_GIB_COLOR = '#b01515'
/** Ticks the marker takes to grow in and to shrink away (presentation only, still a pure function of tickF). */
export const DEATH_MARKER_GROW_TICKS = 4
export const DEATH_MARKER_SHRINK_TICKS = 30

/** Dropped items (contract F6). */
export const DROP_AMMO_SIZE = [12, 12, 8] as const
export const DROP_GIB_SIZE = [6, 6, 6] as const
export const DROP_WEAPON_SIZE = [24, 4, 4] as const
export const DROP_AMMO_COLOR = '#6b6b3a'
