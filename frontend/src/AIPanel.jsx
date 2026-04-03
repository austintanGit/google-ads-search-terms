import React, { useState } from 'react'

const MATCH_TYPE_OPTIONS = [
  { value: 'EXACT', label: 'Exact' },
  { value: 'PHRASE', label: 'Phrase' },
  { value: 'BROAD', label: 'Broad' },
]

const DESTINATION_OPTIONS = [
  { value: 'CAMPAIGN', label: 'Campaign level' },
  { value: 'ADGROUP', label: 'Ad group level' },
  { value: 'NEGATIVE_LIST', label: 'Negative keyword list' },
]

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
  campaigns,
  adGroupsByCampaign,
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
}) {
  const [expandedRows, setExpandedRows] = useState(new Set())
  const [bulkMatchType, setBulkMatchType] = useState('EXACT')
  const [bulkDestination, setBulkDestination] = useState('CAMPAIGN')
  const [bulkCampaignId, setBulkCampaignId] = useState(null)
  const [bulkCampaignName, setBulkCampaignName] = useState(null)
  const [bulkAdGroupId, setBulkAdGroupId] = useState(null)
  const [bulkAdGroupName, setBulkAdGroupName] = useState(null)
  const [bulkSharedSetId, setBulkSharedSetId] = useState(null)
  const [manualKeyword, setManualKeyword] = useState('')
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

  function toggleRowExpand(keyword) {
    setExpandedRows(prev => {
      const next = new Set(prev)
      next.has(keyword) ? next.delete(keyword) : next.add(keyword)
      return next
    })
  }

  function handleBulkDestinationChange(dest) {
    setBulkDestination(dest)
    setBulkCampaignId(null)
    setBulkCampaignName(null)
    setBulkAdGroupId(null)
    setBulkAdGroupName(null)
    setBulkSharedSetId(null)
  }

  function handleDestinationChange(keyword, destination) {
    setPendingNegatives(prev =>
      prev.map(item => {
        if (item.keyword !== keyword) return item
        return { ...item, destination, campaignId: null, campaignName: null, adGroupId: null, adGroupName: null, sharedSetId: null }
      })
    )
  }

  function handleCampaignChange(keyword, campaignId, campaignName) {
    setPendingNegatives(prev =>
      prev.map(item =>
        item.keyword === keyword
          ? { ...item, campaignId, campaignName, adGroupId: null, adGroupName: null }
          : item
      )
    )
  }

  function handleAdGroupChange(keyword, adGroupId, adGroupName) {
    setPendingNegatives(prev =>
      prev.map(item =>
        item.keyword === keyword ? { ...item, adGroupId, adGroupName } : item
      )
    )
  }

  function handleKeywordSharedSetChange(keyword, sharedSetId) {
    setPendingNegatives(prev =>
      prev.map(item => item.keyword === keyword ? { ...item, sharedSetId } : item)
    )
  }

  function handleApplyBulk() {
    setPendingNegatives(prev =>
      prev.map(item => {
        if (!item.selected || item.alreadyInGoogle) return item
        return {
          ...item,
          matchType: bulkMatchType,
          destination: bulkDestination,
          campaignId: bulkCampaignId,
          campaignName: bulkCampaignName,
          adGroupId: bulkAdGroupId,
          adGroupName: bulkAdGroupName,
          sharedSetId: bulkSharedSetId,
        }
      })
    )
  }

  function handleAddManual(e) {
    e.preventDefault()
    const kw = manualKeyword.trim()
    if (!kw) return
    onAddManualNegative(kw, 'EXACT')
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

  // Text-only summary shown below keyword name
  function renderDestinationResult(item) {
    if (item.alreadyInGoogle) return null
    const parts = []
    if (item.campaignName) parts.push({ label: 'Campaign', value: item.campaignName })
    if (item.adGroupName) parts.push({ label: 'Ad group', value: item.adGroupName })
    const dest = item.destination || 'CAMPAIGN'
    if (dest === 'NEGATIVE_LIST' && item.sharedSetId) {
      const listName = sharedSets.find(s => s.id === item.sharedSetId)?.name
      if (listName) parts.push({ label: 'List', value: listName })
    }
    if (parts.length === 0) return null
    return (
      <div className="kw-dest-result">
        {parts.map((p, i) => (
          <span key={i} className="kw-dest-result-item">
            {i > 0 && <span className="kw-dest-result-sep">›</span>}
            <span className="kw-dest-result-label">{p.label}:</span>
            <span className="kw-dest-result-val">{p.value}</span>
          </span>
        ))}
      </div>
    )
  }

  // Interactive cascade pickers rendered inside the Destination column cell
  function renderDestinationCell(item) {
    if (item.alreadyInGoogle) return null
    const dest = item.destination || 'CAMPAIGN'
    const isExpanded = expandedRows.has(item.keyword)
    const adGroups = (adGroupsByCampaign || {})[item.campaignId] || []
    return (
      <div className="dest-cell">
        {/* Destination type + expand toggle on one row */}
        <div className="dest-type-row">
          <select
            className="matchtype-select dest-type-select"
            value={dest}
            onChange={e => handleDestinationChange(item.keyword, e.target.value)}
          >
            {DESTINATION_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button
            className="dest-expand-btn"
            onClick={() => toggleRowExpand(item.keyword)}
            title={isExpanded ? 'Collapse' : 'Configure destination'}
          >
            <i className={`fas fa-chevron-${isExpanded ? 'up' : 'down'}`} />
          </button>
        </div>

        {/* Cascade pickers — only shown when expanded */}
        {isExpanded && (
          <>
            <div className="dest-cascade-row">
              <span className="dest-cascade-label">Campaign</span>
              <select
                className="dest-cascade-select"
                value={item.campaignId || ''}
                onChange={e => {
                  const c = campaigns.find(c => c.id === e.target.value)
                  handleCampaignChange(item.keyword, c?.id || null, c?.name || null)
                }}
              >
                <option value="">Select…</option>
                {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {(dest === 'ADGROUP' || dest === 'NEGATIVE_LIST') && item.campaignId && (
              <div className="dest-cascade-row">
                <span className="dest-cascade-label">Ad group</span>
                <select
                  className="dest-cascade-select"
                  value={item.adGroupId || ''}
                  onChange={e => {
                    const ag = adGroups.find(ag => ag.id === e.target.value)
                    handleAdGroupChange(item.keyword, ag?.id || null, ag?.name || null)
                  }}
                >
                  <option value="">Select…</option>
                  {adGroups.map(ag => <option key={ag.id} value={ag.id}>{ag.name}</option>)}
                </select>
              </div>
            )}

            {dest === 'NEGATIVE_LIST' && item.adGroupId && (
              <>
                {createListCtx === item.keyword ? (
                  <div className="dest-cascade-row create-list-kw-row">
                    <input
                      type="text"
                      className="dest-cascade-input"
                      placeholder="New list name…"
                      value={newListName}
                      onChange={e => setNewListName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleCreateList(s => handleKeywordSharedSetChange(item.keyword, s.id))}
                      autoFocus
                    />
                    <button
                      className="btn-create-list-confirm"
                      disabled={!newListName.trim() || createListLoading}
                      onClick={() => handleCreateList(s => handleKeywordSharedSetChange(item.keyword, s.id))}
                      title="Create"
                    >
                      {createListLoading ? '…' : '✓'}
                    </button>
                    <button className="btn-cancel-create" onClick={closeCreateList} title="Cancel">×</button>
                    {createListError && <span className="create-list-error-sm">{createListError}</span>}
                  </div>
                ) : (
                  <div className="dest-cascade-row">
                    <span className="dest-cascade-label">List</span>
                    <select
                      className="dest-cascade-select"
                      value={item.sharedSetId || ''}
                      onChange={e => handleKeywordSharedSetChange(item.keyword, e.target.value)}
                    >
                      <option value="">Select…</option>
                      {sharedSets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <button
                      className="btn-create-list-sm"
                      onClick={() => openCreateList(item.keyword)}
                      title="Create new list"
                    >+</button>
                  </div>
                )}
              </>
            )}
          </>
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
            {aiStats.explanation && (
              <div className="ai-explanation">
                <i className="fas fa-robot me-1 text-primary" />
                <strong>AI analysis:</strong> {aiStats.explanation}
              </div>
            )}
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

        {/* Bulk apply row — progressive cascade: Destination → Campaign → Ad Group → List | Match Type | Apply */}
        <div className="pending-bulk-top">
          <div className="bulk-col">
            <label className="bulk-col-label">DESTINATION</label>
            <select
              className="matchtype-select"
              value={bulkDestination}
              onChange={e => handleBulkDestinationChange(e.target.value)}
            >
              {DESTINATION_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div className="bulk-col">
            <label className="bulk-col-label">CAMPAIGN</label>
            <select
              className="matchtype-select"
              value={bulkCampaignId || ''}
              onChange={e => {
                const c = campaigns.find(c => c.id === e.target.value)
                setBulkCampaignId(c?.id || null)
                setBulkCampaignName(c?.name || null)
                setBulkAdGroupId(null)
                setBulkAdGroupName(null)
                setBulkSharedSetId(null)
              }}
            >
              <option value="">Select campaign…</option>
              {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {(bulkDestination === 'ADGROUP' || bulkDestination === 'NEGATIVE_LIST') && bulkCampaignId && (
            <div className="bulk-col">
              <label className="bulk-col-label">AD GROUP</label>
              <select
                className="matchtype-select"
                value={bulkAdGroupId || ''}
                onChange={e => {
                  const ags = (adGroupsByCampaign || {})[bulkCampaignId] || []
                  const ag = ags.find(ag => ag.id === e.target.value)
                  setBulkAdGroupId(ag?.id || null)
                  setBulkAdGroupName(ag?.name || null)
                  setBulkSharedSetId(null)
                }}
              >
                <option value="">Select ad group…</option>
                {((adGroupsByCampaign || {})[bulkCampaignId] || []).map(ag => (
                  <option key={ag.id} value={ag.id}>{ag.name}</option>
                ))}
              </select>
            </div>
          )}

          {bulkDestination === 'NEGATIVE_LIST' && bulkAdGroupId && (
            <div className="bulk-col">
              <label className="bulk-col-label">LIST</label>
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
                    className="btn btn-sm btn-primary"
                    disabled={!newListName.trim() || createListLoading}
                    onClick={() => handleCreateList(s => setBulkSharedSetId(s.id))}
                  >
                    {createListLoading ? 'Creating…' : 'Create'}
                  </button>
                  <button className="btn btn-sm btn-outline-secondary" onClick={closeCreateList}>
                    Cancel
                  </button>
                  {createListError && <span className="create-list-error">{createListError}</span>}
                </div>
              ) : (
                <>
                  <select
                    className="matchtype-select"
                    value={bulkSharedSetId || ''}
                    onChange={e => setBulkSharedSetId(e.target.value || null)}
                  >
                    <option value="">Select list…</option>
                    {sharedSets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button className="btn-create-list" onClick={() => openCreateList('bulk')}>
                    + Create new list
                  </button>
                </>
              )}
            </div>
          )}

          <div className="bulk-col">
            <label className="bulk-col-label">MATCH TYPE</label>
            <select
              className="matchtype-select"
              value={bulkMatchType}
              onChange={e => setBulkMatchType(e.target.value)}
            >
              {MATCH_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div className="bulk-col bulk-col-btn">
            <button
              className="btn btn-sm btn-primary"
              onClick={handleApplyBulk}
              disabled={selectedCount === 0}
            >
              Apply to selected
            </button>
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
              {pendingNegatives.map(item => (
                <tr
                  key={item.keyword}
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
                    {renderDestinationResult(item)}
                  </td>
                  <td className="col-matchtype">
                    <select
                      className="matchtype-select"
                      value={item.matchType}
                      disabled={item.alreadyInGoogle}
                      onChange={e => handleMatchTypeChange(item.keyword, e.target.value)}
                    >
                      {MATCH_TYPE_OPTIONS.map(opt => (
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
