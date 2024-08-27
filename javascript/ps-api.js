window.uxpHost && window.addEventListener('message', async e => {
  if (e.source !== window.uxpHost) return
  let error, result
  try {
    result = await eval(code)
  } catch (e) {
    error = e
  }
  window.uxpHost.postMessage({ type: 'sd-webui', id: e.data.id, action: 'result', result, error: error && error.message })
})
