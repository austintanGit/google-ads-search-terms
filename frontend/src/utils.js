export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Normalize for comparison (case-insensitive, collapsed spaces). */
function normalizeComparableQuery(q) {
  return (q ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * Approximate Google Ads negative matching for UI chips/highlights — not authoritative.
 * EXACT ≈ query text equals keyword; PHRASE ≈ contiguous whole-word phrase; BROAD ≈ every token appears as whole word (any order).
 */
export function googleNegativeMatchesSearchQuery(searchTerm, keyword, matchType) {
  const mt = (matchType ?? 'EXACT').toString().toUpperCase()
  const termNorm = normalizeComparableQuery(searchTerm)
  const kwNorm = normalizeComparableQuery(typeof keyword === 'string' ? keyword : keyword == null ? '' : String(keyword))
  if (!kwNorm) return false

  if (mt === 'EXACT') {
    return termNorm === kwNorm
  }

  if (mt === 'PHRASE') {
    const parts = kwNorm.split(/\s+/).map(p => escapeRegex(p)).filter(Boolean)
    if (!parts.length) return false
    const body = parts.join('\\s+')
    const re = new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i')
    return re.test(searchTerm)
  }

  if (mt === 'BROAD') {
    const tokens = kwNorm.split(/\s+/).filter(Boolean)
    if (!tokens.length) return false
    return tokens.every(tok => {
      const re = new RegExp(`(?<![a-z0-9])${escapeRegex(tok)}(?![a-z0-9])`, 'i')
      return re.test(searchTerm)
    })
  }

  return termNorm === kwNorm
}

// Same parsing as SearchTermsTable: "google:foo bar (PHRASE)" → keyword + matchType
export function parseNegativePhrase(phrase) {
  const source = phrase.startsWith('google:') ? 'google'
    : phrase.startsWith('ai:') ? 'ai'
    : 'manual'
  const raw = phrase.replace(/^(google:|ai:|manual:)/, '')
  const parenIdx = raw.lastIndexOf(' (')
  if (parenIdx !== -1) {
    return { keyword: raw.slice(0, parenIdx), matchType: raw.slice(parenIdx + 2, -1), source }
  }
  return { keyword: raw, matchType: 'EXACT', source }
}

/**
 * Value for `/review?client=` — prefer digits-only Google Ads customer id so it matches
 * `client_pending_state` keys and the review resolver `byId`; fall back to descriptive name.
 */
export function buildReviewClientQueryParam(customerId, descriptiveName) {
  const digits = String(customerId ?? '').replace(/\D/g, '')
  if (digits.length >= 6) return digits
  return String(descriptiveName ?? '').trim()
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
    const { keyword: kwRaw, matchType: mtParsed } = parseNegativePhrase(phrase)
    const kwTrim = kwRaw.trim()
    if (!kwTrim) return

    // Keep chip display and highlighting aligned for Google-loaded negatives.
    if (phrase.startsWith('google:')) {
      if (!googleNegativeMatchesSearchQuery(text, kwTrim, mtParsed)) return
    }

    const parts = kwTrim.split(/\s+/).map(seg => escapeRegex(seg)).join('\\s+')
    const escaped = `(?:${parts})`
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
