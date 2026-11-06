import { TogglePanel, TogglePanelButton } from '@components/UI/Shared/TogglePanel'
import { Option, SliderOption, ToggleOption } from '@components/UI/Shared/SettingsOptions'
import {
  IoMdSettingsIcon,
  CrosshairStyleIcon,
  CrossStyleIcon,
  CircleStyleIcon,
  DotStyleIcon,
} from '@components/Misc/Icons'
import { CrosshairStyle } from '@constants/types'
import { BRUSH_COLOR_OPTIONS } from '@constants/drawing'

import { useStore } from '@zus/store'
import { toggleUIPanelAction, updateSettingsOptionAction } from '@zus/actions'
import { cn } from '@utils/styling'
import { useIsMobile } from '@utils/hooks'
import { HighlanderSettingsSection } from '@highlander/settings/HighlanderSettingsSection'
import { AssetSettingsSection } from '@pack/AssetSettingsSection'

//
// ─── SETTINGS PANEL ─────────────────────────────────────────────────────────────
//

export const SettingsPanel = () => {
  const isOpen = useStore(state => state.ui.activePanels.includes('Settings'))
  const scene = useStore(state => state.scene)
  const settings = useStore(state => state.settings)
  const isMobile = useIsMobile()

  const toggleUIPanel = () => {
    toggleUIPanelAction('About', false)
    toggleUIPanelAction('MatchKillfeed', false)
    toggleUIPanelAction('Bookmarks', false)
    toggleUIPanelAction('Setups', false)
    toggleUIPanelAction('Settings')
  }
  const updateSettingsOption = (option: string, value: any) => {
    updateSettingsOptionAction(option, value)
  }

  return (
    <div className="flex items-start">
      <TogglePanelButton onClick={toggleUIPanel}>
        <IoMdSettingsIcon />
      </TogglePanelButton>

      <TogglePanel
        className="w-[clamp(100px,460px,80vw)]"
        showCloseButton
        isOpen={isOpen}
        onClickClose={toggleUIPanel}
      >
        <div className="max-h-[90vh] overflow-auto px-8 pb-8 pt-10">
          {/* ************************************************************* */}

          <div className="mb-4 text-xs font-black uppercase opacity-60">Camera</div>

          <Option label="POV Camera (next)" keyCode="1" leftClass="col" />
          <Option label="POV Camera (prev)" keyCode="Shift + 1" leftClass="col" />

          {!isMobile && <Option label="Spectator Camera" keyCode="2" leftClass="col" />}
          {isMobile && (
            <Option label="Spectator Camera" leftClass="col">
              <span className="text-xs opacity-40">Desktop only</span>
            </Option>
          )}

          {scene.controls.mode === 'spectator' && !isMobile && (
            <div className="ml-3">
              <SliderOption
                label="- FOV"
                min={50}
                max={120}
                step={1}
                value={settings.camera.fov}
                onChange={value => updateSettingsOption('camera.fov', value)}
              />

              <SliderOption
                label="- Look Sensitivity"
                value={settings.controls.lookSpeed}
                onChange={value => updateSettingsOption('controls.lookSpeed', value)}
              />

              <SliderOption
                label="- Move Speed"
                value={settings.controls.moveSpeed}
                onChange={value => updateSettingsOption('controls.moveSpeed', value)}
              />
            </div>
          )}

          <Option label="RTS Camera" keyCode="3" />

          {scene.controls.mode === 'rts' && (
            <div className="ml-3">
              <SliderOption
                label="- FOV"
                min={50}
                max={120}
                step={1}
                value={settings.camera.fov}
                onChange={value => updateSettingsOption('camera.fov', value)}
              />

              <SliderOption
                label="- Pan speed"
                value={settings.controls.panSpeed}
                onChange={value => updateSettingsOption('controls.panSpeed', value)}
              />

              <SliderOption
                label="- Rotate speed"
                value={settings.controls.rotateSpeed}
                onChange={value => updateSettingsOption('controls.rotateSpeed', value)}
              />

              <SliderOption
                label="- Zoom speed"
                value={settings.controls.zoomSpeed}
                onChange={value => updateSettingsOption('controls.zoomSpeed', value)}
              />

              <ToggleOption
                label="- Inertia enabled"
                checked={settings.controls.enableDamping}
                onChange={checked => updateSettingsOption('controls.enableDamping', checked)}
              />
            </div>
          )}

          {/* ************************************************************* */}

          <div className="mb-4 mt-16 text-xs font-black uppercase opacity-60">Scene</div>

          <Option label="Material" keyCode="M">
            <div className="flex gap-1">
              {[
                { label: 'Wireframe', value: 'wireframe' },
                { label: 'Plain', value: 'untextured' },
                { label: 'Textured', value: 'textured' },
              ].map(button => (
                <button
                  key={`geometry-material-btn-${button.value}`}
                  className={cn(
                    'rounded-xl border px-2 text-sm',
                    settings.scene.mode === button.value && 'border-[#3273f6] bg-[#3273f6]'
                  )}
                  onClick={() => updateSettingsOption('scene.mode', button.value)}
                >
                  {button.label}
                </button>
              ))}
            </div>
          </Option>

          <ToggleOption
            label="Frame smoothing (*expensive)"
            checked={settings.scene.interpolateFrames}
            onChange={checked => updateSettingsOption('scene.interpolateFrames', checked)}
          />

          <SliderOption
            label="View distance"
            min={2000}
            max={30000}
            step={500}
            value={settings.ui.viewDistance}
            onChange={value => updateSettingsOption('ui.viewDistance', value)}
          />

          {/* ************************************************************* */}

          <div className="mb-4 mt-16 text-xs font-black uppercase opacity-60">Players</div>

          <ToggleOption
            label="Antialiasing (off is faster, applies on next demo load)"
            checked={settings.ui.antialias !== false}
            onChange={checked => updateSettingsOption('ui.antialias', checked)}
          />

          <ToggleOption
            label="Player outlines (*expensive)"
            keyCode="O"
            checked={settings.ui.playerOutlines}
            onChange={checked => updateSettingsOption('ui.playerOutlines', checked)}
          />

          <ToggleOption
            label="Show nameplates"
            keyCode="N"
            checked={settings.ui.nameplate.enabled}
            onChange={checked => updateSettingsOption('ui.nameplate.enabled', checked)}
          />

          {settings.ui.nameplate.enabled && (
            <div className="ml-3">
              <ToggleOption
                label="- Name"
                checked={settings.ui.nameplate.showName}
                disabled={!settings.ui.nameplate.enabled}
                onChange={checked => updateSettingsOption('ui.nameplate.showName', checked)}
              />

              <ToggleOption
                label="- Health"
                checked={settings.ui.nameplate.showHealth}
                disabled={!settings.ui.nameplate.enabled}
                onChange={checked => updateSettingsOption('ui.nameplate.showHealth', checked)}
              />

              <ToggleOption
                label="- Class"
                checked={settings.ui.nameplate.showClass}
                disabled={!settings.ui.nameplate.enabled}
                onChange={checked => updateSettingsOption('ui.nameplate.showClass', checked)}
              />
            </div>
          )}

          {/* ************************************************************* */}

          <div className="mb-4 mt-16 text-xs font-black uppercase opacity-60">Crosshair</div>

          <Option label="Style">
            <div className="flex gap-1">
              {([
                { label: 'None', value: CrosshairStyle.NONE, icon: null },
                { label: 'Crosshair', value: CrosshairStyle.CROSSHAIR, icon: <CrosshairStyleIcon className="h-4 w-4" /> },
                { label: 'Cross', value: CrosshairStyle.CROSS, icon: <CrossStyleIcon className="h-4 w-4" /> },
                { label: 'Circle', value: CrosshairStyle.CIRCLE, icon: <CircleStyleIcon className="h-4 w-4" /> },
                { label: 'Dot', value: CrosshairStyle.DOT, icon: <DotStyleIcon className="h-4 w-4" /> },
              ] as const).map(button => (
                <button
                  key={`crosshair-style-btn-${button.value}`}
                  className={cn(
                    'flex items-center gap-1 rounded-xl border px-2 py-0.5 text-sm',
                    settings.ui.crosshair.style === button.value && 'border-[#3273f6] bg-[#3273f6]'
                  )}
                  onClick={() => updateSettingsOption('ui.crosshair.style', button.value)}
                >
                  {button.icon}
                  {button.label}
                </button>
              ))}
            </div>
          </Option>

          {settings.ui.crosshair.style !== 'none' && (
            <>
              <SliderOption
                label="Size"
                min={10}
                max={60}
                step={1}
                value={settings.ui.crosshair.size}
                onChange={value => updateSettingsOption('ui.crosshair.size', value)}
              />

              <SliderOption
                label="Opacity"
                min={0.1}
                max={1}
                step={0.05}
                value={settings.ui.crosshair.opacity}
                onChange={value => updateSettingsOption('ui.crosshair.opacity', value)}
              />

              <Option label="Color">
                <div className="flex items-center gap-1.5">
                  {BRUSH_COLOR_OPTIONS.map(({ color }) => (
                    <div
                      key={`crosshair-color-${color}`}
                      className={cn(
                        'h-6 w-6 cursor-pointer rounded-full [transition:0.2s_ease_all] hover:scale-110',
                        settings.ui.crosshair.color === color
                          ? '[border:2px_solid_white] scale-110'
                          : '[border:2px_solid_transparent]'
                      )}
                      style={{ backgroundColor: color }}
                      onClick={() => updateSettingsOption('ui.crosshair.color', color)}
                    />
                  ))}
                </div>
              </Option>
            </>
          )}

          {/* ************************************************************* */}

          <div className="mb-4 mt-16 text-xs font-black uppercase opacity-60">Drawing</div>

          <Option label="Activate" keyCode="F" />
          <Option label="Clear active tool" keyCode="C" />
          <Option label="Undo active tool" keyCode="Z" />
          <Option label="Redo stickers" keyCode="Shift + Z" />
          <Option label="Delete selected sticker" keyCode="Delete" />

          <Option label="Activation method" rightClass="col-auto">
            <div className="flex gap-1">
              {[
                { label: 'Hold', value: 'hold' },
                { label: 'Toggle', value: 'toggle' },
              ].map(button => (
                <button
                  key={`drawing-activation-method-btn-${button.value}`}
                  className={cn(
                    'rounded-xl border px-2 text-sm',
                    settings.drawing.activation === button.value && 'border-[#3273f6] bg-[#3273f6]'
                  )}
                  onClick={() => updateSettingsOption('drawing.activation', button.value)}
                >
                  {button.label}
                </button>
              ))}
            </div>
          </Option>

          <ToggleOption
            label="Auto clear when dismissed"
            checked={settings.drawing.autoClear}
            onChange={checked => updateSettingsOption('drawing.autoClear', checked)}
          />

          {/* ************************************************************* */}

          <HighlanderSettingsSection />
          <AssetSettingsSection />

          {/* ************************************************************* */}

          <div className="mb-4 mt-16 text-xs font-black uppercase opacity-60">Misc</div>

          <ToggleOption
            label="Show FPS"
            checked={settings.ui.showStats}
            onChange={checked => updateSettingsOption('ui.showStats', checked)}
          />
          <ToggleOption
            label="Show Skybox"
            checked={settings.ui.showSkybox}
            onChange={checked => updateSettingsOption('ui.showSkybox', checked)}
          />

          <SliderOption
            label="Killfeed seek buffer"
            min={1}
            max={10}
            step={1}
            value={settings.ui.killfeedSeekBuffer}
            onChange={value => updateSettingsOption('ui.killfeedSeekBuffer', value)}
          />
        </div>
      </TogglePanel>
    </div>
  )
}
