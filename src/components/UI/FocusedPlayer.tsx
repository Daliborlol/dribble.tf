import { AsyncParser } from '@components/Analyse/Data/AsyncParser'
import { ClassIcon } from '@components/UI/ClassIcon'

import { useStore, useInstance, getState } from '@zus/store'
import { playersAt, renderTickOf } from '@utils/tickData'

import { parseClassHealth } from '@utils/players'
import { cn } from '@utils/styling'

export interface FocusedPlayerProps {
  demo: AsyncParser
  intervalPerTick: number
}

export const FocusedPlayer = ({ demo, intervalPerTick }: FocusedPlayerProps) => {
  const controlsMode = useStore(state => state.scene.controls.mode)
  const focusedObject = useInstance(state => state.focusedObject)

  if (controlsMode !== 'pov' || !focusedObject) return null

  return <FocusedPlayerCard demo={demo} intervalPerTick={intervalPerTick} entityId={focusedObject?.userData?.entityId} />
}

// What the card shows of the focused player at the tick, as one primitive: it renders when that changes
const FocusedPlayerCard = ({ demo, intervalPerTick, entityId }: FocusedPlayerProps & { entityId: number }) => {
  useStore(state => {
    const focused = playersAt(demo, renderTickOf(state.playback.tick)).byEntity.get(entityId)
    if (!focused) return ''
    const seconds = focused.health === 0 && focused.respawnTick != null ? Math.ceil((focused.respawnTick - state.playback.tick) * intervalPerTick) : ''
    return `${focused.user.name}|${focused.classId}|${focused.team}|${focused.health}|${seconds}`
  })
  const tick = getState().playback.tick
  const focused = playersAt(demo, renderTickOf(tick)).byEntity.get(entityId)

  if (!focused) return null

  let name, health, percentage, icon
  name = focused.user.name
  health = focused.health
  percentage = parseClassHealth(focused.classId, health).percentage
  icon = <ClassIcon classId={focused.classId} />

  return (
    <div className="flex w-auto flex-col items-center">
      <div className="mb-4 text-3xl">
        {health === 0 && focused.respawnTick != null && (
          <div className="animate-pulse text-xl font-black text-[#fbff09] [text-shadow:0_0_3px_#000000]">
            Respawning in {Math.ceil((focused.respawnTick - tick) * intervalPerTick)}
          </div>
        )}
      </div>

      <div className="flex items-center">
        <div
          className={cn(
            'relative mr-3 flex w-[15px] justify-end text-right font-black text-white [text-shadow:0_0_3px_#000000]'
          )}
        >
          {health > 0 ? (
            <div
              className={cn(
                'text-[2.5rem] leading-10',
                percentage > 100 && 'text-pp-health-overhealed',
                percentage < 40 && 'text-pp-health-low'
              )}
            >
              {health}
            </div>
          ) : (
            <div className="text-xl opacity-60">Dead</div>
          )}
        </div>

        <div
          className={cn(
            'flex max-w-[260px] flex-col overflow-hidden rounded-xl bg-pp-panel/70',
            health === 0 && 'opacity-60'
          )}
        >
          <div className="flex flex-1 items-center px-4 py-2">
            <div className="overflow-hidden text-ellipsis whitespace-nowrap">{name}</div>
            <div className="pl-2">{icon}</div>
          </div>

          <div
            className={cn(
              'h-1 w-full',
              focused.team === 'blue' && 'bg-pp-focused-background-blue',
              focused.team === 'red' && 'bg-pp-focused-background-red'
            )}
          />
        </div>
      </div>
    </div>
  )
}
