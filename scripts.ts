import { app, action, core, constants } from 'photoshop'
import type { Layer } from 'photoshop/dom/Layer'
import type { ExecutionContext } from 'photoshop/dom/CoreModules'

interface FileEntry {
  nativePath: string
  isFile: boolean
  delete: () => Promise<void>
  read: (options: { format: any }) => Promise<ArrayBuffer>
  write: (data: ArrayBuffer, options: { format: any }) => Promise<void>
}

// @ts-expect-error 无法使用 import
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shell, storage: { localFileSystem: fs, formats } } = require('uxp')

let isRunning = false

const batchPlay: typeof action.batchPlay = (commands: any[]) => action.batchPlay(commands, { modalBehavior: 'wait', synchronousExecution: false })
const suspendHistory = async (fn: ((ctx: ExecutionContext) => Promise<unknown>) | (() => void), name: string, commit = true) => {
  if (isRunning) throw Error('正在运行中...')
  let error: any
  await core.executeAsModal(async ctx => {
    isRunning = true
    const documentID = app.activeDocument.id
    const history = await ctx.hostControl.suspendHistory({ name, documentID })
    try {
      await fn(ctx)
      await ctx.hostControl.resumeHistory(history)
    } catch (err) {
      error = err
      await ctx.hostControl.resumeHistory(history, commit)
    }
  }, { commandName: name, interactive: false }).finally(() => { isRunning = false })
  if (error) throw error
}

const webview = document.getElementById('webview') as HTMLIFrameElement & { postMessage: (data: string) => void }
const fillBtn = document.getElementById('fill') as HTMLButtonElement
const urlElm = document.getElementById('url') as HTMLInputElement

const promises: Record<string, (result: any) => void> = {}

window.addEventListener('message', ({ data }) => {
  if (!data?.includes('sd-webui')) return
  const { id, result } = JSON.parse(data)
  const p = promises[id]
  if (p) {
    p(result)
    delete promises[id]
  }
})

function go () {
  const url = localStorage.getItem('url')
  if (!url) {
    fillBtn.setAttribute('disabled', 'disabled')
    return
  }
  fillBtn.removeAttribute('disabled')
  webview.src = ''
  setTimeout(() => (webview.src = url), 100)
}

const execRemote = (code: string) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
  const data = JSON.stringify({ id, code: `{${code}}` })
  webview.postMessage(data)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      delete promises[id]
      reject(Error('Timeout'))
    }, 10000)
    promises[id] = (result: any) => {
      clearTimeout(timer)
      resolve(result)
    }
  })
}
const fillRemoteImage = (field: string, data: string) => execRemote(`
  const file = document.querySelector('#${field} input')
  const dataTransfer = new DataTransfer()
  dataTransfer.items.add(new File([window.dataURLtoFile('${data}')], 'image.jpg', { type: 'image/jpeg' }))
  file.files = dataTransfer.files
  file.dispatchEvent(new Event('change'))
  void 0
`)
const fillRemoteInput = (field: string, data: string) => execRemote(`
  const field = document.querySelector('#${field} .wrap input')
  field.value = ${JSON.stringify('' + data)}
  field.dispatchEvent(new Event('input'))
  void 0
`)

const color = (red = 0, green = 0, blue = 0) => {
  const c = new app.SolidColor()
  c.rgb.red = red
  c.rgb.green = green
  c.rgb.blue = blue
  return c
}

function unselectActiveLayers () {
  app.activeDocument.activeLayers.forEach(layer => (layer.selected = false))
}

const disactiveAllLayers = () => batchPlay([{ _obj: 'selectNoLayers', _target: [{ _enum: 'ordinal', _ref: 'layer', _value: 'targetEnum' }] }])
const setActiveLayer = (layer: Layer) => {
  app.activeDocument.activeLayers.forEach(it => layer !== it && (it.selected = false))
  layer.selected = true
}
const mergeLayers = async () => {
  await disactiveAllLayers()
  const layer = (await app.activeDocument.createLayer(constants.LayerKind.NORMAL, { name: 'PSSD - Merged' }))!
  layer.move(app.activeDocument.layers[0], constants.ElementPlacement.PLACEBEFORE)
  setActiveLayer(layer)
  await batchPlay([{ _obj: 'mergeVisible', duplicate: true }])
}
function deleteLayer (layer: Layer | string) {
  if (typeof layer === 'string') {
    app.activeDocument.layers.forEach(it => { it.name === layer && deleteLayer(it) })
    return
  }
  layer.layers?.forEach(deleteLayer)
  setActiveLayer(layer)
  layer.allLocked = false
  layer.delete()
}
const findLayer = (name: string) => app.activeDocument?.layers?.find(it => it.name === name)
const findMergeLayer = () => findLayer('PSSD - Merged')
const deleteMergeLayer = () => {
  const layer = findMergeLayer()
  if (layer) deleteLayer(layer)
}

const exportImage = async (doc = app.activeDocument, format: 'jpg' | 'png' | 'bmp' = 'jpg') => {
  const folder = await fs.getTemporaryFolder()
  const file = await folder.createFile(`export-${Math.random().toString(36).slice(2)}.${format}`, { overwrite: true })

  switch (format) {
    case 'jpg':
      await doc.saveAs.jpg(file, { quality: 12 } as any, true)
      break
    case 'png':
      await doc.saveAs.png(file, { compression: 6 } as any, true)
      break
    case 'bmp':
      await doc.saveAs.bmp(file, { depth: constants.BMPDepthType.TWENTYFOUR, alphaChannels: false } as any, true)
      break
  }

  return file as FileEntry
}

async function exportLayer (
  layer: Layer,
  format: 'jpg' | 'png' | 'bmp' = 'jpg',
  width = layer.bounds.right - layer.bounds.left,
  height = layer.bounds.bottom - layer.bounds.top
): Promise<FileEntry> {
  const newDoc = await app.documents.add({
    width,
    height,
    resolution: 72,
    mode: constants.NewDocumentMode.RGB,
    fill: constants.DocumentFill.BLACK
  })
  if (!newDoc) throw Error('Cannot create new document')
  setActiveLayer(layer)
  const newLayer = (await layer.duplicate(newDoc))!
  await newLayer.scale(width / (newLayer.bounds.right - newLayer.bounds.left) * 100, height / (newLayer.bounds.bottom - newLayer.bounds.top) * 100)
  await newLayer.translate(-newLayer.bounds.left, -newLayer.bounds.top)
  try {
    return await exportImage(newDoc, format)
  } finally {
    newDoc.closeWithoutSaving()
  }
}

const copyIntoArrayBuffer = async () => {
  await disactiveAllLayers()
  const mergedLayer = findMergeLayer()
  if (!mergedLayer) throw Error('Cannot find merged layer')
  setActiveLayer(mergedLayer)
  await copyToNewLayer()
  const layer = app.activeDocument.activeLayers[0]
  const { bounds } = layer
  const maxEdge = Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) / (app.activeDocument.resolution < 32 ? 1 : app.activeDocument.resolution / 72)

  const scale = Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) / 1024
  const entry = await exportLayer(layer, 'jpg', (bounds.right - bounds.left) / scale, (bounds.bottom - bounds.top) / scale)
  deleteLayer(layer)
  try {
    const arraybuffer = await entry.read({ format: formats.binary })
    return [arraybuffer, 1024 / maxEdge] as const
  } finally {
    await entry.delete()
  }
}

const deleteSelectionArea = () => batchPlay([{ _obj: 'delete', _target: [{ _ref: 'channel', _name: 'PSSD - Selection' }] }])
const saveSelectionArea = () => batchPlay([
  { _obj: 'make', new: { _obj: 'channel', color: { _obj: 'RGBColor', blue: 0.0, grain: 0.0, red: 255.0 }, colorIndicates: { _enum: 'maskIndicator', _value: 'maskedAreas' }, name: 'PSSD - Selection', opacity: 50 }, using: { _property: 'selection', _ref: 'channel' } }
])

const copyToNewLayer = () => batchPlay([{ _obj: 'copyToLayer' }])
const importLayer = async (buffer: ArrayBuffer) => {
  const file = await (await fs.getTemporaryFolder()).createFile(`generated-${Math.random().toString(36).slice(2)}.jpg`, { overwrite: true })
  await file.write(buffer, { format: formats.binary })
  await batchPlay(
    [
      {
        _obj: 'placeEvent',
        null: {
          _path: await fs.createSessionToken(file),
          _kind: 'local'
        },
        freeTransformCenterState: {
          _enum: 'quadCenterState',
          _value: 'QCSAverage'
        },
        offset: {
          _obj: 'offset',
          horizontal: {
            _unit: 'pixelsUnit',
            _value: 0
          },
          vertical: {
            _unit: 'pixelsUnit',
            _value: 0
          }
        },
        _options: {
          dialogOptions: 'dontDisplay'
        }
      }
    ]
  )
  file.delete().catch(console.error)
}

const getSelection = () => batchPlay(
  [{ _obj: 'get', _target: [{ _property: 'selection' }, { _ref: 'document', _id: app.activeDocument.id }] }]
)
const makeSelection = (top: number, left: number, bottom: number, right: number) => batchPlay(
  [{ _obj: 'set', _target: [{ _property: 'selection', _ref: 'channel' }], to: { _obj: 'rectangle', bottom: { _unit: 'pixelsUnit', _value: bottom }, left: { _unit: 'pixelsUnit', _value: left }, right: { _unit: 'pixelsUnit', _value: right }, top: { _unit: 'pixelsUnit', _value: top } } }]
)

const base64Encode = (buffer: ArrayBuffer) => {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i])
  return window.btoa(binary)
}

const base64Decode = (base64: string) => {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

const fillIntoWebview = async () => {
  const selection = (await getSelection())?.[0]?.selection
  if (!selection) {
    await core.showAlert({ message: 'Please make a selection first!' })
    return
  }

  console.log(selection)

  try {
    deleteMergeLayer()
    await deleteSelectionArea()
    await saveSelectionArea()

    await mergeLayers()
    const mergedLayer = findMergeLayer()
    if (!mergedLayer) throw Error('Cannot find merged layer')
    setActiveLayer(mergedLayer)

    const padding = Math.max(mergedLayer.bounds.right - mergedLayer.bounds.left, mergedLayer.bounds.bottom - mergedLayer.bounds.top) / 50
    await makeSelection(selection.top._value - padding, selection.left._value - padding, selection.bottom._value + padding, selection.right._value + padding)

    const [buffer] = await copyIntoArrayBuffer()

    await execRemote(`
      window.dataURLtoFile = (dataurl, filename) => {
        const arr = dataurl.split(','),
          mime = arr[0].match(/:(.*?);/)[1]
          bstr = atob(arr[arr.length - 1]),
          n = bstr.length,
          u8arr = new Uint8Array(n)
          while(n--) u8arr[n] = bstr.charCodeAt(n)
        return new File([u8arr], filename, { type: mime })
      }
      document.querySelectorAll('#tabs .tab-nav button')[1].click()
      document.querySelectorAll('#img2img_settings .tab-nav button')[0].click()
      document.querySelector('#img2img_tab_resize_by-button').click()
    `)

    await fillRemoteImage('img2img_image', `data:image/jpeg;base64,${base64Encode(buffer)}`)
  } catch (err: any) {
    void core.showAlert({ message: err.message })
    console.error(err)
  }
}

document.getElementById('github')!.onclick = () => shell.openExternal('https://github.com/ShirasawaSama/Stable-Diffusion-PS-WebUI', 'Thanks for your star!')
fillBtn.onclick = () => core.executeAsModal(fillIntoWebview, { commandName: 'Fill into Webview' })
document.getElementById('go')!.onclick = () => {
  const url = urlElm.value
  if (!url) return
  localStorage.setItem('url', url)
  urlElm.value = url
  go()
}

go()
urlElm.value = localStorage.getItem('url') || ''