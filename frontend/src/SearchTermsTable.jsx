import React, { useState, useEffect, useRef, useMemo, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { buildHighlightedParts, parseNegativePhrase } from './utils'

const MATCH_TYPE_OPTIONS = [
  { value: 'EXACT', label: 'Exact' },
  { value: 'PHRASE', label: 'Phrase' },
  { value: 'BROAD', label: 'Broad' },
]

const DESTINATION_OPTIONS = [
  { value: 'CAMPAIGN', label: 'Campaign level' },
  { value: 'ADGROUP', label: 'Ad group level' },
  { value: 'NEGATIVE_LIST', label: 'Keyword list' },
]

const DEST_CLASS = {
  CAMPAIGN: 'dest-select-campaign',
  ADGROUP: 'dest-select-adgroup',
  NEGATIVE_LIST: 'dest-select-list',
}

/**
 * Placement for campaign/ad group negatives tied to THIS search-term row (term.campaignId / term.adGroupId).
 */
function mergePendingDestinationFromSearchTermRow(item, destination, row, camps, agByCampaign) {
  const next = {
    ...item,
    destination,
    sharedSetId: destination === 'NEGATIVE_LIST' ? item.sharedSetId : null,
  }
  const campList = Array.isArray(camps) ? camps : []
  const rowCid = row?.campaignId
  const rowAid = row?.adGroupId
  const camp = rowCid ? campList.find(c => String(c.id) === String(rowCid)) : null

  if (destination === 'CAMPAIGN') {
    if (camp) {
      return {
        ...next,
        campaignId: camp.id,
        campaignName: camp.name || row?.campaign || null,
        adGroupId: null,
        adGroupName: null,
      }
    }
    return { ...next, campaignId: null, campaignName: null, adGroupId: null, adGroupName: null }
  }

  if (destination === 'ADGROUP') {
    const agList = rowCid && agByCampaign ? (agByCampaign[rowCid] || []) : []
    const ag = rowAid ? agList.find(a => String(a.id) === String(rowAid)) : null

    if (camp && ag) {
      return {
        ...next,
        campaignId: camp.id,
        campaignName: camp.name || row?.campaign || null,
        adGroupId: ag.id,
        adGroupName: ag.name || row?.adGroup || null,
      }
    }
    if (camp) {
      return {
        ...next,
        campaignId: camp.id,
        campaignName: camp.name || row?.campaign || null,
        adGroupId: null,
        adGroupName: null,
      }
    }
    return { ...next, campaignId: null, campaignName: null, adGroupId: null, adGroupName: null }
  }

  return next
}

/** Prefer search-term row placement when missing pieces (safe for hydrate / no churn). */
function maybeHydratePendingPlacementFromSearchTermRow(item, destination, row, camps, agByCampaign) {
  const dest = destination || 'NEGATIVE_LIST'
  if ((dest !== 'CAMPAIGN' && dest !== 'ADGROUP') || !row?.campaignId) return item

  const merged = mergePendingDestinationFromSearchTermRow(item, dest, row, camps, agByCampaign)
  const cidEq = String(merged.campaignId ?? '') === String(item.campaignId ?? '')
  const aidEq = String(merged.adGroupId ?? '') === String(item.adGroupId ?? '')
  const destEq = merged.destination === item.destination
  const snEq =
    merged.campaignName === item.campaignName &&
    merged.adGroupName === item.adGroupName
  if (destEq && cidEq && aidEq && snEq) return item

  return merged
}

/** When CAMPAIGN/ADGROUP is selected from a row, fill missing IDs from search-term attribution. */
function RowDestinationPlacementHydrate({ peersJson, destination, rowTermSnapshot, hydrateRef }) {
  const cid = rowTermSnapshot?.campaignId ?? ''
  const aid = rowTermSnapshot?.adGroupId ?? ''

  useEffect(() => {
    const fn = hydrateRef?.current
    if (typeof fn !== 'function') return
    let keywords = []
    try {
      keywords = peersJson ? JSON.parse(peersJson) : []
    } catch {
      keywords = []
    }
    fn(keywords, destination, rowTermSnapshot)
  }, [peersJson, destination, cid, aid, hydrateRef])

  return null
}

function HighlightedSearchTerm({ text, negatives }) {
  const parts = buildHighlightedParts(text, negatives)
  return (
    <span>
      {parts.map((part, i) =>
        part.cls ? (
          <span key={i} className={part.cls}>{part.text}</span>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </span>
  )
}

function formatNegLabel(keyword, matchType) {
  const mt = matchType.toUpperCase()
  if (mt === 'EXACT') return `[${keyword}]`
  if (mt === 'PHRASE') return `"${keyword}"`
  return keyword
}

function formatHistoryDate(isoStr) {
  return new Date(isoStr).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

export default function SearchTermsTable({
  searchTerms,
  rowNegatives,
  onAddNegative,
  onRemoveNegative,
  onRemoveGoogleNegative,
  existingNegatives,
  // Unified panel props
  pendingNegatives,
  setPendingNegatives,
  campaigns,
  adGroupsByCampaign,
  sharedSets,
  onCreateSharedSet,
  onSubmitNegatives,
  submissionHistory,
  clientName,
  submitSuccess,
  setSubmitSuccess,
  submitError,
  setSubmitError,
  manualAddSuccess,
  manualAddError,
  onSaveWork,
  onClearWork,
  approvalClientId,
  onCreateReviewRequest,
  defaultSharedSetId,
  onSaveDefaultSharedSet,
  isReviewMode = false,
}) {
  const [isUpdatePending, startTableTransition] = useTransition()
  const pointerPosRef = useRef({ x: typeof window !== 'undefined' ? window.innerWidth / 2 : 0, y: typeof window !== 'undefined' ? window.innerHeight / 2 : 0 })
  const videoRef = useRef(null)
  const pendingSelectionRef = useRef(null)
  const tableRef = useRef(null)
  const destinationPlacementHydrateRef = useRef(() => {})

  const [pointerBusyAt, setPointerBusyAt] = useState(null)
  const [sortCol, setSortCol] = useState('clicks')
  const [sortDir, setSortDir] = useState('desc')
  const [searchFilter, setSearchFilter] = useState('')
  const [campaignFilter, setCampaignFilter] = useState('')
  const [hoveredRow, setHoveredRow] = useState(null)
  const [videoOpen, setVideoOpen] = useState(false)
  const [toolbar, setToolbar] = useState({ visible: false, x: 0, y: 0 })
  const [bulkMatchType, setBulkMatchType] = useState('PHRASE')
  const [bulkDestination, setBulkDestination] = useState('NEGATIVE_LIST')
  const [bulkSharedSetId, setBulkSharedSetId] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  const [showSubmitModal, setShowSubmitModal] = useState(false)
  const [showSubmitSuccessModal, setShowSubmitSuccessModal] = useState(false)
  const [reviewChoices, setReviewChoices] = useState({})
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [showApprovalModal, setShowApprovalModal] = useState(false)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [approvalEmail, setApprovalEmail] = useState('')
  const [approvalSending, setApprovalSending] = useState(false)
  const [approvalSendError, setApprovalSendError] = useState('')
  const [copyLinkCopied, setCopyLinkCopied] = useState(false)
  const [createdReviewLink, setCreatedReviewLink] = useState(null)
  const [creatingReviewLink, setCreatingReviewLink] = useState(false)
  const [reviewLinkAction, setReviewLinkAction] = useState('')
  const [createListCtx, setCreateListCtx] = useState(null)
  const [newListName, setNewListName] = useState('')
  const [createListLoading, setCreateListLoading] = useState(false)
  const [createListError, setCreateListError] = useState('')
  const [savingDefaultList, setSavingDefaultList] = useState(false)

  useEffect(() => {
    const track = (e) => {
      pointerPosRef.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('pointerdown', track, true)
    window.addEventListener('pointermove', track, true)
    return () => {
      window.removeEventListener('pointerdown', track, true)
      window.removeEventListener('pointermove', track, true)
    }
  }, [])

  useEffect(() => {
    if (!isUpdatePending) setPointerBusyAt(null)
  }, [isUpdatePending])

  useEffect(() => {
    const preferredId = defaultSharedSetId || sharedSets?.[0]?.id || null
    if (!preferredId) return
    setBulkSharedSetId(prev => prev || preferredId)
  }, [sharedSets, defaultSharedSetId])

  useEffect(() => {
    if (bulkDestination !== 'NEGATIVE_LIST') return
    const preferredId = defaultSharedSetId || sharedSets?.[0]?.id || null
    if (!preferredId) return
    setBulkSharedSetId(prev => (prev ? prev : preferredId))
  }, [bulkDestination, defaultSharedSetId, sharedSets])

  useEffect(() => {
    function handleMouseUp(e) {
      setTimeout(() => {
        const selection = window.getSelection()
        const selectedText = selection?.toString().trim()
        if (!selectedText || !tableRef.current) return
        const anchor = selection.anchorNode
        const cell = anchor?.parentElement?.closest('.search-term-cell')
        if (!cell || !tableRef.current.contains(cell)) return
        pendingSelectionRef.current = selectedText
        setToolbar({ visible: true, x: e.clientX + 8, y: e.clientY + 8 })
      }, 0)
    }
    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [])

  useEffect(() => {
    function handleMouseDown(e) {
      if (!e.target.closest('.selection-toolbar')) {
        setToolbar({ visible: false, x: 0, y: 0 })
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [])

  const safeSearchTerms = Array.isArray(searchTerms) ? searchTerms : []

  const campaignList = [...new Set(safeSearchTerms.map(t => t.campaign).filter(Boolean))].sort()

  function passesTableFilters(term) {
    if (searchFilter && !term.searchTerm?.toLowerCase().includes(searchFilter.toLowerCase())) return false
    if (campaignFilter && term.campaign !== campaignFilter) return false
    return true
  }

  // Find the pendingNegatives item for a given keyword string.
  // Prefer the truly-pending (alreadyInGoogle=false) entry when duplicates exist.
  function getPendingItem(keyword) {
    const matches = (pendingNegatives || []).filter(i => i.keyword.toLowerCase() === keyword.toLowerCase())
    return matches.find(i => !i.alreadyInGoogle) || matches[0]
  }

  function rowCategory(term) {
    const negs = rowNegatives.get(term.searchTerm)
    if (!negs) return 2
    for (const p of negs) {
      if (p.startsWith('ai:') || p.startsWith('manual:')) {
        const kw = parseNegativePhrase(p).keyword
        const item = getPendingItem(kw)
        if (item && !item.alreadyInGoogle) return 0
      }
    }
    if ([...negs].some(p => p.startsWith('google:'))) return 1
    return 2
  }

  // Sort order is captured once per `searchTerms` load only (filters + sort column as they are at that moment).
  // Uncheck/remove and other pending changes do not re-run this — rows stay fixed (see sortedRows below).
  const frozenRowIndices = useMemo(() => {
    if (!searchTerms.length) return []
    const indexedFiltered = searchTerms
      .map((term, index) => ({ term, index }))
      .filter(({ term }) => passesTableFilters(term))
    const sortedIndexed = [...indexedFiltered].sort((a, b) => {
      const ca = rowCategory(a.term)
      const cb = rowCategory(b.term)
      if (ca !== cb) return ca - cb
      const aVal = a.term[sortCol] ?? ''
      const bVal = b.term[sortCol] ?? ''
      const dir = sortDir === 'asc' ? 1 : -1
      if (typeof aVal === 'number') return (aVal - bVal) * dir
      return String(aVal).localeCompare(String(bVal)) * dir
    })
    return sortedIndexed.map(({ index }) => index)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only when the search-term dataset reloads
  }, [searchTerms])

  const sortedRows = useMemo(() => {
    if (!frozenRowIndices.length) return []
    return frozenRowIndices
      .map(i => {
        const term = searchTerms[i]
        if (!term || !passesTableFilters(term)) return null
        return { term, rowIndex: i }
      })
      .filter(Boolean)
  }, [searchTerms, frozenRowIndices, searchFilter, campaignFilter])

  function handleSort(_col) {
    // Order is fixed after each data load; column headers keep the active sort indicator from when terms loaded.
  }

  function SortIcon({ col }) {
    if (sortCol !== col) return <i className="fas fa-sort sort-icon" />
    return sortDir === 'asc'
      ? <i className="fas fa-sort-up sort-icon active" />
      : <i className="fas fa-sort-down sort-icon active" />
  }

  // Compute problematic keywords: those generating ≥30% of all pending-negative rows
  const problematicKws = useMemo(() => {
    const negCountByKw = {}
    searchTerms.forEach(term => {
      const negs = rowNegatives.get(term.searchTerm)
      if (negs && [...negs].some(p => p.startsWith('ai:') || p.startsWith('manual:'))) {
        const kw = term.matchingKeyword
        if (kw) negCountByKw[kw] = (negCountByKw[kw] || 0) + 1
      }
    })
    const totalNegRows = Object.values(negCountByKw).reduce((a, b) => a + b, 0)
    return new Set(
      Object.entries(negCountByKw)
        .filter(([, count]) => totalNegRows > 0 && count / totalNegRows >= 0.30)
        .map(([kw]) => kw)
    )
  }, [searchTerms, rowNegatives])

  const selectedCount = (pendingNegatives || []).filter(i => i.selected && !i.alreadyInGoogle).length

  function pointFromEvent(ev) {
    if (ev && typeof ev.clientX === 'number' && typeof ev.clientY === 'number') {
      const { x, y } = pointerPosRef.current
      if (ev.clientX !== 0 || ev.clientY !== 0) return { x: ev.clientX, y: ev.clientY }
      return { x, y }
    }
    return { ...pointerPosRef.current }
  }

  /** Large tables stay responsive: defer heavy re-renders and show a pointer indicator while React works. */
  function runPendingUiUpdate(fn, point) {
    const p = point ?? pointerPosRef.current
    setPointerBusyAt({ x: p.x, y: p.y })
    startTableTransition(() => fn())
  }

  // --- Pending negative handlers ---
  function handleToggleRow(keyword, checked, point) {
    runPendingUiUpdate(() =>
      setPendingNegatives(prev =>
        prev.map(i => i.keyword.toLowerCase() === keyword.toLowerCase() && !i.alreadyInGoogle
          ? { ...i, selected: checked } : i
        )
      ),
      point
    )
  }

  /** Uncheck removes AI suggestions from Google’s perspective for this row; manual flags stay but are unchecked. */
  function handleRowPendingCheckboxChange(pendingPhraseList, checked, ev) {
    const pt = pointFromEvent(ev)
    if (!checked) {
      const aiKeywords = []
      const manualKeywords = []
      for (const phrase of pendingPhraseList) {
        const { keyword } = parseNegativePhrase(phrase)
        if (phrase.startsWith('ai:')) aiKeywords.push(keyword)
        else if (phrase.startsWith('manual:')) manualKeywords.push(keyword)
      }
      runPendingUiUpdate(() => {
        aiKeywords.forEach(kw => onRemoveNegative(kw))
        if (manualKeywords.length === 0) return
        const lower = new Set(manualKeywords.map(k => k.toLowerCase()))
        setPendingNegatives(prev =>
          prev.map(i =>
            lower.has(i.keyword.toLowerCase()) && !i.alreadyInGoogle ? { ...i, selected: false } : i
          )
        )
      }, pt)
      return
    }
    selectAllPendingKeywordsInRow(pendingPhraseList, true, ev)
  }

  function handleToggleAll(checked, ev) {
    runPendingUiUpdate(() =>
      setPendingNegatives(prev => prev.map(i => i.alreadyInGoogle ? i : { ...i, selected: checked })),
      pointFromEvent(ev)
    )
  }

  function handleMatchTypeChange(keyword, matchType, ev) {
    const k = keyword.toLowerCase()
    runPendingUiUpdate(() =>
      setPendingNegatives(prev =>
        prev.map(i => i.keyword.toLowerCase() === k ? { ...i, matchType } : i)),
      pointFromEvent(ev)
    )
  }

  /** When a row has several triggered negatives, checking the row should select every pending keyword on that row. */
  function selectAllPendingKeywordsInRow(pendingPhraseList, checked, ev) {
    const pt = pointFromEvent(ev)
    const lowerSet = new Set(
      pendingPhraseList.map(p => parseNegativePhrase(p).keyword.toLowerCase())
    )
    runPendingUiUpdate(() =>
      setPendingNegatives(prev =>
        prev.map(i =>
          lowerSet.has(i.keyword.toLowerCase()) && !i.alreadyInGoogle
            ? { ...i, selected: checked }
            : i
        )
      ),
      pt
    )
  }

  /** Apply a field update to every pending (non–already-in-Google) keyword on the same search-term row. */
  function patchPendingRowPeers(peersLower, ev, updater) {
    const pt = ev ? pointFromEvent(ev) : pointerPosRef.current
    runPendingUiUpdate(
      () =>
        setPendingNegatives(prev => {
          let changed = false
          const next = prev.map(i => {
            if (!peersLower.has(i.keyword.toLowerCase()) || i.alreadyInGoogle) return i
            const n = updater(i)
            if (n !== i) changed = true
            return n
          })
          return changed ? next : prev
        }),
      pt
    )
  }

  function applySharedSetToRowPeers(peersLower, sharedSetId, ev) {
    patchPendingRowPeers(peersLower, ev, i => ({ ...i, sharedSetId }))
  }

  function applyDestinationToRowPeers(peersLower, destination, ev, searchTermRow) {
    patchPendingRowPeers(peersLower, ev, i =>
      mergePendingDestinationFromSearchTermRow(
        i,
        destination,
        searchTermRow || null,
        campaigns,
        adGroupsByCampaign,
      ),
    )
  }

  function applyCampaignToRowPeers(peersLower, campaignId, ev) {
    const cId = campaignId ? String(campaignId) : null
    const pickedLabel = ev?.target?.selectedOptions?.[0]?.textContent?.trim?.() ?? ''
    const campaignMeta = cId ? (campaigns || []).find(c => String(c.id) === cId) : null

    patchPendingRowPeers(peersLower, ev, i => {
      if (!cId) {
        return {
          ...i,
          campaignId: null,
          campaignName: null,
          adGroupId: null,
          adGroupName: null,
        }
      }
      return {
        ...i,
        campaignId: campaignMeta?.id ?? cId,
        campaignName: campaignMeta?.name || pickedLabel || null,
        adGroupId: null,
        adGroupName: null,
      }
    })
  }

  function applyAdGroupToRowPeers(peersLower, anchorCampaignId, adGroupId, ev) {
    const gId = adGroupId ? String(adGroupId) : null
    const pickedLabel = ev?.target?.selectedOptions?.[0]?.textContent?.trim?.() ?? ''
    const agList = (adGroupsByCampaign || {})[anchorCampaignId] || []
    const ag = gId ? agList.find(a => String(a.id) === gId) : null

    patchPendingRowPeers(peersLower, ev, i => {
      if (!gId) {
        return { ...i, adGroupId: null, adGroupName: null }
      }
      return {
        ...i,
        adGroupId: ag?.id ?? gId,
        adGroupName: ag?.name || pickedLabel || null,
      }
    })
  }

  function handleApplyBulkMatchType(ev) {
    runPendingUiUpdate(() =>
      setPendingNegatives(prev =>
        prev.map(i =>
          (!i.selected || i.alreadyInGoogle) ? i : { ...i, matchType: bulkMatchType })),
      pointFromEvent(ev)
    )
  }

  function handleApplyBulkDestination(ev) {
    runPendingUiUpdate(() =>
      setPendingNegatives(prev => prev.map(i => {
        if (!i.selected || i.alreadyInGoogle) return i
        return {
          ...i,
          destination: bulkDestination,
          sharedSetId: bulkDestination === 'NEGATIVE_LIST' ? bulkSharedSetId : null,
        }
      })),
      pointFromEvent(ev)
    )
  }

  // Create new list
  async function handleCreateList(onSuccess) {
    const name = newListName.trim()
    if (!name) return
    setCreateListLoading(true)
    setCreateListError('')
    try {
      const newSet = await onCreateSharedSet(name)
      onSuccess(newSet)
      setCreateListCtx(null)
      setNewListName('')
    } catch (err) {
      setCreateListError(err.message || 'Failed to create list')
    } finally {
      setCreateListLoading(false)
    }
  }

  // One destination control per table row; peers stay in sync. `rowTerm` supplies default campaign/ad group (search term row).
  function renderDestCell(item, rowPeersLower, rowTerm) {
    if (!item || item.alreadyInGoogle) return null
    const dest = item.destination || 'NEGATIVE_LIST'
    const campaignPickList = [...(campaigns || [])]
    if (rowTerm?.campaignId) {
      const has = campaignPickList.some(c => String(c.id) === String(rowTerm.campaignId))
      if (!has) {
        campaignPickList.push({
          id: rowTerm.campaignId,
          name: rowTerm.campaign || 'Campaign',
        })
      }
    }

    let adPick = item.campaignId
      ? ((adGroupsByCampaign || {})[item.campaignId] || []).slice()
      : []
    if (
      dest === 'ADGROUP' &&
      rowTerm?.adGroupId &&
      rowTerm?.campaignId != null &&
      String(rowTerm.campaignId) === String(item.campaignId || '')
    ) {
      const hasAg = adPick.some(a => String(a.id) === String(rowTerm.adGroupId))
      if (!hasAg) {
        adPick.push({
          id: rowTerm.adGroupId,
          name: rowTerm.adGroup || 'Ad group',
        })
      }
    }

    const peers =
      rowPeersLower instanceof Set && rowPeersLower.size > 0
        ? rowPeersLower
        : new Set([item.keyword.toLowerCase()])

    return (
      <div className="destination-cell">
        <select
          className={`matchtype-select ${DEST_CLASS[dest] || ''}`}
          value={dest}
          onChange={e =>
            applyDestinationToRowPeers(peers, e.target.value, e, rowTerm)}
        >
          {DESTINATION_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        {(dest === 'CAMPAIGN' || dest === 'ADGROUP') && campaignPickList.length > 0 && (
          <select
            className="matchtype-select dest-select-campaign"
            value={
              item.campaignId != null && item.campaignId !== ''
                ? String(item.campaignId)
                : ''
            }
            onChange={e => applyCampaignToRowPeers(peers, e.target.value, e)}
          >
            <option value="">Select campaign…</option>
            {campaignPickList.map(c => (
              <option key={String(c.id)} value={String(c.id)}>{c.name}</option>
            ))}
          </select>
        )}

        {dest === 'ADGROUP' && item.campaignId && adPick.length > 0 && (
          <select
            className="matchtype-select dest-select-adgroup"
            value={
              item.adGroupId != null && item.adGroupId !== ''
                ? String(item.adGroupId)
                : ''
            }
            onChange={e => applyAdGroupToRowPeers(peers, item.campaignId, e.target.value, e)}
          >
            <option value="">Select ad group…</option>
            {adPick.map(ag => (
              <option key={String(ag.id)} value={String(ag.id)}>{ag.name}</option>
            ))}
          </select>
        )}

        {dest === 'NEGATIVE_LIST' && (
          <div className="inline-list-picker">
            <div className="list-picker-controls list-picker-controls-solo">
              <select
                className="matchtype-select dest-select-list"
                value={item.sharedSetId || ''}
                onChange={e => applySharedSetToRowPeers(peers, e.target.value || null, e)}
              >
                <option value="">Select list…</option>
                {(sharedSets || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Download / copy history
  function downloadHistoryEntry(entry) {
    const keywords = Array.isArray(entry.keywords) ? entry.keywords : []
    const rows = keywords.map(k => typeof k === 'string' ? `"${k}","EXACT"` : `"${k.keyword}","${k.matchType}"`)
    const csv = `"Keyword","Match Type"\n${rows.join('\n')}`
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `negatives-${formatHistoryDate(entry.submitted_at).replace(/ /g, '-')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  function copyHistoryEntry(entry) {
    const keywords = Array.isArray(entry.keywords) ? entry.keywords : []
    const text = keywords.map(k => typeof k === 'string' ? k : k.keyword).join('\n')
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
    } else {
      fallbackCopy(text)
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
  }

  function copyToClipboard(text) {
    if (!text) return Promise.resolve(false)
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard
        .writeText(text)
        .then(() => true)
        .catch(() => false)
    }
    return Promise.resolve(false)
  }

  function copyCreatedReviewLink() {
    const link = createdReviewLink?.publicUrl
    if (!link) return
    copyToClipboard(link).then((ok) => {
      if (!ok) return
      setCopyLinkCopied(true)
      setTimeout(() => setCopyLinkCopied(false), 2000)
    })
  }

  function buildReviewItemsPayload() {
    return checkedPendingItems.map(item => ({
      keyword: item.keyword,
      matchType: item.matchType,
      destination: item.destination || 'NEGATIVE_LIST',
      campaignId: item.campaignId || null,
      campaignName: item.campaignName || null,
      adGroupId: item.adGroupId || null,
      adGroupName: item.adGroupName || null,
      sharedSetId: item.sharedSetId || null,
      sourceMeta: {
        source: item.source || null,
        sourceSearchTerms: Array.isArray(item.sourceSearchTerms)
          ? item.sourceSearchTerms.slice(0, 5)
          : null,
      },
    }))
  }

  async function createReviewRequest({ withEmail }) {
    if (typeof onCreateReviewRequest !== 'function') {
      throw new Error('Review request creation is not configured.')
    }
    if (checkedPendingItems.length === 0) {
      throw new Error('Check at least one keyword before creating a review request.')
    }
    if (!approvalClientId) {
      throw new Error('Please select a client first.')
    }
    if (withEmail && !approvalEmail.trim()) {
      throw new Error('Please enter a recipient email address.')
    }
    if (onSaveWork) {
      try { await onSaveWork() } catch { /* non-fatal */ }
    }
    const payload = {
      clientId: approvalClientId,
      clientName: clientName || '',
      recipientEmail: withEmail ? approvalEmail.trim() : null,
      sendEmail: !!withEmail,
      items: buildReviewItemsPayload(),
    }
    const result = await onCreateReviewRequest(payload)
    return result
  }

  async function sendApproval() {
    setApprovalSendError('')
    setReviewLinkAction('send')
    setApprovalSending(true)
    try {
      const result = await createReviewRequest({ withEmail: true })
      setCreatedReviewLink(result)
      copyToClipboard(result.publicUrl).catch(() => {})
      setSubmitError('')
      setSubmitSuccess('')
    } catch (err) {
      setApprovalSendError(err.message || 'Failed to create review request.')
    } finally {
      setApprovalSending(false)
      setReviewLinkAction('')
    }
  }

  async function generateLinkOnly() {
    setApprovalSendError('')
    setReviewLinkAction('link')
    setCreatingReviewLink(true)
    try {
      const result = await createReviewRequest({ withEmail: false })
      setCreatedReviewLink(result)
      copyToClipboard(result.publicUrl).then((ok) => {
        if (ok) {
          setCopyLinkCopied(true)
          setTimeout(() => setCopyLinkCopied(false), 2000)
        }
      })
    } catch (err) {
      setApprovalSendError(err.message || 'Failed to create review link.')
    } finally {
      setCreatingReviewLink(false)
      setReviewLinkAction('')
    }
  }

  function closeApprovalModal() {
    setShowApprovalModal(false)
    setApprovalEmail('')
    setApprovalSendError('')
    setCreatedReviewLink(null)
    setCopyLinkCopied(false)
  }

  async function handleToggleDefaultKeywordList(checked) {
    if (!onSaveDefaultSharedSet || !bulkSharedSetId) return
    setSavingDefaultList(true)
    setSubmitError('')
    try {
      await onSaveDefaultSharedSet(checked ? String(bulkSharedSetId) : null)
      setSubmitSuccess(
        checked
          ? 'Default keyword list saved for this account.'
          : 'Default keyword list cleared for this account.',
      )
    } catch (err) {
      setSubmitError(err.message || 'Failed to save default keyword list.')
    } finally {
      setSavingDefaultList(false)
    }
  }

  // Selection toolbar
  useEffect(() => {
    function handleMouseUp(e) {
      setTimeout(() => {
        const selection = window.getSelection()
        const selectedText = selection?.toString().trim()
        if (!selectedText || !tableRef.current) return
        const anchor = selection.anchorNode
        const cell = anchor?.parentElement?.closest('.search-term-cell')
        if (!cell || !tableRef.current.contains(cell)) return
        pendingSelectionRef.current = selectedText
        setToolbar({ visible: true, x: e.clientX + 8, y: e.clientY + 8 })
      }, 0)
    }
    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [])

  useEffect(() => {
    function handleMouseDown(e) {
      if (!e.target.closest('.selection-toolbar')) {
        setToolbar({ visible: false, x: 0, y: 0 })
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [])

  function handleAddAsNegative(ev) {
    const text = pendingSelectionRef.current
    if (text) {
      runPendingUiUpdate(() => onAddNegative(text), pointFromEvent(ev))
      window.getSelection()?.removeAllRanges()
    }
    setToolbar({ visible: false, x: 0, y: 0 })
    pendingSelectionRef.current = null
  }

  // All pending items that are checked and not already in google (for submit modal)
  const checkedPendingItems = useMemo(() => {
    const seen = new Set()
    return (pendingNegatives || []).filter(i => {
      if (!i.selected || i.alreadyInGoogle) return false
      const key = `${String(i.keyword || '').trim().toLowerCase()}::${String(i.matchType || 'PHRASE').toUpperCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [pendingNegatives])

  const reviewItems = useMemo(() => {
    const seen = new Set()
    const out = []
    for (const i of pendingNegatives || []) {
      if (!i || i.alreadyInGoogle) continue
      const key = `${String(i.keyword || '').trim().toLowerCase()}::${String(i.matchType || 'PHRASE').toUpperCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ...i, _key: key })
    }
    return out
  }, [pendingNegatives])

  useEffect(() => {
    if (!isReviewMode) return
    setReviewChoices(prev => {
      const next = {}
      for (const it of reviewItems) {
        next[it._key] = prev[it._key] || null
      }
      return next
    })
  }, [isReviewMode, reviewItems])

  // Determine if "all" rows with pending negatives are checked
  const pendingItems = (pendingNegatives || []).filter(i => !i.alreadyInGoogle)
  const allChecked = pendingItems.length > 0 && pendingItems.every(i => i.selected)

  destinationPlacementHydrateRef.current = (peerKeywords, destination, rowSnap) => {
    if (destination !== 'CAMPAIGN' && destination !== 'ADGROUP') return
    if (!rowSnap?.campaignId || !Array.isArray(peerKeywords) || peerKeywords.length === 0) return
    const peersLower = new Set(peerKeywords.map(k => String(k).toLowerCase()))
    patchPendingRowPeers(peersLower, null, i =>
      maybeHydratePendingPlacementFromSearchTermRow(
        i,
        destination,
        rowSnap,
        campaigns,
        adGroupsByCampaign,
      ),
    )
  }

  useEffect(() => {
    if (!submitSuccess || !submitSuccess.toLowerCase().startsWith('keywords submitted')) return
    setShowSubmitSuccessModal(true)
  }, [submitSuccess])

  async function handleSubmitReviewDecisions() {
    if (!isReviewMode || reviewItems.length === 0) return
    const unresolved = reviewItems.filter(it => !reviewChoices[it._key])
    if (unresolved.length > 0) return
    setReviewSubmitting(true)
    setSubmitError('')
    try {
      setPendingNegatives(prev =>
        prev.map(i => {
          const key = `${String(i.keyword || '').trim().toLowerCase()}::${String(i.matchType || 'PHRASE').toUpperCase()}`
          const choice = reviewChoices[key]
          if (!choice) return i
          return { ...i, selected: choice === 'block' }
        }),
      )
      await new Promise(resolve => setTimeout(resolve, 0))
      await onSubmitNegatives()
    } finally {
      setReviewSubmitting(false)
    }
  }

  if (isReviewMode) {
    const reviewedCount = reviewItems.filter(it => !!reviewChoices[it._key]).length
    const allReviewed = reviewItems.length > 0 && reviewedCount === reviewItems.length
    return (
      <div className="review-clean-wrap">
        <section className="review-clean-header-card">
          <h2 className="review-clean-title">Review your negative keywords</h2>
          <p className="review-clean-sub">
            Your agency flagged these search terms as potential negatives for your Google Ads account.
            Choose whether to block each one or keep it.
          </p>
          <div className="review-clean-progress-row">
            <div className="review-clean-progress-track">
              <div
                className="review-clean-progress-fill"
                style={{ width: `${reviewItems.length ? Math.round((reviewedCount / reviewItems.length) * 100) : 0}%` }}
              />
            </div>
            <span className="review-clean-progress-label">{reviewedCount} of {reviewItems.length} reviewed</span>
          </div>
        </section>

        {submitError ? (
          <div className="alert alert-danger" role="alert">{submitError}</div>
        ) : null}

        <div className="review-clean-list">
          {reviewItems.map(item => {
            const source = Array.isArray(item.sourceSearchTerms) && item.sourceSearchTerms[0]
            const triggerText = source?.searchTerm || source?.query || item.keyword
            const clicks = Number(source?.clicks || 0)
            const conversions = Number(source?.conversions || 0)
            const choice = reviewChoices[item._key]
            return (
              <article key={item._key} className="review-clean-item">
                <div className="review-clean-item-main">
                  <div className="review-clean-item-kw">{formatNegLabel(item.keyword, item.matchType || 'PHRASE')}</div>
                  <div className="review-clean-item-meta">
                    Triggered by: {triggerText} · {clicks} clicks, {conversions} conversions
                  </div>
                </div>
                <div className="review-clean-item-actions">
                  <button
                    type="button"
                    className={`btn btn-sm review-clean-btn-block${choice === 'block' ? ' is-active' : ''}`}
                    onClick={() => setReviewChoices(prev => ({ ...prev, [item._key]: 'block' }))}
                  >
                    Block it
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm review-clean-btn-keep${choice === 'keep' ? ' is-active' : ''}`}
                    onClick={() => setReviewChoices(prev => ({ ...prev, [item._key]: 'keep' }))}
                  >
                    Keep it
                  </button>
                </div>
              </article>
            )
          })}
        </div>

        <div className="review-clean-submit-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!allReviewed || reviewSubmitting}
            onClick={handleSubmitReviewDecisions}
          >
            {reviewSubmitting ? 'Submitting…' : 'Submit review'}
          </button>
          <span className="review-clean-submit-hint">
            {!allReviewed ? 'Review all keywords to enable submit.' : 'Ready to submit.'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <>
      {pointerBusyAt && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="pending-update-pointer-indicator"
              style={{ left: pointerBusyAt.x, top: pointerBusyAt.y }}
              role="status"
              aria-hidden
            />,
            document.body,
          )
        : null}
      {showSubmitSuccessModal && submitSuccess && (
        <div className="unified-modal-overlay" onClick={() => { setShowSubmitSuccessModal(false); setSubmitSuccess('') }}>
          <div className="submit-success-modal" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className="submit-success-modal-close"
              onClick={() => { setShowSubmitSuccessModal(false); setSubmitSuccess('') }}
              aria-label="Close"
            >
              ×
            </button>
            <div className="submit-success-modal-icon" aria-hidden>
              <i className="fas fa-check"></i>
            </div>
            <h3 className="submit-success-modal-title">Keywords submitted to Google Ads</h3>
            <p className="submit-success-modal-copy">
              Your negative keywords have been submitted.
            </p>
            <p className="submit-success-modal-copy submit-success-modal-copy-secondary">
              View <button type="button" className="submit-success-modal-inline-link" onClick={() => { setShowHistory(true); setShowSubmitSuccessModal(false); setSubmitSuccess('') }}>Submission History</button> to review all keywords you&apos;ve submitted.
            </p>
            <div className="submit-success-modal-actions">
              <button
                type="button"
                className="btn btn-outline-secondary"
                onClick={() => { setShowHistory(true); setShowSubmitSuccessModal(false); setSubmitSuccess('') }}
              >
                View submission history
              </button>
              <button
                type="button"
                className="btn btn-success"
                onClick={() => { setShowSubmitSuccessModal(false); setSubmitSuccess('') }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Selection toolbar */}
      {toolbar.visible && (
        <div className="selection-toolbar" style={{ left: toolbar.x, top: toolbar.y }}>
          <button className="btn btn-sm btn-danger" onMouseDown={e => e.preventDefault()} onClick={handleAddAsNegative}>
            <i className="fas fa-ban me-1" />Add &ldquo;{pendingSelectionRef.current}&rdquo; as negative
          </button>
        </div>
      )}

      {/* Video modal */}
      {videoOpen && (
        <div className="video-modal-backdrop" onClick={() => { setVideoOpen(false); videoRef.current?.pause() }}>
          <div className="video-modal-box" onClick={e => e.stopPropagation()}>
            <div className="video-modal-header">
              <span className="video-modal-title">How to flag negative keywords</span>
              <button className="video-modal-close" onClick={() => { setVideoOpen(false); videoRef.current?.pause() }}>
                <i className="fas fa-times" />
              </button>
            </div>
            <video ref={videoRef} src="/assets/video.mov" autoPlay controls playsInline className="video-modal-player" />
          </div>
        </div>
      )}

      {/* Submit confirm modal */}
      {showSubmitModal && (
        <div className="unified-modal-overlay" onClick={() => setShowSubmitModal(false)}>
          <div className="unified-modal" onClick={e => e.stopPropagation()}>
            <div className="unified-modal-header">
              <h3>Review before submitting</h3>
              <button className="unified-modal-close" onClick={() => setShowSubmitModal(false)}>×</button>
            </div>
            <div className="unified-modal-body">
              <p className="unified-modal-desc">Review the {checkedPendingItems.length} keyword{checkedPendingItems.length !== 1 ? 's' : ''} below before submitting to Google Ads.</p>
              {checkedPendingItems.map((item, i) => (
                <div key={i} className="unified-modal-kw-row">
                  <div>
                    <div className="unified-modal-kw-name">{formatNegLabel(item.keyword, item.matchType)}</div>
                    <div className="unified-modal-kw-meta">{item.campaignName || ''}{item.adGroupName ? ` · ${item.adGroupName}` : ''}</div>
                  </div>
                  <div className="unified-modal-kw-tags">
                    <span className={`unified-modal-tag tag-${item.matchType.toLowerCase()}`}>{item.matchType.charAt(0) + item.matchType.slice(1).toLowerCase()}</span>
                    <span className="unified-modal-kw-dest">{item.destination === 'NEGATIVE_LIST' ? 'Keyword list' : item.destination === 'ADGROUP' ? 'Ad group level' : 'Campaign level'}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="unified-modal-footer">
              <button
                className="btn btn-success"
                onClick={() => { setShowSubmitModal(false); onSubmitNegatives() }}
              >
                Confirm &amp; submit to Google Ads
              </button>
              <button className="btn btn-outline-secondary" onClick={() => setShowSubmitModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Approval modal */}
      {showApprovalModal && (
        <div className="unified-modal-overlay" onClick={closeApprovalModal}>
          <div className="unified-modal" onClick={e => e.stopPropagation()}>
            <div className="unified-modal-header">
              <h3>Send for client review</h3>
              <button className="unified-modal-close" onClick={closeApprovalModal}>×</button>
            </div>
            <div className="unified-modal-body">
              {createdReviewLink ? (
                <>
                  <div className="alert alert-success py-2 small mb-3" role="alert">
                    Review request created.
                    {createdReviewLink.emailWarning
                      ? ` Email could not be sent: ${createdReviewLink.emailWarning}`
                      : approvalEmail
                        ? ` Email sent to ${approvalEmail}.`
                        : ''}
                  </div>
                  <p className="unified-modal-desc">
                    Share this public review link with your client. They can review and submit decisions
                    without logging in. After they submit, you&apos;ll get a confirmation link to finalize
                    the changes in Google Ads.
                  </p>
                  <div className="unified-modal-field">
                    <label className="unified-modal-label">Public review link</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="text"
                        className="form-control form-control-sm"
                        readOnly
                        value={createdReviewLink.publicUrl || ''}
                        style={{ background: '#f8f8f8', color: '#555' }}
                        onFocus={e => e.target.select()}
                      />
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        style={{ whiteSpace: 'nowrap', flexShrink: 0, ...(copyLinkCopied ? { background: '#e6f4ea', color: '#137333', borderColor: '#137333' } : {}) }}
                        onClick={copyCreatedReviewLink}
                      >
                        {copyLinkCopied ? 'Copied!' : 'Copy link'}
                      </button>
                    </div>
                    {createdReviewLink.expiresAt ? (
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
                        Expires {new Date(createdReviewLink.expiresAt).toLocaleString()} · one-time submit.
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <p className="unified-modal-desc">
                    Send the <strong>{checkedPendingItems.length} checked</strong> keyword
                    {checkedPendingItems.length === 1 ? '' : 's'} to your client for review. They will
                    decide which to <strong>block</strong> or <strong>keep</strong> on a public link
                    (no login required). After they submit, you&apos;ll get a confirmation step before
                    anything goes to Google Ads.
                  </p>
                  {approvalSendError ? (
                    <div className="alert alert-danger py-2 small mb-3" role="alert">{approvalSendError}</div>
                  ) : null}
                  <div className="unified-modal-field">
                    <label className="unified-modal-label">Recipient email</label>
                    <input
                      type="email"
                      className="form-control form-control-sm"
                      placeholder="e.g. client@example.com"
                      value={approvalEmail}
                      onChange={e => setApprovalEmail(e.target.value)}
                    />
                  </div>
                </>
              )}
              <div className="unified-modal-field">
                <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Keywords being sent:</div>
                {checkedPendingItems.map((item, i) => (
                  <div key={i} className="unified-modal-kw-row">
                    <div className="unified-modal-kw-name">{formatNegLabel(item.keyword, item.matchType)}</div>
                    <span className={`unified-modal-tag tag-${item.matchType.toLowerCase()}`}>{item.matchType.charAt(0) + item.matchType.slice(1).toLowerCase()}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="unified-modal-footer">
              {createdReviewLink ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={closeApprovalModal}
                >
                  Done
                </button>
              ) : (
                <>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={approvalSending || creatingReviewLink || checkedPendingItems.length === 0}
                    onClick={() => sendApproval()}
                  >
                    {reviewLinkAction === 'send' && approvalSending ? 'Sending…' : 'Send email & create link'}
                  </button>
                  <button
                    className="btn btn-outline-primary"
                    type="button"
                    disabled={approvalSending || creatingReviewLink || checkedPendingItems.length === 0}
                    onClick={() => generateLinkOnly()}
                    title="Create a review link without sending an email"
                  >
                    {reviewLinkAction === 'link' && creatingReviewLink ? 'Creating…' : 'Create link only'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline-secondary"
                    disabled={approvalSending || creatingReviewLink}
                    onClick={closeApprovalModal}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Save work modal */}
      {showSaveModal && (
        <div className="unified-modal-overlay" onClick={() => setShowSaveModal(false)}>
          <div className="unified-modal" style={{ maxWidth: 360 }} onClick={e => e.stopPropagation()}>
            <div className="unified-modal-header">
              <h3>Work saved</h3>
              <button className="unified-modal-close" onClick={() => setShowSaveModal(false)}>×</button>
            </div>
            <div className="unified-modal-body">
              <p className="unified-modal-desc">All pending keywords in the table—including match types, destinations, and checkboxes—are saved so the same list reloads next time you open this client (keywords already in Google are kept for context).</p>
            </div>
            <div className="unified-modal-footer">
              <button className="btn btn-primary" onClick={() => setShowSaveModal(false)}>Got it</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {manualAddSuccess && (
        <div className="manual-add-toast">
          <i className="fas fa-check-circle me-2" />
          {manualAddSuccess}
        </div>
      )}
      {manualAddError && (
        <div className="manual-add-toast manual-add-toast-error">
          <i className="fas fa-exclamation-circle me-2" />
          {manualAddError}
        </div>
      )}

      {/* Main review card: scrollable table + in-card sticky footer + history */}
      <div className="review-dashboard-card" id="search-terms-section">
      <div className="search-terms-panel">

        {/* Card header */}
        <div className="unified-card-header">
          <h2 className="unified-card-title">
            Review your search terms{clientName ? ` — ${clientName}` : ''}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" className="btn-watch-how" onClick={() => setVideoOpen(true)}>
              <i className="fas fa-play" />
              Watch how it works
            </button>
            <button className="btn-save-work" onClick={async () => {
              if (!onSaveWork) return
              try {
                await onSaveWork()
                setShowSaveModal(true)
              } catch (err) {
                setSubmitError('Save failed: ' + (err.message || 'Unknown error'))
              }
            }}>
              <i className="fas fa-save" />
              Save work
            </button>
            <button
              className="btn-save-work"
              style={{ background: '#fff', color: '#dc2626', borderColor: '#dc2626' }}
              onClick={async () => { if (onClearWork) await onClearWork() }}
            >
              <i className="fas fa-times" />
              Clear
            </button>
          </div>
        </div>

        {/* Legend */}
        <div className="unified-legend-row">
          <div className="unified-legend-item">
            <span className="unified-leg-chip unified-leg-amber">"keyword"</span>
            Pending negative — not yet submitted
          </div>
          <div className="unified-legend-item">
            <span className="unified-leg-chip unified-leg-green">[keyword]</span>
            Added to Google Ads
          </div>
        </div>

        {/* Submit error bar */}
        {submitError && (
          <div className="submit-error-bar" style={{ margin: '0 16px 0', borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderTop: 'none' }}>
            <div className="submit-error-main"><i className="fas fa-exclamation-circle me-2" />{submitError}</div>
            <button className="submit-error-dismiss" onClick={() => setSubmitError('')}>×</button>
          </div>
        )}

        {/* Bulk match type / destination — above filters */}
        <div className="search-terms-bulk-panel" aria-label="Bulk actions for checked rows">
          <div className="search-terms-bulk-panel-title">Bulk Actions (Apply to all checked rows)</div>
          <div className="search-terms-bulk-rows">
            <div className="search-terms-bulk-row">
              <span className="search-terms-bulk-label">Match type</span>
              <select
                className="form-select form-select-sm matchtype-select search-terms-bulk-select"
                value={bulkMatchType}
                onChange={e => setBulkMatchType(e.target.value)}
              >
                {MATCH_TYPE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                title="Applies to checked rows only"
                onClick={e => handleApplyBulkMatchType(e)}
                disabled={selectedCount === 0}
              >
                Apply
              </button>
            </div>
            <div className="search-terms-bulk-row search-terms-bulk-row-destination">
              <span className="search-terms-bulk-label">Destination</span>
              <select
                className={`form-select form-select-sm matchtype-select search-terms-bulk-select ${DEST_CLASS[bulkDestination] || ''}`}
                value={bulkDestination}
                onChange={e => {
                  const next = e.target.value
                  setBulkDestination(next)
                  if (next === 'NEGATIVE_LIST') {
                    setBulkSharedSetId(defaultSharedSetId || sharedSets?.[0]?.id || null)
                  } else {
                    setBulkSharedSetId(null)
                  }
                }}
              >
                {DESTINATION_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              {bulkDestination === 'NEGATIVE_LIST' && (
                createListCtx === 'bulk' ? (
                  <div className="create-list-inline search-terms-bulk-inline-create">
                    <input
                      type="text"
                      className="form-control form-control-sm create-list-input"
                      placeholder="New list name…"
                      value={newListName}
                      onChange={e => setNewListName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleCreateList(s => setBulkSharedSetId(s.id))}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={!newListName.trim() || createListLoading}
                      onClick={() => handleCreateList(s => setBulkSharedSetId(s.id))}
                    >
                      {createListLoading ? 'Creating…' : 'Create'}
                    </button>
                    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setCreateListCtx(null)}>Cancel</button>
                    {createListError && <span className="create-list-error">{createListError}</span>}
                  </div>
                ) : (
                  <div className="search-terms-bulk-list-default-wrap">
                    <div className="search-terms-bulk-list-pair">
                      <button
                        type="button"
                        className="btn-create-list btn-create-list-compact"
                        onClick={() => { setCreateListCtx('bulk'); setNewListName(''); setCreateListError('') }}
                      >
                        + New list
                      </button>
                      <select
                        className="form-select form-select-sm matchtype-select search-terms-bulk-select"
                        value={bulkSharedSetId || ''}
                        onChange={e => setBulkSharedSetId(e.target.value || null)}
                      >
                        <option value="">Select list…</option>
                        {(sharedSets || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                    {bulkSharedSetId && onSaveDefaultSharedSet ? (
                      <label className="bulk-default-list-toggle">
                        <input
                          type="checkbox"
                          checked={String(defaultSharedSetId || '') === String(bulkSharedSetId)}
                          disabled={savingDefaultList}
                          onChange={e => handleToggleDefaultKeywordList(e.target.checked)}
                        />
                        <span>Save this list as default for this account</span>
                      </label>
                    ) : null}
                  </div>
                )
              )}
              <button
                type="button"
                className="btn btn-sm btn-primary"
                title="Applies to checked rows only"
                onClick={e => handleApplyBulkDestination(e)}
                disabled={selectedCount === 0}
              >
                Apply
              </button>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="search-terms-filters">
          <input
            type="text"
            className="form-control form-control-sm"
            placeholder="Filter search terms…"
            value={searchFilter}
            onChange={e => setSearchFilter(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <select
            className="form-select form-select-sm dropdown-caret-select"
            value={campaignFilter}
            onChange={e => setCampaignFilter(e.target.value)}
            style={{ maxWidth: 220 }}
          >
            <option value="">All campaigns</option>
            {campaignList.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* Table */}
        <div className="table-wrapper" aria-busy={isUpdatePending || undefined}>
          <table ref={tableRef} className="table table-hover table-sm mb-0 search-terms-table unified-table">
            <thead>
              <tr>
                <th style={{ width: 36, padding: '8px 12px' }}>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={e => handleToggleAll(e.target.checked, e)}
                    style={{ width: 16, height: 16, accentColor: '#1a73e8' }}
                  />
                </th>
                <th
                  className="sortable-th"
                  style={{ cursor: 'default' }}
                  title="Order is set when search terms load. Use filters above; column click does not re-sort."
                  onClick={() => handleSort('searchTerm')}
                >
                  SEARCH TERM <SortIcon col="searchTerm" />
                </th>
                <th style={{ minWidth: 300 }}>TRIGGERED NEGATIVE + MATCH TYPE</th>
                <th style={{ width: 170 }}>DESTINATION</th>
                <th
                  className="sortable-th"
                  style={{ width: 65, cursor: 'default' }}
                  title="Order is set when search terms load."
                  onClick={() => handleSort('clicks')}
                >
                  CLICKS <SortIcon col="clicks" />
                </th>
                <th
                  className="sortable-th"
                  style={{ width: 65, cursor: 'default' }}
                  title="Order is set when search terms load."
                  onClick={() => handleSort('conversions')}
                >
                  CONV. <SortIcon col="conversions" />
                </th>
                <th style={{ width: 170 }}>KW DERIVED FROM</th>
                <th
                  className="sortable-th"
                  style={{ width: 170, cursor: 'default' }}
                  title="Order is set when search terms load."
                  onClick={() => handleSort('campaign')}
                >
                  CAMPAIGN <SortIcon col="campaign" />
                </th>
                <th style={{ width: 150 }}>AD GROUP</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(({ term, rowIndex }) => {
                const negatives = rowNegatives.get(term.searchTerm)
                const isHovered = hoveredRow === term.searchTerm
                const uniqueKey = `${term.searchTerm}__${term.campaignId || 'nc'}__${term.adGroupId || 'na'}__${rowIndex}`

                // Separate pending vs google phrases.
                // Exclude ai:/manual: phrases whose keyword is already in Google (alreadyInGoogle=true)
                // — those are covered by the google: prefix chip from existingNegatives.
                const pendingPhrases = negatives
                  ? [...negatives].filter(p => {
                      if (!p.startsWith('ai:') && !p.startsWith('manual:')) return false
                      const kw = parseNegativePhrase(p).keyword
                      const item = getPendingItem(kw)
                      return item && !item.alreadyInGoogle
                    })
                  : []
                const uniquePendingPhrases = (() => {
                  const seen = new Set()
                  const out = []
                  for (const phrase of pendingPhrases) {
                    const { keyword } = parseNegativePhrase(phrase)
                    const item = getPendingItem(keyword)
                    const mt = (item?.matchType || 'PHRASE').toUpperCase()
                    const key = `${keyword.toLowerCase()}::${mt}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    out.push(phrase)
                  }
                  return out
                })()
                const googlePhrases = negatives ? [...negatives].filter(p => p.startsWith('google:')) : []

                // Row-level: any submit-eligible pending negative on this search term
                const firstPendingKw = uniquePendingPhrases.length > 0 ? parseNegativePhrase(uniquePendingPhrases[0]).keyword : null
                const firstPendingItem = firstPendingKw ? getPendingItem(firstPendingKw) : null
                const pendingItemsOnRow = uniquePendingPhrases
                  .map(p => getPendingItem(parseNegativePhrase(p).keyword))
                  .filter(Boolean)
                const actionablePending = pendingItemsOnRow.filter(i => !i.alreadyInGoogle)
                const pendingKwsLower = new Set(actionablePending.map(i => i.keyword.toLowerCase()))
                const destAnchorItem =
                  actionablePending.find(i => i.source !== 'ai') || firstPendingItem
                const hasPending = actionablePending.length > 0
                const isChecked =
                  hasPending && actionablePending.every(i => i.selected)

                return (
                  <tr
                    key={uniqueKey}
                    data-campaign-id={term.campaignId || ''}
                    data-campaign-name={term.campaign || ''}
                    data-adgroup-id={term.adGroupId || ''}
                    data-adgroup-name={term.adGroup || ''}
                    onMouseEnter={() => setHoveredRow(term.searchTerm)}
                    onMouseLeave={() => setHoveredRow(null)}
                  >
                    {/* Checkbox */}
                    <td>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={!hasPending}
                        onChange={e =>
                          handleRowPendingCheckboxChange(uniquePendingPhrases, e.target.checked, e)}
                        style={{ width: 16, height: 16, accentColor: '#1a73e8', opacity: hasPending ? 1 : 0.3 }}
                      />
                    </td>

                    {/* Search term */}
                    <td>
                      <span className="search-term-cell">
                        <HighlightedSearchTerm text={term.searchTerm} negatives={negatives} />
                        {isHovered && (
                          <button
                            className="flag-btn"
                            title="Flag as negative keyword"
                            onClick={e =>
                              runPendingUiUpdate(() => onAddNegative(term.searchTerm), pointFromEvent(e))}
                          >
                            + Flag
                          </button>
                        )}
                      </span>
                    </td>

                    {/* Pending: chip + match type nested in one wrapper; Google: chip only (type implied by quotes/brackets on label) */}
                    <td className="triggered-neg-cell triggered-neg-with-match-cell">
                      {uniquePendingPhrases.length > 0 && uniquePendingPhrases.map((phrase, i) => {
                        const { keyword } = parseNegativePhrase(phrase)
                        const item = getPendingItem(keyword)
                        const mt = item?.matchType ?? 'PHRASE'
                        const label = formatNegLabel(keyword, mt)
                        return (
                          <div key={i} className="triggered-neg-stack-item">
                            <div className="triggered-pending-mt-wrap">
                              <span className="unified-neg-chip unified-neg-amber">
                                {label}
                                <button
                                  type="button"
                                  className="unified-neg-del"
                                  onClick={e =>
                                    runPendingUiUpdate(() => onRemoveNegative(keyword), pointFromEvent(e))}
                                  title="Remove"
                                >
                                  ×
                                </button>
                              </span>
                              {item && !item.alreadyInGoogle ? (
                                <select
                                  className="matchtype-select triggered-neg-mt-select"
                                  value={mt}
                                  onChange={e => handleMatchTypeChange(keyword, e.target.value, e)}
                                  aria-label={`Match type for ${keyword}`}
                                >
                                  {MATCH_TYPE_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>
                              ) : null}
                            </div>
                          </div>
                        )
                      })}
                      {googlePhrases.length > 0 &&
                        googlePhrases.map((phrase, i) => {
                          const { keyword, matchType } = parseNegativePhrase(phrase)
                          const label = formatNegLabel(keyword, matchType)
                          const existing = (existingNegatives || []).find(n =>
                            typeof n === 'object' &&
                            n.keyword?.toLowerCase() === keyword.toLowerCase() &&
                            (n.matchType || '').toUpperCase() === (matchType || '').toUpperCase()
                          )
                          const canDeleteGoogleNegative =
                            !!existing?.resourceName &&
                            !!existing?.source &&
                            typeof onRemoveGoogleNegative === 'function'
                          return (
                            <div key={`g-${i}`} className="triggered-neg-stack-item">
                              <span
                                className="unified-neg-chip unified-neg-green"
                                title="Already in Google Ads"
                              >
                                {label}
                                {canDeleteGoogleNegative ? (
                                  <button
                                    type="button"
                                    className="unified-neg-del"
                                    title="Remove from Google Ads"
                                    onClick={e =>
                                      runPendingUiUpdate(
                                        () => {
                                          const approved = window.confirm(
                                            `Remove ${label} from Google Ads?`,
                                          )
                                          if (!approved) return
                                          onRemoveGoogleNegative(
                                            existing.resourceName,
                                            existing.source,
                                          )
                                        },
                                        pointFromEvent(e),
                                      )
                                    }
                                  >
                                    ×
                                  </button>
                                ) : null}
                              </span>
                            </div>
                          )
                        })}
                      {uniquePendingPhrases.length === 0 && googlePhrases.length === 0 && (
                        <span style={{ color: '#aaa', fontSize: 12 }}>—</span>
                      )}
                    </td>

                    {/* Single destination UI per row — synced to every pending negative on this search term */}
                    <td>
                      {hasPending ? (
                        <>
                          <RowDestinationPlacementHydrate
                            peersJson={JSON.stringify(
                              [...pendingKwsLower].sort((a, b) => a.localeCompare(b)),
                            )}
                            destination={destAnchorItem?.destination || 'NEGATIVE_LIST'}
                            rowTermSnapshot={{
                              campaignId: term.campaignId,
                              campaign: term.campaign,
                              adGroupId: term.adGroupId,
                              adGroup: term.adGroup,
                            }}
                            hydrateRef={destinationPlacementHydrateRef}
                          />
                          {renderDestCell(destAnchorItem, pendingKwsLower, term)}
                        </>
                      ) : (() => {
                        if (googlePhrases.length === 0) return <span style={{ fontSize: 12, color: '#aaa' }}>—</span>
                        const { keyword: gkw, matchType: gmt } = parseNegativePhrase(googlePhrases[0])
                        const existing = (existingNegatives || []).find(n =>
                          typeof n === 'object' &&
                          n.keyword?.toLowerCase() === gkw.toLowerCase() &&
                          (n.matchType || '').toUpperCase() === (gmt || '').toUpperCase()
                        )
                        const sourceLabel = existing?.source === 'SHARED_SET'
                          ? 'Keyword list'
                          : existing?.source === 'AD_GROUP'
                            ? 'Ad group level'
                            : existing?.source === 'CAMPAIGN'
                              ? 'Campaign level'
                              : '—'
                        return <span style={{ fontSize: 12, color: '#666' }}>{sourceLabel}</span>
                      })()}
                    </td>

                    {/* Clicks */}
                    <td className="text-end">{Number(term.clicks).toLocaleString()}</td>

                    {/* Conv. */}
                    <td className="text-end">{Number(term.conversions).toFixed(1)}</td>

                    {/* KW derived from */}
                    <td>
                      {term.matchingKeyword ? (
                        <div className="kw-derived-cell">
                          <span className="kw-derived-text">{term.matchingKeyword}</span>
                          {problematicKws.has(term.matchingKeyword) && (
                            <span className="kw-warn-wrap">
                              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" style={{ cursor: 'pointer', display: 'block', flexShrink: 0 }}>
                                <circle cx="10" cy="10" r="9" fill="#fce8e6" stroke="#d93025" strokeWidth="1.5"/>
                                <line x1="10" y1="6" x2="10" y2="11" stroke="#d93025" strokeWidth="1.8" strokeLinecap="round"/>
                                <circle cx="10" cy="13.5" r="0.8" fill="#d93025"/>
                              </svg>
                              <span className="kw-warn-tip">This keyword is triggering a high percentage of your negative keywords — consider tightening its match type or reviewing it.</span>
                            </span>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: '#aaa', fontSize: 12 }}>—</span>
                      )}
                    </td>

                    {/* Campaign */}
                    <td style={{ fontSize: 12, color: '#555' }}>{term.campaign}</td>

                    {/* Ad group */}
                    <td style={{ fontSize: 12, color: '#555' }}>{term.adGroup}</td>
                  </tr>
                )
              })}
              {sortedRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center text-muted py-3">
                    No matching records found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="unified-footer-dock review-footer-in-card">
        {selectedCount > 0 && (
          <div className="unified-selected-bar">
            <span className="unified-selected-count">
              <strong>{selectedCount}</strong> row{selectedCount !== 1 ? 's' : ''} selected — use bulk above filters or edit per row, then submit below
            </span>
            <button type="button" className="unified-selected-clear" onClick={e => handleToggleAll(false, e)}>
              Clear selection
            </button>
          </div>
        )}

        <div className="unified-submit-footer">
        <div className="unified-step-row unified-step-row-submit unified-step-row-submit-only">
          <button
            type="button"
            className="btn btn-success unified-btn-submit"
            title="Only checked rows with a triggered negative will be submitted"
            disabled={selectedCount === 0}
            onClick={() => { if (selectedCount > 0) setShowSubmitModal(true) }}
          >
            Submit {selectedCount > 0 ? `${selectedCount} ` : ''}keyword{selectedCount !== 1 ? 's' : ''} to Google Ads →
          </button>
          <button
            type="button"
            className="btn btn-outline-primary unified-btn-approval"
            onClick={() => { setApprovalSendError(''); setShowApprovalModal(true) }}
          >
            Send for approval
          </button>
          <span className="unified-submit-hint">Only checked rows will be submitted.</span>
        </div>
        </div>
      </div>

        {/* Submission history — bottom of review card (below action footer) */}
        {submissionHistory && submissionHistory.length > 0 && (
          <div className="submission-history-wrap submission-history-at-bottom">
            <button type="button" className="submission-history-toggle" onClick={() => setShowHistory(v => !v)}>
              <i className="fas fa-history me-1" aria-hidden />
              View submission history
              <i className={`fas fa-chevron-${showHistory ? 'up' : 'down'} ms-1`} aria-hidden />
            </button>
            {showHistory && (
              <div className="submission-history-panel">
                <div className="submission-history-heading">SUBMISSION HISTORY</div>
                {submissionHistory.map(entry => (
                  <div key={entry.id} className="submission-history-row">
                    <div className="submission-history-info">
                      <div className="submission-history-date">{formatHistoryDate(entry.submitted_at)}</div>
                      <div className="submission-history-meta">
                        {entry.keyword_count} {entry.keyword_count === 1 ? 'keyword' : 'keywords'}
                        {entry.list_name ? ` · ${entry.list_name}` : ''}
                        {entry.match_types ? ` · ${entry.match_types}` : ''}
                      </div>
                      {(entry.submitted_by_email || entry.submitted_by_name) && (
                        <div className="submission-history-user">
                          <i className="fas fa-user me-1" aria-hidden />
                          {entry.submitted_by_name || entry.submitted_by_email}
                        </div>
                      )}
                    </div>
                    <div className="submission-history-actions">
                      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => downloadHistoryEntry(entry)}>
                        <i className="fas fa-download me-1" aria-hidden />Download
                      </button>
                      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => copyHistoryEntry(entry)}>
                        <i className="fas fa-copy me-1" aria-hidden />Copy
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
