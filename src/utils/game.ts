import { getAsset } from './misc'
import { fetchMapConversion } from './mapAssets'
import { MAP_NAME_SEARCH_MAP, MAP_SKYBOX_MAP } from '@constants/mappings'
import { MapBoundaries } from '@components/Analyse/Data/PositionCache'
import type { Vector } from '@components/Analyse/Data/Types'

// Handle demos that have different versioned maps. We need a function that
// can parse a given {mapName}, then determine which gltf model to use
// (e.g. cp_process_final and cp_process_f7 can just use the same map model)

export const resolveMapFolderName = (loadedMapName: string): string => {
  let folderName = loadedMapName

  Object.entries(MAP_NAME_SEARCH_MAP).forEach(([shortname, foldername]) => {
    if (loadedMapName.includes(shortname)) {
      folderName = foldername
    }
  })

  return folderName
}

interface MapModelTypes {
  overlay: string
  textured: string
}

export const getMapModelUrls = (loadedMapName: string): MapModelTypes | undefined => {
  let urls: MapModelTypes | undefined

  Object.entries(MAP_NAME_SEARCH_MAP).forEach(([shortname, foldername]) => {
    if (loadedMapName.includes(shortname)) {
      urls = {
        overlay: getAsset(`/models/maps/${foldername}/overlay_compressed.glb`),
        textured: getAsset(`/models/maps/${foldername}/textured_compressed.glb`),
      } as MapModelTypes
    }
  })

  return urls
}

export const getMapConversionUrl = (loadedMapName: string): string | undefined => {
  if (!loadedMapName) return undefined
  const foldername = resolveMapFolderName(loadedMapName)
  return getAsset(`/models/maps/${foldername}/conversion.json`)
}

export const getMapVisibilityUrl = (loadedMapName: string): string | undefined => {
  if (!loadedMapName) return undefined
  const foldername = resolveMapFolderName(loadedMapName)
  return getAsset(`/models/maps/${foldername}/visibility.json`)
}

interface MapSkyboxTypes {
  bk: string
  dn: string
  ft: string
  lf: string
  rt: string
  up: string
  side: string
}

/** World bounds from the map's conversion.json, plus its automatic RTS camera when it has one. */
export const fetchMapWorldBounds = async (
  loadedMapName: string
): Promise<
  | (Pick<MapBoundaries, 'boundaryMin' | 'boundaryMax'> & {
      camera?: { rtsCenter: Vector; cameraOffset: Vector }
    })
  | null
> => {
  const conversion = await fetchMapConversion(loadedMapName)
  const bounds = conversion?.worldBounds
  if (!bounds?.boundaryMin || !bounds?.boundaryMax) return null
  const camera = conversion?.camera
  return {
    boundaryMin: bounds.boundaryMin,
    boundaryMax: bounds.boundaryMax,
    ...(camera?.rtsCenter && camera?.cameraOffset
      ? { camera: { rtsCenter: camera.rtsCenter, cameraOffset: camera.cameraOffset } }
      : {}),
  }
}

export const getMapSkyboxUrls = (loadedMapName: string): MapSkyboxTypes | undefined => {
  let urls: MapSkyboxTypes | undefined

  Object.entries(MAP_SKYBOX_MAP).forEach(([shortname, skyboxname]) => {
    if (loadedMapName.includes(shortname)) {
      urls = {
        lf: getAsset(`/models/skybox/${skyboxname}/${skyboxname}_lf.png`),
        rt: getAsset(`/models/skybox/${skyboxname}/${skyboxname}_rt.png`),
        ft: getAsset(`/models/skybox/${skyboxname}/${skyboxname}_ft.png`),
        bk: getAsset(`/models/skybox/${skyboxname}/${skyboxname}_bk.png`),
        dn: getAsset(`/models/skybox/${skyboxname}/${skyboxname}_dn.png`),
        up: getAsset(`/models/skybox/${skyboxname}/${skyboxname}_up.png`),
      } as MapSkyboxTypes
    }
  })

  return urls
}
