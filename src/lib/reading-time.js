/** Average adult reading speed for web prose. */
const WORDS_PER_MINUTE = 200

export function countWords(text = '') {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

export function readingTimeMinutes(text) {
  return Math.max(1, Math.round(countWords(text) / WORDS_PER_MINUTE))
}
