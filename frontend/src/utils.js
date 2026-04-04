export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Returns the CSS class for highlighting a matched phrase in a search term.
 * Phrases can be prefixed with 'google:', 'ai:', or 'manual:' to indicate source.
 */
export function getHighlightClass(phrase, negatives) {
  const isGoogle = phrase.startsWith('google:')
  const isAi = phrase.startsWith('ai:')
  const isManual = phrase.startsWith('manual:')

  const googlePhrases = new Set(
    [...negatives]
      .filter(p => p.startsWith('google:'))
      .map(p => p.replace('google:', '').toLowerCase())
  )

  const displayPhrase = phrase.replace(/^(google:|ai:|manual:)/, '')

  // If AI/manual but Google already covers it, show as google style
  if ((isAi || isManual) && googlePhrases.has(displayPhrase.toLowerCase())) return 'term-neg-google'
  if (isGoogle) return 'term-neg-google'
  if (isAi) return 'term-neg-ai'
  if (isManual) return 'term-neg-manual'
  return 'term-neg-manual'
}

/**
 * Splits a search term string into parts with optional CSS highlight classes
 * for matched negative keyword portions.
 */
export function buildHighlightedParts(text, negatives) {
  if (!negatives || negatives.size === 0) return [{ text, cls: null }]

  const ranges = []
  negatives.forEach(phrase => {
    const cls = getHighlightClass(phrase, negatives)
    if (!cls) return
    const displayPhrase = phrase.replace(/^(google:|ai:|manual:)/, '')
    const escaped = escapeRegex(displayPhrase)
    const regex = new RegExp(`(?<![a-z0-9])(${escaped})(?![a-z0-9])`, 'gi')
    let match
    while ((match = regex.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length, cls })
    }
  })

  if (ranges.length === 0) return [{ text, cls: null }]

  ranges.sort((a, b) => a.start - b.start || b.end - a.end)

  // Remove overlapping ranges
  const merged = []
  for (const r of ranges) {
    if (merged.length > 0 && r.start < merged[merged.length - 1].end) continue
    merged.push(r)
  }

  const parts = []
  let lastIdx = 0
  for (const r of merged) {
    if (r.start > lastIdx) parts.push({ text: text.slice(lastIdx, r.start), cls: null })
    parts.push({ text: text.slice(r.start, r.end), cls: r.cls })
    lastIdx = r.end
  }
  if (lastIdx < text.length) parts.push({ text: text.slice(lastIdx), cls: null })

  return parts
}

export function getDefaultDates() {
  const today = new Date()
  const year = today.getFullYear()
  const month = today.getMonth() // 0-indexed (0 = January, 3 = April)
  
  // Get first day of previous month
  const firstOfPrevMonth = new Date(year, month - 1, 1)
  
  // Get last day of previous month using day 0 of current month
  const lastOfPrevMonth = new Date(year, month, 0)
  
  return {
    startDate: firstOfPrevMonth.toISOString().split('T')[0],
    endDate: lastOfPrevMonth.toISOString().split('T')[0],
  }
}

export function formatNumber(n, decimals = 0) {
  if (n == null) return '0'
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}
