import React, { useState } from 'react'

function formatLastScanned(date) {
  if (!date) return null
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) +
    ' at ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export default function AIPanel({
  currentClientId,
  websiteUrl,
  setWebsiteUrl,
  onSaveWebsiteUrl,
  aiStats,
  aiLoading,
  lastScannedAt,
  onRescan,
}) {
  const [showSpecificPage, setShowSpecificPage] = useState(false)
  const [specificPageUrl, setSpecificPageUrl] = useState('')
  const [editingWebsiteUrl, setEditingWebsiteUrl] = useState(false)
  const [editWebsiteUrlValue, setEditWebsiteUrlValue] = useState('')
  const [aiAnalysisExpanded, setAiAnalysisExpanded] = useState(false)

  return (
    <>
      <div className="dashboard-summary-card">
      <div className="ai-scanner-shell">
      {/* Negative keyword scanner box */}
      <div className="ai-scanner-box mb-2">
        <div className="ai-scanner-top-row">
          <div className="ai-scanner-text">
            <div className="ai-scanner-title">Negative Keyword Scanner</div>
            <p className="ai-scanner-desc">
              Go through the negatives, select and submit directly to Google Ads.
            </p>
            {aiStats?.websiteContextStatus === 'unreadable' && (
              <div className="ai-url-unreadable-banner" role="alert">
                <div className="ai-url-unreadable-title">
                  <i className="fas fa-shield-alt ai-url-unreadable-icon" aria-hidden />
                  Homepage blocked automated scan
                </div>
                <p className="ai-url-unreadable-detail">
                  {aiStats.websiteFetchDetail
                    ? `${aiStats.websiteFetchDetail} Suggestions below use only your search terms—not page content.`
                    : 'We could not read this homepage from our server (blocking, 404/403, SSL, or timeout). Suggestions below use only your search terms—not page content.'}
                </p>
                <p className="ai-url-unreadable-hint">
                  The URL may still open in your browser. Confirm it is correct, try <strong>Scan a specific page</strong> if another path is less protected, or continue reviewing search-term-only suggestions below.
                </p>
              </div>
            )}
            <div className="ai-website-specific-row">
              {/* Website URL display / edit */}
              <div className="ai-website-url-row">
                {editingWebsiteUrl ? (
                  <div className="ai-website-url-edit">
                    <input
                      type="url"
                      className="form-control form-control-sm"
                      value={editWebsiteUrlValue}
                      onChange={e => setEditWebsiteUrlValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          const v = editWebsiteUrlValue.trim()
                          if (v) { setWebsiteUrl(v); if (onSaveWebsiteUrl) onSaveWebsiteUrl(v) }
                          setEditingWebsiteUrl(false)
                        }
                        if (e.key === 'Escape') setEditingWebsiteUrl(false)
                      }}
                      autoFocus
                      style={{ width: 320 }}
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={!editWebsiteUrlValue.trim()}
                      onClick={() => {
                        const v = editWebsiteUrlValue.trim()
                        if (v) { setWebsiteUrl(v); if (onSaveWebsiteUrl) onSaveWebsiteUrl(v) }
                        setEditingWebsiteUrl(false)
                      }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-secondary"
                      onClick={() => setEditingWebsiteUrl(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="ai-website-url-display">
                    <span className="ai-website-url-label">Website:</span>
                    {websiteUrl
                      ? (
                        <a
                          className="ai-website-url-link"
                          href={websiteUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={websiteUrl}
                        >
                          {websiteUrl}
                        </a>
                      )
                      : <span className="ai-website-url-empty">Not set</span>
                    }
                    <button
                      type="button"
                      className="btn-edit-url"
                      title="Edit website URL"
                      onClick={() => { setEditWebsiteUrlValue(websiteUrl || ''); setEditingWebsiteUrl(true) }}
                    >
                      <i className="fas fa-pencil-alt" />
                    </button>
                  </div>
                )}
              </div>
              {!editingWebsiteUrl && (
                <button
                  type="button"
                  className="ai-specific-toggle ai-specific-toggle-inline"
                  onClick={() => {
                    const next = !showSpecificPage
                    setShowSpecificPage(next)
                    if (next && !specificPageUrl) setSpecificPageUrl(websiteUrl || '')
                  }}
                >
                  <i className={`fas fa-chevron-${showSpecificPage ? 'down' : 'right'} me-1`} />
                  Scan a specific page instead
                </button>
              )}
            </div>
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

        {showSpecificPage && (
          <div className="ai-specific-inputs-row">
            <div className="ai-specific-inputs">
              <input
                type="url"
                className="form-control form-control-sm"
                placeholder="https://example.com/page"
                value={specificPageUrl}
                onChange={e => setSpecificPageUrl(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-outline-primary btn-sm"
                disabled={!specificPageUrl.trim() || aiLoading}
                onClick={() => onRescan(specificPageUrl.trim())}
              >
                Scan page
              </button>
            </div>
          </div>
        )}

        {/* Stats row (shown after AI scan) */}
        {aiStats !== null && aiStats.totalSearchTerms !== undefined && (
          <div className="ai-stats-row">
            <div className="ai-stat-block">
              <div className="ai-stat-value">
                {aiStats.totalSearchTermsInAccount != null &&
                Number(aiStats.totalSearchTermsInAccount) > Number(aiStats.totalSearchTerms)
                  ? `${aiStats.totalSearchTerms} of ${aiStats.totalSearchTermsInAccount}`
                  : aiStats.totalSearchTerms}
              </div>
              <div className="ai-stat-label">
                {aiStats.totalSearchTermsInAccount != null &&
                Number(aiStats.totalSearchTermsInAccount) > Number(aiStats.totalSearchTerms)
                  ? 'Terms analyzed (top by clicks)'
                  : 'Total search terms'}
              </div>
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

        {/* AI Analysis — collapsible panel */}
        {aiStats && aiStats.explanation && (
          <div className="ai-analysis-section">
            <button
              type="button"
              className="ai-analysis-toggle"
              aria-expanded={aiAnalysisExpanded}
              onClick={() => setAiAnalysisExpanded(v => !v)}
            >
              {aiAnalysisExpanded ? '− Hide AI analysis' : '+ Show AI analysis'}
            </button>
            {aiAnalysisExpanded && (
              <div className="ai-analysis-panel">
                <p className="ai-analysis-paragraph">
                  <span className="ai-analysis-emoji" aria-hidden>🤖 </span>
                  <strong className="ai-analysis-label">AI analysis:</strong>{' '}
                  <span className="ai-analysis-body">{aiStats.explanation}</span>
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      </div>
      </div>
    </>
  )
}
