# TF2 mechanics reference for the Highlander viewer

Reference for implementing Highlander (9v9) features in dribble.tf. Everything here comes from three places:

1. Valve's TF2 game code in `../source-sdk-2013` (commit `c623a7c3`). Citations are `path:line` relative to `source-sdk-2013/src/`.
2. Public schema text from SteamDatabase/GameTracking-TF2 (`items_game.txt`, `tf_english.txt`, `tf_proto_obj_defs_english.txt`).
3. Ground truth from a real serveme.tf HL demo. Another agent's `hl_probe` report on `1434434.dem` (pl_vigil_rc10, 66.67 tick) lives at `scratchpad/probe/out/1434434.txt`. I use it to confirm which props actually appear in STV demos. "Probe" below means that report.

Values I could not find in source are marked "unverified". Placeholder sizes I made up are marked "estimate".

Class indices used everywhere: 1 scout, 2 sniper, 3 soldier, 4 demoman, 5 medic, 6 heavy, 7 pyro, 8 spy, 9 engineer (`game/shared/tf/tf_shareddefs.h:203`). Teams: 0 unassigned, 1 spectator, 2 RED, 3 BLU (`game/shared/tf/tf_shareddefs.h:33`, `game/shared/shareddefs.h:281`).

---

## 1. Networking facts that change the plan

These were not obvious from the SDK alone, and several earlier assumptions were wrong.

### 1.1 STV demos contain the "local-only" tables too

The SDK restricts many tables to the owning client with `SendProxy_SendLocalDataTable` / `SendProxy_SendLocalWeaponDataTable` (`pRecipients->SetOnly(owner)`, `game/shared/basecombatweapon_shared.cpp:2717-2756`, `game/shared/tf/tf_player_shared.cpp:590`). The HLTV client does not cull those props. The engine side isn't in the SDK, but the probe shows them on players and weapons:

| prop (table) | what it gives the viewer | probe evidence |
|---|---|---|
| `DT_SniperRifleLocalData.m_flChargedDamage` | exact sniper charge 0..150 | 4797 changes, 0..150 |
| `DT_PipebombLauncherLocalData.m_flChargeBeginTime` | sticky charge, also Huntsman draw (bow inherits the launcher) | 166 changes |
| `DT_LocalWeaponData.m_iClip1` | clip ammo for the HUD | many weapons |
| `DT_TFPlayerSharedLocal.m_flRageMeter` | banner / Phlog / Heatmaker rage 0..100 | 0..89.9 |
| `m_flItemChargeMeter[slot]` (shared local) | jar/milk/cleaver/drink/razorback recharge | 3861 changes on one slot |
| `DT_LocalTFWeaponMedigunData.m_flChargeLevel` | uber 0..1 (also sent as NonLocal copy) | 9217 changes |
| `DT_TFPlayerSharedLocal.m_nDesiredDisguiseClass/Team` | what the spy is switching to while `DISGUISING` | present |
| `DT_LocalPlayerExclusive.m_vecVelocity[0..2]` | exact velocity (motion cloak, animation) | 149k changes |

So prefer the exact values over reconstructions. Reconstructions are still listed below as fallbacks for older demos.

### 1.2 Snapshot rate, ticks and time

- `interval_per_tick = 0.015`, PacketEntities every tick (probe: gap 1 for 15069/15070 messages). `tv_transmitall 1` on serveme (probe SetConVar list), so every entity is present, not only PVS.
- Every `SendPropTime` is a plain float of server `curtime` (`game/server/sendproxy.cpp:133-141`: `SendPropTime` is `SendPropFloat(..., -1, SPROP_NOSCALE)`). Server time at a tick is `serverTick * interval_per_tick`. In the probe, first server tick 7237 maps to 108.6 s and the cloak change times fall in 113..336 s, which matches. Convert every networked time with the same server-tick base the parser exposes (`startTick`/`tickBase`), then sanity-check against a round timer: `m_flTimerEndTime - t` must equal the HUD clock.

### 1.3 Temp entities reach STV

STV relays temp entities to the demo even when the server filter excludes the shooter. Probe counts for 226 s: `CTEPlayerAnimEvent` 9356, `CTEFireBullets` 859, `CTEEffectDispatch` 708, `CTETFExplosion` 292, `CTETFParticleEffect` 155, `CTETFBlood` 403.

- `TE_PlayerAnimEvent` (`game/server/tf/tf_player.cpp:340-370`, sent from `CTFPlayer::DoAnimationEvent` at `:5924-5930`): `m_hPlayer`, `m_iEvent`, `m_nData`. This is the best fire/reload signal for viewmodels (section 10).
- `TE_FireBullets` (`game/server/tf/tf_fx.cpp:56-91`): `m_iPlayer` is entity index minus 1, `m_vecOrigin`, `m_vecAngles[0..1]` (7-bit), `m_iWeaponID` (TF_WEAPON_* enum, `tf_shareddefs.h:405-523`), `m_iSeed`, `m_flSpread`, `m_bCritical`.

### 1.4 Entities that never appear

`CBaseEntity::UpdateTransmitState` drops any entity with `EF_NODRAW` and no move child (`game/server/baseentity.cpp:3999-4003`). `CTFBaseProjectile::Create` sets `EF_NODRAW` and spawns a client-side copy through an EffectDispatch (`game/shared/tf/tf_projectile_base.cpp:173-235`). Result:

- Syringe gun needles exist only as `EffectDispatch "ClientProjectile_Syringe"` with origin and `m_vStart` = velocity (1000 u/s, gravity 0.3, `game/shared/tf/tf_projectile_nail.cpp:46-58`). No entity.
- Old-style Bison/Pomson rings use `"ClientProjectile_EnergyRing"` the same way (`game/shared/tf/tf_projectile_energy_ring.cpp:29,150-163`). The probe saw neither, so check a demo with those weapons.
- `CSniperDot` and `CLaserDot` have no model and only transmit because of `EFL_FORCE_CHECK_TRANSMIT` (`game/shared/tf/tf_weapon_sniperrifle.cpp:1460-1463`).

### 1.5 Viewmodels are in the demo

`CBaseViewModel::ShouldTransmit` sends every viewmodel in PVS to HLTV (`game/server/baseviewmodel.cpp:85-89`). The probe has 36 `CTFViewModel` entities: index 0 for the main weapon, index 1 for the spy watch (`v_watch_*_spy.mdl`). Section 10 covers what to do with them.

---

## 2. Player conditions (ETFCond)

### 2.1 Bit layout

Enum: `game/shared/tf/tf_shareddefs.h:687-833`, values 0..130, `TF_COND_LAST = 131`.

`CConditionVars` picks the word and bit (`game/shared/tf/tf_player_shared.cpp:1041-1074`):

| cond range | networked prop (in `DT_TFPlayerShared`, under the player's `m_Shared`) | bit | send prop |
|---|---|---|---|
| 0..31 | `m_nPlayerCond` (C0) | cond | `tf_player_shared.cpp:536` varint unsigned |
| 32..63 | `m_nPlayerCondEx` (C1) | cond-32 | `:596` |
| 64..95 | `m_nPlayerCondEx2` (C2) | cond-64 | `:601` |
| 96..127 | `m_nPlayerCondEx3` (C3) | cond-96 | `:602` |
| 128..159 | `m_nPlayerCondEx4` (C4) | cond-128 | `:616` |
| 0..31, only 11 in practice | `DT_TFPlayerConditionListExclusive._condition_bits` | cond | `game/shared/tf/tf_condition.cpp:32`, 32 bits unsigned |

Two traps:

- `TF_COND_CRITBOOSTED` (11) is the only condition implemented as a condition object (`tf_condition.cpp:57-90`). On the server it never sets bit 11 of `m_nPlayerCond`. It lives in `_condition_bits` only. `InCond` ORs both for conds < 32 (`tf_player_shared.cpp:1209-1219`). Do the same: `cond0 = m_nPlayerCond | _condition_bits`. Probe: Frontier Justice revenge crits showed up as `_condition_bits = 2048`.
- The words are varints of 32-bit masks. The probe saw `m_nPlayerCondEx3 = 3225944064` (bits 19, 22, 30, 31). Read them as `uint32` (`>>> 0` in JS), never as signed.

`m_ConditionData[*]` (expire times) is not networked except the provider handle (`tf_player_shared.cpp:351-356, 614`). Durations have to be derived from rising and falling edges.

### 2.2 Full table

"viewer" marks conditions worth showing. "seen" means the probe saw it in 1434434.dem.

| # | name | word.bit (mask) | viewer | seen | notes |
|---:|---|---|:---:|:---:|---|
| 0 | AIMING | C0.0 (0x1) | Y | Y | Sniper scoped or Classic charging, Huntsman drawn, minigun spun up (AC states 1-3), Huo-Long ring. Movement slow. |
| 1 | ZOOMED | C0.1 (0x2) | Y | Y | Scoped (FOV 20). Viewmodel hidden. Scope overlay + charge meter in POV. |
| 2 | DISGUISING | C0.2 (0x4) | Y | Y | Disguise in progress, 2.0 s (0.5 s if already disguised, 0 s for on-kill). Smoke `spy_start_disguise_<team>`. |
| 3 | DISGUISED | C0.3 (0x8) | Y | Y | Disguised. See section 4. |
| 4 | STEALTHED | C0.4 (0x10) | Y | Y | Cloaked (invis watch / C&D / DR). See section 3. |
| 5 | INVULNERABLE | C0.5 (0x20) | Y | Y | Ubercharge. Uber skin (skin index +2). Stock full charge lasts 8 s. |
| 6 | TELEPORTED | C0.6 (0x40) | Y | Y | Just teleported, 12 s glow `player_recent_teleport_<team>`. |
| 7 | TAUNTING | C0.7 (0x80) | Y | Y | Taunting. `m_iTauntIndex`, `m_iTauntConcept`, `m_iTauntItemDefIndex`. |
| 8 | INVULNERABLE_WEARINGOFF | C0.8 (0x100) | Y | Y | Last 1.0 s of an uber (`tf_invuln_time`). Cond 5 stays set; the `InvulnLevel` proxy drops to 0, so the uber sheen flickers out. |
| 9 | STEALTHED_BLINK | C0.9 (0x200) | Y | Y | Cloak blink, 0.3 s after >5 dmg or enemy bump. Invisibility x0.85. |
| 10 | SELECTED_TO_TELEPORT | C0.10 (0x400) | Y | Y | Standing on a ready teleporter entrance. |
| 11 | CRITBOOSTED | C0.11 (0x800) | Y | Y | Kritz uber AND revenge crits (Frontier Justice, Diamondback, Manmelter). Only in `_condition_bits` bit 11. |
| 12 | TMPDAMAGEBONUS | C0.12 (0x1000) |  |  |  |
| 13 | FEIGN_DEATH | C0.13 (0x2000) | Y | Y | Dead Ringer feign window, 3 s. Spy is alive and cloaked. |
| 14 | PHASE | C0.14 (0x4000) | Y |  | Bonk! dodge, 8 s. Afterwards a 5 s movement stun if damage was absorbed. |
| 15 | STUNNED | C0.15 (0x8000) | Y |  | Any stun. Read `m_iStunFlags`, `m_flMovementStunTime`, `m_iMovementStunAmount`, `m_hStunner`. |
| 16 | OFFENSEBUFF | C0.16 (0x10000) | Y |  | Buff Banner mini-crits (1.2 s per 1 s pulse, 450 u radius). |
| 17 | SHIELD_CHARGE | C0.17 (0x20000) | Y |  | Demo shield charge, drains 100 meter in 1.5 s. |
| 18 | DEMO_BUFF | C0.18 (0x40000) | Y |  | Eyelander/heads glow (sword with heads). |
| 19 | ENERGY_BUFF | C0.19 (0x80000) | Y |  | Mini-crit buff: Crit-a-Cola, Buffalo Steak, Cleaner's Carbine. Crit glow. |
| 20 | RADIUSHEAL | C0.20 (0x100000) | Y |  | Amputator taunt radius heal (1.2 s refresh). |
| 21 | HEALTH_BUFF | C0.21 (0x200000) | Y | Y | Being healed (medigun/heal source present). |
| 22 | BURNING | C0.22 (0x400000) | Y | Y | Afterburn. `burningplayer_<team>` flames, 4 dmg / 0.5 s. |
| 23 | HEALTH_OVERHEALED | C0.23 (0x800000) | Y | Y | Overhealed. `overhealedplayer_<team>_pluses`. |
| 24 | URINE | C0.24 (0x1000000) | Y |  | Jarate. Yellow drips `peejar_drips`, also makes cloak x0.85. |
| 25 | BLEEDING | C0.25 (0x2000000) | Y | Y | Bleeding, 4 dmg / 0.5 s. |
| 26 | DEFENSEBUFF | C0.26 (0x4000000) | Y |  | Battalion's Backup (35% resist, crit immune). |
| 27 | MAD_MILK | C0.27 (0x8000000) | Y |  | Mad Milk drips `peejar_drips_milk`. |
| 28 | MEGAHEAL | C0.28 (0x10000000) | Y |  | Quick-Fix uber `medic_megaheal_<team>` (knockback/stun immune). |
| 29 | REGENONDAMAGEBUFF | C0.29 (0x20000000) | Y |  | Concheror (heal on hit, speed). |
| 30 | MARKEDFORDEATH | C0.30 (0x40000000) | Y |  | Marked for death, skull icon `mark_for_death` over head. |
| 31 | NOHEALINGDAMAGEBUFF | C0.31 (0x80000000) |  |  |  |
| 32 | SPEED_BOOST | C1.0 (0x1) | Y | Y | Speed boost trail `speed_boost_trail` (DR, Disciplinary Action, Concheror, ...). |
| 33 | CRITBOOSTED_PUMPKIN | C1.1 (0x2) |  |  |  |
| 34 | CRITBOOSTED_USER_BUFF | C1.2 (0x4) | Y |  | Crit boost from canteen/script. |
| 35 | CRITBOOSTED_DEMO_CHARGE | C1.3 (0x8) | Y |  | Shield charge crits, meter < 75 while charging, +0.3 s after. |
| 36 | SODAPOPPER_HYPE | C1.4 (0x10) | Y |  | Soda Popper hype (multi-jump), `m_flHypeMeter`. |
| 37 | CRITBOOSTED_FIRST_BLOOD | C1.5 (0x20) |  |  |  |
| 38 | CRITBOOSTED_BONUS_TIME | C1.6 (0x40) | Y | Y | Round-win humiliation crits (winning team in bonus time). |
| 39 | CRITBOOSTED_CTF_CAPTURE | C1.7 (0x80) |  |  |  |
| 40 | CRITBOOSTED_ON_KILL | C1.8 (0x100) | Y |  | Crits on kill (attribute driven). |
| 41 | CANNOT_SWITCH_FROM_MELEE | C1.9 (0x200) | Y |  | Locked to melee (Buffalo Steak etc). |
| 42 | DEFENSEBUFF_NO_CRIT_BLOCK | C1.10 (0x400) |  |  |  |
| 43 | REPROGRAMMED | C1.11 (0x800) |  |  |  |
| 44 | CRITBOOSTED_RAGE_BUFF | C1.12 (0x1000) | Y |  | Phlogistinator MMMPH crits (primary only). |
| 45 | DEFENSEBUFF_HIGH | C1.13 (0x2000) | Y |  | 75% resist buff. |
| 46 | SNIPERCHARGE_RAGE_BUFF | C1.14 (0x4000) | Y |  | Hitman's Heatmaker focus (charge rate x1.25 for the dot). |
| 47 | DISGUISE_WEARINGOFF | C1.15 (0x8000) | Y | Y | 0.5 s after disguise removal. |
| 48 | MARKEDFORDEATH_SILENT | C1.16 (0x10000) | Y | Y | Silent mark-for-death (Crit-a-Cola attack: 5 s). |
| 49 | DISGUISED_AS_DISPENSER | C1.17 (0x20000) |  |  |  |
| 50 | SAPPED | C1.18 (0x40000) |  |  |  |
| 51 | INVULNERABLE_HIDE_UNLESS_DAMAGED | C1.19 (0x80000) | Y | Y | Uber that only shows when damaged in the last 2 s. Observed 5.00 s (333 ticks) on respawn in 1434434.dem; not set by SDK code (map/plugin). |
| 52 | INVULNERABLE_USER_BUFF | C1.20 (0x100000) | Y |  | Uber from canteen/script. |
| 53 | HALLOWEEN_BOMB_HEAD | C1.21 (0x200000) |  |  |  |
| 54 | HALLOWEEN_THRILLER | C1.22 (0x400000) |  |  |  |
| 55 | RADIUSHEAL_ON_DAMAGE | C1.23 (0x800000) |  |  |  |
| 56 | CRITBOOSTED_CARD_EFFECT | C1.24 (0x1000000) |  |  |  |
| 57 | INVULNERABLE_CARD_EFFECT | C1.25 (0x2000000) |  |  |  |
| 58 | MEDIGUN_UBER_BULLET_RESIST | C1.26 (0x4000000) | Y |  | Vaccinator uber, bullet (75% resist, crit immune). `vaccinator_<team>_buff1`. |
| 59 | MEDIGUN_UBER_BLAST_RESIST | C1.27 (0x8000000) | Y |  | Vaccinator uber, blast. `..._buff2`. |
| 60 | MEDIGUN_UBER_FIRE_RESIST | C1.28 (0x10000000) | Y |  | Vaccinator uber, fire. `..._buff3`. |
| 61 | MEDIGUN_SMALL_BULLET_RESIST | C1.29 (0x20000000) | Y |  | Vaccinator passive 10% bullet resist on medic+patient. |
| 62 | MEDIGUN_SMALL_BLAST_RESIST | C1.30 (0x40000000) | Y |  | Vaccinator passive blast. |
| 63 | MEDIGUN_SMALL_FIRE_RESIST | C1.31 (0x80000000) | Y |  | Vaccinator passive fire. |
| 64 | STEALTHED_USER_BUFF | C2.0 (0x1) | Y |  | Stealth from another source (any class). |
| 65 | MEDIGUN_DEBUFF | C2.1 (0x2) |  |  |  |
| 66 | STEALTHED_USER_BUFF_FADING | C2.2 (0x4) | Y |  | Fading out of user-buff stealth. |
| 67 | BULLET_IMMUNE | C2.3 (0x8) |  |  |  |
| 68 | BLAST_IMMUNE | C2.4 (0x10) |  |  |  |
| 69 | FIRE_IMMUNE | C2.5 (0x20) | Y | Y | Fire immune 1 s (Spy-cicle melt). |
| 70 | PREVENT_DEATH | C2.6 (0x40) |  |  |  |
| 71 | MVM_BOT_STUN_RADIOWAVE | C2.7 (0x80) |  |  |  |
| 72 | HALLOWEEN_SPEED_BOOST | C2.8 (0x100) |  |  |  |
| 73 | HALLOWEEN_QUICK_HEAL | C2.9 (0x200) |  |  |  |
| 74 | HALLOWEEN_GIANT | C2.10 (0x400) |  |  |  |
| 75 | HALLOWEEN_TINY | C2.11 (0x800) |  |  |  |
| 76 | HALLOWEEN_IN_HELL | C2.12 (0x1000) |  |  |  |
| 77 | HALLOWEEN_GHOST_MODE | C2.13 (0x2000) |  |  |  |
| 78 | MINICRITBOOSTED_ON_KILL | C2.14 (0x4000) | Y |  | Mini-crits on kill. |
| 79 | OBSCURED_SMOKE | C2.15 (0x8000) |  |  |  |
| 80 | PARACHUTE_ACTIVE | C2.16 (0x10000) | Y |  | B.A.S.E. Jumper chute open now. |
| 81 | BLASTJUMPING | C2.17 (0x20000) | Y | Y | Rocket/sticky jumping (Market Gardener, Air Strike, Mantreads). |
| 82 | HALLOWEEN_KART | C2.18 (0x40000) |  |  |  |
| 83 | HALLOWEEN_KART_DASH | C2.19 (0x80000) |  |  |  |
| 84 | BALLOON_HEAD | C2.20 (0x100000) |  |  |  |
| 85 | MELEE_ONLY | C2.21 (0x200000) |  |  |  |
| 86 | SWIMMING_CURSE | C2.22 (0x400000) |  |  |  |
| 87 | FREEZE_INPUT | C2.23 (0x800000) |  |  |  |
| 88 | HALLOWEEN_KART_CAGE | C2.24 (0x1000000) |  |  |  |
| 89 | DONOTUSE_0 | C2.25 (0x2000000) |  |  |  |
| 90 | RUNE_STRENGTH | C2.26 (0x4000000) |  |  |  |
| 91 | RUNE_HASTE | C2.27 (0x8000000) |  |  |  |
| 92 | RUNE_REGEN | C2.28 (0x10000000) |  |  |  |
| 93 | RUNE_RESIST | C2.29 (0x20000000) |  |  |  |
| 94 | RUNE_VAMPIRE | C2.30 (0x40000000) |  |  |  |
| 95 | RUNE_REFLECT | C2.31 (0x80000000) |  |  |  |
| 96 | RUNE_PRECISION | C3.0 (0x1) |  |  |  |
| 97 | RUNE_AGILITY | C3.1 (0x2) |  |  |  |
| 98 | GRAPPLINGHOOK | C3.2 (0x4) |  |  |  |
| 99 | GRAPPLINGHOOK_SAFEFALL | C3.3 (0x8) |  |  |  |
| 100 | GRAPPLINGHOOK_LATCHED | C3.4 (0x10) |  |  |  |
| 101 | GRAPPLINGHOOK_BLEEDING | C3.5 (0x20) |  |  |  |
| 102 | AFTERBURN_IMMUNE | C3.6 (0x40) | Y | Y | Afterburn immune (DR 3 s, Spy-cicle). |
| 103 | RUNE_KNOCKOUT | C3.7 (0x80) |  |  |  |
| 104 | RUNE_IMBALANCE | C3.8 (0x100) |  |  |  |
| 105 | CRITBOOSTED_RUNE_TEMP | C3.9 (0x200) |  |  |  |
| 106 | PASSTIME_INTERCEPTION | C3.10 (0x400) |  |  |  |
| 107 | SWIMMING_NO_EFFECTS | C3.11 (0x800) |  |  |  |
| 108 | PURGATORY | C3.12 (0x1000) |  |  |  |
| 109 | RUNE_KING | C3.13 (0x2000) |  |  |  |
| 110 | RUNE_PLAGUE | C3.14 (0x4000) |  |  |  |
| 111 | RUNE_SUPERNOVA | C3.15 (0x8000) |  |  |  |
| 112 | PLAGUE | C3.16 (0x10000) |  |  |  |
| 113 | KING_BUFFED | C3.17 (0x20000) |  |  |  |
| 114 | TEAM_GLOWS | C3.18 (0x40000) |  |  | Team glows (spawn). |
| 115 | KNOCKED_INTO_AIR | C3.19 (0x80000) | Y | Y | Knocked into the air by airblast. |
| 116 | COMPETITIVE_WINNER | C3.20 (0x100000) |  |  | Match winner (comp matchmaking summary only). |
| 117 | COMPETITIVE_LOSER | C3.21 (0x200000) |  |  | Match loser. |
| 118 | HEALING_DEBUFF | C3.22 (0x400000) | Y | Y | Reduced healing while burning (2 s, flames). |
| 119 | PASSTIME_PENALTY_DEBUFF | C3.23 (0x800000) |  |  |  |
| 120 | GRAPPLED_TO_PLAYER | C3.24 (0x1000000) |  |  |  |
| 121 | GRAPPLED_BY_PLAYER | C3.25 (0x2000000) |  |  |  |
| 122 | PARACHUTE_DEPLOYED | C3.26 (0x4000000) | Y |  | Parachute used this airtime. |
| 123 | GAS | C3.27 (0x8000000) | Y |  | Gas Passer coating. |
| 124 | BURNING_PYRO | C3.28 (0x10000000) | Y |  | Dragon's Fury burn. |
| 125 | ROCKETPACK | C3.29 (0x20000000) | Y |  | Thermal Thruster flight. |
| 126 | LOST_FOOTING | C3.30 (0x40000000) | Y | Y | Lost footing (airblast). |
| 127 | AIR_CURRENT | C3.31 (0x80000000) | Y | Y | Air current (airblast). |
| 128 | HALLOWEEN_HELL_HEAL | C4.0 (0x1) |  |  |  |
| 129 | POWERUPMODE_DOMINANT | C4.1 (0x2) |  |  |  |
| 130 | IMMUNE_TO_PUSHBACK | C4.2 (0x4) |  |  |  |

### 2.3 Composite predicates (copy these exactly)

| predicate | definition | source |
|---|---|---|
| stealthed | 4 or 64 or 66 | `tf_player_shared.cpp:8102-8106` |
| invulnerable (uber skin) | 5 or 52 or 51 or 57. Skin +2 unless only 51 and no damage in the last 2 s | `:8089-8097`, `game/client/tf/c_tf_player.cpp:7785-7790` |
| crit boosted | 11, 33, 34, 35 (client only), 37, 38, 39, 40, 56, 105, or 44 with a primary weapon, or a health-threshold crit attribute | `:8046-8082` |
| crit glow on weapon | crit boosted or 19 or 46, not while stealthed, hidden on disguised enemies | `:7491-7510` |
| uber flicker | invulnerable and 8 | `c_tf_player.cpp:1805-1808` |

---

## 3. Spy cloak

### 3.1 Server rules

| item | value | source |
|---|---|---|
| cloak fade-in time | `tf_spy_invis_time` 1.0 s x `mult_cloak_rate` | `tf_player_shared.cpp:115, 6993-6999` |
| decloak fade-out time | `tf_spy_invis_unstealth_time` 2.0 s x `mult_decloak_rate` x caller scale | `:116, 7914-7962` |
| caller scales | watch toggle 1.0, meter empty 1.0, respawn 0.1, user-buff stealth 0.5 (2.0 if a spy gave it) | `game/shared/tf/tf_weapon_invis.cpp:226,280`, `tf_player_shared.cpp:14131`, `game/server/tf/tf_player.cpp:14709,16004` |
| blink | `TF_COND_STEALTHED_BLINK` for 0.3 s after taking more than 5 damage (any amount while bleeding) or an enemy bump, not during feign death; invisibility x0.85 | `tf_player_shared.cpp:214-215, 2986-2994, 7779-7798` |
| jarate on a cloaked spy | same x0.85 as blink | `:7982-7986` |
| meter drain | 10 /s (`tf_spy_cloak_consume_rate`) x consume factor | `:166, 14086-14135` |
| meter regen | 3.3 /s x regen factor, only while not cloaked | `:167, 14165-14172` |
| attack lockout after decloak | 2.0 s (`tf_spy_cloak_no_attack_time`) | `:168, 7958` |
| min meter to cloak | > 8 (standard), = 100 to arm the Dead Ringer | `tf_weapon_invis.cpp:228-251` |
| consume factor formula | `f < 1 ? 1/(2-f) : f` where f = `mult_cloak_meter_consume_rate` | `tf_weapon_invis.cpp:321-345` |

Watch types come from `set_weapon_mode` (`game/shared/tf/tf_weapon_invis.h:22-27, 66-68`), present in `items.json` as `wm`:

| watch | def | wm | cloak behaviour (from items_game attributes) |
|---|---|---|---|
| Invis Watch, Enthusiast's Timepiece, Quackenbirdt, Reissued Timepiece | 30, 212, 297, 947, 1205 | none | 10 s full drain, 30 s regen |
| Dead Ringer | 59 | 1 | feign death. consume 0.6 (=> 7.14 /s, 14 s), regen x1.5, no regen from ammo |
| Cloak and Dagger | 60 | 2 | motion cloak. regen x2.0, regen while standing still, drain scales with speed |

Dead Ringer flow: taking damage with `m_bFeignDeathReady` at 100 meter calls `SpyDeadRingerDeath` (`game/server/tf/tf_player.cpp:15674-15696`). It sets the meter to 50, fires a fake `player_death` with `death_flags & 0x20` (`TF_DEATH_FEIGN_DEATH`, `tf_shareddefs.h:1811`), spawns a fake ragdoll, then adds `TF_COND_FEIGN_DEATH` for 3 s. `OnAddFeignDeath` adds `STEALTHED`, `SPEED_BOOST` 3 s and `AFTERBURN_IMMUNE` 3 s (`tf_player_shared.cpp:7169-7190`). The cloak starts instantly: `m_flInvisChangeCompleteTime = now` (`:7002`).

Motion cloak (C&D): drain = `frametime * rate * min(speed^2 / maxSpeed^2, 1) * 1.5`, regen when the speed is 0 and the spy has not been exposed for 1 s (`:14090-14120`).

### 3.2 Client visibility (what the game actually renders)

`InvisibilityThink` (`tf_player_shared.cpp:7967-8031`) is memoryless. It depends only on the stealth state and `m_flInvisChangeCompleteTime`, both networked (`:576`). Other players' clients re-evaluate it on every network update of that player, which is every tick in STV (`:1414-1429, 1492-1497`); the local player runs it in `PreThink` (`game/client/tf/c_tf_player.cpp:5893-5896, 6106-6109`). Formula per tick:

```
t  = serverTick * 0.015
S  = cond(4) || cond(64) || cond(66)            // stealthed
C  = m_flInvisChangeCompleteTime                 // latest value at or before t
if (C > t)  inv = S ? 1 - (C - t) : (C - t) * 0.5
else        inv = S ? 1 : 0
if (S && C <= t && motionCloak && cloakMeter == 0)
            inv = remap(speed^2, 0, maxSpeed^2, 1, 0.5) // Cloak and Dagger, empty meter
if (cond(9) || cond(24)) inv *= 0.85            // blink, jarate
inv = clamp(inv, 0, 1)
```

Quirks that fall out of this:

- Cloak ramps linearly 0 to 1 over 1 s. Decloak starts at `(C-t)*0.5 = 1.0` and falls linearly to 0 over 2 s.
- The function ignores the current value. A spy who decloaks 0.5 s into a cloak (the minimum, `tf_weapon_invis.cpp:255-262`) jumps from 0.5 to 1.0, then fades out.
- Respawn uses scale 0.1, so `inv` starts at 0.1 and is 0 after 0.2 s.
- Without `m_flInvisChangeCompleteTime` (older parser), use the edges of cond 4: rising edge t0 gives `C = t0 + 1`, falling edge t1 gives `C = t1 + 2`, feign death gives `C = t0`.

`GetEffectiveInvisibilityLevel` (`c_tf_player.cpp:6801-6853`) then applies the viewer:

| viewer | cap | why |
|---|---|---|
| enemy of the spy | none, model not drawn at all when `inv >= 1` (`:6895`) | |
| teammate, spectator, STV, our demo viewer | `min(inv, 0.95)` (`tf_teammate_max_invis`, `:1702`) | `IsEnemyPlayer()` is false when the local team is spectator (`:5341-5366`) |
| victim in freezecam of its killer | 0.95 | `:6824-6838` |

Rendering is the `spy_invis` material proxy (`c_tf_player.cpp:1667-1765`). It sets `$cloakfactor = inv` and `$cloakColorTint` by the spy's real team: RED `(1.0, 0.5, 0.4)`, BLU `(0.4, 0.5, 1.0)` (`:1739-1747`). Wearables and the weapon copy the owner's value. For a placeholder, render opacity `1 - inv` with the tint. At 0.95 you get the faint team-tinted shimmer spectators see. The crit glow is suppressed while stealthed (`tf_player_shared.cpp:7504`). Medigun beams from a fully invisible medic are hidden (`game/shared/tf/tf_weapon_medigun.cpp:2400`).

---

## 4. Spy disguise

### 4.1 State and timing

| item | value | source |
|---|---|---|
| disguise time | 2.0 s, 0.5 s if already disguised, 0 for a targeted disguise (Your Eternal Reward kill) | `tf_shareddefs.h:674-675`, `tf_player_shared.cpp:8234-8247` |
| conds | `DISGUISING` (2) during, `DISGUISED` (3) after, `DISGUISE_WEARINGOFF` (47) for 0.5 s after removal | `:8231, 8283-8290, 8355-8368` |
| smoke | `spy_start_disguise_red` / `_blue` by the spy's real team, at abs origin. Shown to everyone but the local spy, hidden from enemies while the spy is cloaked | `:3350-3371` |
| sound | `Player.Spy_Disguise` on start and on removal | `:3368, 7247` |
| same-class shortcut | choosing your own team and class clears the disguise | `:8165-8170` |

### 4.2 Networked fields (`DT_TFPlayerShared`, `tf_player_shared.cpp:576-585`)

| field | meaning |
|---|---|
| `m_nDisguiseTeam` (3 bits) | team shown to enemies. 0 when not disguised |
| `m_nDisguiseClass` (4 bits) | class shown to enemies |
| `m_nMaskClass` | random 1..9, picked when disguised as a spy, the face on the fake spy's mask (`:8288-8291`) |
| `m_hDisguiseTarget` (EHANDLE) | player whose name enemies see. There is no `m_iDisguiseTargetIndex` in this code base (older builds used that name). Picked randomly from players of that team and class, else any player of that team, else null (`game/server/tf/tf_player.cpp:8601-8656`) |
| `m_iDisguiseHealth` | fake health enemies see. Target's current health at completion (class max if the target is dead), else random in [spy max/2, spy max]. Then follows fake heal/damage (`tf_player_shared.cpp:8301-8315, 2560, 2754`) |
| `m_hDisguiseWeapon` | a weapon entity built for the disguise, matching the target's weapon in the spy's current slot, primary on completion (`:8375-8470`) |
| `m_iDisguiseBody` | bodygroups for the disguise |
| `m_nDesiredDisguiseClass/Team` | local table, target of the disguise in progress |

### 4.3 What each viewer sees

| viewer | model | colors | name and health on hover | source |
|---|---|---|---|---|
| enemy | disguise class model (`ValidateModelIndex`) | disguise team skin | target's name, `m_iDisguiseHealth` of the disguise class max; a disguised "medic" shows 0% uber | `c_tf_player.cpp:8945-8995`, `game/client/tf/tf_hud_target_id.cpp:768-830`, `c_tf_player.cpp:9758-9762` |
| enemy, disguise class is spy | spy model with mask bodygroup | disguise team | "Enemy <mask class>" data line | `c_tf_player.cpp:9728-9737` |
| teammate, spectator, STV | real spy model, mask bodygroup on | real team; skin index `teamSkin + 4 + 2*(disguiseClass-1)` (teamSkin 0 RED, 1 BLU) gives the paper mask of the disguise class | real name and health, plus "Disguised as Friendly/Enemy <class>" | `c_tf_player.cpp:7805-7816, 9714-9727`, `tf_hud_target_id.cpp:806` |

For dribble.tf offer two modes: "true" (spectator view: spy model, a mask badge for class and team, real health) and "enemy eyes" (disguise class model in disguise team color, target's name, fake health). Crit glow is hidden on disguised enemies (`tf_player_shared.cpp:7506-7510, 7552-7557`).

---

## 5. Sniper

### 5.1 Scope, charge, FOV

| item | value | source |
|---|---|---|
| zoom FOV | absolute 20 (`TF_WEAPON_ZOOM_FOV`), 0.1 s blend; `fov_desired` is ignored while zoomed | `tf_shareddefs.h:399`, `game/shared/tf/tf_weaponbase_gun.cpp:1046-1090` |
| zoom conds | `ZoomIn` adds `ZOOMED` (1) and `AIMING` (0) and creates the dot; `ZoomOut` removes both and deletes the dot | `game/shared/tf/tf_weapon_sniperrifle.cpp:523-603` |
| zoom cooldown | 0.3 s (`TF_WEAPON_SNIPERRIFLE_ZOOM_TIME`) before charging starts | `:39, 371-372, 493` |
| charge rate | 50 dmg/s, clamp to [0, 100]/s after modifiers, max 150 | `:34, 375-384` |
| uncharge | 75 dmg/s when not aiming | `:35, 398-401` |
| min / max body damage | 50 / 150 | `:36-37, 872` |
| after a shot | unzoom after 0.5 s (fast_reload scales it), rezoom after 0.9 s if auto-rezoom; dot charge time resets | `:806-852` |
| no crit after zoom | 0.2 s | `:41, 1050` |
| jump | jumping unzooms and resets the charge; zooming in is refused mid-jump | `:359-369, 482-487` |
| viewmodel | hidden while `ZOOMED` | `game/client/tf/clientmode_tf.cpp:584-597` |
| Vertical FOV for three.js | `2*atan(tan(fov/2)*0.75)`: 20 -> 15.07, 75 -> 59.84, 90 -> 73.74 | see 10.4 |

Rifle variants (`set_weapon_mode`, `game/shared/tf/tf_weapon_sniperrifle.h:25-28,116`; attributes from items_game):

| rifle | def | wm | charge rate | notes |
|---|---|---|---|---|
| Sniper Rifle, reskins, AWPer Hand | 14, 201, 851, ... | 0 | 50/s | |
| Sydney Sleeper | 230 | 1 (RIFLE_JARATE) | x1.25 | jarate on hit, 2..5 s scaled by charge 50..150 (`jarate_duration 5`, `tf_weapon_sniperrifle.cpp:1228-1236`), no headshot crits, scope uses `HUD/sniperscope_numbers_jar` |
| Machina, Shooting Star | 526, 30665 | 2 (RIFLE_MACHINA) | 50/s | must be zoomed to fire, full charge penetrates, x1.15 full-charge damage, tracer |
| Classic | 1098 | 3 (RIFLE_CLASSIC) | 50/s | charges while holding fire, unscoped; `AIMING` only while `m_bCharging`; headshots need full charge; charge beam `tfc_sniper_charge_red/blue` |
| Bazaar Bargain | 402 | (decap class) | `50 + 12.5*(min(heads,6)-2)`: 25/s at 0 heads, 100/s at 6 | `tf_weapon_sniperrifle.cpp:1742-1745`, heads = `m_iDecapitations` |
| Hitman's Heatmaker | 752 | bt 6 | focus `TF_COND_SNIPERCHARGE_RAGE_BUFF` (46): dot charge x1.25, no unzoom after shot | `:1615-1619, 813-818` |

Classic flow (`tf_weapon_sniperrifle.cpp:1870-1965`): attack held adds `AIMING`, sets `m_bCharging` (networked, `:113`), creates the dot; release fires if on ground. Zoom is a separate toggle with no charge effect.

### 5.2 The dot (`CSniperDot`, class `env_sniperdot`)

| item | value | source |
|---|---|---|
| network | `m_flChargeStartTime` (SendPropTime), plus base `m_vecOrigin`, `m_hOwnerEntity` (sniper), `m_iTeamNum` | `tf_weapon_sniperrifle.cpp:1381-1388` |
| bounds | 8x8x8 box, not solid | `:1455-1458` |
| origin | server trace from `Weapon_ShootPosition` along eye angles, `MASK_SHOT & ~CONTENTS_WINDOW`, updated every frame (probe: ~50 updates/s) | `:964-998` |
| lifetime | created on zoom (or Classic charge start), deleted on unzoom | `:922-958` |
| charge start | reset at creation and after every shot | `:1412, 849-852` |
| wrangler dot | `CLaserDot` derives from `CSniperDot`, owner = engineer, same props | `game/shared/tf/tf_weapon_laser_pointer.h:25` |

Client drawing (`:1492-1648`), which is what the viewer should copy for third person:

- Position: the client re-traces from the owner's `EyePosition()` along `EyeAngles()` and backs off 4 units. The networked origin is only used when the owner is dormant. Using the networked origin is fine for us.
- Size: 6 units for other players' dots (2 in the owner's own first person, 4 scaled with distance for unscoped Classic charging).
- Brightness: two sprites, outer `size x size` at alpha 128, inner `size*s x size*s` at alpha 255, with `s = clamp(m_flChargedDamage / 150, 0.1, 1)` (`:1622-1645`). The fallback without charge data is `s = remap(t - m_flChargeStartTime, 0, 150/rate, 0.1, 1)`.
- Sprites: `effects/sniperdot_red.vmt`, `effects/sniperdot_blue.vmt` by dot team.
- Not drawn when the viewer is in third person (`:1655-1666`). We can ignore that.

### 5.3 Scope overlay (POV mode)

`CHudScope` draws the scope texture, `CHudScopeCharge` draws `HUD/sniperscope_numbers` (`_jar` for the Sydney Sleeper) and runs in spectator in-eye mode too (`game/client/tf/tf_hud_scope.cpp:162-225`). The `SniperRifleCharge` proxy scrolls the numbers strip: texture transform scale (1, 0.25), translate y = `(1 - charge/150) * 0.8 + 0.6` (`tf_weapon_sniperrifle.cpp:1320-1362`). A vertical 0..100% gauge beside the crosshair, filled from `m_flChargedDamage`, reproduces it.

### 5.4 Huntsman and other bows

| item | value | source |
|---|---|---|
| charge | `min(t - m_flChargeBeginTime, 1)` / `GetChargeMaxTime()` (1 s x fire-rate attrs); begin time 0 = not drawn | `game/shared/tf/tf_weapon_compound_bow.cpp:269-287` |
| cond | `AIMING` while drawn | `:251, 348, 376` |
| arrow speed / gravity | `remap(charge, 0, max, 1800, 2600)` u/s, gravity `remap(.., 0.5, 0.1)` | `:306-317` |
| damage | 50 + base*charge fraction | `:292-300` |
| overdraw | after 5 s drawn: shaking idle anims and +-6 deg random spread | `:57, 400-420, 489-499` |
| lit arrow | `m_bArrowAlight` on the bow and the arrow | `:33-37, 125, 592-605` |

---

## 6. Medic

### 6.1 Medigun types

Type = `set_weapon_mode`, charge = `set_charge_type` (`game/shared/tf/tf_weapon_medigun.cpp:781-835`). Enums: `tf_weapon_medigun.h:23-35`, `tf_shareddefs.h:587-598`.

| family | item def indices (all from items_game) | wm | ct | uber cond | wearing off |
|---|---|---|---|---|---|
| Medi Gun (uber) | 29, 211, 663 festive, 796, 805, 885, 894, 903, 912, 961, 970 botkillers, 15008, 15010, 15025, 15039, 15050, 15078, 15097, 15120, 15121, 15122, 15145, 15146 war paints | 0 | 0 | `INVULNERABLE` (5) | `INVULNERABLE_WEARINGOFF` (8), 1 s |
| Kritzkrieg | 35 | 0 | 1 | `CRITBOOSTED` (11, in `_condition_bits`) | none |
| Quick-Fix | 411 | 2 | 2 | `MEGAHEAL` (28), medic heals himself during it | none |
| Vaccinator | 998 | 3 | 3 + `m_nChargeResistType` | `MEDIGUN_UBER_BULLET/BLAST/FIRE_RESIST` (58/59/60), passive 61/62/63 | none |

Effect table: `tf_weapon_medigun.cpp:49-70`. Rates (`:73-90`): full charge 40 s of healing (`weapon_medigun_charge_rate`), release 8 s (`weapon_medigun_chargerelease_rate`), Vaccinator 4 chunks of 25%, each pop lasts 3 s (`weapon_vaccinator_resist_duration`). Charge multipliers from attributes: Kritz x1.25, Quick-Fix x1.1, Vaccinator x1.67 (x0.67 on overhealed patients).

Network (`:120-168`): `m_hHealingTarget`, `m_bHealing`, `m_bAttacking`, `m_bChargeRelease`, `m_bHolstered`, `m_nChargeResistType` (0 bullet, 1 blast, 2 fire), `m_hLastHealingTarget`, `m_flChargeLevel` 0..1. `CTFPlayerResource.m_iChargeLevel[player]` gives 0..100 for every medic without walking weapons (`game/server/tf/tf_player_resource.cpp:31`).

### 6.2 Visuals and colors

| effect | particle / skin | source |
|---|---|---|
| beam | `medicgun_beam_red` / `_blue`; `_invun` while `m_bChargeRelease`; `medicgun_beam_machinery` on buildings (Rescue Ranger style) | `tf_weapon_medigun.cpp:2412-2455` |
| full charge glow on gun | `medicgun_invulnstatus_fullcharge_red/blue` | `:2150-2160` |
| uber | invuln skins (skin +2), flicker during 8 | section 2.3 |
| kritz | weapon crit glow `critgun_weaponmodel_red/blu` on the patient and medic | `tf_player_shared.cpp:7568-7575` |
| quick-fix | `medic_megaheal_red` / `_blue` | `:6417-6421` |
| vaccinator | `vaccinator_red_buff1..3`, `vaccinator_blue_buff1..3` (bullet, blast, fire) | `:4727-4735` |
| overheal | `overhealedplayer_red_pluses` / `_blue_pluses` | `c_tf_player.cpp:10056-10063` |

HUD colors: use the project's HUD team colors (RED `#b8383b`, BLU `#5885a2`). `player_chargedeployed` (`userid`, `targetid`) marks pops (`tf_weapon_medigun.cpp:1920-1929`). `medic_death` carries `charged`.

---

## 7. Engineer buildings

### 7.1 Types and modes

`m_iObjectType`: 0 dispenser, 1 teleporter, 2 sentry, 3 sapper (`tf_shareddefs.h:1366-1383`). `m_iObjectMode`: teleporter 0 entrance / 1 exit; sentry 0 normal / 1 disposable (MvM); sapper 0 normal (`:1387-1404`). Mini sentry is `m_bMiniBuilding` with the Gunslinger (`game/server/tf/tf_obj.cpp:1486-1516`).

Client classes in demos: `CObjectSentrygun`, `CObjectDispenser`, `CObjectTeleporter`, `CObjectSapper`, plus `CObjectCartDispenser` (the payload cart's dispenser, map placed).

### 7.2 Shared `DT_BaseObject` props (`tf_obj.cpp:158-185`)

`m_iHealth`, `m_iMaxHealth`, `m_bHasSapper`, `m_iObjectType`, `m_bBuilding`, `m_bPlacing`, `m_bCarried`, `m_bCarryDeploy`, `m_bMiniBuilding`, `m_flPercentageConstructed` (8 bits, 0..1), `m_fObjectFlags`, `m_hBuiltOnEntity`, `m_bDisabled`, `m_hBuilder`, `m_vecBuildMins/Maxs`, `m_iUpgradeLevel`, `m_iUpgradeMetal`, `m_iUpgradeMetalRequired`, `m_iHighestUpgradeLevel`, `m_iObjectMode`, `m_bDisposableBuilding`, `m_bWasMapPlaced`, `m_bPlasmaDisable`. Owner engineer: `m_hBuilder`. Carried state on the player: `m_bCarryingObject`, `m_hCarriedObject` (`tf_player_shared.cpp:561-562`).

### 7.3 Health, size, timing

| building | L1 / L2 / L3 max health | hull (mins..maxs) | source |
|---|---|---|---|
| sentry | 150 / 180 / 216 (x1.2 per level) | (-20,-20,0)..(20,20,66) for every level | `game/server/tf/tf_obj_sentrygun.h:31`, `tf_obj.cpp:57, 3808-3823`, `tf_obj_sentrygun.cpp:48-49, 2146-2150` |
| mini sentry | 100, starts at 50, level 1 only, model scale 0.75 (hull 30x30x49.5) | | `tf_obj_sentrygun.h:33`, `tf_obj_sentrygun.cpp:66-67, 366-380` |
| dispenser | 150 / 180 / 216 | (-20,-20,0)..(20,20,55); heal/ammo trigger (-70,-70,0)..(70,70,50) | `game/server/tf/tf_obj_dispenser.h:19`, `tf_obj_dispenser.cpp:24-31` |
| teleporter | 150 / 180 / 216 | (-24,-24,0)..(24,24,12) | `game/server/tf/tf_obj_teleporter.h:26`, `tf_obj_teleporter.cpp:34-35` |
| sapper | 100 | 1x1x1, parented to the building | `game/server/tf/tf_obj_sapper.h:15`, `tf_obj_sapper.cpp:27-28` |

`m_iMaxHealth` is networked, so attribute changes (`mult_engy_building_health`) are already applied.

Sentry gun pivot heights (eye offsets): L1 32, L2 40, L3 46 (`tf_shareddefs.h:1351-1353`). Good placeholder proportions: L1 box about 40 tall with the gun at 32, L2 about 50 with two barrels, L3 about 60 with the rocket pod (estimate).

Construction: `m_flPercentageConstructed` is the truth. Rate = `(maxHealth - 0.1) / totalTime` per second x construction multiplier (1 + wrench hit values + carry-deploy bonus), health rises with it, minis at half rate (`tf_obj.cpp:2092-2147, 2178-2211`). The base `BuildTime` and `UpgradeDuration` live in `scripts/objects.txt`, which is not in the SDK or in GameTracking. The TF2 wiki lists about 10.5 s for a sentry, 21 s for dispensers and teleporters and 4.2 s for a mini sentry (the Gunslinger's `sentry_build_rate_multiplier 2.5` matches 10.5/2.5). Unverified here.

Upgrades: `StartUpgrading` increments `m_iUpgradeLevel` at the start of the animation (`tf_obj.cpp:3010-3030`). During the animation: sentry `m_iState = 3`, dispenser `m_iState = 1`, teleporter `m_iState = 7`. The sentry model also switches to `sentryN_heavy.mdl` while building or upgrading and back to `sentryN.mdl` after (`tf_obj_sentrygun.cpp:38-44, 530-595`; probe shows these model names). Upgrade cost 200 metal (`tf_shareddefs.h:1350`), `m_iUpgradeMetal` progress.

### 7.4 Sentry behaviour and aim

| item | value | source |
|---|---|---|
| states | 0 inactive, 1 searching, 2 attacking, 3 upgrading (`m_iState`) | `tf_shareddefs.h:1508-1519` |
| range | 1100 u (`SENTRY_MAX_RANGE`) | `tf_obj_sentrygun.h:35` |
| idle sweep | +-50 deg around the build yaw, random pitch -10..10 at 30% of turns | `tf_obj_sentrygun.cpp:404-420, 1744-1763` |
| disabled / sapped / wrangler shield idle | pitch goal 30 (barrel droops) | `:1725-1729` |
| pitch clamp when tracking | -50..50 | `:1246-1252` |
| turn rate | base 6: yaw accelerates 30 -> 60 deg/s idle, up to 180 deg/s tracking; pitch 30 deg/s; minis x1.35 (int 8); wrangled x100 (effectively instant) | `:1805-1945` |
| fire interval | L1 0.2 s, L2/L3 0.1 s, x0.5 wrangled, x0.75 mini | `:1269-1296` |
| rockets (L3) | every 3 s (2.25 s wrangled) | `:1360-1376` |
| bullet damage | 16 (mini 8) | `:134-135` |
| ammo | shells 150 / 200 / 200, rockets 20 | `tf_shareddefs.h:1354-1357` |

Sentry props (`:112-126`): `m_iAmmoShells`, `m_iAmmoRockets`, `m_iState`, `m_bPlayerControlled` (wrangled), `m_nShieldLevel` (0 none, 1 wrangler shield), `m_hEnemy`, `m_hAutoAimTarget`. Kills/assists are local data.

Aim is not networked as angles. It travels in the `DT_BaseAnimating` pose parameters (8 bits, 0..1) named `aim_pitch` and `aim_yaw` (`tf_obj_sentrygun.cpp:2130-2131`):

- pitch pose = `-currentPitch`, yaw pose = `-(currentYaw - buildYaw)` (`:1851, 1932-1936`).
- Normalization uses the model's pose ranges, which are not in source. Probe values: index 1 sweeps the full 0..1 range, index 0 spans 0.118..1, both start at 0.502. My reading is yaw over [-180, 180] and pitch over [-50, 50] (the code clamp). Verify per model: the pose that oscillates by +-50 deg during `m_iState == 1` is yaw. When `m_iState == 2`, the gun points at `m_hEnemy`'s center, which gives a calibration target.
- Muzzle flash and tracers come as `EffectDispatch` `"TF_3rdPersonMuzzleFlash_SentryGun"` and `"Tracer"` (probe: 201 each).

Wrangler shield: damage x0.33 while shielded, repair and ammo from wrenches also x0.33 (`game/server/tf/tf_obj.h:61-67`, `tf_obj_sentrygun.cpp:615-695, 1974`). After the engineer stops wrangling the sentry stays disabled 3 s (`WRANGLER_DISABLE_TIME`, `:71, 872-873`). The laser is a `CLaserDot` owned by the engineer.

### 7.5 Dispenser, teleporter, sapper

| entity | props | rules |
|---|---|---|
| dispenser | `m_iState` (0 idle, 1 upgrading), `m_iAmmoMetal` (max 400; mini 200), `healing_array` of EHANDLEs (`tf_obj_dispenser.cpp:63-70`) | beams to each entry of `healing_array` |
| teleporter | `m_iState` 0 building, 1 idle (no match), 2 ready, 3 sending, 4 receiving, 5 receiving release, 6 recharging, 7 upgrading; `m_flRechargeTime` (absolute), `m_flCurrentRechargeDuration`, `m_iTimesUsed`, `m_flYawToExit`, `m_bMatchBuilding` (`tf_obj_teleporter.cpp:50-55`, `tf_shareddefs.h:1488-1496`) | recharge 10 / 5 / 3 s by level (`:41-46`); 0.25 s fade out + 0.25 s fade in; player arrives 20 u above; arrival glow 12 s via cond 6 (`:71-80`). Model swaps to `teleporter_light.mdl` when active (probe) |
| sapper | `CObjectSapper`, `m_hBuiltOnEntity` = building; building gets `m_bHasSapper` and `m_bDisabled` | drains 25 hp/s (`obj_sapper_amount`, `tf_obj_sapper.cpp:43, 494`). Red-Tape Recorder 810/831: no damage, reverses construction/level (`sapper_degenerates_buildings 0.5`). Sentry sapped particle `sapper_sentry1_fx` (`tf_player_shared.cpp:4408`) |

Events: `player_builtobject`, `player_upgradedobject`, `player_carryobject`, `player_dropobject`, `object_destroyed`, `player_sapped_object`, `player_teleported` (`tf_obj.cpp:1440, 2895, 3626, 1379, 2371`, `tf_obj_sapper.cpp:198`, `tf_obj_teleporter.cpp:1145`).

---

## 8. Other class mechanics that are visible

### 8.1 Pyro

Flamethrower `m_iWeaponState` (`game/shared/tf/tf_weapon_flamethrower.h:31-38`): 0 idle (pilot light), 1 start firing (0.16 s), 2 firing, 3 airblast (`FT_STATE_SECONDARY`). Props: `m_iWeaponState`, `m_bCritFire`, `m_bHitTarget`, `m_flChargeBeginTime` (Dragon's Fury pressure), and the local `m_iActiveFlames`, `m_hFlameManager` (`tf_weapon_flamethrower.cpp:183-210`). Probe: states 0/1/2/3 all present.

| item | value | source |
|---|---|---|
| airblast | enter state 3, `ACT_VM_SECONDARYATTACK`, particle `pyro_blast` at the muzzle; 0.75 s to next airblast, 1.0 s to next primary; costs 20 ammo x `mult_airblast_cost` | `:965-1036, 2334-2343` |
| airblast cone | 35 deg | `:63` |
| reflects | `object_deflected` event: `userid` (pyro), `ownerid`, `weaponid` (0 = player pushed), `object_entindex`; the projectile flips `m_iTeamNum` and owner and increments `m_iDeflected` (grenades also set `m_hDeflectOwner`, `m_hThrower`, `m_hLauncher`; probe) | `game/shared/tf/tf_weaponbase.cpp:6020-6036`, `tf_weapon_flamethrower.cpp:1836` |
| flames | one `CTFFlameManager` per pyro, networked (`m_bIsFiring`, spawn times, seed, speed 2450, drag 8.5, lifetime 0.6 s, up 50 from item static attrs). Points decay with `v -= dt*drag*v`, so reach is about `2450/8.5 * (1 - e^-5.1)` = 286 u | `game/shared/tf/tf_flame.cpp:61-86`, `game/shared/tf/tf_point_manager.cpp:23-25, 369-372` |
| afterburn | `BURNING` (22), 4 dmg every 0.5 s, max 10 s, `HEALING_DEBUFF` (118) during | `tf_shareddefs.h:664-667`, `tf_player_shared.cpp:6652` |

Flare guns (`set_weapon_mode`, `game/shared/tf/tf_weapon_flaregun.h:23-29`): 0 Flare Gun (39, 1081 festive), 1 Detonator (351, detonates on alt fire), 2 Manmelter (595, `tf_weapon_flaregun_revenge`, revenge crits from extinguishes), 3 Scorch Shot (740, knockback). All fire `tf_projectile_flare`: 2000 u/s, gravity 0.3 (Manmelter x1.5 speed and gravity), crit trail `flaregun_trail_crit_red/blue` (`game/server/tf/tf_projectile_flare.cpp:19-20, 86-92`, `game/client/tf/c_tf_projectile_flare.cpp:72-82`). Dragon's Fury: `tf_projectile_balloffire`, 3000 u/s, 0.5 s max life, 22.5 u radius (`game/shared/tf/tf_projectile_dragons_fury.cpp:33-40`). Gas Passer: `tf_projectile_jar_gas` 2000 u/s, cond 123. Thermal Thruster: cond 125.

### 8.2 Heavy

Minigun `m_iWeaponState` (`game/shared/tf/tf_weapon_minigun.h:27-35`): 0 idle, 1 start firing (spin-up 0.75 s x `mult_minigun_spinup_time`: Natascha 1.3, Brass Beast 1.5, Tomislav 0.8), 2 firing, 3 spinning (attack2), 4 dry fire. `AIMING` (0) from wind-up until wind-down (`tf_weapon_minigun.cpp:35, 251-290, 749-778, 860-866`). `m_bCritShot`. The minigun does no viewmodel muzzle flash (`tf_weapon_minigun.h:78`); its bullets arrive as `TE_FireBullets` with `m_iWeaponID 18` (probe: 680 events). Huo-Long Heater keeps a fire ring while spun. Sandvich/steak: `tf_weapon_lunchbox`, `m_bBroken` (`tf_weapon_lunchbox.cpp:30-32`); Buffalo Steak adds `ENERGY_BUFF` + `CANNOT_SWITCH_FROM_MELEE` (`:399-400`).

### 8.3 Demoman

| item | value | source |
|---|---|---|
| charge | `SHIELD_CHARGE` (17), meter `m_flChargeMeter` (networked, 0..100) drains 100 in 1.5 s x `mod_charge_time`, regen 8.3 /s x `charge_recharge_rate` (Splendid Screen 1.5) | `tf_player_shared.cpp:176-177, 6016-6060` |
| charge crits | `CRITBOOSTED_DEMO_CHARGE` (35) while charging with meter < 75, kept 0.3 s after; melee hit at meter <= 40 crits, <= 75 mini-crits (Tide Turner: mini-crit only) | `:6124-6144, 6236-6257` |
| heads | `m_iDecapitations` (networked, 8 bits), `DEMO_BUFF` (18) eye glow | `:558`, `game/shared/tf/tf_weapon_sword.cpp:350-363` |
| shields | Chargin' Targe 131, Splendid Screen 406, Tide Turner 1099, Festive Targe 1144 (`tf_wearable_demoshield`, no viewmodel) | items_game |
| stickies | `CTFGrenadePipebombProjectile` with `m_iType 1`; `demoman_det_stickies` event on detonation (probe: 109) | |
| loch / iron bomber / loose cannon | barrel state `m_iCurrentTube`, `m_iGoalTube` on the launcher; Loose Cannon fires `m_iType 3` cannonballs | `game/shared/tf/tf_weapon_grenadelauncher.cpp:54-60` |

### 8.4 Scout

| item | value | source |
|---|---|---|
| Bonk! (46, 1145) | `PHASE` (14) for `100/12.5 + 1` s cap, really 8 s as the drink meter drains 12.5/s; afterwards a 5 s slow of 25..50% if damage was dodged | `tf_player_shared.cpp:172-174`, `tf_player.cpp:18636-18655`, `tf_player_shared.cpp:3550-3575` |
| Crit-a-Cola (163) | `ENERGY_BUFF` (19), 8 s; attacking adds `MARKEDFORDEATH_SILENT` (48) 5 s | `tf_player.cpp:18648`, `tf_player_shared.cpp:4643-4654` |
| drink meter | `m_flEnergyDrinkMeter` 0..100, regen 3.3 /s | `:172, 569` |
| hype | `m_flHypeMeter` (Soda Popper `SODAPOPPER_HYPE` 36, Baby Face's boost) | `:570` |
| Mad Milk (222, 1121) | `MAD_MILK` (27) | |
| Sandman (44) ball | `tf_projectile_stun_ball` 3000 u/s, `STUNNED` (15) with flags | `game/shared/tf/tf_weapon_bat.cpp:107-109` |
| Wrap Assassin (648) | `tf_projectile_ball_ornament`, gravity 0.4, about 5 u (probe), bleed | |
| Flying Guillotine (812, 833) | `tf_projectile_cleaver`, 3000 u/s, causes bleed | `game/shared/tf/tf_weapon_jar.cpp:906-915` |
| air jumps | `m_iAirDash` (Atomizer triple jump), `DOUBLEJUMP` anim event | `tf_player_shared.cpp:540` |
| capture value | scouts count 2 (Pain Train +1) for cap rate and cart cappers | `game/shared/tf/tf_gamerules.cpp:18121-18158` |

### 8.5 Soldier

Banners use `set_buff_type` (`items.json` `bt`) mapped by `g_SoldierBuffAttributeIDToConditionMap` (`tf_player_shared.cpp:264-273`): 1 Buff Banner -> `OFFENSEBUFF` 16, 2 Battalion's Backup -> `DEFENSEBUFF` 26, 3 Concheror -> `REGENONDAMAGEBUFF` 29, 4 unused, 5 Phlogistinator -> `CRITBOOSTED_RAGE_BUFF` 44, 6 Hitman's Heatmaker -> `SNIPERCHARGE_RAGE_BUFF` 46. Rage fills `m_flRageMeter` (local table, present in STV). On deploy, `deploy_buff_banner` fires (`buff_type`, `buff_owner`; `game/shared/tf/tf_weapon_buff_item.cpp:239-250`). The buff pulses every 1 s for 10 pulses (`tf_shareddefs.h:2760-2769`, `tf_player_shared.cpp:13786-13803`), each pulse gives the cond for 1.2 s to living teammates within 450 u, skipping cloaked spies and own spies disguised as enemies. Phlogistinator and Heatmaker rage buff only their owner (`:13863-13925`). Soldier aura particle: `soldierbuff_red_soldier` / `_blue_soldier` (`:4160-4180`).

Also visible: `BLASTJUMPING` (81, Market Gardener crits, Air Strike), Gunboats 133 and Mantreads 444 (`tf_wearable`), B.A.S.E. Jumper 1101 (`PARACHUTE_ACTIVE` 80, `PARACHUTE_DEPLOYED` 122, `m_bParachuteEquipped`), Cow Mangler charged shot (`m_bChargedShot` on `CTFProjectile_EnergyBall`, `game/server/tf/tf_projectile_energy_ball.cpp:39-41`), Righteous Bison rings.

### 8.6 Sniper extras

Jarate 58/1083/1105 -> `URINE` (24) up to 10 s; Razorback 57 (`tf_wearable_razorback`, blocks one backstab, recharges via `m_flItemChargeMeter`); Darwin's Danger Shield 231 and Cozy Camper 642 are passive wearables; Cleaner's Carbine 751 builds a meter then gives `ENERGY_BUFF`; Tribalman's Shiv 171 bleeds.

### 8.7 Spy extras

`m_bReadyToBackstab` on the knife raises the blade (probe: 6 toggles) (`game/shared/tf/tf_weapon_knife.cpp:32-40`). Spy-cicle 649: `m_bKnifeExists` false while melted, `m_flKnifeMeltTimestamp`, `m_flKnifeRegenerateDuration`; melting gives `FIRE_IMMUNE` 1 s and `AFTERBURN_IMMUNE` (`tf_weaponbase.cpp:5438-5446`). Your Eternal Reward 225/574: disguise on backstab (instant disguise), silent kills. Diamondback, Manmelter, Frontier Justice: `m_iRevengeCrits` (networked, 7 bits) and `CRITBOOSTED` in `_condition_bits` while firing them.

### 8.8 Kill feed rules worth copying

- Fake deaths (`death_flags & 0x20`) are shown only to the enemy team of the victim (`game/client/tf/hud_basedeathnotice.cpp:418-440`). A spectator never sees them. The viewer should hide them by default, and must not count them as deaths or spawn a death marker. The spy stays alive.
- Other `death_flags`: 0x1 domination, 0x2 assister domination, 0x4 revenge, 0x8 assister revenge, 0x10 first blood, 0x40 interrupted capture, 0x80 gibbed, 0x100 purgatory, 0x200 miniboss, 0x400 australium (`tf_shareddefs.h:1806-1816`).
- `weapon` in `player_death` is the item's `item_iconname` when set, else the weapon/projectile log name, with special cases for pipes, stickies, sappers, healing bolts (`crusaders_crossbow`) and Dragon's Fury (`game/shared/tf/tf_gamerules.cpp:12120-12680`).

---

## 9. Projectiles

`m_iProjectileType` / override values (`tf_shareddefs.h:545-581`): 0 none, 1 bullet, 2 rocket, 3 pipebomb, 4 sticky, 5 syringe, 6 flare, 7 jar, 8 arrow, 9 flame rocket, 10 jar milk, 11 healing bolt, 12 energy ball, 13 energy ring, 14 practice sticky, 15 cleaver, 16 sticky ball, 17 cannonball, 18 building repair bolt (Rescue Ranger), 19 festive arrow, 20 throwable, 21 spell, 22 festive jar, 23 festive healing bolt, 24 breadmonster jarate, 25 breadmonster madmilk, 26 grappling hook, 27 sentry rocket, 28 bread monster, 29 gas jar, 30 flame ball.

| demo client class | classname | discriminator | speed (u/s) | gravity | crit / team visual | placeholder mesh (estimate) |
|---|---|---|---|---|---|---|
| `CTFProjectile_Rocket` | `tf_projectile_rocket` | `m_hLauncher` -> item def (Direct Hit x1.8 = 1980, Liberty x1.4 = 1540, Air Strike, Black Box, Original, Beggar's) | 1100 x `mult_projectile_speed` (`game/shared/tf/tf_weaponbase_rocket.cpp:274-298`) | 0 | `m_bCritical` -> `critical_rocket_red/blue`; trail `rockettrail` (`game/client/tf/c_tf_projectile_rocket.cpp:162`) | 22 u long, 3.5 u diameter, nose cone |
| `CTFProjectile_SentryRocket` | `tf_projectile_sentryrocket` | owner sentry | 1100 | 0 | same as rocket | 16 u long |
| `CTFGrenadePipebombProjectile` | `tf_projectile_pipe`, `tf_projectile_pipe_remote` | `m_iType`: 0 pipe, 1 sticky, 2 practice sticky, 3 cannonball (`game/shared/tf/tf_weapon_grenade_pipebomb.h:22-28`); `m_bTouched`, `m_bDefensiveBomb` | pipe 1200 x mult (Loch-n-Load 1500, Loose Cannon 1440); sticky 900 -> 2400 over a 4 s charge (`tf_weapon_pipebomblauncher.h:21-29`) | VPhysics, `m_flGravity 0.4` (`tf_weaponbase_grenadeproj.cpp:245`) | `critical_pipe_*` for pipes, `critical_grenade_*` for stickies (`tf_weapon_grenade_pipebomb.cpp:310-336`) | pipe 8 u long, 4 u diameter (collision 4 u cube, `tf_shareddefs.h:2830-2831`); sticky 6 u sphere with spikes; cannonball 8 u sphere |
| `CTFProjectile_Arrow` | `tf_projectile_arrow` | `m_iProjectileType` 8 / 18 / 19 | bow 1800..2600, Rescue Ranger 2400 (`tf_weapon_shotgun.cpp:507-516`) | bow 0.5..0.1, Rescue Ranger 0.2 | `m_bCritical`, `m_bArrowAlight` | arrow 32 u shaft, 1 u thick; repair claw 12 u |
| `CTFProjectile_HealingBolt` | `tf_projectile_healing_bolt` | type 11 (23 festive), syringe model at scale 3 | 2400 (`tf_weapon_rocketlauncher.cpp:751-761`) | 0.2 (probe) | `crossbow_heal` event on heal hits | 18 u syringe (6 u x3) |
| `CTFProjectile_Flare` | `tf_projectile_flare` | launcher item def (section 8.1) | 2000 (x1.5 Manmelter) | 0.3 | `flaregun_trail_crit_*` | 6 u long, 2 u diameter |
| `CTFProjectile_Jar`, `_JarMilk`, `_JarGas` | `tf_projectile_jar`, `_jar_milk`, `_jar_gas` | | jar/milk 1000 fwd + 200 up (`tf_weapon_jar.cpp:84, 153-157`), gas 2000 | physics | splash particle on break | 8 u tall jar |
| `CTFProjectile_Cleaver` | `tf_projectile_cleaver` | | 3000 | physics | | 16 u blade |
| `CTFStunBall`, `CTFBall_Ornament` | `tf_projectile_stun_ball`, `tf_projectile_ball_ornament` | | 3000 (`tf_scout_stunball_base_speed`) | 0.4 (probe, ornament) | sprite trail `baseballtrail_*` (probe `CSpriteTrail`) | 3 u ball, 5 u ornament |
| `CTFProjectile_EnergyBall` | `tf_projectile_energy_ball` | `m_bChargedShot`, `m_vColor1/2` | 1100 (`tf_weapon_particle_cannon.cpp:72-75`) | 0 | | 8 u glowing sphere |
| `CTFProjectile_EnergyRing` | `tf_projectile_energy_ring` | Bison / Pomson | 1200, gravity 0 (`tf_weapon_raygun.cpp:214-223`) | 0 | | 20 u ring |
| `CTFProjectile_BallOfFire` | `tf_projectile_balloffire` | Dragon's Fury | 3000, life 0.5 s | 0 | | 22.5 u radius fireball |
| `CTFProjectile_MechanicalArmOrb` | `tf_projectile_mechanicalarmorb` | Short Circuit | unverified | 0 | | 10 u orb |
| none (EffectDispatch) | `tf_projectile_syringe` | `ClientProjectile_Syringe` effect | 1000 | 0.3 | crit `nailtrails_medic_*_crit` | 6 u needle |

Identify teams from `m_iTeamNum`, owners from `m_hOwnerEntity` / `m_hThrower` (grenades) / `m_hLauncher`. Explosions arrive as `TE_TFExplosion` (origin, normal, weapon id, entindex, item def `m_nDefID`; `tf_fx.cpp:136-145`).

---

## 10. Viewmodels

### 10.1 What the demo gives

`CTFViewModel` props (`game/shared/baseviewmodel_shared.cpp:559-575`): `m_nModelIndex`, `m_nBody`, `m_nSkin`, `m_nSequence` (8 bits), `m_nViewModelIndex` (0 main, 1 secondary hand, used by the spy watch), `m_flPlaybackRate`, `m_fEffects`, `m_nAnimationParity` (3 bits), `m_hWeapon`, `m_hOwner`, `m_nNewSequenceParity` (3 bits), `m_nResetEventsParity` (3 bits), `m_nMuzzleFlashParity` (2 bits), `m_flPoseParameter[24]`.

Models are per class, not per weapon: `c_scout_arms.mdl`, `c_soldier_arms.mdl`, ..., `c_engineer_gunslinger.mdl`, plus `v_pda_spy.mdl` and `v_watch_*_spy.mdl` (probe). The weapon is bonemerged onto the arms, and its item def comes from `m_hWeapon`.

### 10.2 How TF2 picks animations

Weapons call `SendWeaponAnim(ACT_VM_*)`. `TranslateViewmodelHandActivity` maps the base activity to a role activity, for example `ACT_VM_PRIMARYATTACK` -> `ACT_PRIMARY_VM_PRIMARYATTACK` for a primary, `ACT_SECONDARY_VM_*`, `ACT_MELEE_VM_*`, `ACT_ITEM1_VM_*`, `ACT_ITEM2_VM_*`, `ACT_PDA_VM_*`, `ACT_BUILDING_VM_*` (`game/shared/tf/tf_weaponbase.cpp:4194-4445`). Items can override with `anim_slot` and `animation_replacement` in items_game. Per weapon:

| action | activity | timing / signal | source |
|---|---|---|---|
| draw | `ACT_VM_DRAW` | deploy 0.5 s x `mult_deploy_time` (swords x1.75). Viewmodel playback rate = `1.34 / mult` (probe: 1.3125 is the 8-bit value of 1.34) | `tf_weaponbase.cpp:1237-1290` |
| idle | `ACT_VM_IDLE` loop | | |
| fire | `ACT_VM_PRIMARYATTACK` | muzzle flash parity +1 from `CTFWeaponBaseGun::PrimaryAttack` (not minigun, bow, flamethrower) (`tf_weaponbase_gun.cpp:357, 1008-1018`, `game/shared/baseplayer_shared.cpp:1771-1783`) | |
| alt fire | `ACT_VM_SECONDARYATTACK` | airblast, Sandman ball | `tf_weapon_flamethrower.cpp:980` |
| clip reload | `ACT_VM_RELOAD` | | |
| shell-by-shell reload | `ACT_RELOAD_START` -> `ACT_VM_RELOAD` per shell -> `ACT_RELOAD_FINISH`; weapon `m_iReloadMode` 0 idle/start, 1 reloading, 2 continue, 3 finish (networked, `tf_weaponbase.cpp:214`) | `tf_weaponbase.cpp:1956-2075`, `tf_weaponbase.h:63-66` | |
| minigun | `ACT_MP_ATTACK_STAND_PREFIRE` wind up, `m_iWeaponState` | `tf_weapon_minigun.cpp:755` | |
| flamethrower | `ACT_VM_PRIMARYATTACK` once, then loop; `ACT_MP_ATTACK_STAND_POSTFIRE` on release | `tf_weapon_flamethrower.cpp:604-608, 745-752` | |
| bow | `ACT_VM_PULLBACK` -> `ACT_ITEM2_VM_CHARGE`, idle variants after 5 s | `tf_weapon_compound_bow.cpp:395-420` | |

### 10.3 Can the sequence index alone tell fire from reload?

No, not without the MDL. Sequence numbers index the class arms model, so the same number means different activities on different classes. Combine these instead, in priority order:

1. `TE_PlayerAnimEvent` for the owner (`m_iEvent`, `game/shared/Multiplayer/multiplayer_animstate.h:23-76`): 0 ATTACK_PRIMARY, 1 ATTACK_SECONDARY, 2 ATTACK_GRENADE, 3 RELOAD, 4 RELOAD_LOOP, 5 RELOAD_END, 6 JUMP, 15 DOUBLEJUMP, 16 CANCEL, 17 SPAWN, 20 CUSTOM_GESTURE, 23 ATTACK_PRE, 24 ATTACK_POST, 29 VOICE_COMMAND_GESTURE, 30 DOUBLEJUMP_CROUCH, 31..33 STUN_BEGIN/MIDDLE/END, 40 ATTACK_PRIMARY_SUPER. Melee swings, projectile shots, hitscan shots and reload steps all emit these (probe: ATTACK_PRIMARY 6377, RELOAD_LOOP 176, ATTACK_PRE/POST from mediguns, miniguns and flamethrowers). The shooter is removed from the server filter (`tf_player.cpp:349-360`) but STV still records the event.
2. `m_hWeapon` change on viewmodel 0 = draw of the new weapon (scale the draw by the playback rate).
3. Weapon `m_iReloadMode` 1..3 and `m_iClip1` increments = reload phases, independent of the TE.
4. `m_nMuzzleFlashParity` change = a gun fired. It is 2 bits, so count `(new - old) & 3` per tick. Exact at 66 Hz snapshots for every TF2 fire rate.
5. `m_nNewSequenceParity` change = a new animation started (also fires on repeats of the same sequence, as with minigun loops).
6. `TE_FireBullets` (hitscan), new projectile entities whose owner/launcher is the player's weapon, `object_deflected` (airblast reflects).
7. Weapon state props: flamethrower and minigun `m_iWeaponState`, medigun `m_bHealing`, sniper `ZOOMED`, knife `m_bReadyToBackstab`, spy viewmodel 1 sequence changes for watch raise/lower.

A per-class table from sequence index to activity could be learned offline from many demos by labelling sequences with the signals above. The numbers stay stable for a given TF2 build. That would let real GLB animations plug in later.

### 10.4 Placement and FOV

| setting | value | source |
|---|---|---|
| `viewmodel_fov` default | 54, competitive clamp 54..70 that only Valve matchmaking turns on | `game/client/view.cpp:109-113`, `game/client/tf/tf_gc_client.cpp:1023` |
| demo playback | the TF2 client uses `viewmodel_fov_demo` (default 54) while playing a demo | `game/client/tf/clientmode_tf.cpp:569-578` |
| `fov_desired` | 75 default, 20..90 range | `clientmode_tf.cpp:114`, `game/shared/shareddefs.h:274` |
| common comp settings | `viewmodel_fov` 70..90, `tf_use_min_viewmodels 1`, many players run `r_drawviewmodel 0`; not stored in demos | community practice |
| FOV meaning | Source FOVs are horizontal at 4:3 and widened for wider screens: `fovH = 2*atan(tan(fov/2) * (aspect/(4/3)))` | `view.cpp:990-997, 1075-1084` |
| three.js vertical FOV | `2*atan(tan(fov/2) * 0.75)`: viewmodel 54 -> 41.8, 70 -> 55.4; world 90 -> 73.7 | derived |
| eye heights | scout 65, soldier/demo/pyro/engineer 68, sniper/medic/heavy/spy 75, duck 45 | `game/shared/tf/tf_gamerules.cpp:1311-1341` |
| left-handed | `m_bFlipViewModels` on the player (networked) mirrors the viewmodel | `game/server/tf/tf_player.cpp:818` |
| min viewmodels | extra offset `min_viewmodel_offset` (forward, right, up) per item, `items.json` `o` | `game/shared/tf/tf_viewmodel.cpp:196-224`, `tf_weaponbase.cpp:6839-6853` |
| zoomed | no viewmodel | `clientmode_tf.cpp:584-597` |

Render the viewmodel in its own scene with its own camera at the eye, depth cleared, so it never clips into walls. At 54 deg and 25 u forward the visible half height is 9.5 u and the half width at 16:9 is 17 u, which puts a grip at (fwd 25, right 9, up -7) at the lower right where TF2 weapons sit.

Placeholder silhouettes, eye-space anchor in Source units (forward, right, up), all estimates:

| `k` | silhouette | anchor | animation hooks |
|---|---|---|---|
| rocket_launcher | tube 40 x 7 dia on the shoulder | (20, 10, -6) | recoil 2 u back on fire, tube dips on reload loop |
| shotgun | receiver box + 30 u barrel | (24, 8, -9) | pump on fire, shell per RELOAD_LOOP |
| scattergun | 28 u double barrel | (24, 8, -9) | break-open on reload |
| pistol | 10 u L shape | (20, 7, -7) | small kick |
| revolver | 12 u with cylinder | (20, 7, -7) | hammer kick |
| smg | 16 u box with magazine | (22, 7, -8) | fast jitter while firing |
| sniper_rifle | 44 u barrel + scope tube | (26, 9, -9) | bolt cycle after shot, hide when zoomed |
| bow | 30 u tall arc, arrow along forward | (22, 6, -4) | string pulls back with charge |
| minigun | 6 barrels, 36 x 10 | (26, 6, -14) | spin speed from `m_iWeaponState` |
| flamethrower | 40 u tube + tank | (24, 8, -12) | flame cone while state 1/2, puff on state 3 |
| grenade_launcher | drum + 26 u tube | (24, 8, -10) | drum turn on fire |
| sticky_launcher | 30 u tube | (24, 8, -10) | barrel retracts with charge |
| medigun | 24 u box + nozzle | (24, 9, -10) | beam from nozzle to `m_hHealingTarget` |
| syringe_gun | 24 u tube with vials | (24, 8, -10) | rapid kick |
| crossbow | 24 u T shape | (24, 7, -9) | string reset after fire |
| knife | 10 u blade | (18, 8, -6) | blade up when `m_bReadyToBackstab` |
| watch | left wrist | (18, -10, -10) | rise on cloak/decloak (viewmodel 1) |
| sapper | 6 u box | (18, 7, -7) | |
| wrench | 18 u shaft + head | (20, 8, -8) | swing |
| melee_blunt / melee_blade | 24..26 u shaft | (20, 9, -8) | swing arc on ATTACK_PRIMARY |
| fists | two 5 u boxes | (20, +-8, -8) | alternate jabs |
| lunchbox | 6 u item | (18, 6, -7) | raise to mouth on taunt |
| jar | 6 x 8 cylinder | (18, 7, -7) | throw arc |
| banner | 10 u bugle | (20, 7, -7) | raise on deploy |
| pda | 12 x 8 tablet, both hands | (16, 0, -9) | |
| shield, parachute, other | none or a generic box | | |

---

## 11. `src/constants/items.json`

Built by `scripts/build-items.mjs` (not committed). Run:

```
node scripts/build-items.mjs \
  --items <items_game.txt> --lang <tf_english.txt> --proto-lang <tf_proto_obj_defs_english.txt> [--report]
```

Missing inputs are downloaded from `raw.githubusercontent.com/SteamDatabase/GameTracking-TF2/master/tf/...`. The parser follows `MergeDefinitionPrefab` + `RecursiveInheritKeyValues` (`game/shared/econ/econ_item_schema.cpp:2896-2965`): prefabs listed in `prefab` apply last to first, then the item's own keys, blocks merge deeply, keys are case-insensitive. Output: 517 weapons, 70 KiB minified.

| key | meaning |
|---|---|
| `n` | English name from `item_name` via tf_english; war paints get the paint name from `9_<paintkit>_field { field_number: 2 }` |
| `c` | schema `item_class` (before `TranslateWeaponEntForClass`) |
| `s` | default `item_slot`: primary, secondary, melee, pda, pda2, building, action |
| `u` | `used_by_classes` in TF class order |
| `k` | placeholder category (section 10.4) |
| `i` | kill icon basename present in `src/assets/kill_icons/` (direct, alias, or punctuation-insensitive match), omitted when no icon fits (mediguns, PDAs, watches, banners, drinks) |
| `cs` | per-class slot override, e.g. multi-class shotguns `{soldier: 'secondary', ...}` |
| `wm`, `ct`, `bt`, `pt` | `set_weapon_mode`, `set_charge_type`, `set_buff_type`, `override_projectile_type` |
| `o` | `min_viewmodel_offset` |

Included: every `tf_weapon_*` or `saxxy` item in a weapon or action slot, plus `tf_wearable*` items that occupy weapon slots (shields, Razorback, boots, Darwin's, Cozy Camper). Cosmetics, tools and taunts are skipped.

---

## 12. Game modes and HUD

### 12.1 Round state (`CTFGameRulesProxy`)

`DT_TeamplayRoundBasedRules` (`game/shared/teamplayroundbased_gamerules.cpp:107-125`): `m_iRoundState` (0 init, 1 pregame, 2 startgame, 3 preround, 4 running, 5 team win, 6 restart, 7 stalemate, 8 game over, 9 bonus, 10 between rounds; `teamplayroundbased_gamerules.h:44-79`), `m_bInWaitingForPlayers`, `m_iWinningTeam`, `m_bInOvertime`, `m_bInSetup`, `m_bSwitchedTeamsThisRound`, `m_flRestartRoundTime`, `m_flMapResetTime`, `m_nRoundsPlayed`, `m_flNextRespawnWave[team]`, `m_TeamRespawnWaveTimes[team]`, `m_bTeamReady[]`, `m_bStopWatch`, `m_bMultipleTrains`, `m_flStateTransitionTime`.

`DT_TFGameRules` (`game/shared/tf/tf_gamerules.cpp:1486-1550`): `m_nGameType` (0 undefined, 1 CTF, 2 CP, 3 escort, 4 arena, 5 MvM, 6 RD, 7 passtime, 8 PD; `tf_shareddefs.h:279-292`), `m_nHudType`, `m_bPlayingKoth`, `m_hRedKothTimer`, `m_hBlueKothTimer`, `m_nStopWatchState` (0 not set, 1 running, 2 overtime; `tf_gamerules.h:141-145`), `m_bStopWatchWinner`, `m_pszTeamGoalStringRed/Blue`, `m_bCompetitiveMode`, `m_bMatchEnded`.

Per-player HUD data in `CTFPlayerResource` (`game/server/tf/tf_player_resource.cpp:24-49`): `m_flNextRespawnTime[player]` (respawn countdowns), `m_iChargeLevel` (uber %), `m_iMaxHealth`, `m_iMaxBuffedHealth`, `m_iPlayerClass`, `m_iDamage`, `m_iHealing`, `m_iTotalScore`.

Teams (`CTFTeam`): `m_iScore`, `m_iRoundsWon`, `m_szTeamname`, `m_iRole` (0 none, 1 defenders, 2 attackers; `game/server/tf/tf_team.cpp:46`, `tf_shareddefs.h:71-78`), player list, object list (`game/server/team.cpp:41-48`).

Respawn waves are what make HL timing readable. Show each dead player's `m_flNextRespawnTime - t`.

### 12.2 Timers (`team_round_timer`, `CTeamRoundTimer`)

Props (`game/shared/teamplay_round_timer.cpp:140-155`): `m_bTimerPaused`, `m_flTimeRemaining`, `m_flTimerEndTime`, `m_nTimerMaxLength`, `m_bIsDisabled`, `m_bShowInHUD`, `m_nTimerLength`, `m_nTimerInitialLength`, `m_bAutoCountdown`, `m_nSetupTimeLength`, `m_nState` (0 setup, 1 normal; `game/shared/shareddefs.h:917-918`), `m_bStartPaused`, `m_bShowTimeRemaining`, `m_bStopWatchTimer`, `m_bInCaptureWatchState`, `m_flTotalTime`.

Remaining time (`:377-403`): stopwatch timer in capture-watch state shows `m_flTotalTime`; paused shows `m_flTimeRemaining`; else `m_flTimerEndTime - t`; clamp at 0. The HUD timer is the entity at `CTFObjectiveResource.m_iTimerToShowInHUD`.

### 12.3 Control points (A/D, 5CP, KOTH)

`CTFObjectiveResource` (always transmitted; `game/server/team_objectiveresource.cpp:25-67, 228-234`). Per-team arrays use `TEAM_ARRAY(point, team) = point + team * 8` (`game/server/team_objectiveresource.h:15`).

| prop | use |
|---|---|
| `m_iNumControlPoints`, `m_vCPPositions[8]`, `m_bCPIsVisible`, `m_iCPGroup` | layout |
| `m_iOwner[8]` | owner team |
| `m_iCappingTeam`, `m_iTeamInZone`, `m_iNumTeamMembers[64]`, `m_bBlocked` | live capture state |
| `m_flLazyCapPerc[8]` | time-remaining fraction, refreshed every 3 s only while capping (`LAZY_UPDATE_TIME`, `:20, 215-226`) |
| `m_flTeamCapTime[64]` | total cap time per point and team |
| `m_iTeamReqCappers`, `m_bTeamCanCap`, `m_iPreviousPoints`, `m_bCPLocked`, `m_flUnlockTimes`, `m_bInMiniRound`, `m_bPlayingMiniRounds` | which points are cappable |
| `m_iTeamIcons`, `m_iTeamOverlays`, `m_iTeamBaseIcons`, `m_iBaseControlPoints` | icons |
| `m_iStopWatchTimer` | stopwatch timer entity |

Cap progress is not streamed. The client integrates it (`game/client/c_team_objectiveresource.cpp:214-217, 264-278, 373-460`), and so must we:

- With `mp_capstyle 1` (default) `m_flTeamCapTime = area_time_to_cap * 2 * team_numcap` (`game/server/trigger_area_capture.cpp:1019-1030`).
- Rate while only the capping team is on the point: `H(v) = 1 + 1/2 + ... + 1/v` seconds per second, where v is the summed capture value (scout 2, others 1, Pain Train +1) (`trigger_area_capture.cpp:462-475`).
- Blocked (both teams on it): frozen. Nobody on it: progress decays so a full cap drains in `mp_capdeteriorate_time` = 90 s (`game/shared/teamplayroundbased_gamerules.cpp:201`), 6x faster in overtime.
- For seek determinism, start from the newest `m_flLazyCapPerc` change at or before t (or the `teamplay_point_startcapture` event) and integrate the per-tick `m_iNumTeamMembers` forward. That is at most 3 s of ticks.

Events: `teamplay_point_startcapture`, `teamplay_point_captured`, `teamplay_capture_blocked`, `teamplay_capture_broken`, `teamplay_point_locked`, `teamplay_point_unlocked`, `controlpoint_starttouch` / `endtouch` (probe), `teamplay_round_start`, `teamplay_round_win`, `teamplay_setup_finished`, `teamplay_timer_time_added`, `teamplay_update_timer`, `teamplay_game_over`.

KOTH (`tf_gamerules.cpp:19875-19947`): `tf_logic_koth` creates `zz_red_koth_timer` and `zz_blue_koth_timer` (initial length = `timer_length`, paused) and locks the point for `unlock_point` seconds. Map I/O resumes the owning team's timer on capture and pauses the other. Show both; `m_bTimerPaused` tells which runs. At 0 the owner wins unless the point is being capped (overtime).

5CP: symmetric, mid point neutral at start, `m_iPreviousPoints` and owners decide which points each team may cap. No HL map in this set uses it, but the same code paths apply.

### 12.4 Payload (`team_train_watcher`)

Watcher props (`game/server/team_train_watcher.cpp:132-139`): `m_flTotalProgress` (11 bits, 0..1), `m_iTrainSpeedLevel` (-1 rolling back, 0 stopped, 1..3 arrows), `m_flRecedeTime` (absolute time the cart starts rolling back, 0 when not pending), `m_nNumCappers` (capture value on the cart, -1 blocked), `m_hGlowEnt`.

| rule | value | source |
|---|---|---|
| push speed | `startspeed` x 0.55 (value 1), 0.77 (2), 1.0 (3+); downhill 1.0 | `:519-560`, `game/server/trains.cpp:1521-1528` |
| rollback | -0.1 x max speed after `train_recede_time` (map) or `tf_escort_recede_time` 30 s (5 s in overtime) without cappers | `:413-414, 660-690` |
| speed arrows | thresholds `hud_min_speed_level_1/2/3` from the map (HL maps: 1, 60, 80 u/s) | `:1115-1150` |
| checkpoints | `CTFObjectiveResource.m_flPathDistance[i]` = fraction of the track for each CP; owners from `m_iOwner` | probe: 0.251, 0.451, 0.718, 1.0 on Vigil |
| hills | `m_nNumNodeHillData[team]`, `m_flNodeHillData` (start/end fraction pairs), `m_bHillIsDownhill` | `team_objectiveresource.h:228-232` |

The cart itself is in the demo: `CFuncTrackTrain` (the train) and a `CPhysicsProp` or prop with `bomb_cart.mdl` (probe: 7580 origin updates, bounds about 124 x 62 x 99). Draw a placeholder box at that origin. `m_flTotalProgress` drives the HUD bar.

### 12.5 Stopwatch (competitive A/D: payload and cp_steel)

Requires `mp_tournament 1` and `mp_tournament_stopwatch 1` (default 1, `tf_gamerules.cpp:797`) and teams with roles. `ManageStopwatchTimer` (`:5236-5310`) creates `zz_stopwatch_timer` (`m_bStopWatchTimer = 1`, hidden from the HUD), registered in `m_iStopWatchTimer`.

- First half: `m_bInCaptureWatchState = 1`. The timer records the attackers' total time (`SetStopWatchTimeStamp` adds elapsed time per capture, `teamplay_round_timer.cpp:1167-1178`).
- Teams switch sides between halves: watch `m_bSwitchedTeamsThisRound` and players changing team at round restart. BLU attacks in both halves, so follow teams by SteamID, not by color.
- Second half: the timer counts down from the first-half time (`m_bInCaptureWatchState = 0`, `SetTime m_flStopWatchTotalTime`). The new attackers win by capping more points, or the same number faster (`StopWatchModeThink`, `tf_gamerules.cpp:5133-5230`). `m_nStopWatchState = 2` once the clock runs out (overtime). `m_bStopWatchWinner` flags the decided game.
- The serveme HL config sets `mp_winlimit 2` (probe SetConVar). Read as a best of three stopwatch games of two halves each, that is 4 to 6 halves per map. Confirm with `CTFTeam.m_iScore` / `m_iRoundsWon` on a full-match demo before relying on it.
- Probe on 1434434.dem (a first half): `m_bStopWatch 1`, `m_nStopWatchState 1`, stopwatch timer `m_bInCaptureWatchState 1`, `m_flTotalTime` 45.1 then 150.6 after captures, RED role 1 (defenders), BLU role 2 (attackers).

### 12.6 The Highlander maps on disk

From the BSP entity lumps (`scratchpad/tools/bsp_summary.py`). Cap times are `area_time_to_cap`; the effective single-capper time is `2 x time x numcap`.

| map | mode | objectives | timers and speeds |
|---|---|---|---|
| cp_steel_f12 | A/D, 5 points | A `cap_a_flag` 16, B 16, C 18, D 18, E `final_cap_flag` 35; BLU only; master `switch_teams 1`, `score_style 1`, `cpm_restrict_team_cap_win 2` | 360 s + 60 s setup |
| koth_ashville_final1 | KOTH | `cp_koth` 10, numcap 1 | `tf_logic_koth` 180 s, unlock 30 s |
| koth_product_final | KOTH | 3, numcap 2 | 180 / 30 |
| koth_proot_b5b | KOTH | 5.5, numcap 1 | 180 / 30 |
| koth_warmtic_f10 | KOTH | 6, numcap 2 | 180 / 30 |
| pl_divulgence_b4b | payload, 4 CPs | cart `sspl_train` 90 u/s, rollback after 4 s | 270 s + 70 s setup, max 600 |
| pl_downfall_b13 | payload, 3 CPs, last is "the Lift" (capture zone parented to `last_elevator_platform`, a second track train) | 90 u/s | 270 + 70, max 600 |
| pl_eruption_b15 | payload, 4 CPs | 90 u/s | 270 + 70, max 600 |
| pl_upward_f12 | payload, 4 CPs, one `team_control_point_round` | minecart 90 u/s, partial cap rate 0.02 | 330 + 70, max 600 |
| pl_vigil_rc10 | payload, 4 CPs | 80 u/s, rollback after 25 s | 270 + 70, max 600 |
| tow_tetsudo_b10c | Tug of War (community) | see 12.7 | 540 s, no setup |

### 12.7 Tug of War (tow_tetsudo_b10c)

Not a stock TF2 mode, and the SDK knows nothing about it. The map builds it from stock entities plus VScript packed in the BSP (`scripts/vscripts/towdistance.nut`, `plhud.nut`, `resource/ui/hudobjectivetow_tetsudo.res`):

- One cart, `func_tracktrain PL_Payload`, `startspeed 180`, starts at the middle point `CP_Center` (index 3, neutral). `CP_REDHQ` (index 1) is RED-owned, `CP_BLUHQ` (index 5) BLU-owned.
- Two capture areas ride on the cart: `Trigger_BLUCart` (BLU only) and `Trigger_REDCart` (RED only), both `area_time_to_cap 99999`, so the cap itself never completes. A 5 s countdown enables `CP_Init`.
- `team_train_watcher PL_Watcher` runs from `track1` (BLU side) to `track92` (RED side), recede off. Forward motion means BLU is pushing toward the RED base.
- Score: `tf_logic_player_destruction` serves as a scoreboard. Every think the script integrates the cart speed into `pos`. Each time a team pushes `convert` = 3149.35 units further than its previous best, it scores a point. The script notes "terminus: 314935", so the far end equals 100 points, and the PD logic's `min_points 100` ends the round.
- Overtime when the 540 s timer ends: the leading team wins after a 5 s countdown during which the other team does not push.
- The custom HUD reads script-written values smuggled through `water_lod_control` (`m_flCheapWaterStartDistance` for the cart marker) and `CWorld` `m_WorldMins/m_WorldMaxs` (countdowns, leader flag).

For the viewer: scores from `CTFPlayerDestructionLogic` `m_nRedScore`, `m_nBlueScore`, `m_nMaxPoints` (`game/shared/tf/tf_logic_robot_destruction.cpp:1449-1461`), cart position from the cart entity or `m_flTotalProgress` (0 BLU end, 1 RED end), plus the round timer. The map also has `red_train` / `blue_train` track trains with `dmg 9999` (the `train` kill icon exists).

---

## 13. Gaps and things easy to forget

- Feign deaths (`death_flags & 0x20`) must not count as deaths. They are fake and spectators never see them.
- OR `_condition_bits` into `m_nPlayerCond`, or kritz ubers and revenge crits disappear.
- Disguised spies need a deliberate viewer choice (true view vs enemy view), and crits on disguised spies are hidden in game.
- Stopwatch halves swap team colors. Track teams by SteamID for scores and names.
- Respawn timers (`m_flNextRespawnTime`) and uber percentages (`m_iChargeLevel`) come from the player resource, which saves walking weapons.
- Syringes and old Bison rings exist only as EffectDispatch. The base parser's projectile cache has types 1..4 only; arrows, flares, healing bolts, sentry rockets, jars, cleavers, balls, energy projectiles and fireballs are missing.
- Building HUD per engineer: level, health, `m_iAmmoShells`, `m_iAmmoRockets`, `m_iAmmoMetal`, upgrade metal, sapper and wrangler state.
- Sentry aim needs the pose parameter calibration in 7.4.
- Teleporter use: cond 6 for 12 s, `player_teleported` event, `m_iTimesUsed`.
- `m_flCloakMeter`, `m_flChargeMeter`, `m_flEnergyDrinkMeter`, `m_flHypeMeter` are full floats despite their bit counts (`SPROP_NOSCALE`).
- `scripts/objects.txt` (build and upgrade times) and the player class scripts are not in the SDK or GameTracking. Class max health is in `CTFPlayerResource.m_iMaxHealth`, so nothing needs it.
- The probe found `TF_COND_INVULNERABLE_HIDE_UNLESS_DAMAGED` (51) for exactly 5 s after spawns on serveme. It comes from outside the SDK code, so don't hard-code it as stock behaviour.
- `tow_tetsudo_b10c` requires reading `CTFPlayerDestructionLogic`, which the parser does not decode yet.
