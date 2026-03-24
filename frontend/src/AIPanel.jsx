import React, { useState } from 'react'

const MATCH_TYPE_OPTIONS = [
  { value: 'EXACT', label: 'Exact' },
  { value: 'PHRASE', label: 'Phrase' },
  { value: 'BROAD', label: 'Broad' },
]

export default function AIPanel({
  currentClientId,
  websiteUrl,
  setWebsiteUrl,
  aiStats,
  setAiStats,
  aiLoading,
  setAiLoading,
  searchTerms,
  pendingNegatives,
  setPendingNegatives,
  sharedSets,
  selectedSharedSetId,
  setSelectedSharedSetId,
  onAiResults,
  onAddManualNegative,
  onRemoveNegative,
  onSubmitNegatives,
  submitSuccess,
  setSubmitSuccess,
  submitError,
  setSubmitError,
}) {
  const [saveUrlStatus, setSaveUrlStatus] = useState('idle')
  const [bulkMatchType, setBulkMatchType] = useState('EXACT')
  const [manualKeyword, setManualKeyword] = useState('')
  const [manualMatchType, setManualMatchType] = useState('EXACT')
  const [allChecked, setAllChecked] = useState(true)

  const selectedCount = pendingNegatives.filter(item => item.selected && !item.alreadyInGoogle).length

  async function handleSaveUrl() {
    if (!currentClientId) { alert('Please select a client first.'); return }
    if (!websiteUrl.trim()) { alert('Please enter a website URL first.'); return }
    setSaveUrlStatus('saving')
    try {
      const r = await fetch('/api/client-website-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: currentClientId, websiteUrl: websiteUrl.trim() }),
      })
      if (!r.ok) throw new Error('Failed to save')
      setSaveUrlStatus('saved')
      setTimeout(() => setSaveUrlStatus('idle'), 2000)
    } catch {
      setSaveUrlStatus('error')
      setTimeout(() => setSaveUrlStatus('idle'), 2000)
    }
  }

  async function handleAiScan() {
    if (!searchTerms.length) { alert('Please load search terms first.'); return }
    setAiLoading(true)
    setSubmitSuccess('')
    try {
      const r = await fetch('/api/ai-recommend-negatives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchTerms, websiteUrl: websiteUrl.trim() }),
      })
      if (!r.ok) {
        const d = await r.json()
        throw new Error(d.error || 'AI analysis failed')
      }
      const result = await r.json()
      onAiResults(result)
    } catch (err) {
      alert('AI analysis failed: ' + err.message)
    } finally {
      setAiLoading(false)
    }
  }

  function handleToggleItem(keyword) {
    setPendingNegatives(prev =>
      prev.map(item =>
        item.keyword === keyword && !item.alreadyInGoogle ? { ...item, selected: !item.selected } : item
      )
    )
  }

  function handleToggleAll(checked) {
    setAllChecked(checked)
    setPendingNegatives(prev => prev.map(item =>
      item.alreadyInGoogle ? item : { ...item, selected: checked }
    ))
  }

  function handleMatchTypeChange(keyword, matchType) {
    setPendingNegatives(prev =>
      prev.map(item => item.keyword === keyword ? { ...item, matchType } : item)
    )
  }

  function handleApplyBulkMatchType() {
    setPendingNegatives(prev =>
      prev.map(item => item.selected ? { ...item, matchType: bulkMatchType } : item)
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

  function exportNegatives() {
    if (pendingNegatives.length === 0) return
    const rows = pendingNegatives.map(item =>
      `"${item.keyword}","${item.matchType}","${item.source}"`
    )
    const csv = `"Keyword","Match Type","Source"\n${rows.join('\n')}`
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'negative-keywords.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const saveUrlLabel = {
    idle: 'Save URL',
    saving: 'Saving…',
    saved: 'Saved!',
    error: 'Save URL',
  }[saveUrlStatus]

  return (
    <>
      {/* Negative keyword scanner box */}
      <div className="ai-scanner-box mb-3">
        <div className="ai-scanner-header">
          <div className="ai-scanner-title">Negative keyword scanner</div>
          <p className="ai-scanner-desc">
          Enter your website URL and we'll scan your site, use AI to understand your business, and generate a recommended list of negative keywords — so you stop wasting ad spend on irrelevant searches.
          </p>
          <div className="ai-steps">
            <span><span className="step-num">1</span> Enter your URL</span>
            <span><span className="step-num">2</span> We scan &amp; analyze with AI</span>
            <span><span className="step-num">3</span> Review &amp; submit to Google Ads</span>
          </div>
        </div>

        {/* URL input row */}
        <div className="ai-url-row">
          <input
            type="url"
            className="form-control"
            placeholder="https://example.com"
            value={websiteUrl}
            onChange={e => setWebsiteUrl(e.target.value)}
          />
          <button
            className="btn btn-primary btn-scan"
            disabled={!currentClientId || aiLoading}
            onClick={handleAiScan}
          >
            {aiLoading
              ? <><i className="fas fa-spinner fa-spin me-1" />Analyzing…</>
              : <><i className="fas fa-search me-1" />Scan website</>}
          </button>
          <button
            className={`btn btn-outline-secondary ${saveUrlStatus === 'saved' ? 'btn-outline-success' : ''}`}
            disabled={!currentClientId || saveUrlStatus === 'saving'}
            onClick={handleSaveUrl}
          >
            {saveUrlLabel}
          </button>
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

      {/* Submit result messages — outside the pending gate so they survive after list is cleared */}
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

      {/* Pending negative keywords section — always visible */}
      <div className="pending-section mb-3">
          <div className="pending-header">
            <span className="pending-title">Pending negative keywords</span>
            <button className="btn btn-sm btn-outline-secondary" onClick={exportNegatives}>
              <i className="fas fa-download me-1" />Export negatives
            </button>
          </div>

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
                  <th className="col-action" />
                </tr>
              </thead>
              <tbody>
                {pendingNegatives.length === 0 && (
                  <tr>
                    <td colSpan={4} className="pending-empty">
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
                      <span className="kw-text">{item.keyword}</span>
                      {item.alreadyInGoogle
                        ? <span className="source-badge source-in-google">In Google</span>
                        : item.source === 'ai'
                          ? <span className="source-badge source-ai">AI</span>
                          : <span className="source-badge source-manual">Manual</span>
                      }
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

          {/* Bulk match type apply */}
          <div className="pending-bulk-row">
            <span className="text-muted small">Apply match type to selected:</span>
            <select
              className="matchtype-select"
              value={bulkMatchType}
              onChange={e => setBulkMatchType(e.target.value)}
            >
              {MATCH_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <button
              className="btn btn-sm btn-outline-secondary"
              onClick={handleApplyBulkMatchType}
              disabled={selectedCount === 0}
            >
              Apply all
            </button>
          </div>

          {/* Manual add */}
          <div className="pending-manual-row">
            <div className="manual-label-col">
              <label className="manual-label">ADD KEYWORD MANUALLY</label>
              <input
                type="text"
                className="form-control form-control-sm"
                placeholder="e.g. marketing jobs"
                value={manualKeyword}
                onChange={e => setManualKeyword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddManual(e)}
              />
            </div>
            <div className="manual-type-col">
              <label className="manual-label">MATCH TYPE</label>
              <select
                className="form-select form-select-sm"
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

          {/* Keyword list selector + submit */}
          <div className="pending-submit-row">
            <div className="keyword-list-group">
              <label className="manual-label">KEYWORD LIST</label>
              <div className="keyword-list-controls">
                <select
                  className="form-select form-select-sm"
                  value={selectedSharedSetId}
                  onChange={e => setSelectedSharedSetId(e.target.value)}
                >
                  {sharedSets.length === 0 && (
                    <option value="">No lists available</option>
                  )}
                  {sharedSets.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <button
                  className="btn btn-primary btn-submit-kw"
                  disabled={selectedCount === 0 || !selectedSharedSetId}
                  onClick={onSubmitNegatives}
                >
                  Submit {selectedCount > 0 ? `${selectedCount} ` : ''}keywords to Google Ads →
                </button>
              </div>
            </div>
          </div>

        </div>
    </>
  )
}
