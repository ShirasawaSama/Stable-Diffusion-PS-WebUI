import puppeteer from 'puppeteer'
import { WebSocketServer } from 'ws'

const wss = new WebSocketServer({ port: +process.env.PORT || 8573 })

const browser = await puppeteer.launch({ headless: false, appMode: true, defaultViewport: null, userDataDir: './cache' })
const page = (await browser.pages())[0]

wss.on('connection', ws => {
  console.log('Connection opened')
  ws.on('error', console.error).on('message', data => {
    const { id, code } = JSON.parse(data.toString())
    ;(id === 'goto' ? page.goto(code).then(() => true) : page.evaluate(code)).catch(e => {
      console.error(e)
      return null
    }).then(result => ws.send(JSON.stringify({ type: 'sd-webui', id, result })))
  })
})
page.on('close', () => {
  console.log('Page closed')
  browser.close()
  process.exit()
})

console.log('Server started on port ' + wss.options.port)
