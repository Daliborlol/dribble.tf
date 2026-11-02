// The world models of the models stage (asset contract 12.5 W-pack). Model paths only, no numbers from
// Valve files. `role` is a hint for the feature tasks; `clips` says which animations stay:
// 'sequences' keeps every clip a sequence uses (the reference pose `ref` aside), 'none' keeps none.
// `pak` names the map folder whose BSP PAK holds the model (source 'pak:<folder>').

const building = (model, extra = {}) => ({ model: `models/buildables/${model}.mdl`, role: 'building', clips: 'sequences', ...extra })
const projectile = (model, kind) => ({ model, role: `projectile:${kind}`, clips: 'none' })
const pickup = (model, kind) => ({ model, role: `pickup:${kind}`, clips: 'none' })
// Skinned prop_dynamic models that the older textured map GLBs (koth_product_final and the other
// textured_compressed.glb maps) bake in their reference pose. `refPose` keeps that pose in the node extras,
// so the runtime can turn those baked props into their default-sequence pose (src/assetpack/mapPropPoses.ts).
const mapProp = model => ({ model: `models/${model}.mdl`, role: 'mapprop', clips: 'none', refPose: true })

export const MODEL_LIST = [
  building('sentry1', { variants: { mini: { skins: [2, 3] } } }),
  building('sentry1_heavy'),
  building('sentry1_animations'), // the build sequence of sentry1_heavy (its include model)
  building('sentry2'),
  building('sentry2_heavy'),
  building('sentry3'),
  building('sentry3_heavy'),
  building('sentry3_rockets'),
  building('sentry1_blueprint'),
  building('dispenser'),
  building('dispenser_light'),
  building('dispenser_lvl2'),
  building('dispenser_lvl2_light'),
  building('dispenser_lvl3'),
  building('dispenser_lvl3_light'),
  building('dispenser_blueprint'),
  building('teleporter'),
  building('teleporter_light'),
  building('teleporter_blueprint_enter'),
  building('teleporter_blueprint_exit'),
  building('sapper_placed'),
  building('sapper_sentry1'),
  building('sapper_sentry2'),
  building('sapper_sentry3'),
  building('sapper_dispenser'),
  building('sapper_teleporter'),

  projectile('models/weapons/w_models/w_flaregun_shell.mdl', 'flare'),
  projectile('models/weapons/w_models/w_arrow.mdl', 'arrow'),
  projectile('models/weapons/w_models/w_repair_claw.mdl', 'repairBolt'),
  projectile('models/weapons/w_models/w_syringe_proj.mdl', 'syringe'),
  projectile('models/weapons/c_models/urinejar.mdl', 'jarate'),
  projectile('models/weapons/c_models/c_madmilk/c_madmilk.mdl', 'milk'),
  projectile('models/workshop_partner/weapons/c_models/c_sd_cleaver/c_sd_cleaver.mdl', 'cleaver'),
  projectile('models/weapons/w_models/w_baseball.mdl', 'stunBall'),
  projectile('models/weapons/c_models/c_xms_festive_ornament.mdl', 'ornament'),
  projectile('models/weapons/w_models/w_cannonball.mdl', 'cannonball'),

  pickup('models/items/medkit_small.mdl', 'health:small'),
  pickup('models/items/medkit_medium.mdl', 'health:medium'),
  pickup('models/items/medkit_large.mdl', 'health:large'),
  pickup('models/items/ammopack_small.mdl', 'ammo:small'),
  pickup('models/items/ammopack_medium.mdl', 'ammo:medium'),
  pickup('models/items/ammopack_large.mdl', 'ammo:large'),
  pickup('models/items/plate.mdl', 'health:medium'),
  pickup('models/items/plate_robo_sandwich.mdl', 'health:medium'),
  pickup('models/items/plate_sandwich_xmas.mdl', 'health:medium'),
  pickup('models/items/banana/plate_banana.mdl', 'health:small'),
  pickup('models/workshop/weapons/c_models/c_chocolate/plate_chocolate.mdl', 'health:small'),
  pickup('models/workshop/weapons/c_models/c_fishcake/plate_fishcake.mdl', 'health:small'),
  pickup('models/workshop/weapons/c_models/c_buffalo_steak/plate_buffalo_steak.mdl', 'health:medium'),

  { model: 'models/props_gameplay/resupply_locker.mdl', role: 'locker', clips: 'sequences', refPose: true },

  mapProp('props_gameplay/door_slide_large_dynamic'),
  mapProp('props_gameplay/door_slide_small_dynamic'),
  mapProp('props_well/main_entrance_door'),
  mapProp('props_2fort/lantern001'),
  mapProp('props_2fort/chimney007'),
  mapProp('props_ui/bannerflag_comp_l'),
  mapProp('props_ui/bannerflag_comp_r'),
  mapProp('props_ui/comp_win_banner'),
  mapProp('props_manor/spooky_eyes_01'),

  { model: 'models/props_trainyard/bomb_cart.mdl', role: 'cart', clips: 'none' },
  { model: 'models/props_trainyard/bomb_cart_red.mdl', role: 'cart', clips: 'none' },
  { model: 'models/props_tow/tow_cart.mdl', role: 'cart', clips: 'none', pak: 'tow_tetsudo_b10c' },
]
