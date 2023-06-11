const { app, action, core, constants } = require('photoshop')
const { storage: { localFileSystem: fs, formats } } = require('uxp')
const { batchPlay } = action

const webview = document.getElementById('webview')

const promises = { }
window.addEventListener('message', ({ data }) => {
  if (!data || !data.includes('sd-webui')) return
  const { id, result } = JSON.parse(data)
  const p = promises[id]
  if (p) {
    p(result)
    delete promises[id]
  }
})

const execRemote = code => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
  webview.postMessage(JSON.stringify({ id, code: `{${code}}` }))
  return new Promise(resolve => (promises[id] = resolve))
}
const fillRemoteImage = (field, data) => execRemote(`
  const file = document.querySelector('#${field} input')
  const dataTransfer = new DataTransfer()
  dataTransfer.items.add(new File([window.dataURLtoFile('${data}')], 'image.jpg', { type: 'image/jpeg' }))
  file.files = dataTransfer.files
  file.dispatchEvent(new Event('change'))
  void 0
`)
const fillRemoteInput = (field, data) => execRemote(`
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
  app.activeDocument.layers.forEach(layer => (layer.selected = false))
}

async function getImageData () {
  const folder = await fs.getTemporaryFolder()
  const file = await folder.createFile('canvas_image.jpg', { overwrite: true })

  const currentDocument = app.activeDocument
  await currentDocument.saveAs.jpg(file, { quality: 12 }, true)

  return 'data:image/jpeg;base64,' + btoa(new Uint8Array(await file.read({ format: formats.binary }))
    .reduce((data, byte) => data + String.fromCharCode(byte), ''))
}

const fillIntoWebview = async () => {
  if (!(await batchPlay(
    [{
      _obj: 'get',
      _target: [{ _property: 'selection' }, { _ref: 'document', _id: app.activeDocument._id }],
      _options: { dialogOptions: 'dontDisplay' }
    }],
    { modalBehavior: 'execute' }
  ))[0].selection) {
    await core.showAlert({ message: 'Please make a selection!' })
    return
  }
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
    document.querySelectorAll('#img2img_settings .tab-nav button')[4].click()
  `)
  const doc = app.activeDocument
  const layer = doc.activeLayers[0]
  if (!layer) {
    await core.showAlert({ message: 'Please select a layer!' })
    return
  }
  if (!layer.visible || layer.kind !== constants.LayerKind.NORMAL) {
    await core.showAlert({ message: 'Please select a normal visible layer!' })
    return
  }
  unselectActiveLayers()
  const oldColor = app.foregroundColor

  const maskBackgroundLayer = await doc.createLayer({ name: 'Mask Background Layer' })
  const maskLayer = await doc.createLayer({ name: 'Mask Layer' })
  app.foregroundColor = color()
  maskLayer.selected = true
  await batchPlay([
    { _obj: 'fill', using: { _enum: 'fillContents', _value: 'foregroundColor' } },
    { _obj: 'set', _target: [{ _property: 'selection', _ref: 'channel' }], to: { _enum: 'ordinal', _value: 'none' } }
  ], {})

  maskLayer.selected = false
  maskBackgroundLayer.selected = true
  app.foregroundColor = color(255, 255, 255)
  await batchPlay([{ _obj: 'fill', using: { _enum: 'fillContents', _value: 'foregroundColor' } }], {})

  app.foregroundColor = oldColor
  maskLayer.selected = true
  const newLayer = await maskLayer.merge()
  const maskData = await getImageData()
  newLayer.delete()

  await fillRemoteImage('img_inpaint_mask', maskData)
  await fillRemoteImage('img_inpaint_base', await getImageData())

  const maxEdge = Math.max(doc.width, doc.height)
  const scale = Math.min(1176 / maxEdge, 1)
  await fillRemoteInput('img2img_width', (doc.width * scale / 8 | 0) * 8)
  await fillRemoteInput('img2img_height', (doc.height * scale / 8 | 0) * 8)
  await fillRemoteInput('img2img_denoising_strength', 0.5)
  await fillRemoteInput('img2img_steps', 75)
}

const execInModal = (func, name) => core.executeAsModal(async () => {
  try { await func() } catch (e) { console.error(e) }
}, { commandName: name })

document.getElementById('fill').addEventListener('click', () => execInModal(fillIntoWebview, 'Fill data into webview'))
document.getElementById('go').addEventListener('click', () => {
  const elm = document.getElementById('url')
  const url = elm.value
  if (!url) return
  elm.value = ''
  webview.src = url
  localStorage.setItem('url', url)
})

const url = localStorage.getItem('url')
if (url) webview.src = url
