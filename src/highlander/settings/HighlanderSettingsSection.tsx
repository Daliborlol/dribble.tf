// The "Highlander" block of the settings panel (contract section 6.3). Every control writes through
// updateSettingsOptionAction('highlander.<path>', value).

import { get } from 'lodash'

import { SelectOption, SliderOption, ToggleOption } from '@components/UI/Shared/SettingsOptions'
import { useStore } from '@zus/store'
import { updateSettingsOptionAction } from '@zus/actions'
import { EFFECT_PRESETS, HighlanderSettings, type ViewStyle } from '@highlander/settings'
import { applyViewStyle, currentViewStyle, VIEW_STYLE_LABELS } from '@highlander/view/viewStyle'

type PresetKey = keyof typeof EFFECT_PRESETS

const PRESET_OPTIONS: { label: string; value: PresetKey }[] = [
  { label: 'Minimal', value: 'minimal' },
  { label: 'Standard', value: 'standard' },
  { label: 'Everything', value: 'everything' },
]

const DISGUISE_VIEW_OPTIONS: {
  label: string
  value: HighlanderSettings['players']['disguiseView']
}[] = [
  { label: 'Auto', value: 'auto' },
  { label: 'Spectator view', value: 'true' },
  { label: 'Enemy view', value: 'enemy' },
  { label: "POV player's view", value: 'pov' },
]

const DEAD_POV_OPTIONS: { label: string; value: HighlanderSettings['pov']['deadPov'] }[] = [
  { label: 'Follow spectated player', value: 'spectated' },
  { label: 'Stay', value: 'stay' },
]

const VIEW_STYLE_OPTIONS: { label: string; value: ViewStyle }[] = [
  { label: VIEW_STYLE_LABELS.analysis, value: 'analysis' },
  { label: VIEW_STYLE_LABELS.tf2, value: 'tf2' },
]

const PLATES_OPTIONS: { label: string; value: HighlanderSettings['view']['plates'] }[] = [
  { label: 'Nearest 12 and pinned', value: 'all' },
  { label: 'Followed, hovered, POV team', value: 'focus' },
]

const PLATE_TAGS_OPTIONS: { label: string; value: HighlanderSettings['view']['plateTags'] }[] = [
  { label: 'Always', value: 'always' },
  { label: 'For 2 s when they start', value: 'brief' },
  { label: 'Off', value: 'off' },
]

const BUILDING_LABEL_OPTIONS: { label: string; value: HighlanderSettings['view']['buildingLabels'] }[] = [
  { label: 'All', value: 'all' },
  { label: 'Followed engineer and hover', value: 'focus' },
]

const OBJECTIVE_MARKER_OPTIONS: { label: string; value: HighlanderSettings['view']['objectiveMarkers'] }[] = [
  { label: 'Full', value: 'full' },
  { label: 'Subtle', value: 'subtle' },
]

const update = (path: string, value: unknown) =>
  updateSettingsOptionAction(`highlander.${path}`, value)

/** The preset whose keys all match the current values, or 'custom'. */
const currentPreset = (hl: HighlanderSettings): PresetKey | 'custom' =>
  (Object.keys(EFFECT_PRESETS) as PresetKey[]).find(key =>
    Object.entries(EFFECT_PRESETS[key]).every(([path, value]) => get(hl, path) === value)
  ) ?? 'custom'

const applyPreset = (key: PresetKey) => {
  for (const [path, value] of Object.entries(EFFECT_PRESETS[key])) update(path, value)
}

export const HighlanderSettingsSection = () => {
  // Select the whole settings object: the reducer gives it a new identity on every change, while nested
  // objects such as settings.highlander keep theirs (shallow clone).
  const settings = useStore(state => state.settings)
  const hl = settings.highlander

  if (!hl) return null

  const toggle = (label: string, path: string, keyCode?: string) => (
    <ToggleOption
      label={label}
      keyCode={keyCode}
      checked={!!get(hl, path)}
      onChange={checked => update(path, checked)}
    />
  )

  const preset = currentPreset(hl)
  const viewStyle = currentViewStyle(settings)
  const view = hl.view

  return (
    <>
      <div className="mb-4 mt-16 text-xs font-black uppercase opacity-60">Highlander</div>

      {toggle('Highlander features (applies on next demo load)', 'enabled')}

      <SelectOption<ViewStyle | 'custom'>
        label="View style"
        keyCode="H"
        value={viewStyle}
        options={viewStyle === 'custom' ? [...VIEW_STYLE_OPTIONS, { label: 'Custom', value: 'custom' }] : VIEW_STYLE_OPTIONS}
        onChange={value => {
          if (value !== 'custom') applyViewStyle(value)
        }}
      />

      {view && (
        <div className="ml-3">
          <SelectOption
            label="- Nameplates for"
            value={view.plates}
            options={PLATES_OPTIONS}
            onChange={value => update('view.plates', value)}
          />
          <SelectOption
            label="- Nameplate tags"
            value={view.plateTags}
            options={PLATE_TAGS_OPTIONS}
            onChange={value => update('view.plateTags', value)}
          />
          <SelectOption
            label="- Building labels"
            value={view.buildingLabels}
            options={BUILDING_LABEL_OPTIONS}
            onChange={value => update('view.buildingLabels', value)}
          />
          <SliderOption
            label="- Heal beam width"
            min={0.25}
            max={1}
            step={0.05}
            value={view.healBeamScale}
            onChange={value => update('view.healBeamScale', value)}
          />
          <SelectOption
            label="- Control point markers"
            value={view.objectiveMarkers}
            options={OBJECTIVE_MARKER_OPTIONS}
            onChange={value => update('view.objectiveMarkers', value)}
          />
          {toggle('- Kit respawn rings', 'view.respawnRings')}
          {toggle('- Player columns', 'view.playerColumns')}
          {toggle('- Hide controls while playing', 'view.autoHideControls')}
        </div>
      )}

      <SelectOption<PresetKey | 'custom'>
        label="Effects preset"
        value={preset}
        options={
          preset === 'custom'
            ? [...PRESET_OPTIONS, { label: 'Custom', value: 'custom' }]
            : PRESET_OPTIONS
        }
        onChange={value => {
          if (value !== 'custom') applyPreset(value)
        }}
      />

      {toggle('Condition effects', 'players.conditions')}
      {hl.players.conditions && (
        <div className="ml-3">
          {toggle('- Uber', 'players.fxUber')}
          {toggle('- Crit and buffs', 'players.fxCrit')}
          {toggle('- Debuffs', 'players.fxDebuffs')}
          {toggle('- Overheal and teleport', 'players.fxOverheal')}
        </div>
      )}

      {toggle('Cloak fade', 'players.cloak')}
      {hl.players.cloak && (
        <div className="ml-3">
          <SliderOption
            label="- Cloak visibility"
            min={0.05}
            max={0.5}
            step={0.05}
            value={hl.players.cloakFloor}
            onChange={value => update('players.cloakFloor', value)}
          />
        </div>
      )}

      <SelectOption
        label="Disguise view"
        keyCode="I"
        value={hl.players.disguiseView}
        options={DISGUISE_VIEW_OPTIONS}
        onChange={value => update('players.disguiseView', value)}
      />

      {toggle('Player glow through walls', 'players.xrayGlow', 'X')}
      {toggle('Nameplate extras', 'players.nameplateExtras')}
      {toggle('Weapon icon on nameplates', 'players.nameplateWeapon')}

      <SliderOption
        label="Nameplate fade distance (0 = off)"
        min={0}
        max={6000}
        step={250}
        inputClassName="w-16"
        value={hl.players.nameplateFadeDistance}
        onChange={value => update('players.nameplateFadeDistance', value)}
      />

      {toggle('Buildings', 'buildings.enabled')}
      {hl.buildings.enabled && (
        <div className="ml-3">
          {toggle('- Labels', 'buildings.labels')}
          {toggle('- Sentry range', 'buildings.sentryRange')}
          {toggle('- Blueprints', 'buildings.blueprints')}
        </div>
      )}

      {toggle('Extra projectiles', 'projectiles.extraTypes')}
      {toggle('Crit glow', 'projectiles.critGlow')}
      {toggle('Explosions', 'projectiles.explosions')}
      {toggle('Tracers', 'projectiles.tracers')}
      {toggle('Flames', 'projectiles.flames')}
      {toggle('Airblast', 'projectiles.airblast')}

      {toggle('Sniper dots', 'sniper.dots')}
      {toggle('Laser beams', 'sniper.beams')}

      {toggle('Viewmodel', 'pov.viewmodel', 'V')}
      {hl.pov.viewmodel && (
        <div className="ml-3">
          <SliderOption
            label="- Viewmodel FOV"
            min={54}
            max={90}
            step={1}
            value={hl.pov.viewmodelFov}
            onChange={value => update('pov.viewmodelFov', value)}
          />
          {toggle('- Minimal viewmodels', 'pov.minimalViewmodel')}
        </div>
      )}

      {toggle('TF2 field of view in POV', 'pov.tf2Fov')}
      {toggle('Class eye height', 'pov.eyeHeight')}
      {toggle('Scope overlay', 'pov.scopeOverlay')}
      {toggle('Weapon HUD', 'pov.weaponHud')}
      {toggle('Damage numbers', 'pov.damageNumbers')}
      {toggle('Chase camera in POV', 'pov.chase', '4')}

      <SelectOption
        label="When the POV player dies"
        value={hl.pov.deadPov}
        options={DEAD_POV_OPTIONS}
        onChange={value => update('pov.deadPov', value)}
      />

      {toggle('Objective HUD', 'hud.objective')}
      {toggle('Compact player list', 'hud.compactStatuses')}
      {toggle('Status badges', 'hud.statusBadges')}
      {toggle('Medic panel', 'hud.medicPanel')}
      {toggle('Scoreboard', 'hud.scoreboard', 'Tab')}
      {toggle('Round banner', 'hud.roundBanner')}

      <SliderOption
        label="Killfeed lines"
        min={3}
        max={12}
        step={1}
        value={hl.hud.killfeedMaxLines}
        onChange={value => update('hud.killfeedMaxLines', value)}
      />

      {toggle('Show Dead Ringer fakes', 'hud.killfeedFeignDeaths')}
      {toggle('Objective lines in killfeed', 'hud.killfeedObjectives')}

      {toggle('Timeline markers', 'hud.timelineMarkers', '[ ]')}
      {hl.hud.timelineMarkers && (
        <div className="ml-3">
          {toggle('- Medic markers', 'hud.timelineMedic')}
          {toggle('- Objective markers', 'hud.timelineObjective')}
          {toggle('- Spy markers', 'hud.timelineSpy')}
          {toggle('- Engineer markers', 'hud.timelineEngineer')}
        </div>
      )}

      {toggle('Moving doors', 'map.movers')}
      {toggle('Pickups', 'map.pickups')}
      {toggle('Respawn room walls', 'map.respawnVisualizers')}
      {toggle('Death markers', 'map.deathMarkers')}
      {toggle('Dropped items', 'map.drops')}
      {toggle('Fog', 'map.fog')}
      {toggle('Map props', 'map.staticProps')}

      <SliderOption
        label="Map brightness"
        min={0.5}
        max={2}
        step={0.05}
        value={hl.map.brightness}
        onChange={value => update('map.brightness', value)}
      />
    </>
  )
}
