import fs from 'fs'

if (!fs.existsSync('Stable-Diffusion-PS-WebUI')) fs.mkdirSync('Stable-Diffusion-PS-WebUI')
if (!fs.existsSync('Stable-Diffusion-PS-WebUI/images')) fs.mkdirSync('Stable-Diffusion-PS-WebUI/images')

;['index.html', 'scripts.js', 'LICENSE', 'manifest.json', 'images/icon@1x.png', 'images/icon@2x.png']
  .forEach(file => fs.copyFileSync(file, `Stable-Diffusion-PS-WebUI/${file}`))
