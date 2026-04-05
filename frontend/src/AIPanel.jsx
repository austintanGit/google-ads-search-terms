import React, { useState } from 'react'

const MATCH_TYPE_OPTIONS = [
  { value: 'EXACT', label: 'Exact' },
  { value: 'PHRASE', label: 'Phrase' },
  { value: 'BROAD', label: 'Broad' },
]

// Helper function to get available match types for a keyword
function getAvailableMatchTypes(keyword, existingNegatives) {
  const existingMatchTypes = new Set()
  
  existingNegatives.forEach(existing => {
    let existingKeyword, matchType
    if (typeof existing === 'string') {
      existingKeyword = existing
      matchType = 'EXACT'
    } else {
      existingKeyword = existing.keyword
      matchType = existing.matchType || 'EXACT'
    }
    
    if (existingKeyword.toLowerCase() === keyword.toLowerCase()) {
      existingMatchTypes.add(matchType)
    }
  })
  
  return MATCH_TYPE_OPTIONS.filter(option => !existingMatchTypes.has(option.value))
}

const DESTINATION_OPTIONS = [
  { value: 'CAMPAIGN', label: 'Campaign level' },
  { value: 'ADGROUP', label: 'Ad group level' },
  { value: 'NEGATIVE_LIST', label: 'Negative keyword list' },
]

const DEST_CLASS = {
  CAMPAIGN: 'dest-select-campaign',
  ADGROUP: 'dest-select-adgroup',
  NEGATIVE_LIST: 'dest-select-list',
}

function formatLastScanned(date) {
  if (!date) return null
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) +
    ' at ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export default function AIPanel({
  currentClientId,
  websiteUrl,
  setWebsiteUrl,
  aiStats,
  aiLoading,
  pendingNegatives,
  setPendingNegatives,
  sharedSets,
  selectedSharedSetId,
  setSelectedSharedSetId,
  lastScannedAt,
  onRescan,
  onCreateSharedSet,
  onAddManualNegative,
  onRemoveNegative,
  onSubmitNegatives,
  submitSuccess,
  setSubmitSuccess,
  submitError,
  setSubmitError,
  submissionHistory,
  existingNegatives,
}) {
  const [bulkMatchType, setBulkMatchType] = useState('EXACT')
  const [bulkDestination, setBulkDestination] = useState('CAMPAIGN')
  const [bulkSharedSetId, setBulkSharedSetId] = useState(null)
  const [manualKeyword, setManualKeyword] = useState('')
  const [manualMatchType, setManualMatchType] = useState('EXACT')
  const [showSpecificPage, setShowSpecificPage] = useState(false)
  const [specificPageUrl, setSpecificPageUrl] = useState('')
  const [showManualAdd, setShowManualAdd] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  // Create-list inline state — ctx is 'bulk' | keyword-string | null
  const [createListCtx, setCreateListCtx] = useState(null)
  const [newListName, setNewListName] = useState('')
  const [createListLoading, setCreateListLoading] = useState(false)
  const [createListError, setCreateListError] = useState('')

  function openCreateList(ctx) {
    setCreateListCtx(ctx)
    setNewListName('')
    setCreateListError('')
  }

  function closeCreateList() {
    setCreateListCtx(null)
    setNewListName('')
    setCreateListError('')
  }

  async function handleCreateList(onSuccess) {
    const name = newListName.trim()
    if (!name) return
    setCreateListLoading(true)
    setCreateListError('')
    try {
      const newSet = await onCreateSharedSet(name)
      onSuccess(newSet)
      closeCreateList()
    } catch (err) {
      setCreateListError(err.message || 'Failed to create list')
    } finally {
      setCreateListLoading(false)
    }
  }

  const selectedCount = pendingNegatives.filter(item => item.selected && !item.alreadyInGoogle).length

  function handleToggleItem(keyword) {
    setPendingNegatives(prev =>
      prev.map(item =>
        item.keyword === keyword && !item.alreadyInGoogle ? { ...item, selected: !item.selected } : item
      )
    )
  }

  function handleToggleAll(checked) {
    setPendingNegatives(prev => prev.map(item =>
      item.alreadyInGoogle ? item : { ...item, selected: checked }
    ))
  }

  function handleMatchTypeChange(keyword, matchType) {
    setPendingNegatives(prev =>
      prev.map(item => item.keyword === keyword ? { ...item, matchType } : item)
    )
  }

  function handleBulkDestinationChange(dest) {
    setBulkDestination(dest)
    setBulkSharedSetId(null)
    if ((dest === 'CAMPAIGN' || dest === 'ADGROUP') && bulkMatchType === 'BROAD') {
      setBulkMatchType('EXACT')
    }
  }

  function handleDestinationChange(keyword, destination) {
    setPendingNegatives(prev =>
      prev.map(item => {
        if (item.keyword !== keyword) return item
        const matchType = (destination === 'CAMPAIGN' || destination === 'ADGROUP') && item.matchType === 'BROAD'
          ? 'EXACT'
          : item.matchType
        return {
          ...item,
          destination,
          matchType,
          sharedSetId: destination === 'NEGATIVE_LIST' ? item.sharedSetId : null,
        }
      })
    )
  }

  function handleKeywordSharedSetChange(keyword, sharedSetId) {
    setPendingNegatives(prev =>
      prev.map(item => item.keyword === keyword ? { ...item, sharedSetId } : item)
    )
  }

  function handleApplyBulkMatchType() {
    setPendingNegatives(prev =>
      prev.map(item => {
        if (!item.selected || item.alreadyInGoogle) return item
        return { ...item, matchType: bulkMatchType }
      })
    )
  }

  function handleApplyBulkDestination() {
    setPendingNegatives(prev =>
      prev.map(item => {
        if (!item.selected || item.alreadyInGoogle) return item
        const matchType = (bulkDestination === 'CAMPAIGN' || bulkDestination === 'ADGROUP') && item.matchType === 'BROAD'
          ? 'EXACT'
          : item.matchType
        return {
          ...item,
          destination: bulkDestination,
          matchType,
          sharedSetId: bulkDestination === 'NEGATIVE_LIST' ? bulkSharedSetId : null,
        }
      })
    )
  }

  function handleAddManual(e) {
    e.preventDefault()
    const kw = manualKeyword.trim()
    if (!kw) return
    onAddManualNegative(kw, manualMatchType)
    setManualKeyword('')
    setSubmitSuccess('')
  }

  function formatHistoryDate(isoStr) {
    return new Date(isoStr).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  }

  function downloadHistoryEntry(entry) {
    const keywords = Array.isArray(entry.keywords) ? entry.keywords : []
    const rows = keywords.map(k =>
      typeof k === 'string'
        ? `"${k}","EXACT"`
        : `"${k.keyword}","${k.matchType}"`
    )
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

  function exportNegatives() {
    if (pendingNegatives.length === 0) return
    const rows = pendingNegatives.map(item =>
      `"${item.keyword}","${item.matchType}","${item.source}","${item.destination || 'CAMPAIGN'}"`
    )
    const csv = `"Keyword","Match Type","Source","Destination"\n${rows.join('\n')}`
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'negative-keywords.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Shows campaign/adgroup context text + list picker (when NEGATIVE_LIST) under the keyword name
  function renderKeywordDetails(item) {
    if (item.alreadyInGoogle) return null
    const hasCampaignInfo = item.campaignName || item.adGroupName

    return (
      <>
        {hasCampaignInfo && (
          <div className="kw-dest-result">
            {item.campaignName && (
              <span className="kw-dest-result-item">
                <span className="kw-dest-result-label">Campaign:</span>
                <span className="kw-dest-result-val">{item.campaignName}</span>
              </span>
            )}
            {item.adGroupName && (
              <>
                <span className="kw-dest-result-sep">›</span>
                <span className="kw-dest-result-item">
                  <span className="kw-dest-result-label">Ad group:</span>
                  <span className="kw-dest-result-val">{item.adGroupName}</span>
                </span>
              </>
            )}
          </div>
        )}
      </>
    )
  }

  // Destination column — just the type dropdown, color-coded by level
  function renderDestinationCell(item) {
    if (item.alreadyInGoogle) return null
    const dest = item.destination || 'CAMPAIGN'
    
    return (
      <div className="destination-cell">
        <select
          className={`matchtype-select ${DEST_CLASS[dest] || ''}`}
          value={dest}
          onChange={e => handleDestinationChange(item.keyword, e.target.value)}
        >
          {DESTINATION_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        
        {dest === 'NEGATIVE_LIST' && (
          <div className="inline-list-picker">
            {createListCtx === item.keyword ? (
              <div className="create-list-inline">
                <input
                  type="text"
                  className="form-control form-control-sm create-list-input"
                  placeholder="New list name…"
                  value={newListName}
                  onChange={e => setNewListName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateList(s => handleKeywordSharedSetChange(item.keyword, s.id))}
                  autoFocus
                />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={!newListName.trim() || createListLoading}
                  onClick={() => handleCreateList(s => handleKeywordSharedSetChange(item.keyword, s.id))}
                >
                  {createListLoading ? 'Creating…' : 'Create'}
                </button>
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={closeCreateList}>
                  Cancel
                </button>
                {createListError && <span className="create-list-error">{createListError}</span>}
              </div>
            ) : (
              <div className="list-picker-controls">
                <select
                  className="matchtype-select"
                  value={item.sharedSetId || ''}
                  onChange={e => handleKeywordSharedSetChange(item.keyword, e.target.value || null)}
                >
                  <option value="">Select list…</option>
                  {sharedSets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <button type="button" className="btn-create-list" onClick={() => openCreateList(item.keyword)}>
                  + Create new list
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {/* Negative keyword scanner box */}
      <div className="ai-scanner-box mb-3">
        <div className="ai-scanner-top-row">
          <div className="ai-scanner-text">
            <div className="ai-scanner-title">Negative keyword scanner</div>
            <p className="ai-scanner-desc">
              AI automatically analyzes your site to recommend negative keywords — so you stop wasting ad spend on irrelevant searches.
            </p>
          </div>
          <div className="ai-scanner-actions">
            {lastScannedAt && (
              <span className="ai-last-scanned">Last scanned: {formatLastScanned(lastScannedAt)}</span>
            )}
            <button
              className="btn btn-primary btn-sm btn-rescan"
              disabled={!currentClientId || aiLoading || (!websiteUrl && !specificPageUrl)}
              onClick={() => onRescan()}
            >
              {aiLoading
                ? <><i className="fas fa-spinner fa-spin me-1" />Analyzing…</>
                : <><i className="fas fa-redo me-1" />Re-scan site</>}
            </button>
          </div>
        </div>

        {/* Scan a specific page toggle */}
        <div className="ai-specific-row">
          <button
            className="ai-specific-toggle"
            onClick={() => {
              const next = !showSpecificPage
              setShowSpecificPage(next)
              if (next && !specificPageUrl) setSpecificPageUrl(websiteUrl || '')
            }}
          >
            <i className={`fas fa-chevron-${showSpecificPage ? 'down' : 'right'} me-1`} />
            Scan a specific page instead
          </button>
          {showSpecificPage && (
            <div className="ai-specific-inputs">
              <input
                type="url"
                className="form-control form-control-sm"
                placeholder="https://example.com/page"
                value={specificPageUrl}
                onChange={e => setSpecificPageUrl(e.target.value)}
              />
              <button
                className="btn btn-outline-primary btn-sm"
                disabled={!specificPageUrl.trim() || aiLoading}
                onClick={() => onRescan(specificPageUrl.trim())}
              >
                Scan page
              </button>
            </div>
          )}
        </div>

        {/* Stats row (shown after AI scan) */}
        {aiStats !== null && aiStats.totalSearchTerms !== undefined && (
          <div className="ai-stats-row">
            <div className="ai-stat-block">
              <div className="ai-stat-value">{aiStats.totalSearchTerms}</div>
              <div className="ai-stat-label">Total search terms</div>
            </div>
            <div className="ai-stat-divider" />
            <div className="ai-stat-block">
              <div className="ai-stat-value text-danger">{aiStats.negativeCount}</div>
              <div className="ai-stat-label">Recommended negatives</div>
            </div>
            <div className="ai-stat-divider" />
            <div className="ai-stat-block">
              <div className="ai-stat-value text-success">
                {Number(aiStats.qualityPercentage).toFixed(0)}%
              </div>
              <div className="ai-stat-label">Quality keyword %</div>
            </div>
          </div>
        )}

        {/* AI Analysis explanation row */}
        {aiStats && aiStats.explanation && (
          <div className="ai-explanation">
            <i className="fas fa-robot me-1 text-primary" />
            <strong>AI analysis:</strong> {aiStats.explanation}
          </div>
        )}
      </div>

      {/* Submit result messages */}
      {submitSuccess && (
        <div className="submit-success-bar mb-3">
          <i className="fas fa-check-circle me-2" />
          {submitSuccess}
        </div>
      )}
      {submitError && (
        <div className="submit-error-bar mb-3">
          <div className="submit-error-main">
            <i className="fas fa-exclamation-circle me-2" />
            {submitError}
          </div>
          <button className="submit-error-dismiss" onClick={() => setSubmitError('')}>×</button>
        </div>
      )}

      {/* Step 1 heading */}
      <div className="step-heading">
        <div className="step-heading-num">1</div>
        <div className="step-heading-text">
          <div className="step-heading-title">Pending negative keywords</div>
          <div className="step-heading-sub">Review AI recommendations and submit to Google Ads</div>
        </div>
      </div>

      {/* Pending negative keywords section */}
      <div className="pending-section mb-3">

        {/* Section header */}
        <div className="pending-header">
          <div className="pending-header-left">
            <span className="pending-title">Pending negative keywords</span>
            <span className="source-badge source-ai">AI-recommended</span>
            <span className="source-badge source-manual">Manual</span>
          </div>
          <button className="btn btn-sm btn-outline-secondary" onClick={exportNegatives}>
            <i className="fas fa-download me-1" />Export negatives
          </button>
        </div>

        {/* Scroll hint */}
        <div className="pending-table-container">
          <a className="scroll-down-link" href="#search-terms-section">
            Scroll down to "Review your search terms" to see the full search terms report and manually add others that our AI software didn't detect.
            <i className="fas fa-chevron-down" />
          </a>
        </div>

        {/* Bulk apply — two separate rows */}
        <div className="pending-bulk-top">
          {/* Match Type Row */}
          <div className="bulk-row">
            <div className="bulk-row-content">
              <div className="bulk-setting-group">
                <label className="bulk-setting-label">Match Type</label>
                <select
                  className="matchtype-select"
                  value={bulkMatchType}
                  onChange={e => setBulkMatchType(e.target.value)}
                >
                  {MATCH_TYPE_OPTIONS
                    .filter(opt => !(opt.value === 'BROAD' && (bulkDestination === 'CAMPAIGN' || bulkDestination === 'ADGROUP')))
                    .map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                </select>
              </div>
            </div>
            <div className="bulk-apply-cell">
              <button
                type="button"
                className="btn btn-sm btn-primary apply-to-selected-btn"
                onClick={handleApplyBulkMatchType}
                disabled={selectedCount === 0}
              >
                Apply to selected
              </button>
            </div>
          </div>

          {/* Destination Row */}
          <div className="bulk-row">
            <div className="bulk-row-content">
              <div className="bulk-setting-group">
                <label className="bulk-setting-label">Destination</label>
                <select
                  className={`matchtype-select ${DEST_CLASS[bulkDestination] || ''}`}
                  value={bulkDestination}
                  onChange={e => handleBulkDestinationChange(e.target.value)}
                >
                  {DESTINATION_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {bulkDestination === 'NEGATIVE_LIST' && (
                <div className="bulk-setting-group">
                  <label className="bulk-setting-label">List</label>
                  {createListCtx === 'bulk' ? (
                    <div className="create-list-inline">
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
                      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={closeCreateList}>
                        Cancel
                      </button>
                      {createListError && <span className="create-list-error">{createListError}</span>}
                    </div>
                  ) : (
                    <div className="bulk-list-controls">
                      <select
                        className="matchtype-select"
                        value={bulkSharedSetId || ''}
                        onChange={e => setBulkSharedSetId(e.target.value || null)}
                      >
                        <option value="">Select list…</option>
                        {sharedSets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                      <button type="button" className="btn-create-list" onClick={() => openCreateList('bulk')}>
                        + Create new list
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="bulk-apply-cell">
              <button
                type="button"
                className="btn btn-sm btn-primary apply-to-selected-btn"
                onClick={handleApplyBulkDestination}
                disabled={selectedCount === 0}
              >
                Apply to selected
              </button>
            </div>
          </div>
        </div>

        {/* Keywords table */}
        <div className="pending-table-wrap">
          <table className="pending-table">
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    checked={
                      pendingNegatives.some(i => !i.alreadyInGoogle) &&
                      pendingNegatives.filter(i => !i.alreadyInGoogle).every(i => i.selected)
                    }
                    onChange={e => handleToggleAll(e.target.checked)}
                  />
                </th>
                <th className="col-keyword">KEYWORD</th>
                <th className="col-matchtype">MATCH TYPE</th>
                <th className="col-destination">DESTINATION</th>
                <th className="col-action" />
              </tr>
            </thead>
            <tbody>
              {pendingNegatives.length === 0 && (
                <tr>
                  <td colSpan={5} className="pending-empty">
                    No pending keywords — scan your website or select text in the table below to add negatives
                  </td>
                </tr>
              )}
              {pendingNegatives.map((item, index) => (
                <tr
                  key={`${item.keyword}-${item.destination}-${item.matchType}-${index}`}
                  className={
                    item.alreadyInGoogle ? 'row-in-google' :
                    item.selected ? '' : 'row-unchecked'
                  }
                >
                  <td className="col-check">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      disabled={item.alreadyInGoogle}
                      onChange={() => handleToggleItem(item.keyword)}
                    />
                  </td>
                  <td className="col-keyword">
                    <div className="kw-main-row">
                      <span className="kw-text">{item.keyword}</span>
                      {item.alreadyInGoogle
                        ? <span className="source-badge source-in-google">In Google</span>
                        : item.source === 'ai'
                          ? <span className="source-badge source-ai">AI</span>
                          : <span className="source-badge source-manual">Manual</span>
                      }
                    </div>
                    {renderKeywordDetails(item)}
                  </td>
                  <td className="col-matchtype">
                    <select
                      className="matchtype-select"
                      value={item.matchType}
                      disabled={item.alreadyInGoogle}
                      onChange={e => handleMatchTypeChange(item.keyword, e.target.value)}
                    >
                      {MATCH_TYPE_OPTIONS
                        .filter(opt => !(opt.value === 'BROAD' && (item.destination === 'CAMPAIGN' || item.destination === 'ADGROUP')))
                        .map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                  </td>
                  <td className="col-destination">
                    {renderDestinationCell(item)}
                  </td>
                  <td className="col-action">
                    {!item.alreadyInGoogle && (
                      <button
                        className="btn-remove-kw"
                        onClick={() => onRemoveNegative(item.keyword)}
                        title="Remove"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Manual add toggle */}
        <div className="pending-manual-toggle-row">
          <button
            className="btn-manual-toggle"
            onClick={() => setShowManualAdd(v => !v)}
          >
            <i className={`fas fa-chevron-${showManualAdd ? 'down' : 'right'} me-1`} />
            Add keyword manually
          </button>
        </div>

        {showManualAdd && (
          <div className="pending-manual-row">
            <div className="manual-label-col">
              <label className="manual-label">KEYWORD</label>
              <input
                type="text"
                className="form-control form-control-sm"
                placeholder="e.g. marketing jobs"
                value={manualKeyword}
                onChange={e => setManualKeyword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddManual(e)}
              />
            </div>
            <div className="manual-match-col">
              <label className="manual-label">MATCH TYPE</label>
              <select
                className="matchtype-select"
                value={manualMatchType}
                onChange={e => setManualMatchType(e.target.value)}
              >
                {MATCH_TYPE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="manual-add-col">
              <label className="manual-label">&nbsp;</label>
              <button
                className="btn btn-sm btn-outline-primary"
                onClick={handleAddManual}
                disabled={!manualKeyword.trim()}
              >
                + Add
              </button>
            </div>
          </div>
        )}

        {/* Submit row */}
        <div className="pending-submit-row">
          <div className="keyword-list-group">
            <div className="keyword-list-controls">
              <button
                className="btn btn-primary btn-submit-kw"
                disabled={selectedCount === 0}
                onClick={onSubmitNegatives}
              >
                Submit {selectedCount > 0 ? `${selectedCount} ` : ''}keywords to Google Ads →
              </button>
            </div>
          </div>
        </div>

        {/* Submission history */}
        {submissionHistory && submissionHistory.length > 0 && (
          <div className="submission-history-wrap">
            <button
              className="submission-history-toggle"
              onClick={() => setShowHistory(v => !v)}
            >
              <i className="fas fa-history me-1" />
              View submission history
              <i className={`fas fa-chevron-${showHistory ? 'up' : 'down'} ms-1`} />
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
                    </div>
                    <div className="submission-history-actions">
                      <button
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => downloadHistoryEntry(entry)}
                        title="Download as CSV"
                      >
                        <i className="fas fa-download me-1" />Download
                      </button>
                      <button
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => copyHistoryEntry(entry)}
                        title="Copy keywords to clipboard"
                      >
                        <i className="fas fa-copy me-1" />Copy
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
