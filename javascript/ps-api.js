window.uxpHost && window.addEventListener('message', async e => {
  if (e.source !== window.uxpHost) return
  const { id, code } = JSON.parse(e.data)
  // eslint-disable-next-line no-eval
  window.uxpHost.postMessage(JSON.stringify({ type: 'sd-webui', id, result: await eval(code) }))
})
