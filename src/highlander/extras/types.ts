// src/highlander/extras/types.ts
export const HL_EXTRAS_SCHEMA = 1

export type U8 = Uint8Array
export type I8 = Int8Array
export type U16 = Uint16Array
export type I16 = Int16Array
export type U32 = Uint32Array
export type I32 = Int32Array
export type F32 = Float32Array

/** CSR change list. Entries of key k: [offsets[k], offsets[k+1]), strictly increasing ticks. */
export interface Track { offsets: U32; ticks: U32 }
/** Columnar events sorted by tick. */
export interface EventList { tick: U32 }
/** Per-instance static columns. */
export interface Instances { count: number; entityId: U16; created: U32; deleted: U32 }
/** Absolute (Rust) or scene (after hydration) transform track. */
export type XformTrack = Track & { x: F32; y: F32; z: F32; qx: F32; qy: F32; qz: F32; qw: F32 }

export type HlAvailKey =
  | 'cond' | 'cloak' | 'disguise' | 'weapon' | 'wstate' | 'ammo' | 'medigun' | 'sniper' | 'fov' | 'view'
  | 'resource' | 'misc' | 'builder' | 'loadout' | 'viewmodels' | 'fire' | 'anim' | 'scoring' | 'itemCharge'
  | 'buildings' | 'projectiles' | 'flames' | 'dots'
  | 'objectiveResource' | 'timers' | 'rules' | 'teams' | 'watchers' | 'carts' | 'pd'
  | 'movers' | 'pickups' | 'ragdolls' | 'drops'
  | 'bullets' | 'explosions' | 'tracers' | 'particles' | 'clientProjectiles' | 'hurts' | 'events'

export interface XMeta {
  schema: 1
  startTick: number          // echo of options.startTick
  tickBase: number           // echo
  ticks: number              // echo
  intervalPerTick: number    // from ServerInfo, falls back to options
  snapshotInterval: number   // most common server-tick gap between consecutive PacketEntities messages: 1 on the HL demos, 2 on the 6v6 sample
  playerCount: number        // options.playerEntityIds.length
  map: string                // ServerInfo map name
  parseMs: number            // Rust writes 0 (std::time::Instant panics on wasm32-unknown-unknown); ExtrasWorker sets the wall time
  available: Record<HlAvailKey, boolean>   // true when the group produced at least one entry
  counts: Record<string, number>           // diagnostics: instances per class, events per type
  warnings: string[]
  excluded: string[]                       // groups left out through options.groups (emitted empty, section 2.2)
  convars: { tick: number; key: string; value: string }[]   // every SetConVar entry; signon entries at tick 0 (section 1.2)
  pauses: { tick: number; paused: boolean }[]               // SetPause messages
}

export interface XStrings {
  models: string[]        // modelprecache, index = m_nModelIndex
  classes: string[]       // server class names, index = class id
  particles: string[]     // ParticleEffectNames
  effects: string[]       // EffectDispatch names
}

export interface XAlignment {
  ticks: U32              // 16 sample ticks: for k = 0..15, the first tick at or after round(ticks * (k + 0.5) / 16) that received a PacketEntities message
  pos: F32                // (p * 16 + k) * 3 + axis; NaN when player p is absent or dead at that tick
}

export interface XPlayers {
  count: number
  entityId: U32
  cond: Track & { w0: U32; w1: U32; w2: U32; w3: U32; w4: U32 }
  cloak: Track & { meter: U8 }
  invis: Track & { completeTick: F32 }
  disguise: Track & { team: U8; cls: U8; target: U8; health: U16; weaponDef: U16; desiredTeam: U8; desiredCls: U8 }
  weapon: Track & { id: U32; def: U16; cls: U16 }
  wstate: Track & { state: U8; reload: U8; clip: I16; flags: U8; chargeTick: F32 }
  ammo: Track & { primary: U16; secondary: U16; metal: U16 }
  medigun: Track & { charge: U16; flags: U8; target: U8; def: U16; resist: U8 }
  sniper: Track & { charge: U8 }
  fov: Track & { fov: U8; start: U8; tick: F32; rate: F32 }
  view: Track & { eyeZ: U8; duck: U8 }
  resource: Track & { respawnTick: F32; maxHealth: U16; maxBuffed: U16; alive: U8; score: U16; damage: U32; healing: U32 }
  misc: Track & { healers: U8; carrying: U8; flip: U8; obsMode: U8; obsTarget: U8; revenge: U8; heads: U8; charge: U8; rage: U8; stickies: U8; saveMe: U8 }
  builder: Track & { state: U8; type: U8; mode: U8 }
  loadout: Track & { d0: U16; d1: U16; d2: U16; d3: U16; d4: U16; d5: U16; d6: U16; d7: U16; w0: U16; w1: U16; w2: U16; w3: U16 }
  scoring: Track & {
    kills: U16; deaths: U16; assists: U16; damage: U32; heals: U32; caps: U16; defenses: U16; backstabs: U16
    headshots: U16; invulns: U16; teleports: U16; built: U16; destroyed: U16; dominations: U16; revenges: U16; points: U16
  }
  itemCharge: Track & { s0: U8; s1: U8; s2: U8 }
  vm0: Track & { model: U16; seq: U8; parity: U8; muzzle: U8; weaponDef: U16; rate: F32; nodraw: U8 }
  vm1: Track & { model: U16; seq: U8; parity: U8; muzzle: U8; weaponDef: U16; rate: F32; nodraw: U8 }
  fire: EventList & { player: U8; weaponDef: U16 }
  anim: EventList & { player: U8; event: U8; data: U16 }
}

export interface XWeapons extends Instances { owner: U8; def: U16; cls: U16; disguise: U8 }

export interface XBuildings extends Instances {
  type: U8; mode: U8; builder: U8; team: U8; mini: U8; mapPlaced: U8; builtOn: I32
  state: Track & {
    level: U8; health: U16; maxHealth: U16; built: U8; flags: U16; objState: U8; upgradeMetal: U16
    shells: U16; rockets: U8; metal: U16; rechargeTick: F32; rechargeDur: F32; timesUsed: U16
  }
  pose: Track & { yaw: U8; pitch: U8 }
  xform: XformTrack
  enemy: Track & { kind: U8; index: U16 }
  heal: Track & { lo: U32; hi: U32 }
}

export interface XProjectiles extends Instances {
  kind: U8; team: U8; owner: U8; launcherDef: U16; crit: U8; sentry: U16
  hidden: U32                      // first tick the projectile is no longer drawn (Leave or Delete)
  vx: F32; vy: F32; vz: F32        // m_vInitialVelocity, NaN when absent
  posStart: U32; posCount: U32     // sample s of instance j is tick created[j] + s, at pos[(posStart[j] + s) * 3]
  pos: F32
  deflects: Track & { team: U8; owner: U8; count: U8 }
}

export interface XFlames extends Instances {
  owner: U8
  box: Track & { firing: U8; cx: F32; cy: F32; cz: F32; hx: F32; hy: F32; hz: F32 }
}

export interface XDots extends Instances {
  owner: U8; team: U8; laser: U8
  pos: Track & { x: F32; y: F32; z: F32; chargeTick: F32 }
}

export interface XTimers extends Instances {
  state: Track & {
    paused: U8; endTick: F32; remaining: F32; length: U16; maxLength: U16; setupLength: U16
    mode: U8; flags: U8; totalTime: F32
  }
}

export interface XWatchers extends Instances {
  state: Track & { progress: U16; speed: I8; cappers: I8; recedeTick: F32 }
}

export interface XControlPoints {
  count: number
  layout: string
  pos: F32            // 8 * 3, m_vCPPositions
  visible: U8         // 8
  group: U8           // 8
  capTimeRed: F32     // 8, seconds for one capper (m_flTeamCapTime[16 + p])
  capTimeBlu: F32     // 8 (m_flTeamCapTime[24 + p])
  reqRed: U8          // 8
  reqBlu: U8          // 8
  pathDistance: F32   // 8, payload checkpoint fractions
  scales: U8          // 8, m_bCPCapRateScalesWithPlayers
  state: Track & { owner: U8; capping: U8; inZone: U8; numRed: U8; numBlu: U8; lazy: F32; flags: U8; unlockTick: F32 }
  progress: Track & { p: U16 }   // simulated capture fraction toward state.capping, 0..65535
  // P2 (contract 12.4 item 3): the linear-capture data of CTFGameRules::TeamMayCapturePoint. Static per demo: no
  // local demo changes them within the demo (133-demo survey); the last value of the parse, -1 / false without an
  // objective resource.
  prevRed: I8         // 8 * 3, m_iPreviousPoints of RED: index point * 3 + slot, -1 none
  prevBlu: I8         // 8 * 3, m_iPreviousPoints of BLU
  baseRed: number     // m_iBaseControlPoints[2], -1 none
  baseBlu: number     // m_iBaseControlPoints[3], -1 none
  miniRounds: boolean // m_bPlayingMiniRounds
}

export interface XObjectives {
  gameType: number
  koth: boolean
  rules: Track & {
    roundState: U8; winner: U8; flags: U16; swState: U8; rounds: U8
    redKoth: I16; bluKoth: I16; hudTimer: I16; swTimer: I16
    waveRed: F32; waveBlu: F32; restartTick: F32
  }
  teams: Track & { score: I32; roundsWon: U16; role: U8; flagCaps: U8 }   // key = team number 0..3
  timers: XTimers
  cp: XControlPoints
  watchers: XWatchers
  cart: { movers: I32; trains: I32 }   // mover instance indices of payload cart props and of CFuncTrackTrain
  pd: Track & { red: U16; blu: U16; max: U16 }   // key 0, tug of war (CTFPlayerDestructionLogic)
}

export interface XMovers extends Instances {
  cls: U8; bspModel: I16; model: U16; parent: I32
  xform: XformTrack
  vis: Track & { v: U8 }
}

export interface XPickups extends Instances {
  kind: U8; size: U8; model: U16; x: F32; y: F32; z: F32
  vis: Track & { v: U8 }
  /**
   * P2 (contract 12.4 item 1): the absolute transform of a pickup whose transform changes after creation (thrown
   * lunchbox items and dropped kits, CTFPowerup::DropSingleInstance), one entry per change from `created` on.
   * Static pickups (map kits) have no entries; their position is x, y, z.
   */
  xform: XformTrack
}

export interface XRagdolls extends Instances {
  player: U8; cls: U8; team: U8; flags: U16; custom: U16
  x: F32; y: F32; z: F32; vx: F32; vy: F32; vz: F32
}

export interface XDrops extends Instances {
  kind: U8; model: U16; def: U16
  xform: XformTrack
}

export interface XTempEnts {
  bullets: EventList & { player: U8; weaponId: U8; crit: U8; seed: U8; spread: F32; x: F32; y: F32; z: F32; pitch: F32; yaw: F32 }
  explosions: EventList & { x: F32; y: F32; z: F32; nx: F32; ny: F32; nz: F32; weaponId: U8; def: U16; entity: U16; particle: U16 }
  tracers: EventList & { sentry: U16; sx: F32; sy: F32; sz: F32; ex: F32; ey: F32; ez: F32 }
  particles: EventList & { name: U16; x: F32; y: F32; z: F32; entity: U16 }
  clientProjectiles: EventList & { kind: U8; player: U8; crit: U8; x: F32; y: F32; z: F32; vx: F32; vy: F32; vz: F32 }
}

export type XHurts = EventList & { victim: U8; attacker: U8; damage: U16; health: I16; crit: U8; weaponId: U8; custom: U16 }

export type HlEvent =
  | { t: 'kill'; tick: number; victim: number; attacker: number; assister: number; inflictor: number; weapon: string; weaponLog: string; weaponDef: number; weaponId: number; deathFlags: number; customKill: number; critType: number; feign: boolean }
  | { t: 'uberDeployed'; tick: number; medic: number; target: number }
  | { t: 'medicDeath'; tick: number; medic: number; attacker: number; healing: number; charged: boolean }
  | { t: 'deflect'; tick: number; pyro: number; owner: number; weaponId: number; entity: number; projectile: number }
  | { t: 'buildStart'; tick: number; building: number; builder: number; type: number; mode: number }
  | { t: 'buildDone'; tick: number; building: number; builder: number; type: number }
  | { t: 'upgrade'; tick: number; building: number; builder: number; level: number }
  | { t: 'carry'; tick: number; building: number; builder: number }
  | { t: 'redeploy'; tick: number; building: number; builder: number }
  | { t: 'destroyed'; tick: number; building: number; owner: number; attacker: number; assister: number; weapon: string; type: number; wasBuilding: boolean }
  | { t: 'detonated'; tick: number; building: number; owner: number; type: number }
  | { t: 'sapped'; tick: number; building: number; spy: number; owner: number; type: number }
  | { t: 'teleported'; tick: number; player: number; builder: number; dist: number }
  | { t: 'capStart'; tick: number; cp: number; cpName: string; team: number; capTeam: number; cappers: number[]; capTime: number }
  | { t: 'captured'; tick: number; cp: number; cpName: string; team: number; cappers: number[] }
  | { t: 'capBlocked'; tick: number; cp: number; cpName: string; blocker: number; victim: number }
  | { t: 'capBroken'; tick: number; cp: number; cpName: string; timeRemaining: number }
  | { t: 'cpLocked'; tick: number; cp: number }
  | { t: 'cpUnlocked'; tick: number; cp: number }
  | { t: 'roundStart'; tick: number; fullReset: boolean }
  | { t: 'roundActive'; tick: number }
  | { t: 'setupFinished'; tick: number }
  | { t: 'roundWin'; tick: number; team: number; winReason: number; fullRound: boolean; roundTime: number; suddenDeath: boolean }
  | { t: 'overtimeStart'; tick: number }
  | { t: 'overtimeEnd'; tick: number }
  | { t: 'timeAdded'; tick: number; timer: number; seconds: number }
  | { t: 'gameOver'; tick: number; reason: string }
  | { t: 'banner'; tick: number; owner: number; buffType: number }
  | { t: 'pickup'; tick: number; player: number; item: string }
  | { t: 'spawn'; tick: number; player: number; cls: number; team: number }
  | { t: 'classChange'; tick: number; player: number; cls: number }
  | { t: 'teamChange'; tick: number; player: number; team: number; oldTeam: number; disconnect: boolean }
  | { t: 'disconnect'; tick: number; player: number; reason: string }

export interface ExtrasRaw {
  meta: XMeta
  strings: XStrings
  alignment: XAlignment
  players: XPlayers
  weapons: XWeapons
  buildings: XBuildings
  projectiles: XProjectiles
  flames: XFlames
  dots: XDots
  objectives: XObjectives
  movers: XMovers
  pickups: XPickups
  ragdolls: XRagdolls
  drops: XDrops
  tempents: XTempEnts
  hurts: XHurts
  events: HlEvent[]
}

/** Index lists built during hydration: rows of a global EventList grouped by player, tick order kept. */
export interface ByPlayer { offsets: U32; rows: U32 }

export interface HighlanderExtras extends ExtrasRaw {
  derived: {
    sceneOrigin: { x: number; y: number; z: number }
    flags: U32                         // HL flag mask per players.cond entry (same offsets/ticks as players.cond)
    entityToPlayer: Map<number, number>
    fireByPlayer: ByPlayer
    animByPlayer: ByPlayer
    bulletsByPlayer: ByPlayer
    hurtsByVictim: ByPlayer
    hurtsByAttacker: ByPlayer
    projectilesByEntity: Map<number, number[]>   // entity id -> instance indices sorted by created
    buildingsByEntity: Map<number, number[]>
    eventsByType: Record<string, number[]>       // HlEvent type -> indices into events
  }
}
