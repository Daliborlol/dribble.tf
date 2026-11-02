// What the viewmodels stage exports (asset contract 13). Model paths and public item definition indices only,
// no numbers read from Valve files.
//
// ARMS: the class's c_arms model; its sequences come from the models it includes ($includemodel), merged in
// Source's order (contract 13.2).
//
// WEAPON_DEFS: item definition indices whose c_model is bone-merged onto the arms. The stage resolves each to
// its model through the item schema (`model_player`, or `model_player_per_class` for the class) and keeps only
// items with `attach_to_hands`. Two sources:
//   - the stock weapons of every class and their "Upgradeable" copies;
//   - every def the 131 parseable local HL demos hold or fire: `players.weapon.def`, `players.vm0.weaponDef`
//     (`hl_extras --dump --groups players`) and `stats.fireByDef` (`hl_extras --json`), surveyed 2026-11-02.
//     Wearables and other non-weapons in it are skipped by the schema rule.

export const ARMS = {
  scout: 'models/weapons/c_models/c_scout_arms.mdl',
  soldier: 'models/weapons/c_models/c_soldier_arms.mdl',
  pyro: 'models/weapons/c_models/c_pyro_arms.mdl',
  demoman: 'models/weapons/c_models/c_demo_arms.mdl',
  heavy: 'models/weapons/c_models/c_heavy_arms.mdl',
  engineer: 'models/weapons/c_models/c_engineer_arms.mdl',
  medic: 'models/weapons/c_models/c_medic_arms.mdl',
  sniper: 'models/weapons/c_models/c_sniper_arms.mdl',
  spy: 'models/weapons/c_models/c_spy_arms.mdl',
}

export const STOCK_DEFS = [
  0, 13, 23, // scout
  18, 10, 6, // soldier
  21, 12, 2, // pyro
  19, 20, 1, // demoman
  15, 11, 5, // heavy
  9, 22, 7, 25, 26, 28, // engineer
  17, 29, 8, // medic
  14, 16, 3, // sniper
  24, 735, 4, 27, 30, // spy
  190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 736, 737,
]

export const DEMO_DEFS = [
  1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 24, 25, 26, 27, 28, 29, 35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 46, 56, 61,
  127, 129, 130, 132, 140, 141, 142, 153, 154, 155, 159, 160, 171, 172, 191, 192, 193, 194, 197, 199,
  200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 214, 215, 220, 224, 225, 226, 228, 232,
  237, 239, 264, 265, 294, 298, 304, 305, 311, 312, 317, 325, 326, 329, 331, 349, 351, 354, 355, 356,
  357, 401, 402, 404, 411, 412, 413, 414, 415, 416, 424, 425, 441, 447, 448, 449, 452, 457, 460, 461,
  466, 474, 513, 527, 574, 588, 589, 593, 594, 609, 648, 649, 654, 658, 664, 669, 730, 735, 736, 737,
  751, 752, 773, 775, 792, 799, 809, 810, 811, 813, 851, 863, 880, 883, 885, 887, 889, 894, 898, 900,
  901, 902, 903, 904, 906, 907, 908, 909, 913, 915, 933, 939, 957, 958, 959, 962, 963, 967, 974, 996,
  997, 998, 1002, 1003, 1004, 1005, 1006, 1007, 1013, 1078, 1079, 1080, 1081, 1084, 1086, 1092, 1098, 1100, 1102, 1104,
  1123, 1127, 1141, 1142, 1146, 1149, 1150, 1151, 1153, 1178, 1179, 1180, 1181, 1190, 1202, 1206, 15003, 15007, 15009, 15012,
  15021, 15022, 15029, 15045, 15047, 15049, 15053, 15054, 15070, 15078, 15098, 15103, 15107, 15109, 15110, 15126, 15132, 15133, 15144, 15154,
  30474, 30666, 30668,
]

export const WEAPON_DEFS = [...new Set([...STOCK_DEFS, ...DEMO_DEFS])].sort((a, b) => a - b)
