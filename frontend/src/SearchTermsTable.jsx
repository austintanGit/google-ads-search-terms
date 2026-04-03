import React, { useState, useEffect, useRef, useCallback } from 'react'
import { buildHighlightedParts } from './utils'

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

function NegativeBadges({ negatives, onRemove }) {
  if (!negatives || negatives.size === 0) return null

  const googlePhrases = new Set(
    [...negatives]
      .filter(p => p.startsWith('google:'))
      .map(p => p.replace('google:', '').toLowerCase())
  )

  return (
    <span className="negative-badges">
      {[...negatives].map(phrase => {
        const isGoogle = phrase.startsWith('google:')
        const isAi = phrase.startsWith('ai:')
        const isManual = phrase.startsWith('manual:')
        const display = phrase.replace(/^(google:|ai:|manual:)/, '')

        // Skip AI/manual badge if Google already covers it
        if ((isAi || isManual) && googlePhrases.has(display.toLowerCase())) return null

        if (isGoogle) {
          return (
            <span key={phrase} className="neg-badge neg-badge-google" title="Already a negative in Google Ads">
              {display}
            </span>
          )
        }
        if (isAi) {
          return (
            <span key={phrase} className="neg-badge neg-badge-ai" title="AI-recommended — not yet submitted">
              {display}
              <button className="neg-badge-remove" onClick={() => onRemove(display)}>×</button>
            </span>
          )
        }
        // manual
        return (
          <span key={phrase} className="neg-badge neg-badge-manual" title="Manually flagged — not yet submitted">
            {display}
            <button className="neg-badge-remove" onClick={() => onRemove(display)}>×</button>
          </span>
        )
      })}
    </span>
  )
}

const COLUMNS = [
  { key: 'searchTerm', label: 'SEARCH TERM', sortable: true },
  { key: 'matchingKeyword', label: 'KEYWORD', sortable: true },
  { key: 'campaign', label: 'CAMPAIGN', sortable: true, filterable: true },
  { key: 'clicks', label: 'CLICKS', sortable: true, numeric: true },
  { key: 'conversions', label: 'CONV', sortable: true, numeric: true },
  { key: 'negatives', label: 'NEGATIVE', sortable: false },
]

export default function SearchTermsTable({ searchTerms, rowNegatives, onAddNegative, onRemoveNegative }) {
  const [sortCol, setSortCol] = useState('clicks')
  const [sortDir, setSortDir] = useState('desc')
  const [searchFilter, setSearchFilter] = useState('')
  const [campaignFilter, setCampaignFilter] = useState('')
  const [hoveredRow, setHoveredRow] = useState(null)
  const [videoOpen, setVideoOpen] = useState(false)
  const videoRef = useRef(null)

  // Selection toolbar state (text selection)
  const [toolbar, setToolbar] = useState({ visible: false, x: 0, y: 0 })
  const pendingSelectionRef = useRef(null)
  const pendingSelectionTermRef = useRef(null)
  const tableRef = useRef(null)

  const campaigns = [...new Set(searchTerms.map(t => t.campaign).filter(Boolean))].sort()

  const filtered = searchTerms.filter(term => {
    if (searchFilter && !term.searchTerm?.toLowerCase().includes(searchFilter.toLowerCase())) return false
    if (campaignFilter && term.campaign !== campaignFilter) return false
    return true
  })

  const sorted = [...filtered].sort((a, b) => {
    const aVal = a[sortCol] ?? ''
    const bVal = b[sortCol] ?? ''
    const dir = sortDir === 'asc' ? 1 : -1
    if (typeof aVal === 'number') return (aVal - bVal) * dir
    return String(aVal).localeCompare(String(bVal)) * dir
  })

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortCol(col)
      setSortDir('desc')
    }
  }

  function SortIcon({ col }) {
    if (sortCol !== col) return <i className="fas fa-sort sort-icon" />
    return sortDir === 'asc'
      ? <i className="fas fa-sort-up sort-icon active" />
      : <i className="fas fa-sort-down sort-icon active" />
  }

  // Show floating toolbar after text is selected (mouseup = selection is complete)
  useEffect(() => {
    function handleMouseUp(e) {
      // Small delay so the browser finalises the selection
      setTimeout(() => {
        const selection = window.getSelection()
        const selectedText = selection?.toString().trim()

        if (!selectedText || !tableRef.current) return

        const anchor = selection.anchorNode
        const cell = anchor?.parentElement?.closest('.search-term-cell')
        if (!cell || !tableRef.current.contains(cell)) return

        const row = anchor?.parentElement?.closest('tr[data-campaign-id]')
        pendingSelectionTermRef.current = row ? {
          campaignId: row.dataset.campaignId || null,
          campaignName: row.dataset.campaignName || null,
          adGroupId: row.dataset.adGroupId || null,
          adGroupName: row.dataset.adGroupName || null,
        } : null

        pendingSelectionRef.current = selectedText
        setToolbar({ visible: true, x: e.clientX + 8, y: e.clientY + 8 })
      }, 0)
    }

    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [])

  // Hide toolbar when clicking outside it
  useEffect(() => {
    function handleMouseDown(e) {
      if (!e.target.closest('.selection-toolbar')) {
        setToolbar({ visible: false, x: 0, y: 0 })
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [])

  function handleAddAsNegative() {
    const text = pendingSelectionRef.current
    const term = pendingSelectionTermRef.current
    if (text) {
      const destination = term?.adGroupId ? 'ADGROUP' : 'CAMPAIGN'
      // matchType is inferred in handleAddManualNegative; pass null so it auto-computes
      onAddNegative(text, null, term?.campaignId, term?.campaignName, term?.adGroupId, term?.adGroupName, destination)
      window.getSelection()?.removeAllRanges()
    }
    setToolbar({ visible: false, x: 0, y: 0 })
    pendingSelectionRef.current = null
    pendingSelectionTermRef.current = null
  }

  return (
    <>
      {/* Selection toolbar (floating, appears after text selection) */}
      {toolbar.visible && (
        <div className="selection-toolbar" style={{ left: toolbar.x, top: toolbar.y }}>
          <button className="btn btn-sm btn-danger" onMouseDown={e => e.preventDefault()} onClick={handleAddAsNegative}>
            <i className="fas fa-ban me-1" />Add &ldquo;{pendingSelectionRef.current}&rdquo; as negative
          </button>
        </div>
      )}

      {/* Instructional video modal */}
      {videoOpen && (
        <div className="video-modal-backdrop" onClick={() => { setVideoOpen(false); videoRef.current?.pause() }}>
          <div className="video-modal-box" onClick={e => e.stopPropagation()}>
            <div className="video-modal-header">
              <span className="video-modal-title">How to flag negative keywords</span>
              <button className="video-modal-close" onClick={() => { setVideoOpen(false); videoRef.current?.pause() }}>
                <i className="fas fa-times" />
              </button>
            </div>
            <video
              ref={videoRef}
              src="/assets/video.mov"
              autoPlay
              controls
              playsInline
              className="video-modal-player"
            />
          </div>
        </div>
      )}

      <div className="search-terms-panel">
        {/* Panel header: legend + hint */}
        <div className="search-terms-panel-header-container">
          <span className="search-terms-panel-header-title">Review your search terms</span>
        </div>
        <div className="search-terms-panel-header">
          <div className="status-key">
            <div className="status-key-items">
              <div className="status-key-item status-key-item-google">
                <span className="status-key-item-label">Already a Negative</span>
                <span className="status-key-item-sub">No Action</span>
              </div>
              <div className="status-key-item status-key-item-ai">
                <span className="status-key-item-label">AI-Recommended</span>
                <span className="status-key-item-sub">Not Yet Submitted</span>
              </div>
              <div className="status-key-item status-key-item-manual">
                <span className="status-key-item-label">Manual</span>
                <span className="status-key-item-sub">Not Yet Submitted</span>
              </div>
            </div>
          </div>
        </div>

        {/* Hover hint */}
        <div className="hover-hint search-terms-hint">
          <span>
            <i className="fas fa-info-circle me-1" />
            Hover over any word to flag it individually, or hover over the full row to flag the entire search term as a negative
          </span>
          <button className="hint-video-btn" onClick={() => setVideoOpen(true)}>
            <i className="fas fa-play-circle me-1" />Watch how it works
          </button>
        </div>

        {/* Search + Campaign filter */}
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
            className="form-select form-select-sm"
            value={campaignFilter}
            onChange={e => setCampaignFilter(e.target.value)}
            style={{ maxWidth: 220 }}
          >
            <option value="">All campaigns</option>
            {campaigns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="text-muted small ms-auto">
            Showing {sorted.length} of {searchTerms.length} terms
          </span>
        </div>

        {/* Table */}
        <div className="table-wrapper">
          <table
            ref={tableRef}
            className="table table-hover table-sm mb-0 search-terms-table"
          >
            <thead>
              <tr>
                {COLUMNS.map(col => (
                  <th
                    key={col.key}
                    className={col.sortable ? 'sortable-th' : ''}
                    onClick={col.sortable ? () => handleSort(col.key) : undefined}
                  >
                    {col.label}
                    {col.sortable && <SortIcon col={col.key} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(term => {
                const negatives = rowNegatives.get(term.searchTerm)
                const isHovered = hoveredRow === term.searchTerm
                return (
                  <tr
                    key={`${term.searchTerm}__${term.campaign}__${term.adGroup}`}
                    data-campaign-id={term.campaignId || ''}
                    data-campaign-name={term.campaign || ''}
                    data-adgroup-id={term.adGroupId || ''}
                    data-adgroup-name={term.adGroup || ''}
                    onMouseEnter={() => setHoveredRow(term.searchTerm)}
                    onMouseLeave={() => setHoveredRow(null)}
                  >
                    <td>
                      <span className="search-term-cell">
                        <HighlightedSearchTerm text={term.searchTerm} negatives={negatives} />
                        {isHovered && (
                          <button
                            className="flag-btn"
                            title="Flag as negative keyword"
                            onClick={() => onAddNegative(term.searchTerm, null, term.campaignId, term.campaign, term.adGroupId, term.adGroup, term.adGroupId ? 'ADGROUP' : 'CAMPAIGN')}
                          >
                            + Flag
                          </button>
                        )}
                      </span>
                    </td>
                    <td className="text-muted">{term.matchingKeyword}</td>
                    <td>{term.campaign}</td>
                    <td className="text-end">{Number(term.clicks).toLocaleString()}</td>
                    <td className="text-end">{Number(term.conversions).toFixed(1)}</td>
                    <td>
                      <NegativeBadges negatives={negatives} onRemove={onRemoveNegative} />
                    </td>
                  </tr>
                )
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-muted py-3">
                    No matching records found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
