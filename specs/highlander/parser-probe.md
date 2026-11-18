# Highlander parser probe: what SourceTV demos contain, and how to extract it

Ground truth for the Highlander work. It covers which data exists in serveme.tf SourceTV demos, the exact send
props that carry it, and how to decode it with `tf-demo-parser` (fork `../dribble-parser`, branch `highlander`).

- Probe: `../dribble-parser/src/bin/hl_probe.rs` (bin `hl_probe`, `required-features = ["write"]`).
- Build: `CARGO_BUILD_JOBS=4 cargo build --release --features write --bin hl_probe`
- Run: `target/release/hl_probe <demo.dem> <report.txt>` (full report, about 2.4 MB of text per demo) or
  `target/release/hl_probe --bench <demo.dem>` (parse timing and memory).
- Reports this document was written from (regenerate in about 2 s each):
  `<scratchpad>/probe/out/{1434434,1438891,1440442}.txt`

The probe keeps its own full entity state (instance or static baseline plus every delta), so it sees every send prop,
not only the ~60 the `GameStateAnalyser` decodes. It also delta-merges temp entities the way the engine does (see
§0.4), resolves model, particle and effect indices through the string tables, and decodes game events with the
field names from the demo's own event list.

| demo | map | duration | ticks | PacketEntities msgs | entity updates enter / delta / leave / delete | temp entities | game events |
|---|---|---|---|---|---|---|---|
| 1434434.dem | pl_vigil_rc10 | 226 s | 15 076 | 15 071 | 3 397 / 394 410 / 345 / 2 980 | 12 899 | 3 157 |
| 1438891.dem | koth_product_final | 817 s | 54 442 | 54 439 | 10 735 / 1 403 826 / 1 078 / 12 961 | 65 696 | 13 510 |
| 1440442.dem | cp_steel_f12 (stopwatch A/D) | 724 s | 48 263 | 48 254 | 9 772 / 1 346 525 / 1 196 / 9 424 | 38 507 | 10 787 |

All three are protocol 24, `interval_per_tick = 0.015` (66.67 Hz), 363 server classes (92–93 of them instantiated),
19 player entities (18 players plus the SourceTV bot at entity 1), `mp_tournament 1`, `tf_weapon_criticals 0`,
`tf_use_fixed_weaponspreads 1`.

---

## TL;DR: key findings

1. **STV demos contain far more than expected.** `tv_transmitall 1` is set (SetConVar), so the HLTV client gets
   every PVS-checked entity. It also gets **all "local player only" data tables for every player**:
   `DT_LocalPlayerExclusive`, `DT_Local`, `DT_TFLocalPlayerExclusive`, `DT_TFPlayerSharedLocal`, `m_iAmmo[]`, scoring
   data, and the weapons' `DT_LocalWeaponData`, `DT_LocalActiveWeaponData`, `DT_LocalTFWeaponData`,
   `DT_SniperRifleLocalData`, `DT_LocalTFWeaponMedigunData`, `DT_PipebombLauncherLocalData` and `DT_SentrygunLocalData`.
   Sniper charge, clip and ammo counts, last-fire times, precise velocity, fall velocity, punch angle and FOV are all
   present.
2. **Viewmodels exist for every player.** There are 36 `CTFViewModel` entities: 2 per player (vm index 0 is the
   weapon, vm index 1 is the spy watch). They carry `m_nSequence`, `m_nAnimationParity`, `m_nMuzzleFlashParity`,
   `m_hWeapon`, `m_nModelIndex` (the class arms model) and `m_flPlaybackRate`. They carry no origin or cycle.
   On the soldier sample, every rocket spawn (43/43) lands on the same tick as a viewmodel animation restart and a
   `TEPlayerAnimEvent ATTACK_PRIMARY`.
3. **Shots are fully observable.** Per player, four counts agree exactly (for example 36 = 36 = 36 = 36 for a scout):
   - weapon `DT_LocalTFWeaponData.m_flLastFireTime` changes
   - weapon `DT_BaseAnimating.m_nMuzzleFlashParity` changes
   - viewmodel `m_nMuzzleFlashParity` changes
   - `TEFireBullets` events (hitscan) or projectile spawns (projectile weapons)

   `TEFireBullets` gives the eye origin (within 1 unit), 7-bit angles, weapon id, seed, spread and a crit flag for
   every hitscan shot.
4. **Spy, sniper, medic and pyro mechanics are all networked to STV.**
   - Spy: `m_nPlayerCond` (STEALTHED, DISGUISING, DISGUISED, …), `m_flCloakMeter` (every tick),
     `m_flInvisChangeCompleteTime`, `m_nDisguiseTeam/Class`, `m_hDisguiseTarget`, `m_iDisguiseHealth` and
     `m_hDisguiseWeapon`.
   - Sniper: `m_iFOV` (20 when zoomed), `m_flChargedDamage` (0..150, +0.75 per tick) and a `CSniperDot` entity per
     zoom.
   - Medic: medigun `m_flChargeLevel` and `m_bChargeRelease`.
   - Pyro: flamethrower `m_iWeaponState` (3 = airblast), plus a `CTFFlameManager` entity with `m_bIsFiring` and a
     flame bounding box per tick.
5. **Engineer buildings are complete:** level, health, construction %, ammo, enemy, wrangler, sapper and pose-parameter
   aim. Objectives are complete too: the full `CTFObjectiveResource` arrays, `CTeamRoundTimer` (two KOTH timers via
   `m_hRed/BlueKothTimer`), `CTFGameRulesProxy` (round state, stopwatch, overtime), `CTeamTrainWatcher`
   (`m_flTotalProgress`) and the cart `CFuncTrackTrain` plus `CPhysicsProp bomb_cart.mdl`.
6. **Blockers and gaps.**
   - **Server-only game events never reach STV:** `player_builtobject`, `player_carryobject`, `player_dropobject`,
     `player_extinguished`, `player_ignited`, `payload_pushed` and `escort_*`. They are fired with
     `FireEvent(event, true)` in the SDK and must be derived from entity state.
   - Viewmodel sequence numbers index arms models we don't have, so there are no activity names. Use parities and the
     anim/fire signals instead (§5).
   - Sentry aim pose parameters are normalized 0..1 and need model ranges.
   - CP capture progress (`m_flLazyCapPerc`) updates only about every 3 s and must be simulated between updates.
   - Library pitfalls (§15): `PacketEntity::props()` dedupes by identifier and drops repeated UtlVector elements;
     temp entities are not delta-merged; `GameStateAnalyser` has several decoding bugs.

   None of these blocks a Highlander viewer.
7. **Performance.** Native release parse of 1438891.dem (49.6 MB, 817 s) with `GameStateAnalyser` takes **0.57 s**.
   Peak RSS is 60.6 MB, of which 51.7 MB is the file buffer. The lib.rs-style `DemoHandler` loop with both analysers
   takes 0.56 s. The full probe (all entities, all props, logs) takes 1.8–1.9 s with 169 MB peak.

---

## 0. Stream facts and decoding rules (apply everywhere)

### 0.1 Ticks and time
- There is one `PacketEntities` per server tick (gap 1 for 99.99 % of messages; a handful of gaps of 2–6), so
  the effective `tv_snapshotrate` is 66.
- `server_tick = demo_tick + tickBase`, and the offset is constant within a demo:
  - 1434434: 7 237
  - 1438891: 6 634
  - 1440442: 186 060
- Entity messages start at demo tick 1. **Signon packets carry a bogus demo tick** (87 731, 88 847 and 60 501), which
  shows up in `handle_packet_meta`. Ignore it for ranges; lib.rs is unaffected because it keys on server ticks.
- **Every time-valued prop is server `curtime` = server_tick × 0.015.** Verified:
  - Sniper `m_flFOVTime = 160.155` arrives at demo tick 3440 (server 10677 × 0.015 = 160.155).
  - The same applies to `m_flInvisChangeCompleteTime`, `m_flChargeStartTime`, `m_flTimerEndTime`,
    `m_flNextRespawnWave`, `m_flRechargeTime`, `m_flLastFireTime` and `m_flStealthNextChangeTime`.
  - The extras must convert these with the same tickBase lib.rs uses: `internal_tick = server_tick - start_server_tick`.
- `DT_BaseEntity.m_flSimulationTime` and `m_flAnimTime` are 8-bit tick-modulo counters. They are noise; ignore them.

### 0.2 Handles
EHANDLE props are 21-bit: `index = v & 0x7FF`, `serial = v >> 11`, and `0x1FFFFF` (2097151) means null. The serial
matches the 10-bit serial of the entity's `Enter`. Entity indices are reused all the time (weapons, projectiles, round
restarts), so key every entity by (index, serial).

### 0.3 Leave and dormancy
`UpdateType::Leave` (PVS leave) happens even with `tv_transmitall`. Entities that set `EF_NODRAW` become
`FL_EDICT_DONTSEND` and go dormant on the client. A re-`Enter` with the **same serial** is the same entity coming
back. Examples:
- taken medkits and ammo packs (until respawn)
- carried buildings
- hidden `func_brush` entities
- dead players' viewmodels
- exploding pipes and stickies and landed crossbow bolts, which get `EF_NODRAW` (a Leave with no re-Enter) a few
  ticks before their Delete. Hide the projectile at the Leave.

lib.rs and `GameStateAnalyser` treat Enter and Leave naively. The extras must model "visible intervals".

### 0.4 Temp entities need delta merging (the parser does not do it)
In `svc_TempEntities`, an event whose class-id bit is 0 is a **delta against the previous event in the same
message**: absent props keep the previous values. A full event is a **delta against zero**: absent props are 0.
Evidence:
- 904 / 6 265 / 3 322 `TEPlayerAnimEvent` events carry no props at all; they are repeats of the previous event.
- `TEFireBullets.m_iWeaponID` is explicitly sent in only 4 852 of 5 001 events, yet after merging every event has a
  sensible weapon.

`EventInfo` doesn't expose the bit. Treat "same `class_id` as the previous event in the same message" as a delta;
that matches the engine, which always deltas consecutive same-class events.

### 0.5 Duplicated identifiers
`SendPropIdentifier = hash(owner table, prop name)`. UtlVector-of-datatable props repeat the same identifier for
every element:
- `DT_TFPlayerConditionSource.m_pProvider` ×131 (one per cond)
- `DT_ScriptCreatedAttribute.*` ×20 (item attributes)
- `DT_TFPlayerScoringDataExclusive.*` ×2 (`m_ScoreData` and `m_RoundScoreData`)

Tell them apart by `SendProp.index` (flattened index). The k-th occurrence in flattened order is element k; the probe
names them `prop[k]`. **`PacketEntity::props()` dedupes Enter plus baseline by identifier and silently drops elements
1..N** (same for `BaselineEntity::apply_update`). Merge own and baseline props by `index` instead (the probe does).

### 0.6 String-table-relative indices
`m_nModelIndex` resolves through `modelprecache`; brush models are `*N`. Other indices are per-demo string-table
positions and differ between demos (for example `Tracer` is EffectDispatch #4 in one demo and #3 in another), so
always resolve them through that demo's tables:
- `m_iParticleSystemIndex` and EffectDispatch `ParticleEffect`'s `m_nHitBox` → `ParticleEffectNames`
- `m_iEffectName` → `EffectDispatch`

### 0.7 HLTV visibility
User messages sent to specific players (for example `PlayerIgnited`) are absent; only broadcast ones exist (44–137
per demo). The fork's `UserMessageType` id table looks stale, so don't rely on it.

---

## 1. Server classes

The `kind` column groups classes the way the probe does. Counts are instances, with max simultaneously alive in
brackets, as vigil | product | steel. "-" means not instantiated.

| class | vigil | product | steel | notes |
|---|---|---|---|---|
| CTFPlayer | 19 (19) | 19 | 19 | ~60 deltas per player-second |
| CTFViewModel | 36 (36) | 36 | 36 | 2 per player, leave/re-enter on death |
| CTFPlayerResource / CTFTeam ×4 / CTFGameRulesProxy / CTFObjectiveResource / CMonsterResource | 1 each | 1 each | 1 each | |
| CTeamRoundTimer | 3 | 6 (2 alive: KOTH red/blue) | 5 (3) | |
| CTeamTrainWatcher / CFuncTrackTrain | 2 / 2 | – / 3 (static scenery train) | – | |
| CObjectCartDispenser | 2 | – | – | parented to train |
| CPhysicsProp | 2 (bomb_cart.mdl) | 5 | 2 | |
| CObjectSentrygun / Dispenser / Teleporter / Sapper | 6/3/6/– | 29/12/15/13 | 20/6/22/12 | |
| CSniperDot / CLaserDot (wrangler) | 61 / 7 | 249 / 10 | 159 / 26 | |
| CTFFlameManager | 60 | 333 | 260 | |
| projectiles | Rocket 86, Pipebomb 140, Flare 68, Arrow 15, HealingBolt 15, SentryRocket 14, Ball_Ornament 18 | 424, 624, 244, 67, 141, 6, 85 | 319, 494, 200, 70, 93, 47, 41, EnergyRing 8 | |
| CTFRagdoll | 46 | 227 | 169 | |
| CTFDroppedWeapon | 47 | 222 | 156 | |
| CTFAmmoPack (dropped packs **and building gibs**) | 79 | 386 | 298 | |
| CBaseAnimating (medkits/ammo/plates/cappoint hologram) | 96 | 39 | 132 | |
| CBaseDoor | 37 | 12 | 111 | |
| CFuncRotating | – | – | 6 | |
| CBaseEntity (func_brush etc.) | 109 | 165 | 723 | |
| CDynamicProp | 114 | 51 | 162 | |
| CSceneEntity (VCD voice/taunt scenes) | 1 328 | 5 479 | 4 435 | |
| CTFWearable | 160 | 437 | 321 | |
| CTFWearableVM | 3 | 1 | 4 | |
| CTFTauntProp | 1 | 1 | – | |
| CVGuiScreen, CBeam, CSprite, CSpriteTrail, CLightGlow, CRopeKeyframe, CParticleSystem, CFunc_LOD, CFuncOccluder, CFuncRespawnRoomVisualizer, CFuncAreaPortalWindow, CEnvTonemapController, CFogController, CShadowControl, CSun, CWaterLODControl, CFunc_Dust, CFuncSmokeVolume, CVoteController, CMannVsMachineStats, CTFPowerupBottle, CWorld | | | | |

Weapon classes seen: CTFRocketLauncher, CTFGrenadeLauncher, CTFPipebombLauncher, CTFScatterGun, CTFPistol(_Scout,
_ScoutSecondary), CTFShotgun(_Revenge, BuildingRescue), CTFMinigun, CTFFlameThrower, CTFFlareGun, CTFSniperRifle,
CTFSniperRifleDecap, CTFChargedSMG, CTFSMG, CTFCompoundBow, CTFCrossbow, CWeaponMedigun, CTFKnife, CTFRevolver,
CTFWeaponInvis, CTFWeaponPDA_Spy, CTFWeaponBuilder, CTFWeaponPDA_Engineer_Build/_Destroy, CTFWrench, CTFRobotArm,
CTFLaserPointer, CTFDRGPomson, CTFBat(_Giftwrap), CTFBottle, CTFShovel, CTFFireAxe, CTFFists, CTFClub, CTFKatana,
CTFSword, CTFBonesaw, CTFLunchBox(_Drink), CTFBuffItem and CTFSpellBook.

Not instantiated in any of the three (271 classes) but relevant: CTFStunBall, CTFProjectile_Jar, JarMilk, Cleaver,
Arrow from the Huntsman (only one arrow seen), CTFProjectile_EnergyBall, CCaptureFlag and CTeamControlPoint (control
points are only in the objective resource).

Per-class "props that change" with value distributions are in §2 of each report. The important ones are summarized
below.

---

## 2. Players (`CTFPlayer`, table `DT_TFPlayer`)

### 2.1 Conditions
| prop | definition | notes |
|---|---|---|
| `DT_TFPlayerShared.m_nPlayerCond` | int varint unsigned | cond 0–31 = bit i |
| `DT_TFPlayerShared.m_nPlayerCondEx` | varint | cond 32–63 |
| `…m_nPlayerCondEx2` | varint | 64–95 |
| `…m_nPlayerCondEx3` | varint | 96–127 |
| `…m_nPlayerCondEx4` | varint | 128–130; present but never changed |
| `DT_TFPlayerConditionListExclusive._condition_bits` | int 32b unsigned | **separate "condition list" system; in practice only cond 11 CRITBOOSTED** (bit 11, value 2048). The SDK only registers `TF_COND_CRITBOOSTED` there (`tf_condition.cpp`). Effective crit = `m_nPlayerCond` bit 11 OR `_condition_bits` bit 11. |
| `DT_TFPlayerConditionSource.m_pProvider[k]` (UtlVector, k = cond) | EHANDLE | who applied cond k. Observed: [5] INVULNERABLE → medic, [21] HEALTH_BUFF → healer, [22] BURNING → pyro, [4] STEALTHED → self, [118] HEALING_DEBUFF, [25] BLEEDING. Needs flattened-index decoding (§0.5). |

Cadence: a cond word is re-sent only when it changes (1 329 / 4 740 / 4 156 changes of `m_nPlayerCond`).

Conds seen across the three demos (onsets, vigil / product / steel):

| cond | name | onsets | notes |
|---|---|---|---|
| 0 | AIMING | 80 / 440 / 269 | sniper scoped + heavy revved |
| 1 | ZOOMED | 61 / 249 / 159 | sniper only |
| 2 | DISGUISING | 22 / 155 / 111 | ≈1.4–1.5 s on average, min 3 ticks |
| 3 | DISGUISED | 14 / 83 / 62 | |
| 4 | STEALTHED | 10 / 51 / 31 | |
| 5 | INVULNERABLE | 18 / 58 / 34 | provider `m_pProvider[5]` = medic |
| 6 | TELEPORTED | 8 / 67 / 29 | ≈12 s glow after teleport |
| 7 | TAUNTING | 10 / 15 / 35 | |
| 8 | INVULNERABLE_WEARINGOFF | 18 / 85 / 39 | ≈1 s |
| 9 | STEALTHED_BLINK | 4 / 9 / 9 | cloaked spy bumped or shot |
| 10 | SELECTED_TO_TELEPORT | 8 / 67 / 29 | standing on a teleporter entrance |
| 11 | CRITBOOSTED | 2 / 7 / 48 | via `_condition_bits` (Frontier Justice revenge crits; Kritzkrieg in steel) |
| 13 | FEIGN_DEATH | 3 / 24 / 22 | Dead Ringer |
| 14 | PHASE | – / – / 9 | Bonk! |
| 15 | STUNNED | – / – / 6 | after Bonk! |
| 21 | HEALTH_BUFF | 409 / 1 156 / 1 158 | being healed; provider [21] = healer |
| 22 | BURNING | 35 / 120 / 105 | provider [22] = pyro |
| 23 | HEALTH_OVERHEALED | 87 / 296 / 310 | |
| 25 | BLEEDING | 1 / 17 / 10 | |
| 26 | DEFENSEBUFF | – / – / 14 | Battalion's Backup |
| 32 | SPEED_BOOST | 86 / 152 / 164 | |
| 38 | CRITBOOSTED_BONUS_TIME | 9 / 12 / 14 | round-win humiliation, ≈1001 ticks |
| 47 | DISGUISE_WEARINGOFF | 13 / 93 / 64 | ≈0.5 s after undisguise |
| 48 | MARKEDFORDEATH_SILENT | 2 / 4 / 11 | engineers only |
| 51 | INVULNERABLE_HIDE_UNLESS_DAMAGED | 12 / – / 1 | spawn or round-end protection |
| 69 | FIRE_IMMUNE | 1 / 10 / 3 | spy |
| 81 | BLASTJUMPING | 42 / 219 / 123 | mostly soldiers |
| 102 | AFTERBURN_IMMUNE | 4 / 34 / 25 | spy |
| 115 | KNOCKED_INTO_AIR | 1 / 26 / 30 | airblasted |
| 118 | HEALING_DEBUFF | 15 / 72 / 52 | |
| 126 | LOST_FOOTING | 1 / 27 / 32 | airblasted |
| 127 | AIR_CURRENT | 1 / 26 / 30 | airblasted |

The full table with durations, classes and players is in report §4. Names come from `tf_shareddefs.h` `ETFCond`.

### 2.2 Spy
| prop | definition | semantics / observed |
|---|---|---|
| `DT_TFPlayerShared.m_flCloakMeter` | float NOSCALE | 0..100. Sent **every tick while it changes** (gap histogram: 1 tick ×7 334, 2 ×546). It drains while cloaked and regenerates after: ≈0.107 per tick (≈7 /s) drain and ≈0.05 per tick regen in the sample. Only spies change it; the value at creation is 100 for everyone. |
| `DT_TFPlayerShared.m_flInvisChangeCompleteTime` | float NOSCALE (server time) | Set on cloak and decloak onset. The fade ends at this time. Measured: cloak onset 243.81 → 244.855 (+1.045 s); decloak 250.185 → 252.23 (+2.045 s). Render alpha = fade between onset tick and this time; combine with cond 4 (STEALTHED) and cond 9 (STEALTHED_BLINK, bumping). |
| `DT_TFPlayerShared.m_nDisguiseTeam` / `m_nDisguiseClass` | int 3b / 4b unsigned | 0 when not disguised. Set when DISGUISED starts, together with `m_hDisguiseTarget` (EHANDLE of the impersonated player), `m_iDisguiseHealth` (varint, 0..185 seen), `m_hDisguiseWeapon` (EHANDLE of a weapon entity spawned for the disguise, for example `CTFScatterGun[def 200]`) and `m_iDisguiseBody` (bodygroup). |
| `DT_TFPlayerShared.m_nMaskClass` | int 4b | changes in product and steel (73 / 18) |
| `DT_TFPlayerSharedLocal.m_nDesiredDisguiseTeam/Class` | local | what is being disguised as during DISGUISING (cond 2, ≈1.5 s) |
| `DT_TFPlayerSharedLocal.m_flStealthNoAttackExpire`, `m_flStealthNextChangeTime` | local, server time | |
| `DT_TFPlayerShared.m_bFeignDeathReady` | bool | Dead Ringer out; cond 13 FEIGN_DEATH on fake death |
| `DT_TFPlayerShared.m_nDisguiseSkinOverride`, `m_flSpyTranqBuffDuration` | | present, never changed |

Sample, spy "Pooper", vigil:

```
8935 +134.01s m_hActiveWeapon = CTFKnife[def 461]; m_flInvisChangeCompleteTime = 242.78
9017 +135.24s cond +STEALTHED ; m_flInvisChangeCompleteTime = 244.855 ; m_flStealthNextChangeTime = 244.355
9018          m_flCloakMeter = 99.89 ... (1 change/tick) ... 9440 m_flCloakMeter = 54.68
9034 +135.49s m_hActiveWeapon = CTFWeaponPDA_Spy[def 27]   (disguise kit)
9044 +135.65s cond +DISGUISING ; m_nDesiredDisguiseTeam = 3 ; active -> CTFKnife
9178 +137.65s cond -DISGUISING +DISGUISED ; m_hDisguiseTarget = #2 (kanon) ; m_hDisguiseWeapon = CTFScatterGun[def 200]
              m_iDisguiseBody = 3 ; m_iDisguiseHealth = 125 ; m_nDisguiseClass = 1 (scout) ; m_nDisguiseTeam = 3
9442 +141.61s cond -STEALTHED ; m_flInvisChangeCompleteTime = 252.23 ; then cloak regenerates 54.96, 55.60, ...
```

### 2.3 Sniper and zoom
| prop | definition | semantics |
|---|---|---|
| `DT_BasePlayer.m_iFOV` | int 8b unsigned | 0 = default, 20 = scoped (61 / 249 zoom onsets) |
| `m_iFOVStart` | int 8b | |
| `m_flFOVTime` | float (server time) | zoom transition start |
| `DT_Local.m_flFOVRate` | float | 0.1 or 0.5 |
| `DT_BasePlayer.m_hZoomOwner` | EHANDLE | the player itself while zoomed |
| `m_iDefaultFOV` | int 8b | static 90 (75 for the SourceTV bot) |
| `DT_SniperRifleLocalData.m_flChargedDamage` (weapon) | float NOSCALE, CHANGES_OFTEN | 0..150, +0.75 per tick (50/s, `TF_WEAPON_SNIPERRIFLE_CHARGE_PER_SEC`). Sent every tick while charging and reset on each shot. Machina (`CTFSniperRifleDecap`, def 402) has the same prop. |
| cond 0 AIMING + cond 1 ZOOMED | | set on the zoom tick |
| `CSniperDot` (§6) | | created on the zoom tick, deleted on unzoom |

Sample, vigil sniper ent 10:

```
3440 +51.58s cond +AIMING +ZOOMED ; m_iFOV = 20 ; m_iFOVStart = 90 ; m_flFOVTime = 160.155 ; m_hZoomOwner = #10
             CSniperDot ent 774 CREATED chargeStart = 160.155 origin (1148.4,-639.0,-490.4)
3460 +51.88s m_flChargedDamage = 0.75 ... 3655 = 147 (then 150) ...
5304 +79.54s CSniperDot ent 774 DELETED (1864 ticks, 298 origin updates)
```

### 2.4 Weapons held, healers, taunts and misc
- **Active weapon.** `DT_BaseCombatCharacter.m_hActiveWeapon` (EHANDLE). It changes 892 / 5 844 / 3 805 times and
  every non-null value resolved to a live weapon entity (0 unresolved in all three demos).
- **Owned weapons.** `m_hMyWeapons.000`..`.047` (table `m_hMyWeapons`) lists the owned weapons, slot order
  primary/secondary/melee/… (spy: revolver, knife, builder (sapper), PDA, invis watch, spellbook). It changes only on
  spawn or resupply. `GameStateAnalyser` reads only 000–002.
- **Previous weapons.** `DT_LocalPlayerExclusive.m_hLastWeapon` and `DT_TFPlayer.m_hSecondaryLastWeapon` hold the
  previous weapons.
- **Healers.** `DT_TFPlayerShared.m_nNumHealers` (5b) is the number of medics or dispensers healing; values seen 0..2.
  `m_pProvider[21]` gives the healer.
- **Taunts.**
  - Cond 7 TAUNTING.
  - `DT_TFPlayerShared.m_iTauntIndex` (8b) and `m_iTauntConcept` (8b).
  - `DT_TFPlayer.m_iTauntItemDefIndex` (16b, -1 = none, for example 1183) and `m_nActiveTauntSlot`.
  - `m_flTauntYaw` (float, the yaw locked during the taunt).
  - `m_bAllowMoveDuringTaunt`, `m_flCurrentTauntMoveSpeed`, `m_unTauntSourceItemID_Low/High`.
  - A `CTFTauntProp` entity holds the prop model (for example `models/player/items/taunts/yeti/yeti.mdl`).
  - `CSceneEntity` entities carry the VCD scenes (`m_bIsPlayingBack`).
- **Engineer carry.** `DT_TFPlayerShared.m_bCarryingObject` and `m_hCarriedObject` (the building handle); see §7.
- **Ammo and clips.**
  - `m_iAmmo.001`..`.005`: ammo by `TF_AMMO_*` index (1 primary, 2 secondary, **3 metal**, 4/5 grenades/action).
  - `DT_TFSendHealersDataTable.m_nActiveWpnClip` is the clip of the active weapon.
  - `m_flItemChargeMeter.NNN` holds per-slot recharge meters (0..100).
- **Medic.** `DT_TFPlayerSharedLocal.m_flRageMeter`.
- **Movement and pose.**
  - `DT_LocalPlayerExclusive.m_vecVelocity[0..2]` (float NOSCALE, every tick).
  - `DT_TFLocalPlayerExclusive.m_vecOrigin` (vectorXY NOSCALE, full precision), alongside the non-local
    `COORD_MP_LOWPRECISION` (1/8 u) origin that lib.rs uses.
  - `m_vecViewOffset[2]` (eye height: 75/68/65, 45 ducked).
  - `DT_Local.m_bDucked`, `m_bDucking`, `m_flDucktime`, `m_flFallVelocity`, `m_vecPunchAngle(Vel)` (view punch).
  - `DT_BasePlayer.m_fFlags`, `DT_LocalPlayerExclusive.m_hGroundEntity`.
  - `DT_TFPlayerShared.m_bJumping`, `m_iAirDash` (scout double-jump count), `m_nAirDucked`.
  - `m_iCritMult` (0..223, crit-meter-ish), `m_iRevengeCrits`.
- **Spawn, death and spectating.**
  - `DT_TFPlayer.m_hRagdoll`, `DT_LocalPlayerExclusive.m_flDeathTime`, `DT_TFPlayer.m_iSpawnCounter`.
  - `m_nPlayerState` (0 active, 2 observer, 3 dying).
  - `m_iObserverMode` and `m_hObserverTarget` (whom the dead player spectates).
  - `DT_TFPlayer.m_bSaveMeParity` (MEDIC! call), `m_flHelpmeButtonPressTime`, `m_flInspectTime`.
- **Scoreboard (per player, live).** `DT_TFPlayerScoringDataExclusive.{m_iKills, m_iDeaths, m_iDamageDone,
  m_iHealPoints, m_iCaptures, m_iDefenses, m_iBackstabs, m_iHeadshots, m_iInvulns, m_iTeleports,
  m_iBuildingsBuilt/Destroyed, m_iPoints, …}[0|1]` ([0] = `m_ScoreData`, [1] = `m_RoundScoreData`; the order needs
  confirming). `CTFPlayerResource` arrays add `m_iTotalScore`, `m_iDamage`, `m_iHealing`, `m_iMaxBuffedHealth`,
  `m_flNextRespawnTime` (respawn timers), `m_iChargeLevel`, `m_bAlive`, `m_iPlayerClassWhenKilled` and
  `m_iActiveDominations`.

**`GameStateAnalyser` covers:** position, angles, health, max health, life state, flags, class and team (from the
player resource), weapons[0..2], the raw cond bytes (buggy), spy `cloak` / `disguise_team` / `disguise_class`
(applied only while `class_data` is Spy) and the medic charge (integer % from the player resource). It covers none of
FOV, invis time, disguise target, healers or taunts.

---

## 3. Weapons

- **Identity.** `DT_ScriptCreatedItem.m_iItemDefinitionIndex` (int 20b unsigned, set at creation, the full path is
  `DT_EconEntity → DT_AttributeContainer (m_AttributeManager) → DT_ScriptCreatedItem (m_Item)`). Also
  `DT_BaseCombatWeapon.m_hOwner` (EHANDLE, set at creation, always equal to `DT_BaseEntity.m_hOwnerEntity`) and
  `m_iWorldModelIndex` / `m_iViewModelIndex` (model indices).
  - Weapon entities are often re-created on respawn: 140 CTFKnife and 126 CTFRevolver instances in product.
    Resolve per tick via `m_hActiveWeapon` → (index, serial).
  - Item defs seen include 35 (Kritzkrieg, 15 instances in steel), 29/211 (Medi Gun), 424 (Tomislav), 513 (The
    Original), 1151 (Iron Bomber), 997 (Rescue Ranger), 305 (Crusader's Crossbow) and 59 (Dead Ringer). The full
    per-class lists are in report §5.
  - Map def → name and slot from `items_game.txt` (allowed metadata).
  - **Item attributes are networked** in two UtlVector lists of `DT_ScriptCreatedAttribute.{m_iAttributeDefinitionIndex,
    m_iRawValue32}`: elements [0..19] and [20..39], the second list being `m_NetworkedDynamicAttributesForDemos`.
    Lengths are `_LPT_m_Attributes_20.lengthprop20[0|1]`. For example, the steel Kritzkrieg instances carry attr 18
    (medigun charge is crit boost) and attr 10 at [20..21]; strange weapons carry kill-eater and killstreak attributes.
    They need flattened-index decoding (§0.5).
- **`DT_BaseCombatWeapon.m_iState`** (8b): 0 = not carried, 1 = carried/holstered, 2 = active. Paired with
  `DT_BaseEntity.m_fEffects` 161 (`EF_BONEMERGE|EF_NODRAW|EF_BONEMERGE_FASTCULL`, holstered) vs 129 (drawn).
- **Shot signal** (see §5 and the TL;DR). `DT_LocalTFWeaponData.m_flLastFireTime` (float, server time of the last
  shot) and `DT_BaseAnimating.m_nMuzzleFlashParity` (2b) change once per shot for every gun. The minigun and medigun
  don't use muzzle parity, but the minigun's `m_flLastFireTime` still ticks per bullet batch: 3 830 changes = 3 830
  TEFireBullets. Melee swings don't touch `m_flLastFireTime`; use `TEPlayerAnimEvent`.
  - Other per-shot or reload props: `DT_LocalWeaponData.m_iClip1` (clip), `DT_TFWeaponBase.m_iConsecutiveShots`,
    `m_iReloadMode` (`TF_RELOAD_START` = 0, which is also the idle value; 1 reloading; 2 continue; 3 finish), `DT_LocalActiveWeaponData.m_flNextPrimaryAttack/
    m_flNextSecondaryAttack/m_flTimeWeaponIdle`, `m_flReloadPriorNextFire`, `m_bResetParity`, `m_bLowered`
    (rarely), and `m_nInspectStage` / `m_flInspectAnimEndTime` (inspect).
- **Flamethrower.** `DT_WeaponFlameThrower.m_iWeaponState` (4b, CHANGES_OFTEN): 0 IDLE, 1 STARTFIRING, 2 FIRING,
  **3 SECONDARY (airblast)**. It changed 337 / 2 053 / 1 493 times. Also `m_bHitTarget`, `m_bCritFire` (crits) and
  `m_flChargeBeginTime`. See §11 for `CTFFlameManager`.

  Sample:
  ```
  67 m_iWeaponState=1 · 79 =2 · 146 m_bHitTarget=1 · 174 m_iWeaponState=0, m_iState=1 (switched away)
  ```
- **Minigun.** `DT_WeaponMinigun.m_iWeaponState` (4b): 0 IDLE, 1 STARTFIRING (spin-up), 2 FIRING, 3 SPINNING (revved,
  not firing), 4 DRYFIRE. It changed 148 / 1 078 / 852 times. Also `m_bCritShot`. Cond 0 AIMING is set while revved.
- **Medigun (`CWeaponMedigun`).**
  - `DT_LocalTFWeaponMedigunData.m_flChargeLevel` **and** `DT_TFWeaponMedigunDataNonLocal.m_flChargeLevel` (both
    float NOSCALE 0..1, identical, every tick while it changes: 9 217 / 52 123 / 40 871). This is more precise than
    the integer % lib.rs takes from `CTFPlayerResource.m_iChargeLevel`.
  - `DT_WeaponMedigun.m_bChargeRelease` (deploy, 7 / 23 / 30) and `m_hHealingTarget` (EHANDLE, null when not healing).
  - `m_bHealing`, `m_bAttacking` (M1 held), `m_bHolstered`, `m_hLastHealingTarget`, `m_nChargeResistType`
    (vaccinator, unchanged here).
  - Read the medigun type from the item def (35 Kritzkrieg, 411 Quick-Fix, 998 Vaccinator) or from the networked
    attributes (attr 18 on the Kritzkrieg).
- **Bow and stickies.** `DT_PipebombLauncherLocalData.m_flChargeBeginTime` (local, server time; 0 = not charging) and
  `m_iPipebombCount`. The CompoundBow (def 56) is used in product only briefly.
- **Knife.** `DT_TFWeaponKnife.m_bReadyToBackstab`, `m_bKnifeExists` / `m_flKnifeMeltTimestamp` /
  `m_flKnifeRegenerateDuration` (Spy-cicle).
- **Engineer builder.** `DT_TFWeaponBuilder.m_iBuildState` (0 idle, 2 placing, 3 placing-invalid),
  `DT_BuilderLocalData.m_hObjectBeingBuilt` and `m_iObjectType` (0 dispenser, 1 teleporter, 2 sentry, 3 sapper), and
  `m_iObjectMode` (teleporter entrance/exit). This is the only way to show blueprints: blueprint objects are not
  networked to STV.
- **Others.** `DT_WeaponChargedSMG.m_flMinicritCharge`, `DT_WeaponLunchBox.m_bBroken`, `DT_TFDroppedWeapon.m_flChargeLevel`
  (dropped medigun with uber).

**`GameStateAnalyser` covers** only the medigun (type at Enter from attributes, healing target). Everything else is
new.

---

## 4. `TEFireBullets` and `TEPlayerAnimEvent` as player animation inputs

Detailed in §12. Summary:
- `TEPlayerAnimEvent` (`m_hPlayer` EHANDLE, `m_iEvent` 6b `PlayerAnimEvent_t`, `m_nData` 12b) arrives for every
  player: 9 356 / 50 239 / 28 804 events.
  - Event meanings: `ATTACK_PRIMARY` on every attack (the minigun sends it about every tick while firing),
    `ATTACK_SECONDARY` (pyro airblast, scout alt), `ATTACK_PRE` / `ATTACK_POST` (medigun beam on/off, pyro
    flame start/stop, minigun spin), `RELOAD` / `RELOAD_LOOP` / `RELOAD_END`, `JUMP`, `DOUBLEJUMP(_CROUCH)`,
    `FLINCH_*` (hit reactions), `SPAWN`, `VOICE_COMMAND_GESTURE`, `CUSTOM_GESTURE`, `ATTACK_GRENADE`.
  - `m_nData` is non-zero only for gestures (1502 etc. are activity or sequence ids).
- `TEFireBullets` covers every hitscan shot; see §12.

---

## 5. Viewmodels (`CTFViewModel`, `DT_TFViewModel` → `DT_BaseViewModel`, 14 props)

- **Coverage.** Every player has two viewmodels, `m_nViewModelIndex` 0 and 1. vm 1 is used by spies for the watch
  (`v_watch_*_spy.mdl`) and is otherwise model 0 / `EF_NODRAW`. `CBaseViewModel::ShouldTransmit` returns
  `FL_EDICT_PVSCHECK` for HLTV, and HLTV doesn't cull against PVS. A viewmodel leaves PVS (dormant) while its owner is
  dead: 5 / 29 / 10 leave/re-enter cycles.
- **Props.** None carry origin or angles; the client places the viewmodel at the owner's eye.
  - `m_nModelIndex` (13b): class arms `c_<class>_arms.mdl`, gunslinger arms, `v_pda_spy.mdl` and the watches.
    Changes with weapon (446 changes in product).
  - `m_hWeapon` (EHANDLE of the drawn weapon).
  - `m_hOwner` (static).
  - `m_nSequence` (8b): index into the **arms** model (0..73). 3 622 / 17 167 / 13 851 changes.
  - `m_nAnimationParity` = `m_nNewSequenceParity` = `m_nResetEventsParity` (3b each, all identical): increments
    whenever a viewmodel sequence is (re)started, even with the same sequence. 10 384 / 42 440 / 31 410 changes.
  - `m_nMuzzleFlashParity` (2b): +1 per shot (§3).
  - `m_flPlaybackRate` (8b [-3.94..12]).
  - `m_fEffects` (32 = `EF_NODRAW` toggles on vm1).
  - `m_flPoseParameter` (array[24], static 0).
- **Cycle.** There is no `m_flCycle`. Animation time is "ticks since the last parity change × playback rate" (seek-safe).
- **Sequence semantics need the models.** Statistically some (arms model, sequence) pairs are always shots: within
  ±3 ticks of a projectile spawn, a TEFireBullets or `ATTACK_PRIMARY`, 100 % of the time. Examples from product:

  | arms model | sequence | starts | meaning |
  |---|---|---|---|
  | `c_heavy_arms` | 21 | 3 829 | fire |
  | `c_heavy_arms` | 25 | 17 443 | revved loop |
  | `c_soldier_arms` | 44 | 421 | rocket launcher fire |
  | `c_demo_arms` | 18 | 422 | grenade launcher fire |
  | `c_demo_arms` | 26 | 203 | |
  | `c_scout_arms` | 27 | 455 | |
  | `c_scout_arms` | 19 | 170 | |
  | `c_pyro_arms` | 9 | 247 | |
  | `c_spy_arms` | 4 | 173 | |
  | `c_sniper_arms` | 29 | 168 | |
  | `c_engineer_arms` | 37 / 38 | | |
  | gunslinger | 22 / 4 | | |
  | `c_medic_arms` | 9 | | |

  The full table is in report §6. An empirical sequence → {fire, reload, draw, idle} table could be built from
  demos, but a placeholder viewmodel does not need it.
- **Recommended placeholder driver**, all seek-deterministic:
  - weapon: `m_hWeapon` → item def / weapon class → placeholder mesh
  - draw: `m_hWeapon` change (or `m_iState` → 2)
  - fire: `m_nMuzzleFlashParity` change or `m_flLastFireTime` change, minigun `m_iWeaponState == 2`, flamethrower
    `m_iWeaponState ∈ {1,2}` / 3 airblast, melee `ATTACK_PRIMARY`
  - reload: `m_iReloadMode`, or `RELOAD*` anim events
  - generic restart kick: `m_nAnimationParity` change
  - inspect: `m_nInspectStage`

**Soldier sample** (vigil, "Dwapking", vm 867; window +75.6 s..+81.0 s, 4 rockets):

```
5072 +76.06s ROCKET spawn ent 1006 | vm867 m_nSequence=44 m_nAnimationParity=0 m_nMuzzleFlashParity=0 | TEPlayerAnimEvent ATTACK_PRIMARY
5125 +76.86s vm867 m_nSequence=46 parity=1                       (post-fire / idle)
5143 +77.13s ROCKET spawn ent 836  | vm867 m_nSequence=44 parity=2 muzzle=1 | ATTACK_PRIMARY (+ JUMP)
5197 +77.94s vm867 m_nSequence=46 parity=3
5231 +78.45s vm867 m_nSequence=47 parity=4 | TEPlayerAnimEvent RELOAD
5287 +79.29s vm867 parity=5 (same seq restarted) | RELOAD_LOOP
5328 +79.90s ROCKET spawn ent 1023 | vm867 m_nSequence=44 parity=6 muzzle=2 | ATTACK_PRIMARY
5382 +80.71s vm867 m_nSequence=46 parity=7
5384 +80.74s ROCKET spawn ent 60   | vm867 m_nSequence=44 parity=0 muzzle=3 | ATTACK_PRIMARY
over the whole demo: rocket spawn − nearest vm parity change = 0 ticks for 43/43 rockets; same for ATTACK_PRIMARY.
```

Per-player agreement (vigil). Columns: vm0 sequence changes / vm parity changes / vm muzzle changes / weapon
`m_flLastFireTime` changes / weapon muzzle changes / clip rounds used / TEFireBullets / projectiles:

```
scout "kanon"       185 / 269 /   36 /  36 /  36 / 36 /  36 /  6 (ornaments)
heavy               136 / 1827 /   0 / 351 /   0 /  0 / 351 /  0
soldier "Dwapking"  238 / 288 /   43 /  43 /  43 / 43 /   0 / 43
demo "dastron"      204 / 280 /   56 /  56 /  56 / 56 /   0 / 56 (pipes; owner = m_hThrower)
sniper              79 / 151 /   17 /  17 /  17 /  0 /  17 /  0
```

---

## 6. `CSniperDot` (`DT_SniperDot`) and `CLaserDot`

- **Present.** 61 / 249 / 159 instances, at most 2 alive (one per sniper).
- **Lifetime.** Created on the zoom-in tick (owner ZOOMED at creation for 469 of 469 dots) and deleted on zoom-out or
  death. Lifetimes from 6 to 1 864 ticks, median about 77.
- **Props.**
  - `DT_BaseEntity.m_hOwnerEntity` (EHANDLE → the sniper, static).
  - `DT_BaseEntity.m_vecOrigin` (vector COORD_MP, 1/32 u): the dot's world hit point, sent only when it moves
    (298 updates in 1 864 ticks).
  - `DT_SniperDot.m_flChargeStartTime` (float, server time). It equals `m_flFOVTime` at creation and is **reset after
    each shot while scoped** (27 / 151 / 98 changes).
  - `m_iTeamNum`, `m_fEffects 16`, model 0 (the client draws the sprite `effects/sniperdot_<team>.vmt`).
- **Charge.** Charge ≈ `clamp((curtime − m_flChargeStartTime) × 50, 0, 150)`, or read `m_flChargedDamage` directly.
- **`CLaserDot`** (Wrangler): owner = the engineer, origin updated about every tick (≈60/s), and it also has
  `m_flChargeStartTime`.

---

## 7. Buildings (`DT_BaseObject` + class tables)

**Common `DT_BaseObject` props** (all reach STV):

| prop | definition | notes |
|---|---|---|
| `m_iHealth`, `m_iMaxHealth` | varint | max 150/180/216 by level |
| `m_bBuilding` | 1b | |
| `m_flPercentageConstructed` | float 8b [0..1] | updates about every 7 ticks while building, with health climbing |
| `m_iUpgradeLevel`, `m_iHighestUpgradeLevel` | 3b | |
| `m_iUpgradeMetal`, `m_iUpgradeMetalRequired` | 10b | 0..200 |
| `m_bHasSapper` | 1b | |
| `m_bDisabled`, `m_bPlasmaDisable` | | |
| `m_bMiniBuilding` | | gunslinger minis |
| `m_bCarryDeploy` | | 1 while redeploying after a carry |
| `m_bServerOverridePlacement`, `m_iDesiredBuildRotations` | | |
| `m_hBuilder` | EHANDLE | static |
| `m_iObjectType` | | 0 dispenser, 1 teleporter, 2 sentry, 3 sapper |
| `m_iObjectMode` | | teleporter 0 entrance / 1 exit, static |
| `m_hBuiltOnEntity` | | sapper → target building |
| `m_fObjectFlags`, `m_vecBuildMins/Maxs` | | |
| `m_bWasMapPlaced` | | |
| `DT_BaseEntity.m_vecOrigin`, `m_angRotation` | | change only on redeploy |
| `m_nModelIndex` | | `sentry1_heavy.mdl` while building → `sentry1/2/3(.mdl)`, `dispenser_lvl2_light.mdl`, `teleporter_light.mdl` … |

**Never observed:** `m_bCarried` and `m_bPlacing`. A carried building goes **dormant (Leave) and re-enters on
redeploy**: sentries show 3 / 19 / 18 leave/re-enter pairs, each followed by a single new `m_vecOrigin` /
`m_angRotation`. Use the builder's `m_bCarryingObject` and `m_hCarriedObject` plus `m_bCarryDeploy`. Blueprints are
not networked; see `CTFWeaponBuilder` in §3.

**Sentry (`DT_ObjectSentrygun`):**
- `m_iAmmoShells` (varint, 0..200) and `m_iAmmoRockets` (0..20).
- `m_iState`: 0 inactive, 1 searching, 2 attacking, 3 upgrading.
- `m_hEnemy`: current target, players or buildings.
- `m_hAutoAimTarget`.
- `m_bPlayerControlled` (wrangled) and `m_nShieldLevel` (wrangler shield).
- `DT_SentrygunLocalData.m_iKills/m_iAssists`.

**Sentry aim:**
- `m_flPoseParameter.000` (float 8b [0..1], 1 036 / 2 590 / 2 503 changes) is most likely aim_pitch.
- `m_flPoseParameter.001` (4 647 / 17 267 / 13 028 changes, idle scanning) is aim_yaw.
- Both are normalized, so the model's pose ranges are needed. Probably yaw −180..180 and pitch −50..50; a
  placeholder can also just aim at `m_hEnemy`.
- `DT_ServerAnimationData.m_flCycle` and `DT_BaseAnimating.m_nSequence` / `m_flPlaybackRate` carry the
  build/upgrade animation.

**Dispenser (`DT_ObjectDispenser`):** `m_iAmmoMetal` (varint 0..400), `m_iState` (2b: 0 idle, 1 upgrading),
`m_iMiniBombCounter`, and
`"healing_array"` (array[101] of EHANDLE: who is being healed; changes 222 / 627 / 805 times).
`CObjectCartDispenser` (the payload cart's dispenser) uses the same table.

**Teleporter (`DT_ObjectTeleporter`):** `m_iState` (5b: 0 building, 1 idle (no partner), 2 ready, 3 sending,
4 receiving, 5 receiving-release, 6 recharging, 7 upgrading), `m_flRechargeTime` (server time), `m_flCurrentRechargeDuration`, `m_iTimesUsed`, `m_flYawToExit` (8b), and
`m_bMatchBuilding` (bool; it does not identify the other end). Pair entrance and exit by builder plus `m_iObjectMode`.

**Sapper (`CObjectSapper`):** `m_hBuiltOnEntity` → building, `m_hBuilder` → spy, health 100.

**Sample** (product sentry ent 451, BLU, alive +217.05 s..+371.52 s; reached level 3, sapped once, carried twice
(2 leave/re-enter pairs, each with one new origin and angle); 656 non-noise changes):

```
14474 +217.10s m_flPercentageConstructed=0.0118 m_iHealth=2 m_flPlaybackRate=0.5
14481 +217.20s m_flPercentageConstructed=0.0196 m_iHealth=4      (one step every 7 ticks)
15062 +225.91s m_flPercentageConstructed=0.851  m_iHealth=127    (≈10.5 s build at playback 0.5)
15175..       m_flPoseParameter.001 (yaw) changes ×2 450, range 0.306..0.714; .000 (pitch) ×464, range 0.055..1
```

Value distributions across all sentries (report §2): `m_iState` 1 ×31, 2 ×19, 3 ×6, 0 ×3; `m_nModelIndex`
`sentry1.mdl` / `sentry2(_heavy).mdl` / `sentry3.mdl`; `m_iUpgradeLevel` 1→2→3 with `m_iUpgradeMetal` 0/50/100/150;
`m_hEnemy` targets players and buildings.

Game events present for buildings: `object_destroyed` (index = entindex, `was_building`, weapon string, objecttype),
`object_detonated`, `object_removed`, `player_upgradedobject`, `player_sapped_object` (sapperid), `building_healed`
and `npc_hurt` (building damage, 34 / 783 / 694). **Absent (server-only):** `player_builtobject`,
`player_carryobject` and `player_dropobject`.

**`GameStateAnalyser` covers** a subset of buildings, with bugs: `builder` and `healing` are stored as `UserId`
(the raw EHANDLE truncated), the teleporter `other_end` is taken from the `m_bMatchBuilding` bool, and the sentry
`angle` comes from a non-existent table.

---

## 8. Objectives, rules and timers

### 8.1 Payload (pl_vigil)
- **Cart position.** `CFuncTrackTrain` (brush model `*1`, `DT_BaseEntity.m_vecOrigin` COORD_MP plus
  `m_angRotation` 13b) updates every tick while moving: 7 572 origin and 686 angle changes. `GameStateAnalyser`'s
  `Objective::Cart` uses exactly this origin.
- **Visual cart.** It is a separate **`CPhysicsProp` `models/props_trainyard/bomb_cart.mdl`** (ent 40). Its
  world-space origin stays a constant 48 units below the train origin and it has its own `m_angRotation` (691
  changes). It is not parented.
- **Cart dispenser.** `CObjectCartDispenser` is parented via `DT_BaseEntity.moveparent` (note the name: not
  `m_hMoveParent`) to the train, with local offset (−41, −12, 20), and it carries `healing_array`.
- **`CTeamTrainWatcher` (`DT_TeamTrainWatcher`):**
  - `m_flTotalProgress` (float 11b [0..1], 734 changes; for example 0 → 0.4524 in vigil)
  - `m_iTrainSpeedLevel` (4b: −1 receding, 0 stopped, 1..3 cappers)
  - `m_nNumCappers` (0..7), `m_flRecedeTime` (server time), `m_hGlowEnt`
- **Checkpoints.** `CTFObjectiveResource.m_flPathDistance[0..3]` = 0.251, 0.451, 0.7176, 1 gives the HUD checkpoint
  marks on the progress bar.
- **Events.** `teamplay_point_captured` fires on each checkpoint. `escort_progress`, `escort_speed`,
  `escort_recede` and `payload_pushed` are **never sent**.

Sample:

```
5100 +76.49s train (64.03,128,-624)   progress 0        phys cart (64.03,128,-672.03) d=48.03
5497 +82.44s train (465.8,109.9,-624) progress 0.0332   phys cart d=48.03
5762 +86.42s train (511.9,-189.0,-607.5) progress 0.0625 (slope: cart pitch changes)
```

### 8.2 `CTFObjectiveResource` (`DT_TFObjectiveResource` → `DT_BaseTeamObjectiveResource`, 917 flattened props)
- **Static per map:**
  - `m_iNumControlPoints` (vigil 4, product 1, steel 5)
  - `m_vCPPositions` (array[8] of vector COORD_MP)
  - `m_bCPIsVisible[8]`, `m_iCPGroup[8]`, `m_iBaseControlPoints`, `m_bCPCapRateScalesWithPlayers[8]`
  - `m_pszCapLayoutInHUD` ("0 1 2 3 4" in steel), `m_iszWarnSound[8]`, `m_iWarnOnCap[8]`, `m_flPathDistance[8]`
  - `m_bInMiniRound[8]`, `m_bPlayingMiniRounds`, `m_iChallengeIndex`
- **Per team × point** arrays use **index = team × 8 + point** (team 2 RED = 16..23, team 3 BLU = 24..31):
  `m_iTeamIcons`, `m_iTeamOverlays`, `m_iTeamReqCappers`, `m_flTeamCapTime` (seconds to capture with one player,
  for example 32/36/70 in steel), `m_bTeamCanCap`, `m_iNumTeamMembers` (players of that team on the point, live).
- **Per point, live:**
  - `m_iOwner[8]` (team)
  - `m_iCappingTeam[8]`, `m_iTeamInZone[8]`
  - `m_flLazyCapPerc[8]`: **fraction of cap time left**, 1 = untouched, so progress = 1 − value
  - `m_bBlocked[8]`, `m_bCPLocked[8]`, `m_flUnlockTimes[8]`, `m_flCPTimerTimes[8]`
  - `m_iPreviousPoints[192]`, `m_bTrackAlarm`
- **Other:** `m_iStopWatchTimer` (EHANDLE index of the stopwatch timer, 11b), `m_iTimerToShowInHUD`,
  `m_iUpdateCapHudParity` (6b; bumps on every HUD-relevant change: 159 / 557 / 1 099 changes),
  `m_bControlPointsReset`, `m_flCustomPositionX/Y`.
- **Capture progress needs simulation.** `m_flLazyCapPerc` updates only about every 200 ticks or on state changes.
  Steel sample: 0.8478 at +72.1 s, 0.6889 at +75.1 s, 0.5223, 0.3478, 0.1422, then the owner flips at +86.1 s. The
  real client simulates `m_flCapTimeLeft` every frame (`c_team_objectiveresource.cpp ClientThink`: diminishing returns
  per extra capper with `mp_capstyle 1`, decay at `mp_capdeteriorate_time`). For seek-determinism, bake this in the
  parser's forward pass, or linearly interpolate between lazy updates (simplest, within a few %).
- **Events:** `teamplay_point_startcapture` (cp, cappers = byte string of entindices, captime),
  `teamplay_point_captured` (cp, cpname, team, cappers), `teamplay_capture_broken`, `teamplay_capture_blocked`
  (product and steel only), `teamplay_point_locked/unlocked`, `controlpoint_starttouch/endtouch`,
  `killed_capping_player`, `capper_killed`.

### 8.3 `CTeamRoundTimer` (`DT_TeamRoundTimer`, 16 props)
- **Props:** `m_bTimerPaused`, `m_flTimeRemaining` (valid while paused), `m_flTimerEndTime` (server time; while
  running, remaining = end − curtime), `m_nTimerLength`, `m_nTimerMaxLength`, `m_nTimerInitialLength`,
  `m_nSetupTimeLength`, `m_bIsDisabled`, `m_bShowInHUD`, `m_bShowTimeRemaining`, `m_bAutoCountdown`, `m_nState`
  (0 setup, 1 normal), `m_bStartPaused`, `m_bStopWatchTimer`, `m_bInCaptureWatchState`, `m_flTotalTime`.
- **KOTH** (product): **two timers**, ents 473 and 475 (re-created per round: 477/483).
  `CTFGameRulesProxy.m_hBlueKothTimer` / `m_hRedKothTimer` point at them. They alternate `m_bTimerPaused` on every
  capture:
  ```
  3279 +49.2s 473 unpaused end=328.695 · 6242 473 paused remaining=135.555, 475 unpaused end=373.14 ·
  ... 24979 475 paused remaining=-0.195 → round win
  ```
- **Payload and CP:** one timer runs both setup and the round (`CTFObjectiveResource.m_iTimerToShowInHUD` names
  it). In vigil (ent 339) it starts with `m_nState` 0, `m_nSetupTimeLength` 70 and `m_nTimerLength` 70. At setup end
  (+75 s, `teamplay_setup_finished`) it switches to `m_nState` 1 with `m_nTimerLength` 270, then 480 and 660 as caps
  add time (`teamplay_timer_time_added`, new `m_flTimerEndTime`; `m_nTimerMaxLength` 600). A second timer (ent 767,
  `m_bStopWatchTimer` 1, `m_bInCaptureWatchState` 1) appears at setup end; its `m_flTotalTime` records the elapsed
  time at each cap (45.1 s, 150.6 s) for the stopwatch.

### 8.4 `CTFGameRulesProxy` (`DT_TFGameRules` + `DT_TeamplayRoundBasedRules`, 368 props)
- **Round state:** `m_iRoundState` (5b; GR_STATE 3 = PREROUND, 4 = RND_RUNNING, 5 = TEAM_WIN, …), `m_iWinningTeam`,
  `m_nRoundsPlayed`, `m_bInSetup`, `m_bInWaitingForPlayers`, `m_bInOvertime` (product: 1 at +782.7 s; **no
  `teamplay_overtime_begin` event was received**), `m_bAwaitingReadyRestart`, `m_bTeamReady[4]`,
  `m_flRestartRoundTime`, `m_flMapResetTime`, `m_flStateTransitionTime`.
- **Respawn waves:** `m_flNextRespawnWave[team]` (server time, every 4–8 s) and `m_TeamRespawnWaveTimes[team]`.
  These drive the respawn countdown; per-player respawn times are `CTFPlayerResource.m_flNextRespawnTime`.
- **Stopwatch** (steel): `m_bStopWatch` (1 from +5 s until the match ends at +708.9 s), `m_nStopWatchState` (3b: 0 → 1 at +86.1 s after
  the first half's first cap; back to 0 at the end), `m_bStopWatchWinner`, `m_bTeamsSwitched` /
  `m_bSwitchedTeamsThisRound`, plus `CTFObjectiveResource.m_iStopWatchTimer`.
- **Mode:** `m_nGameType` (4b `ETFGameType`: **3 = ESCORT** in vigil, 2 = CP in product (KOTH) and steel),
  `m_bPlayingKoth`, `m_hRed/BlueKothTimer`, `m_pszTeamGoalString{Red,Blue}`
  (for example `#steel_setup_goal_blue`), `m_bMatchEnded`, `m_nMatchGroupType`.

**`GameStateAnalyser` covers** only the `CFuncTrackTrain` origin (`Objective::Cart`). `handle_cp_entity` is a
`todo!()`, and nothing reads the timers or rules.

---

## 9. Movers and visibility toggles

Brush entities with `m_nModelIndex` resolve to `*N` brush models, matching the BSP's `models[N]`.

| class | entities with changes (vigil / product / steel) | what changes |
|---|---|---|
| CBaseDoor (`func_door`, `func_door_rotating`, `func_movelinear`) | 21 / 6 / 71 | `m_vecOrigin` (COORD_MP) every tick while moving (1 608 / 4 709 / 52 621 origin+angle changes). Rotating doors use `m_angRotation`, often **parented** (`moveparent`, local coordinates). Example from steel: ent 331 `*229` slides from y −676 → −252; ents 327/328 rotate, parented to 331. |
| CFuncRotating | – / – / 4 | `m_angRotation` every tick (67 302 changes) |
| CFuncTrackTrain | 1 / 0 / – | the payload train |
| CPhysicsProp / CPhysicsPropMultiplayer | 1 / 5 / 2 + 4 | origin and angles |
| CBaseEntity (`func_brush`, `func_wall_toggle`, …) | 35 / 4 / 321 | **no prop changes**; visibility toggles appear as **Leave (dormant) / Enter**, because `EF_NODRAW` stops transmission. `m_fEffects` is 16 (`EF_NOSHADOW`) while visible. |
| CFuncRespawnRoomVisualizer | static | |
| CDynamicProp | 24 / 6 / 21 leaves | prop_dynamic, mostly static; some parented to doors |

No `m_nRenderMode` or `m_clrRender` changes were seen on movers.

**Recommendation.** Emit per-entity `(tick, origin, angles)` change lists for brush movers keyed by model `*N`, plus
visible intervals from Enter/Leave. Movers are re-created on round restarts (new serial).

---

## 10. Pickups, dropped items, gibs and ragdolls

- **Map pickups.** `CBaseAnimating` with `models/items/{medkit,ammopack}_{small,medium,large}.mdl`.
  - **Taken → Leave (dormant); respawn → re-Enter with the same serial.** For example product medkit_medium: 12
    entities, 85 leaves, 81 re-enters. `m_fEffects` never changes on the wire.
  - The game event `item_pickup` (`userid`, `item` such as "medkit_medium" or "tf_ammo_pack") says who took it, and
    `take_health` / `ammo_pickup` give amounts.
  - `models/effects/cappoint_hologram.mdl` and `plate.mdl` / `plate_robo_sandwich.mdl` (a dropped sandvich spawned as
    `item_healthkit_medium`) are also `CBaseAnimating`.
- **Dropped ammo packs.** `CTFAmmoPack` with `ammopack_medium.mdl` (from deaths). `DT_AmmoPack.m_angRotation[0..2]`
  (7b) and origin change every tick while flying. **Building gibs are also `CTFAmmoPack`**:
  `models/buildables/gibs/{sentry1,sentry2,sentry3,dispenser,teleporter}_gibN.mdl` (gibs give metal).
- **Dropped weapons.** `CTFDroppedWeapon` with `m_iItemDefinitionIndex`, model, origin and angles while falling,
  and `DT_TFDroppedWeapon.m_flChargeLevel` for mediguns.
- **Ragdolls.** `CTFRagdoll` (one per death, static props):
  - `m_hPlayer`, `m_vecRagdollOrigin` (COORD_MP), `m_vecRagdollVelocity` (13b), `m_vecForce`, `m_nForceBone`
  - `m_bGib` (50 of 227), `m_bBurning`, `m_bFeignDeath` (Dead Ringer fakes), `m_bIceRagdoll`, `m_bOnGround`,
    `m_bCloaked`, `m_bBecomeAsh`, `m_bElectrocuted`, `m_bGoldRagdoll`
  - `m_iDamageCustom` (`ETFDmgCustom`), `m_iClass`, `m_iTeam`
  - This is enough for gib-vs-ragdoll placeholders.

---

## 11. Projectiles and flames

| class | m_iType / m_iProjectileType | owner path | notes |
|---|---|---|---|
| CTFProjectile_Rocket | – | `m_hOwnerEntity` → player; `DT_TFBaseRocket.m_hLauncher` → weapon | 86 / 424 / 319. `m_bCritical` (7 crits in product). Origin `DT_TFBaseRocket.m_vecOrigin` is **COORD_MP_INTEGRAL (1 u)** and sent every tick. `m_angRotation` is **only 6 bits per component (5.6°)** and is re-sent only on deflect, so take the direction from `m_vInitialVelocity` (12b [−3000..3000], static). |
| CTFProjectile_SentryRocket | – | no owner or launcher handles: link to the sentry by spawn position | 14 / 6 / 47 |
| CTFGrenadePipebombProjectile | `DT_TFProjectile_Pipebomb.m_iType` 3b: **0 pipe, 1 sticky** (2 practice, 3 loose cannon unseen) | `DT_BaseGrenade.m_hThrower` → player (not `m_hOwnerEntity`, which is null); `DT_TFProjectile_Pipebomb.m_hLauncher` → weapon | `m_bTouched` (landed), `DT_TFWeaponBaseGrenadeProj.m_bCritical` (29 kritz crits in steel), `m_vecOrigin` COORD_MP_INTEGRAL, `m_angRotation` 6b, `m_vInitialVelocity` 20b. Models: stickybomb, kingmaker sticky, quadball (Iron Bomber). Resting stickies stop updating. On detonation the pipe gets `EF_NODRAW` → **Leave** (129 / 595 / 483 leaves, no re-enters), then Delete a few ticks later. |
| CTFProjectile_Arrow | `m_iProjectileType` int32: **18 BUILDING_REPAIR_BOLT** (Rescue Ranger, 151 total), **8 ARROW** (Huntsman, 1) | owner and launcher as for rockets | On impact `m_fEffects` → 48 (`NODRAW|NOSHADOW`) and `movetype` 0. `arrow_impact` events give the attach entity and bone. |
| CTFProjectile_HealingBolt | 11 HEALING_BOLT | | crossbow; leaves PVS on hit |
| CTFProjectile_Flare | – | | 68 / 244 / 200, life ≈25–33 ticks; `TETFExplosion` with weapon FLAREGUN on hit |
| CTFBall_Ornament | (pipebomb `m_iType` 0) | `m_hThrower` and `m_hLauncher` (Wrap Assassin) | |
| CTFProjectile_EnergyRing | – | `DT_TFBaseProjectile.m_hLauncher` (Pomson) | origin in **`DT_BaseEntity.m_vecOrigin`** (the GameStateAnalyser misses it), angles static `DT_BaseEntity.m_angRotation`, `m_nRenderMode 10` |

- **Deflects.** `m_iDeflected` (4b) increments and `m_hDeflectOwner` (grenades) is set. Rockets also re-send
  `m_hOwnerEntity`, `m_iTeamNum`, `m_hLauncher` and `m_angRotation` on reflect. The `object_deflected` event
  (`userid` = pyro, `ownerid`, `object_entindex`; `weapon_id` 0 seen) and TEEffectDispatch `ParticleEffect:deflect_fx`
  (66 in product) go with it.
- **Original launcher.** `DT_BaseProjectile.m_hOriginalLauncher` is the original weapon (survives deflects).
- **Not seen:** jars, cleaver, stun ball, energy ball and loose cannon. Class names are known from the server class
  list if they appear: `CTFProjectile_Jar`, `CTFProjectile_JarMilk`, `CTFProjectile_JarGas`,
  `CTFProjectile_Cleaver`, `CTFStunBall`, `CTFProjectile_EnergyBall`.

**Flames: `CTFFlameManager`** (`DT_TFFlameManager` + `DT_TFPointManager`, 94 props). It is created per pyro weapon
(333 instances in product).
- Static props: `m_hWeapon`, `m_hAttacker`, `m_hOwnerEntity` (the flamethrower), `m_nRandomSeed`, and the flame
  physics: `m_flFlameSpeed` 2450, `m_flFlameLifeTime` 0.6 (+`m_flRandomLifeTimeOffset` 0.1), `m_flSpreadDegree` 2.8,
  `m_flFlameDrag` 8.5, `m_flFlameUp` 50, size multipliers.
- Live props:
  - **`m_bIsFiring`** (989 toggles)
  - `m_unNextPointIndex` (ring index 0..29)
  - `m_nSpawnTime.000..029`: the tick at which each flame point spawned
  - `DT_BaseEntity.m_vecOrigin` and **`DT_CollisionProperty.m_vecMins/m_vecMaxs`**, every tick while flames live
    (34 133 changes in product). This bounding box encloses the live flame points: a free placeholder flame volume.

**lib.rs exports** only rockets, pipes and stickies, and healing bolts (types 1–4). Flares, arrows, ornaments,
sentry rockets and energy rings come out as type 0, and energy-ring positions stay (0,0,0).

---

## 12. Temp entities (after delta merging, §0.4)

| class | vigil / product / steel | props and semantics |
|---|---|---|
| **CTEFireBullets** (`DT_TEFireBullets`, NOBASE) | 859 / 5 001 / 2 599 | See the next table. |
| **CTEPlayerAnimEvent** | 9 356 / 50 239 / 28 804 | See §4. Heavy `ATTACK_PRIMARY` arrives about every tick while firing (33 245 in product). |
| **CTETFExplosion** | 292 / 1 239 / 1 011 | `m_vecOrigin[0..2]` (COORD_MP_INTEGRAL), `m_vecNormal` (6b), `m_iWeaponID` (ROCKETLAUNCHER, GRENADE_PIPEBOMB = stickies, GRENADE_DEMOMAN = pipes, FLAREGUN), `m_nDefID` (item def: 513, 1151, 207, 351, 898, …), `entindex` (hit entity; 2047 = none, 0 = world), `m_nSound`, `m_iCustomParticleIndex` (65535 = none). This is the projectile impact/explosion event. |
| **CTETFParticleEffect** | 155 / 859 / 675 | `m_iParticleSystemIndex` → ParticleEffectNames (`ExplosionCore_MidAir_Flare`, `nutsnbolts_build/upgrade/repair` (wrench hits), `ExplosionCore_buildings`, `teleported_{red,blue}`, `teleportedin_*`, `player_sparkles_*`, `repair_claw_heal_*`, `ExplosionCore_sapperdestroyed`, `dxhr_sniper_rail_blue`, `bl_killtaunt`), `m_vecOrigin[0..2]`, `m_vecStart`, `m_vecAngles`, `entindex` (2047 = none), `m_iAttachType`, `m_bResetParticles`, control point 1, custom colors. **No airblast**: airblast is client-predicted; use flamethrower `m_iWeaponState == 3`, `ATTACK_SECONDARY` and `deflect_fx`. |
| **CTEEffectDispatch** (`DT_EffectData`) | 708 / 2 262 / 1 256 | `m_iEffectName` → EffectDispatch: `Impact` (bullet impacts), `Tracer` + `TF_3rdPersonMuzzleFlash_SentryGun` (**sentry gun shots**: `m_vStart` = muzzle, `m_vOrigin` = end, `entindex` = sentry), `bloodimpact`, `TFBoltImpact`, `ParticleEffect` (`m_nHitBox` = particle index → `rocketjump_smoke` (player), `deflect_fx`, `xms_ornament_*`). Also `m_vOrigin/m_vStart` [0..2] (COORD_MP_INTEGRAL), `m_vNormal`, `m_vAngles`, `m_nDamageType`, `m_nAttachmentIndex`, `m_fFlags`, `m_flScale`. |
| CTETFBlood | 403 / 2 544 / 1 413 | `entindex` (victim), `m_vecOrigin[0..2]`, `m_vecNormal`: per-hit blood |
| CTEWorldDecal / CTEDecal | 326 / 8 … | decal index and origin |
| CTEDust / CTESparks / CTEArmorRicochet / CTEMetalSparks / CTESmoke | small counts | cosmetic |

**CTEFireBullets props:**

| prop | definition | meaning |
|---|---|---|
| `m_iPlayer` | 6b | **entindex − 1** |
| `m_vecOrigin` | vector COORD_MP_INTEGRAL | **shooter eye position**: \|xy − player xy\| median 0.75 u (p90 1.15, max 17), z − feet = 64.75..75 (eye height), 41.75 ducked |
| `m_vecAngles[0]` / `[1]` | float 7b [0..360] | 2.83° steps; pitch wrapped (360 − x for up); yaw within ±1.6° of the eye yaw |
| `m_iWeaponID` | 7b, `ETFWeaponType` | MINIGUN 3 830, SCATTERGUN 455, REVOLVER 173, SHOTGUN_PRIMARY 143, SNIPERRIFLE 140, HANDGUN_SCOUT_SECONDARY 124, PISTOL_SCOUT 46, PISTOL 29, SNIPERRIFLE_DECAP 28, CHARGED_SMG 20, SENTRY_REVENGE 13 |
| `m_iMode` | 1b | always 0 |
| `m_iSeed` | 8b | |
| `m_flSpread` | 8b [0..1] | |
| `m_bCritical` | 1b | 83 / 86 crits |

With `tf_use_fixed_weaponspreads 1`, the seed and spread give the pellet pattern. **Sentry bullets are not
FireBullets**; they come as EffectDispatch Tracer and muzzle flash. Cadence: the minigun shows a 7–8 tick gap
(0.105–0.12 s per batch).

Samples:

```
FB  tick 55  player 15 MINIGUN seed 76 spread .0941 origin (-2290,-1654,203) ang (5.67, 85.04) | player feet (-2290.25,-1654.5,128) eye (4.59, 85.87)
FB  tick 82  player 16 REVOLVER seed 160 spread 0 origin (-1869,1522,123) ang (354.33, 232.44) | eye (-6.0, 232.96)
EXP tick 78  ROCKETLAUNCHER def 513 origin (...) normal (0.016,0.016,1) entindex 2047
PE  ExplosionCore_MidAir_Flare / nutsnbolts_upgrade entindex 2047 origin (1969,1697,-479)
ED  Tracer m_vStart=(2466,748,-557) m_vOrigin=(...) entindex=sentry ; TF_3rdPersonMuzzleFlash_SentryGun same tick
```

---

## 13. Game events

Event counts are vigil / product / steel. Field lists come from the demo's `GameEventList`; samples are from product.

| event | count | fields (as defined in the demo) |
|---|---|---|
| player_death | 33 / 211 / 149 | userid, victim_entindex, inflictor_entindex, attacker, weapon (string, for example "tomislav", "player" = world/self), weaponid, damagebits, customkill (`ETFDmgCustom`: 1 HEADSHOT, 2 BACKSTAB, 3 BURNING, 5 MINIGUN, 6 SUICIDE, 11, 31, 44 …), assister (65535/255 = none), weapon_logclassname, stun_flags, **death_flags** (`TF_DEATH_*` bits: 0x01 domination, 0x04 revenge, 0x20 **FEIGN_DEATH**, 0x80 GIBBED, 0x400 AUSTRALIUM), silent_kill, playerpenetratecount, assister_fallback, kill_streak_*, ducks_*, rocket_jump, **weapon_def_index**, crit_type (0 none, 1 mini, 2 crit) |
| player_hurt | 601 / 3 350 / 2 015 | userid, health, attacker, damageamount, custom, showdisguisedcrit, crit, minicrit, allseecrit, weaponid, bonuseffect |
| object_destroyed | 4 / 46 / 34 | userid (owner), attacker, assister, weapon, weaponid, objecttype, index (entindex), was_building, team |
| object_detonated / object_removed | | userid, objecttype, index |
| player_upgradedobject | 7 / 28 / 37 | userid, object, index, isbuilder |
| player_sapped_object | 0 / 13 / 12 | userid, ownerid, object, sapperid |
| teamplay_point_captured | 2 / 10 / 8 | cp, cpname, team, **cappers (byte string of entindices)** |
| teamplay_point_startcapture | | cp, cpname, team, capteam, cappers, captime |
| teamplay_capture_broken | 18 / 8 / 11 | cp, cpname, time_remaining |
| teamplay_capture_blocked | 0 / 7 / 2 | cp, cpname, blocker, victim |
| player_chargedeployed | 5 / 12 / 15 | userid (medic), targetid |
| medic_death | 1 / 16 / 10 | userid, attacker, healing, charged |
| player_invulned | 17 / 77 / 80 | userid, medic_userid |
| object_deflected | 22 / 108 / 92 | userid, ownerid, weaponid, object_entindex (projectile, or a player for pushes) |
| teamplay_round_start / round_active / round_win / win_panel / restart_round / setup_finished / timer_time_added / pre_round_time_left / map_time_remaining / point_locked / point_unlocked / broadcast_audio / game_over / tf_game_over | present | round_win: team, winreason, flagcaplimit, full_round, round_time, losing_team_num_caps, was_sudden_death |
| rocket_jump(_landed), sticky_jump(_landed) | 56 / 307 / 133 rocket jumps | userid, playsound |
| player_teleported | 8 / 67 / 29 | userid, builderid, dist |
| player_healed / player_healonhit / crossbow_heal / building_healed / take_health / ammo_pickup / item_pickup | | |
| arrow_impact | 13 / 123 / 104 | attachedEntity, shooter, bone index, bone position and angles, projectileType, isCrit |
| demoman_det_stickies / player_destroyed_pipebomb / npc_hurt (building damage) / entity_killed | | |
| player_spawn / player_changeclass / player_team / player_disconnect / post_inventory_application / weapon_equipped / player_regenerate | | |
| player_buff / deploy_buff_banner / player_stunned / player_stealsandvich / player_domination / killed_capping_player / capper_killed / medic_defended / environmental_death / hltv_status | | |

**Defined but never received in any of the three demos** (server-only `FireEvent(e, true)` in the SDK, or never
broadcast): `player_builtobject`, `player_carryobject`, `player_dropobject`, `player_extinguished`, `player_ignited`,
`payload_pushed`, `escort_progress`, `escort_speed`, `escort_recede`, `teamplay_overtime_begin/end` (overtime
happened in product), `deadringer_cheat_death`, `sentry_on_go_active`, `player_jarated(_fade)`,
`player_shield_blocked`, `player_damage_dodged`, `localplayer_builtobject`, `teamplay_waiting_begins/ends`,
`teamplay_round_stalemate`, `teamplay_suddendeath_begin`, `player_highfive_*`, `player_mvp`, `teamplay_alert`.
`medigun_shield_blocked` is not even defined. Derive all of these from entity state.

**Dead Ringer fakes appear as `player_death` with `death_flags & 0x20`** (3 / 16+ / 9+ per demo); the victim stays
alive (`m_lifeState` 0), and a `CTFRagdoll` with `m_bFeignDeath = 1` spawns. lib.rs's `deaths` currently lists them
as real deaths: mark or filter them (the in-game killfeed shows them to enemies only).

`GameStateAnalyser` stores every event in `state.events` (typed via `gameevent_gen.rs`). Typed decoding reads fields
in **struct order**, not the demo's definition order. It worked here, but a future TF2 update that reorders fields
would silently misread them.

---

## 14. Performance and memory (native, release, AMD Ryzen 7 7735HS)

| run | 1438891.dem (49.6 MB, 817 s, 54 446 packets) |
|---|---|
| file read | VmHWM 51.7 MB |
| `DemoParser::new_with_analyser(GameStateAnalyser)` | **0.568–0.572 s**, VmHWM 60.6 MB (≈9 MB of parser and analyser state) |
| lib.rs-style loop (`DemoHandler::with_analyser`, Match + GameState analysers, borrow both outputs per packet) | 0.557–0.560 s, VmHWM 61.1 MB |
| full probe (all entities × all props, change logs, TE merging) | 1.79–1.93 s, VmHWM 169 MB (vigil 0.52 s / 78 MB; steel 1.55 s / 155 MB) |

For comparison, the committed wasm parser took 3.1 s in Node on 1442753.dem (51 MB, 910 s). An extras pass that tracks
only whitelisted classes and props should cost about 1–1.5× a base parse.

---

## 15. Library / `GameStateAnalyser` / lib.rs gaps and bugs found

1. `PacketEntity::props()` dedupes own + baseline props **by identifier**, so repeated UtlVector elements are lost on
   Enter (`m_pProvider`, item attributes, scoring data [1]). `BaselineEntity::apply_update` and
   `PacketEntity::apply_update` have the same problem. Fix: merge by `SendProp.index`.
   - `has_attribute()` scans the Enter's own props, which keep the duplicates, so medigun type detection works in
     practice.
   - At code level, new instance baselines store only the Enter's own props, not the static baseline underneath. The
     probe merges own > instance > static by index; on these demos that made no difference.
2. `TempEntitiesMessage` events are not delta-merged (§0.4). Prop-less events decode as "entity 0 / event 0".
3. `Player::conditions()` / `has_condition()` test `(byte >> bit) == 1` instead of `& 1`. `_condition_bits` and
   `m_nPlayerCond` both **overwrite** `conditions[0..4]`; they should OR, and only bit 11 matters for the list.
4. Buildings: `builder` and dispenser `healing` are EHANDLEs stored as `UserId(u16)`. Teleporter `other_end` comes
   from `m_bMatchBuilding` (a bool). The sentry angle reads `DT_TFNonLocalPlayerExclusive.m_angEyeAngles[1]` (does
   not exist on sentries). A Leave sets health to 0 (that is actually a carry), and a re-Enter restores it.
   `Building::class()` returns Sentry for dispensers.
5. Projectiles: `ProjectileType` covers rocket, pipe, sticky, flare and healing bolt only. The origin is read only from
   `DT_TFBaseRocket` / `DT_TFWeaponBaseGrenadeProj`, so EnergyRing is missed. Rotation is the 6-bit
   `m_angRotation`; use `m_vInitialVelocity` instead.
6. The spy and medic `class_data` updates apply only after `CTFPlayerResource.m_iPlayerClass` arrives. Prop order
   within a packet can drop the first values.
7. `handle_cp_entity` is `todo!()`. Nothing reads `CTFObjectiveResource`, the timers or the game rules.
8. `src/demo/message/usermessage.rs` `UserMessageType` ids look outdated for current TF2.
9. lib.rs `parse_demo_cache_internal` ignores Leave/Enter visibility, exports projectile types 1–4 only, and takes
   uber as an integer % from the player resource (the medigun has a float).

---

## 16. Recommended extraction design (`parse_demo_extras`, second wasm export)

Use the same `DemoHandler` / `RawPacketStream` loop, tick mapping (`internal_tick = server_tick − start_server_tick`;
start chosen exactly like lib.rs: 100 frames with players and a world boundary) and player index mapping
(first-seen order of `CTFPlayer` entity ids) as lib.rs. Expose `ticks`, `startTick` and `tickBase` so the frontend can
assert alignment. Implementation outline:

1. **Generic tracked-entity layer.** Like the probe, keep a per-entity prop map keyed by **flattened index** (or a
   synthetic id for duplicate identifiers) for a whitelist of classes, and apply Enter (own + baseline merged by
   index), Delta, Leave, Delete and explicit removes. Emit *changes only*, as sparse per-entity-instance lists
   `(tick, value)`. Binary search gives the value at any T, which keeps seeking deterministic.
2. **Per player (19 slots, sparse change lists):**
   - cond words 0–4 plus `_condition_bits`
   - `m_pProvider[5, 11, 21, 22, 28…]` (optional)
   - cloak meter quantized to u8, `m_flInvisChangeCompleteTime` → internal tick
   - disguise team, class, target player index, health and weapon item def
   - `m_hActiveWeapon` → (weapon class id, item def)
   - FOV and `m_hZoomOwner`, sniper `m_flChargedDamage` (u8)
   - medigun charge (u16 permille), release, healing target index, `m_bAttacking`, item def
   - flamethrower and minigun `m_iWeaponState`
   - `m_nNumHealers`, taunt index/concept/item def plus cond 7
   - `m_bCarryingObject`
   - `m_iReloadMode`, clip
   - viewmodel 0/1: model name id, sequence, animation parity, muzzle parity, `m_hWeapon` item def, `m_fEffects`
3. **Event streams** with internal ticks:
   - shots (FireBullets: player, weapon id, origin, angles, crit, seed, spread)
   - `m_flLastFireTime` / muzzle-parity shot ticks per player (covers projectile weapons too)
   - anim events (player, event, data)
   - explosions (TETFExplosion), particle effects (name id, origin, entindex)
   - sentry tracers (EffectDispatch Tracer and muzzle flash), blood
   - deflects, ragdolls (origin, gib/burning/feign/ice/class/team)
4. **Entity lifetimes with sample streams:**
   - sniper and laser dots (owner, origin changes)
   - buildings (class, builder index, mode, mini, change lists of level, health, max, construction, building, sapped,
     disabled, ammo, state, enemy, wrangled, shield, pose 000/001, model, origin/angles) plus visible intervals
   - all projectile classes (type, team, crit, owner/thrower index, launcher item def, positions per tick,
     `m_vInitialVelocity`, deflect ticks)
   - flame managers (owner, `m_bIsFiring`, origin plus bounding box per tick)
   - pickups (model id, origin, visible intervals), dropped weapons, ammo packs and gibs (model, origin, angles)
   - movers (`*N`, origin and angles per tick, visible intervals)
5. **Objectives:**
   - `CTFObjectiveResource` static arrays once, plus per-point change lists (owner, capping team, team in zone,
     num team members, lazy cap %, locked, blocked, unlock times), with cap % pre-simulated per tick (or interpolated)
   - all `CTeamRoundTimer`s (paused, time remaining, end time → tick, length, disabled, showInHUD, stopwatch)
   - game rules (round state, winning team, setup, overtime, stopwatch state, KOTH timer handles → timer ids, respawn
     waves)
   - train watcher (progress, speed level, cappers) and the train or phys-cart origin and angles
   - `CTFPlayerResource.m_flNextRespawnTime[]`
6. **Game events**, already in `state.events`: deaths (with `weapon_def_index`, `customkill`, `death_flags`, crit),
   object events, cap events, charge deployed, deflected, rocket jumps, `item_pickup`. Map userids to player indices
   via userinfo.

Seek-determinism holds because everything is either a value-at-tick lookup or an event with a tick; derived effects
(muzzle flash, explosion, flame cone) render from (T − eventTick).

---

## Appendix A: verified prop paths for the extras (copy into `SendPropIdentifier::new`)

```text
player  DT_TFPlayerShared.{m_nPlayerCond,m_nPlayerCondEx,m_nPlayerCondEx2,m_nPlayerCondEx3,m_nPlayerCondEx4}
        DT_TFPlayerConditionListExclusive._condition_bits
        DT_TFPlayerConditionSource.m_pProvider            (k-th flattened occurrence = cond k)
        DT_TFPlayerShared.{m_flCloakMeter,m_flInvisChangeCompleteTime,m_nDisguiseTeam,m_nDisguiseClass,m_nMaskClass,
                           m_hDisguiseTarget,m_iDisguiseHealth,m_hDisguiseWeapon,m_iDisguiseBody,m_bFeignDeathReady,
                           m_nNumHealers,m_iTauntIndex,m_iTauntConcept,m_bCarryingObject,m_hCarriedObject,
                           m_iCritMult,m_bJumping,m_iAirDash,m_nAirDucked,m_nPlayerState,m_unTauntSourceItemID_Low}
        DT_TFPlayerSharedLocal.{m_nDesiredDisguiseTeam,m_nDesiredDisguiseClass,m_flStealthNoAttackExpire,
                                m_flStealthNextChangeTime,m_flRageMeter}
        DT_TFPlayer.{m_iTauntItemDefIndex,m_nActiveTauntSlot,m_flTauntYaw,m_hRagdoll,m_iSpawnCounter,m_bSaveMeParity,
                     m_hSecondaryLastWeapon,m_hOffHandWeapon,m_flInspectTime}
        DT_TFPlayerClassShared.m_iClass
        DT_BaseCombatCharacter.m_hActiveWeapon          m_hMyWeapons.000 .. .047
        DT_BasePlayer.{m_iFOV,m_iFOVStart,m_flFOVTime,m_iDefaultFOV,m_hZoomOwner,m_iHealth,m_lifeState,m_fFlags,
                       m_iObserverMode,m_hObserverTarget,m_flMaxspeed}
        DT_Local.{m_flFOVRate,m_bDucked,m_bDucking,m_flDucktime,m_flFallVelocity,m_vecPunchAngle}
        DT_LocalPlayerExclusive.{m_vecVelocity[0],m_vecVelocity[1],m_vecVelocity[2],m_vecViewOffset[2],
                                 m_hGroundEntity,m_flDeathTime,m_hLastWeapon}
        DT_TFLocalPlayerExclusive.{m_vecOrigin,m_vecOrigin[2],m_angEyeAngles[0],m_angEyeAngles[1]}   (full precision)
        m_iAmmo.001..005    m_flItemChargeMeter.000..010    DT_TFSendHealersDataTable.m_nActiveWpnClip
weapon  DT_ScriptCreatedItem.m_iItemDefinitionIndex   DT_BaseCombatWeapon.{m_hOwner,m_iState,m_iWorldModelIndex,
        m_iViewModelIndex}   DT_LocalTFWeaponData.m_flLastFireTime   DT_BaseAnimating.m_nMuzzleFlashParity
        DT_LocalWeaponData.m_iClip1   DT_TFWeaponBase.{m_iReloadMode,m_iConsecutiveShots,m_bLowered,m_nInspectStage}
        DT_WeaponFlameThrower.{m_iWeaponState,m_bCritFire,m_bHitTarget}   DT_WeaponMinigun.{m_iWeaponState,m_bCritShot}
        DT_WeaponMedigun.{m_hHealingTarget,m_bHealing,m_bAttacking,m_bChargeRelease,m_bHolstered,m_nChargeResistType,
        m_hLastHealingTarget}   DT_TFWeaponMedigunDataNonLocal.m_flChargeLevel   DT_SniperRifleLocalData.m_flChargedDamage
        DT_PipebombLauncherLocalData.{m_flChargeBeginTime,m_iPipebombCount}   DT_TFWeaponKnife.m_bReadyToBackstab
        DT_TFWeaponBuilder.{m_iBuildState,m_iObjectMode}   DT_BuilderLocalData.{m_hObjectBeingBuilt,m_iObjectType}
vm      DT_BaseViewModel.{m_nModelIndex,m_nSequence,m_nViewModelIndex,m_flPlaybackRate,m_fEffects,m_nAnimationParity,
        m_hWeapon,m_hOwner,m_nNewSequenceParity,m_nResetEventsParity,m_nMuzzleFlashParity}
dot     DT_BaseEntity.{m_hOwnerEntity,m_vecOrigin}  DT_SniperDot.m_flChargeStartTime   (CSniperDot, CLaserDot)
object  DT_BaseObject.{m_iHealth,m_iMaxHealth,m_bHasSapper,m_iObjectType,m_bBuilding,m_bPlacing,m_bCarried,
        m_bCarryDeploy,m_bMiniBuilding,m_flPercentageConstructed,m_hBuilder,m_iUpgradeLevel,m_iHighestUpgradeLevel,
        m_iUpgradeMetal,m_iUpgradeMetalRequired,m_iObjectMode,m_bDisabled,m_bPlasmaDisable,m_hBuiltOnEntity,
        m_bWasMapPlaced}   DT_ObjectSentrygun.{m_iAmmoShells,m_iAmmoRockets,m_iState,m_bPlayerControlled,
        m_nShieldLevel,m_hEnemy,m_hAutoAimTarget}  m_flPoseParameter.000/.001   DT_ObjectDispenser.{m_iState,
        m_iAmmoMetal,"healing_array"}   DT_ObjectTeleporter.{m_iState,m_flRechargeTime,m_flCurrentRechargeDuration,
        m_iTimesUsed,m_flYawToExit}
proj    DT_TFBaseRocket.{m_vecOrigin,m_angRotation,m_vInitialVelocity,m_hLauncher,m_iDeflected}
        DT_TFWeaponBaseGrenadeProj.{m_vecOrigin,m_angRotation,m_vInitialVelocity,m_bCritical,m_iDeflected,
        m_hDeflectOwner}   DT_BaseGrenade.m_hThrower   DT_TFProjectile_Pipebomb.{m_iType,m_bTouched,m_hLauncher}
        DT_TFProjectile_Rocket.m_bCritical   DT_TFProjectile_Arrow.{m_bCritical,m_iProjectileType}
        DT_BaseProjectile.m_hOriginalLauncher   DT_TFBaseProjectile.m_hLauncher (energy ring)
flames  DT_TFFlameManager.{m_hWeapon,m_hAttacker,m_bIsFiring,m_flFlameSpeed,m_flFlameLifeTime,m_flSpreadDegree}
        DT_TFPointManager.m_unNextPointIndex  m_nSpawnTime.000..029  DT_CollisionProperty.{m_vecMins,m_vecMaxs}
cart    CFuncTrackTrain DT_BaseEntity.{m_vecOrigin,m_angRotation}   CTeamTrainWatcher DT_TeamTrainWatcher.{
        m_flTotalProgress,m_iTrainSpeedLevel,m_nNumCappers,m_flRecedeTime}   CPhysicsProp (bomb_cart.mdl) origin/angles
        DT_BaseEntity.moveparent (parent handle; NOT m_hMoveParent)
rules   DT_TeamplayRoundBasedRules.{m_iRoundState,m_iWinningTeam,m_bInSetup,m_bInOvertime,m_bStopWatch,
        m_bInWaitingForPlayers,m_nRoundsPlayed,m_flRestartRoundTime}  m_flNextRespawnWave.NNN m_TeamRespawnWaveTimes.NNN
        DT_TFGameRules.{m_nGameType,m_bPlayingKoth,m_hRedKothTimer,m_hBlueKothTimer,m_nStopWatchState,
        m_bStopWatchWinner}
timer   DT_TeamRoundTimer.{m_bTimerPaused,m_flTimeRemaining,m_flTimerEndTime,m_nTimerLength,m_nTimerMaxLength,
        m_bIsDisabled,m_bShowInHUD,m_nSetupTimeLength,m_nState,m_bStopWatchTimer}
objres  DT_BaseTeamObjectiveResource.{m_iNumControlPoints,m_vCPPositions,m_iStopWatchTimer,m_iTimerToShowInHUD,
        m_iUpdateCapHudParity,m_pszCapLayoutInHUD}   arrays: m_iOwner m_iCappingTeam m_iTeamInZone m_flLazyCapPerc
        m_bBlocked m_bCPLocked m_flUnlockTimes m_bCPIsVisible m_flPathDistance m_iCPGroup (index = point)
        m_iNumTeamMembers m_iTeamReqCappers m_flTeamCapTime m_bTeamCanCap m_iTeamIcons (index = team*8+point)
te      DT_TEFireBullets.{m_iPlayer,m_vecOrigin,m_vecAngles[0],m_vecAngles[1],m_iWeaponID,m_iMode,m_iSeed,
        m_flSpread,m_bCritical}  DT_TEPlayerAnimEvent.{m_hPlayer,m_iEvent,m_nData}  DT_TETFExplosion.{m_vecOrigin[0..2],
        m_vecNormal,m_iWeaponID,entindex,m_nDefID}  DT_TETFParticleEffect.{m_iParticleSystemIndex,m_vecOrigin[0..2],
        entindex}  DT_EffectData.{m_iEffectName,m_vOrigin[0..2],m_vStart[0..2],entindex,m_nHitBox}
        DT_TETFBlood.{entindex,m_vecOrigin[0..2]}
```
