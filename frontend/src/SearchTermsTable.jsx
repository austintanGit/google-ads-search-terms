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

  // Selection toolbar state (text selection)
  const [toolbar, setToolbar] = useState({ visible: false, x: 0, y: 0 })
  const pendingSelectionRef = useRef(null)
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
    if (text) {
      onAddNegative(text)
      window.getSelection()?.removeAllRanges()
    }
    setToolbar({ visible: false, x: 0, y: 0 })
    pendingSelectionRef.current = null
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

      {/* Keyword status key */}
      <div className="status-key mb-3">
        <div className="status-key-title">KEYWORD STATUS KEY</div>
        <div className="status-key-items">
          <div className="status-key-item">
            <span className="neg-badge neg-badge-google">keyword</span>
            <span className="status-key-desc">Already a negative in Google Ads — no action needed</span>
          </div>
          <div className="status-key-item">
            <span className="neg-badge neg-badge-ai">keyword <span className="neg-badge-remove-demo">×</span></span>
            <span className="status-key-desc">AI-recommended negative — not yet submitted to Google</span>
          </div>
          <div className="status-key-item">
            <span className="neg-badge neg-badge-manual">keyword <span className="neg-badge-remove-demo">×</span></span>
            <span className="status-key-desc">Manually flagged negative — not yet submitted to Google</span>
          </div>
        </div>
      </div>

      {/* Hover hint */}
      <div className="hover-hint mb-2">
        <i className="fas fa-info-circle me-1" />
        Hover over a search term row and click <strong>+ Flag</strong> to add the whole term, or <strong>select any word/phrase</strong> to add just that part as a negative keyword
      </div>

      {/* Search + Campaign filter */}
      <div className="d-flex gap-2 mb-2 align-items-center flex-wrap">
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

      <div className="table-wrapper border rounded">
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
                          onClick={() => onAddNegative(term.searchTerm)}
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
    </>
  )
}
