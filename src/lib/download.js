/**
 * Hands the viewer a file. Must run in a document context (popup or the saved
 * -article page) -- a service worker has no `URL.createObjectURL`, which is why
 * exporting is not routed through the background.
 */
export function downloadText(filename, text, type = 'text/markdown') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()

  // The download reads the blob asynchronously; revoking at once can truncate it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
