/**
 * map-meta.mjs — derive dribble.tf gameplay metadata (map-meta.json, schema v1) from a compiled
 * BSP entity graph (bsp-to-glb --entities-out) and brush-model bounds.
 *
 * Every position is in raw Source units (Z-up). Scene space = Source − worldBounds.boundaryMin,
 * which is exactly how the demo parser shifts player positions (m_WorldMins == worldspawn world_mins).
 */

const num = (value, fallback = null) => {
  const n = Number(value)
  return value === undefined || value === null || value === '' || !Number.isFinite(n) ? fallback : n
}
const vec3 = (value, fallback = null) => {
  const parts = String(value ?? '').trim().split(/\s+/).map(Number)
  return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? parts.slice(0, 3) : fallback
}
const round = (v, d = 2) => (Array.isArray(v) ? v.map(x => round(x, d)) : v === null || v === undefined ? v : +Number(v).toFixed(d))
const colorBrightness = value => {
  const parts = String(value ?? '').trim().split(/\s+/).map(Number)
  if (parts.length < 3 || parts.slice(0, 3).some(n => !Number.isFinite(n))) return null
  return { color: parts.slice(0, 3).map(n => Math.max(0, Math.min(255, Math.round(n)))), brightness: Number.isFinite(parts[3]) ? parts[3] : null }
}
const deg = Math.PI / 180

// Source AngleVectors forward vector (pitch down positive).
const forward = ([pitch, yaw]) => [Math.cos(pitch * deg) * Math.cos(yaw * deg), Math.cos(pitch * deg) * Math.sin(yaw * deg), -Math.sin(pitch * deg)]

// Rotate a local point by Source angles (pitch, yaw, roll) — same matrix as bsp-to-glb.
const rotate = ([pitch, yaw, roll], p) => {
  const [sp, cp] = [Math.sin(pitch * deg), Math.cos(pitch * deg)]
  const [sy, cy] = [Math.sin(yaw * deg), Math.cos(yaw * deg)]
  const [sr, cr] = [Math.sin(roll * deg), Math.cos(roll * deg)]
  const m = [
    [cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy],
    [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy],
    [-sp, sr * cp, cr * cp],
  ]
  return [0, 1, 2].map(r => m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2])
}

export function buildMapMeta({ mapName, entities, modelBounds, worldMins, worldMaxs, waterSurfaces = [], bspVersion = 20 }) {
  const byName = new Map()
  for (const entity of entities) {
    const name = entity.kv.targetname
    if (!name) continue
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), [])
    byName.get(name.toLowerCase()).push(entity)
  }
  const named = name => (name ? byName.get(String(name).toLowerCase()) ?? [] : [])
  const ofClass = (...classes) => entities.filter(entity => classes.includes(entity.classname))
  const origin = entity => vec3(entity.kv.origin, [0, 0, 0])
  const angles = entity => vec3(entity.kv.angles, [0, 0, 0])

  // Absolute AABB of a brush entity (model bounds are model-local; origin/angles place them).
  const brushBounds = entity => {
    const index = entity.bspModelIndex ?? (String(entity.kv.model ?? '').startsWith('*') ? Number(entity.kv.model.slice(1)) : null)
    const model = index === null ? null : modelBounds.get(index)
    if (!model) return null
    const o = model.origin ?? origin(entity)
    const a = model.angles ?? angles(entity)
    const mins = [Infinity, Infinity, Infinity]
    const maxs = [-Infinity, -Infinity, -Infinity]
    for (const x of [model.mins[0], model.maxs[0]])
      for (const y of [model.mins[1], model.maxs[1]])
        for (const z of [model.mins[2], model.maxs[2]]) {
          const p = rotate(a, [x, y, z])
          for (let i = 0; i < 3; i++) {
            mins[i] = Math.min(mins[i], p[i] + o[i])
            maxs[i] = Math.max(maxs[i], p[i] + o[i])
          }
        }
    return { bspModelIndex: index, node: model.node ?? null, mins: round(mins, 1), maxs: round(maxs, 1) }
  }
  const team = entity => num(entity.kv.teamnum, 0)

  // ── spawns ──
  const spawns = ofClass('info_player_teamspawn').map(entity => ({
    team: team(entity),
    origin: round(origin(entity), 1),
    yaw: round(angles(entity)[1], 1),
    name: entity.kv.targetname ?? undefined,
    controlPoint: entity.kv.controlpoint ?? undefined,
    disabled: entity.kv.startdisabled === '1' || undefined,
    roundRed: entity.kv.round_redspawn ?? undefined,
    roundBlue: entity.kv.round_bluespawn ?? undefined,
  }))

  // ── control points + capture areas ──
  const captureAreas = ofClass('trigger_capture_area').map(entity => ({
    name: entity.kv.targetname ?? null,
    capPoint: entity.kv.area_cap_point ?? null,
    timeToCap: num(entity.kv.area_time_to_cap),
    canCap: { 2: entity.kv.team_cancap_2 !== '0', 3: entity.kv.team_cancap_3 !== '0' },
    numCappers: { 2: num(entity.kv.team_numcap_2, 1), 3: num(entity.kv.team_numcap_3, 1) },
    parent: entity.kv.parentname ?? null,
    startDisabled: entity.kv.startdisabled === '1',
    ...brushBounds(entity),
  }))
  const controlPoints = ofClass('team_control_point')
    .map(entity => ({
      name: entity.kv.targetname ?? null,
      index: num(entity.kv.point_index, 0),
      printName: entity.kv.point_printname ?? null,
      origin: round(origin(entity), 1),
      defaultOwner: num(entity.kv.point_default_owner, 0),
      startLocked: entity.kv.point_start_locked === '1',
      group: num(entity.kv.point_group, 0),
      hidden: (num(entity.kv.spawnflags, 0) & 1) !== 0,
      // Indices into captureAreas (areas are often unnamed, e.g. koth_ashville).
      captureAreas: captureAreas.flatMap((area, i) => (area.capPoint && area.capPoint.toLowerCase() === String(entity.kv.targetname).toLowerCase() ? [i] : [])),
    }))
    .sort((a, b) => a.index - b.index)

  // ── payload / tug of war ──
  const pathTracks = new Map(ofClass('path_track').map(entity => [String(entity.kv.targetname).toLowerCase(), entity]))
  const walkPath = start => {
    const nodes = []
    const seen = new Set()
    let current = start ? pathTracks.get(String(start).toLowerCase()) : null
    let distance = 0
    let previous = null
    while (current && !seen.has(current)) {
      seen.add(current)
      const p = origin(current)
      if (previous) distance += Math.hypot(p[0] - previous[0], p[1] - previous[1], p[2] - previous[2])
      nodes.push({
        name: current.kv.targetname,
        origin: round(p, 1),
        distance: round(distance, 1),
        next: current.kv.target ?? null,
        alt: current.kv.altpath ?? undefined,
        speed: num(current.kv.speed) ?? undefined,
        flags: num(current.kv.spawnflags, 0) || undefined,
      })
      previous = p
      current = current.kv.target ? pathTracks.get(current.kv.target.toLowerCase()) : null
    }
    return { nodes, length: round(distance, 1) }
  }
  const payload = ofClass('team_train_watcher').map(watcher => {
    const path = walkPath(watcher.kv.start_node)
    const linked = []
    for (let i = 1; i <= 8; i++) {
      const track = watcher.kv[`linked_pathtrack_${i}`]
      if (!track) continue
      const at = path.nodes.findIndex(node => node.name?.toLowerCase() === track.toLowerCase())
      linked.push({ pathTrack: track, controlPoint: watcher.kv[`linked_cp_${i}`] ?? null, pathIndex: at, distance: at >= 0 ? path.nodes[at].distance : null })
    }
    const trainName = watcher.kv.train
    const train = named(trainName).find(entity => entity.classname === 'func_tracktrain')
    const isTrain = name => Boolean(trainName && name && name.split(',')[0].toLowerCase() === trainName.toLowerCase())
    // Valve's payload prefab keeps the cart prop unparented and ties it to the train with a
    // phys_constraint (attach1/attach2), so follow constraints as well as parentname.
    const constrained = new Set(
      entities
        .filter(entity => /^phys_/.test(entity.classname ?? '') && (isTrain(entity.kv.attach1) || isTrain(entity.kv.attach2)))
        .map(entity => (isTrain(entity.kv.attach1) ? entity.kv.attach2 : entity.kv.attach1)?.toLowerCase())
        .filter(Boolean)
    )
    const attached = trainName
      ? entities.filter(entity => isTrain(entity.kv.parentname) || (entity.kv.targetname && constrained.has(entity.kv.targetname.toLowerCase())))
      : []
    return {
      watcher: watcher.kv.targetname ?? null,
      team: team(watcher),
      train: trainName ?? null,
      startNode: watcher.kv.start_node ?? null,
      goalNode: watcher.kv.goal_node ?? null,
      canRecede: watcher.kv.train_can_recede !== '0',
      path: path.nodes,
      length: path.length,
      linked,
      cart: train
        ? {
            origin: round(origin(train), 1),
            brush: brushBounds(train),
            models: attached.filter(entity => entity.classname.startsWith('prop_')).map(entity => entity.kv.model),
            attached: attached.map(entity => ({ classname: entity.classname, name: entity.kv.targetname ?? null })),
          }
        : null,
    }
  })

  // ── doors, respawn rooms, resupply ──
  const doors = ofClass('func_door', 'func_door_rotating', 'func_movelinear').map(entity => {
    const name = entity.kv.targetname ?? null
    return {
      name,
      classname: entity.classname,
      origin: round(origin(entity), 1),
      moveDir: round(forward(vec3(entity.kv.movedir, [0, 0, 0])), 3),
      lip: num(entity.kv.lip),
      speed: num(entity.kv.speed),
      spawnflags: num(entity.kv.spawnflags, 0),
      props: name ? entities.filter(e => e.kv.parentname && e.kv.parentname.toLowerCase() === name.toLowerCase() && e.classname.startsWith('prop_')).map(e => e.kv.model) : [],
      ...brushBounds(entity),
    }
  })
  const respawnRooms = ofClass('func_respawnroom').map(entity => ({ name: entity.kv.targetname ?? null, team: team(entity), ...brushBounds(entity) }))
  const respawnVisualizers = ofClass('func_respawnroomvisualizer').map(entity => {
    const room = respawnRooms.find(r => r.name && entity.kv.respawnroomname && r.name.toLowerCase() === entity.kv.respawnroomname.toLowerCase())
    return { room: entity.kv.respawnroomname ?? null, team: room?.team ?? 0, solidToEnemies: entity.kv.solid_to_enemies !== '0', ...brushBounds(entity) }
  })
  const resupply = ofClass('func_regenerate').map(entity => ({ team: team(entity), locker: entity.kv.associatedmodel ?? null, ...brushBounds(entity) }))
  const items = entities
    .filter(entity => /^item_(healthkit|ammopack)_/.test(entity.classname ?? ''))
    .map(entity => {
      const [, kind, size] = entity.classname.match(/^item_(healthkit|ammopack)_(\w+)$/)
      return { kind: kind === 'healthkit' ? 'health' : 'ammo', size, origin: round(origin(entity), 1), team: team(entity) || undefined, disabled: entity.kv.startdisabled === '1' || undefined }
    })
  const teleports = ofClass('trigger_teleport').map(entity => {
    const destination = named(entity.kv.target)[0]
    return { name: entity.kv.targetname ?? null, team: team(entity) || undefined, destination: destination ? round(origin(destination), 1) : null, ...brushBounds(entity) }
  })
  const GAMEPLAY_PROP = /resupply_locker|bomb_cart|cap_point_base|cappoint_hologram|door|ammopack|medkit|healthkit|intel|flag/i
  const gameplayProps = ofClass('prop_dynamic', 'prop_dynamic_override', 'prop_physics_override')
    .filter(entity => GAMEPLAY_PROP.test(entity.kv.model ?? ''))
    .map(entity => ({ model: entity.kv.model, name: entity.kv.targetname ?? undefined, parent: entity.kv.parentname ?? undefined, origin: round(origin(entity), 1), angles: round(angles(entity), 1), skin: num(entity.kv.skin) ?? undefined }))

  // ── light, sky, fog ──
  const lightEnv = ofClass('light_environment')[0]
  let environment = null
  if (lightEnv) {
    const a = angles(lightEnv)
    const pitch = num(lightEnv.kv.pitch, a[0])
    const yaw = num(lightEnv.kv.angle, null) ?? a[1]
    // VRAD SetupLightNormalFromProps: direction the sunlight travels.
    const direction = [Math.cos(yaw * deg) * Math.cos(pitch * deg), Math.sin(yaw * deg) * Math.cos(pitch * deg), Math.sin(pitch * deg)]
    environment = {
      sun: colorBrightness(lightEnv.kv._light),
      sunHDR: colorBrightness(lightEnv.kv._lighthdr),
      ambient: colorBrightness(lightEnv.kv._ambient),
      ambientHDR: colorBrightness(lightEnv.kv._ambienthdr),
      pitch,
      yaw,
      sunSpreadAngle: num(lightEnv.kv.sunspreadangle),
      direction: round(direction, 4),
    }
  }
  const shadowControl = ofClass('shadow_control')[0]
  const envSun = ofClass('env_sun')[0]
  const skyCamera = ofClass('sky_camera')[0]
  const fogController = ofClass('env_fog_controller')[0]
  const fog = fogController
    ? {
        enabled: fogController.kv.fogenable === '1',
        color: vec3(fogController.kv.fogcolor),
        start: num(fogController.kv.fogstart),
        end: num(fogController.kv.fogend),
        maxDensity: num(fogController.kv.fogmaxdensity),
        farZ: num(fogController.kv.farz),
      }
    : null

  // ── game mode ──
  const prefix = mapName.split('_')[0].toLowerCase()
  const owners = new Set(controlPoints.map(cp => cp.defaultOwner))
  // Both teams can cap on an area parented to the cart → tug of war (tow_*); one team → payload.
  const cartAreaTeams = new Set(
    captureAreas
      .filter(area => area.parent && payload.some(p => p.train && area.parent.split(',')[0].toLowerCase() === p.train.toLowerCase()))
      .flatMap(area => [2, 3].filter(t => area.canCap[t]))
  )
  let gameMode = 'unknown'
  if (prefix === 'koth' || ofClass('tf_logic_koth').length) gameMode = 'koth'
  else if (prefix === 'plr' || (payload.length >= 2 && new Set(payload.map(p => p.team).filter(Boolean)).size >= 2)) gameMode = 'payload-race'
  else if (prefix === 'tow' || (payload.length === 1 && cartAreaTeams.size === 2)) gameMode = 'tug-of-war'
  else if (payload.length || prefix === 'pl') gameMode = 'payload'
  else if (controlPoints.length && owners.size === 1 && !owners.has(0)) gameMode = 'attack-defend'
  else if (controlPoints.length) gameMode = 'control-points'

  // ── automatic camera defaults (no hand tuning) ──
  // Focus on where the round starts fighting: KOTH point; payload: halfway from the cart start to
  // the first checkpoint; tug of war / 5CP: the middle point; A/D: the first unlocked point.
  // Expressed like MapBoundaries.rtsCenter, i.e. relative to worldBounds.boundaryMin.
  const pointAlongPath = (path, distance) => {
    const i = path.findIndex(node => node.distance >= distance)
    if (i <= 0) return path[Math.max(0, i)].origin
    const [a, b] = [path[i - 1], path[i]]
    const t = b.distance > a.distance ? (distance - a.distance) / (b.distance - a.distance) : 0
    return a.origin.map((v, k) => v + (b.origin[k] - v) * t)
  }
  let focus = null
  let method = 'bounds-centre'
  if (gameMode === 'koth' && controlPoints.length) {
    focus = controlPoints[Math.floor(controlPoints.length / 2)].origin
    method = 'koth-point'
  } else if ((gameMode === 'payload' || gameMode === 'payload-race') && payload[0]?.path.length) {
    const p = payload[0]
    const firstCheckpoint = p.linked.map(l => l.distance).filter(d => d !== null && d > 0).sort((a, b) => a - b)[0] ?? p.length
    focus = pointAlongPath(p.path, firstCheckpoint / 2)
    method = 'payload-first-push'
  } else if (gameMode === 'tug-of-war' && payload[0]?.path.length) {
    focus = pointAlongPath(payload[0].path, payload[0].length / 2)
    method = 'tug-of-war-centre'
  } else if (gameMode === 'attack-defend' && controlPoints.length) {
    focus = (controlPoints.find(cp => !cp.startLocked) ?? controlPoints[0]).origin
    method = 'first-attack-point'
  } else if (controlPoints.length) {
    focus = controlPoints[Math.floor((controlPoints.length - 1) / 2)].origin
    method = 'middle-control-point'
  }
  if (!focus) {
    const zs = spawns.map(s => s.origin[2]).sort((x, y) => x - y)
    focus = [(worldMins[0] + worldMaxs[0]) / 2, (worldMins[1] + worldMaxs[1]) / 2, zs.length ? zs[Math.floor(zs.length / 2)] : worldMins[2]]
  }
  // Orientation: look across the long axis of the playable area (spawns + objectives).
  const points = [...spawns.map(s => s.origin), ...controlPoints.map(c => c.origin), ...payload.flatMap(p => p.path.map(n => n.origin))]
  const xs = points.map(p => p[0])
  const ys = points.map(p => p[1])
  const spanX = points.length ? Math.max(...xs) - Math.min(...xs) : worldMaxs[0] - worldMins[0]
  const spanY = points.length ? Math.max(...ys) - Math.min(...ys) : worldMaxs[1] - worldMins[1]
  // High and fairly far so the focus is not occluded by nearby buildings/cliffs.
  const distance = Math.min(3200, Math.max(1400, 0.22 * Math.hypot(spanX, spanY)))
  const elevation = 58 * deg
  // Long axis along X → camera sits on −Y looking +Y (map spans the screen horizontally).
  const azimuth = spanX >= spanY ? -Math.PI / 2 : Math.PI
  const horizontal = distance * Math.cos(elevation)
  const camera = {
    rtsCenter: { x: round(focus[0] - worldMins[0], 0), y: round(focus[1] - worldMins[1], 0), z: round(focus[2] - worldMins[2], 0) },
    cameraOffset: { x: round(horizontal * Math.cos(azimuth), 0), y: round(horizontal * Math.sin(azimuth), 0), z: round(distance * Math.sin(elevation), 0) },
    focusSource: round(focus, 1),
    method,
  }

  return {
    schema: 'dribble.map-meta',
    version: 1,
    map: mapName,
    bspVersion,
    coordinateSpace: 'source',
    sceneTransform: 'scene = source - worldBounds.boundaryMin',
    worldBounds: {
      boundaryMin: { x: worldMins[0], y: worldMins[1], z: worldMins[2] },
      boundaryMax: { x: worldMaxs[0], y: worldMaxs[1], z: worldMaxs[2] },
    },
    gameMode,
    camera,
    spawns,
    controlPoints,
    captureAreas,
    koth: ofClass('tf_logic_koth').map(entity => ({ timerLength: num(entity.kv.timer_length), unlockPoint: num(entity.kv.unlock_point) }))[0] ?? null,
    roundTimers: ofClass('team_round_timer').map(entity => ({
      name: entity.kv.targetname ?? null,
      timerLength: num(entity.kv.timer_length),
      setupLength: num(entity.kv.setup_length),
      maxLength: num(entity.kv.max_length),
      startPaused: entity.kv.start_paused === '1',
      showInHud: entity.kv.show_in_hud !== '0',
    })),
    payload,
    doors,
    respawnRooms,
    respawnVisualizers,
    resupply,
    items,
    teleports,
    gameplayProps,
    light: {
      environment,
      shadow: shadowControl ? { direction: round(forward(angles(shadowControl)), 4), color: vec3(shadowControl.kv.color), distance: num(shadowControl.kv.distance) } : null,
      sunSprite: envSun ? { direction: round(forward(angles(envSun)), 4), color: vec3(envSun.kv.rendercolor), size: num(envSun.kv.size) } : null,
    },
    sky: {
      name: entities.find(e => e.classname === 'worldspawn')?.kv.skyname ?? null,
      camera: skyCamera ? { origin: round(origin(skyCamera), 1), scale: num(skyCamera.kv.scale, 16) } : null,
    },
    fog,
    water: waterSurfaces,
  }
}
