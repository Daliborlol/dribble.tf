// settings.assets (asset contract 3.7). No imports from the store: store.ts imports this file.

export interface AssetSettings {
  /** Master switch, read when the pack resolves; off unmounts and disposes every pack item at once. */
  enabled: boolean
  /** props-stock.glb (wave 1). Applies at once; also needs highlander.map.staticProps. */
  stockProps: boolean
  /** Phase 2 textured maps. Applies on the next map load. */
  mapTextures: boolean
  /** Phase 3 world models (buildings, projectiles, map items, cart). Applies at once. */
  models: boolean
  /** Phase 4 viewmodels. Applies at once. */
  viewmodels: boolean
  /** as/mapfx: the 3D skybox of pack worlds, drawn around sky_camera behind the map. Applies at once. */
  skybox3d: boolean
  /** as/particles: TF2 particle systems for explosions, flamethrower flames and projectile trails. Applies at once. */
  particles: boolean
}

export const DEFAULT_ASSET_SETTINGS: AssetSettings = {
  enabled: true,
  stockProps: true,
  mapTextures: true,
  models: true,
  viewmodels: true,
  skybox3d: true,
  particles: true,
}

export type AssetSettingKey = keyof AssetSettings
