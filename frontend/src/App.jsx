import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Routes, Route, useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import Select from 'react-select'
import { getDefaultDates, escapeRegex, googleNegativeMatchesSearchQuery } from './utils'
import SearchTermsTable from './SearchTermsTable'
import AIPanel from './AIPanel'
import AIScanTablePlaceholder from './components/AIScanTablePlaceholder'
import AuthPage from './components/AuthPage'
import AdminPanel from './components/AdminPanel'
import PublicReviewPage from './components/PublicReviewPage'
import StrategistConfirmPage from './components/StrategistConfirmPage'

// Authentication check
function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('authToken');
    const savedUser = localStorage.getItem('user');
    
    if (token && savedUser) {
      // Verify token is still valid
      fetch('/api/auth/me', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
      .then(response => {
        if (response.ok) {
          setUser(JSON.parse(savedUser));
        } else {
          // Token invalid, clear it
          localStorage.removeItem('authToken');
          localStorage.removeItem('user');
        }
      })
      .catch(() => {
        // Network error or token invalid
        localStorage.removeItem('authToken');
        localStorage.removeItem('user');
      })
      .finally(() => {
        setLoading(false);
      });
    } else {
      setLoading(false);
    }
  }, []);

  const logout = () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('user');
    setUser(null);
  };

  return { user, loading, logout };
}

// Add authentication header to fetch requests
const authenticatedFetch = (url, options = {}) => {
  const token = localStorage.getItem('authToken');
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    }
  });
};

/** Server may scrape pages + Bedrock — cap wait so a dead 404/host never locks the analyser spinner. */
const AI_RECOMMEND_TIMEOUT_MS = 150000

function aiRecommendAbortSignal() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(AI_RECOMMEND_TIMEOUT_MS)
  }
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), AI_RECOMMEND_TIMEOUT_MS)
  return ctrl.signal
}

function isAiRequestTimeoutAbort(err) {
  const n = err?.name
  return n === 'AbortError' || n === 'TimeoutError'
}

async function postAiRecommendNegatives(payload) {
  let r
  try {
    r = await authenticatedFetch('/api/ai-recommend-negatives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: aiRecommendAbortSignal(),
    })
  } catch (err) {
    if (isAiRequestTimeoutAbort(err)) {
      throw new Error(
        'AI scan timed out. The client site may be down, very slow to load, or the model took too long. Try Re-scan, fix the URL, or continue without AI.',
      )
    }
    throw new Error(err.message || 'Could not reach the AI scan server.')
  }
  if (!r.ok) {
    let msg = `AI scan failed (${r.status})`
    try {
      const d = await r.json()
      msg = d.details || d.error || msg
    } catch {
      /* keep msg */
    }
    throw new Error(msg)
  }
  return r.json()
}

/**
 * Load `client_pending_state` for a Google Ads customer id.
 * Requires r.ok + JSON array — error bodies like `{ error }` are ignored (previously broke restore).
 * Retries digits-only id when the first query returns [] (rows may have been saved under a different id shape).
 */
/** Prefer digits-only Google customer id for `client_pending_state` keys (matches list/search APIs). */
function canonicalPendingStateClientId(clientId) {
  const digits = String(clientId ?? '').replace(/\D/g, '')
  return digits.length >= 6 ? digits : String(clientId ?? '').trim()
}

async function fetchPendingStateForClient(clientId) {
  const raw = String(clientId ?? '').trim()
  const canonical = canonicalPendingStateClientId(clientId)
  const candidates = [...new Set([canonical, raw].filter(Boolean))]
  for (let i = 0; i < candidates.length; i++) {
    const cid = candidates[i]
    try {
      const r = await authenticatedFetch(`/api/pending-state?clientId=${encodeURIComponent(cid)}`)
      const data = await r.json().catch(() => null)
      if (!r.ok || !Array.isArray(data)) continue
      if (data.length > 0) return data
      if (i === candidates.length - 1) return data
    } catch {
      /* try next candidate */
    }
  }
  return []
}

async function saveDefaultSharedSetForClient(clientId, sharedSetId) {
  const r = await authenticatedFetch('/api/client-default-shared-set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      sharedSetId: sharedSetId != null && sharedSetId !== '' ? String(sharedSetId) : null,
    }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.details || d.error || 'Failed to save default keyword list')
  return d
}

// Default for new inferred / AI recommendations (rows & bulk controls use Phrase).
function inferMatchType(_kw) {
  return 'PHRASE'
}

// Default placement: negative keyword list; callers can override (e.g. row flag → campaign/ad group).
function inferKeywordDestination(kw, _terms) {
  const matchType = inferMatchType(kw)
  return {
    campaignId: null,
    campaignName: null,
    adGroupId: null,
    adGroupName: null,
    destination: 'NEGATIVE_LIST',
    matchType,
  }
}

/** AI suggestions default to phrase + keyword list; match type may be changed in the UI. */
function normalizeAiPendingItem(item, defaultSharedSetId) {
  if (!item || item.source !== 'ai') return item
  const base = {
    ...item,
    destination: 'NEGATIVE_LIST',
    campaignId: null,
    campaignName: null,
    adGroupId: null,
    adGroupName: null,
  }
  if (defaultSharedSetId && !base.sharedSetId) {
    return { ...base, sharedSetId: defaultSharedSetId }
  }
  return base
}

const PENDING_DESTINATIONS = new Set(['NEGATIVE_LIST', 'CAMPAIGN', 'ADGROUP'])

/** Round-trip persisted fields after load so selects and submit logic match React state shapes. */
function mapRestoredPendingItem(item, defaultSharedSetId) {
  if (!item) return item
  const dest = PENDING_DESTINATIONS.has(item.destination) ? item.destination : 'NEGATIVE_LIST'
  const mt = (item.matchType || 'PHRASE').toString().toUpperCase()
  let sharedSetId = null
  let campaignId = null
  let campaignName = null
  let adGroupId = null
  let adGroupName = null
  if (dest === 'NEGATIVE_LIST') {
    if (item.sharedSetId != null && item.sharedSetId !== '') sharedSetId = String(item.sharedSetId)
    else if (defaultSharedSetId != null && defaultSharedSetId !== '')
      sharedSetId = String(defaultSharedSetId)
  } else {
    campaignId = item.campaignId != null ? String(item.campaignId) : null
    campaignName = item.campaignName ?? null
  }
  if (dest === 'ADGROUP') {
    adGroupId = item.adGroupId != null ? String(item.adGroupId) : null
    adGroupName = item.adGroupName ?? null
  }

  return {
    ...item,
    keyword: String(item.keyword || '').trim(),
    matchType: mt,
    destination: dest,
    sharedSetId: dest === 'NEGATIVE_LIST' ? sharedSetId : null,
    source: item.source === 'ai' ? 'ai' : 'manual',
    selected: item.selected !== false,
    campaignId: dest === 'NEGATIVE_LIST' ? null : campaignId,
    campaignName: dest === 'NEGATIVE_LIST' ? null : campaignName,
    adGroupId: dest === 'ADGROUP' ? adGroupId : null,
    adGroupName: dest === 'ADGROUP' ? adGroupName : null,
  }
}

/** Send only persisted columns with stable types so saves match DB and restore cleanly. */
function serializePendingItemsForPersist(items) {
  const serialized = (items || [])
    .filter(i => i && typeof i.keyword === 'string' && i.keyword.trim() && !i.alreadyInGoogle)
    .map(i => {
      const dest = PENDING_DESTINATIONS.has(i.destination) ? i.destination : 'NEGATIVE_LIST'
      const mt = (i.matchType || 'PHRASE').toString().toUpperCase()
      let sharedSetId = null
      let campaignId = null
      let campaignName = null
      let adGroupId = null
      let adGroupName = null
      if (dest === 'NEGATIVE_LIST') {
        if (i.sharedSetId != null && i.sharedSetId !== '') sharedSetId = String(i.sharedSetId)
      } else {
        campaignId = i.campaignId != null ? String(i.campaignId) : null
        campaignName = i.campaignName ?? null
      }
      if (dest === 'ADGROUP') {
        adGroupId = i.adGroupId != null ? String(i.adGroupId) : null
        adGroupName = i.adGroupName ?? null
      }

      return {
        keyword: String(i.keyword || '').trim(),
        matchType: mt,
        destination: dest,
        sharedSetId: dest === 'NEGATIVE_LIST' ? sharedSetId : null,
        source: i.source === 'ai' ? 'ai' : 'manual',
        selected: i.selected !== false,
        campaignId: dest === 'NEGATIVE_LIST' ? null : campaignId,
        campaignName: dest === 'NEGATIVE_LIST' ? null : campaignName,
        adGroupId: dest === 'ADGROUP' ? adGroupId : null,
        adGroupName: dest === 'ADGROUP' ? adGroupName : null,
      }
    })
  // DB key is (client_id, keyword, match_type); dedupe to avoid PK collisions.
  const seen = new Set()
  return serialized.filter(i => {
    const key = `${String(i.keyword || '').trim().toLowerCase()}::${String(i.matchType || 'PHRASE').toUpperCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeGoogleNegativeKeyword(entry) {
  if (typeof entry === 'string') return entry.trim().toLowerCase()
  return String(entry?.keyword || '').trim().toLowerCase()
}

function isKeywordInGoogle(keyword, googleNegatives) {
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw || !Array.isArray(googleNegatives)) return false
  return googleNegatives.some(entry => normalizeGoogleNegativeKeyword(entry) === kw)
}

function isKeywordMatchTypeInGoogle(keyword, matchType, googleNegatives) {
  const mt = (matchType || 'EXACT').toString().toUpperCase()
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return false
  return (googleNegatives || []).some(existing => {
    if (typeof existing === 'string') {
      return existing.trim().toLowerCase() === kw && mt === 'EXACT'
    }
    const emt = (existing.matchType || 'EXACT').toString().toUpperCase()
    return normalizeGoogleNegativeKeyword(existing) === kw && emt === mt
  })
}

function filterPendingNotInGoogle(items, googleNegatives) {
  return (items || []).filter(item => {
    if (!item?.keyword?.trim()) return false
    return !isKeywordInGoogle(item.keyword, googleNegatives)
  })
}

function formatSubmissionAppliedTo(item, sharedSets) {
  const dest = item.destination || 'NEGATIVE_LIST'
  if (dest === 'NEGATIVE_LIST') {
    const listName = (sharedSets || []).find(s => String(s.id) === String(item.sharedSetId || ''))?.name
    if (listName) return `Keyword list: ${listName}`
    if (item.sharedSetId) return `Keyword list: ${item.sharedSetId}`
    return 'Keyword list'
  }
  if (dest === 'CAMPAIGN') {
    const label = item.campaignName || item.campaignId
    return label ? `Campaign: ${label}` : 'Campaign'
  }
  if (dest === 'ADGROUP') {
    const ag = item.adGroupName || item.adGroupId
    const camp = item.campaignName ? ` (${item.campaignName})` : ''
    return ag ? `Ad group: ${ag}${camp}` : 'Ad group'
  }
  return ''
}

function computeSubmissionQualityPercentage(aiStats, pendingNegatives) {
  if (!aiStats || aiStats.totalSearchTerms === undefined) return null
  const total = aiStats.totalSearchTerms
  const recommended = (pendingNegatives || []).filter(i => i.source === 'ai' && !i.alreadyInGoogle).length
  if (total <= 0) return 100
  return Math.min(100, Math.max(0, Math.round(((total - recommended) / total) * 100)))
}

function buildAiPendingRow(kw, sourcesMap, googleNegatives, defaultSharedSetId) {
  if (isKeywordInGoogle(kw, googleNegatives)) return null
  const matchType = 'PHRASE'
  return {
    keyword: kw,
    matchType,
    source: 'ai',
    sourceSearchTerms: sourcesMap[kw] || [],
    selected: true,
    destination: 'NEGATIVE_LIST',
    sharedSetId: defaultSharedSetId ?? null,
    campaignId: null,
    campaignName: null,
    adGroupId: null,
    adGroupName: null,
  }
}

function HomePage({ onNavigate, user }) {
  return (
    <div className="home-page">
      <img src="/assets/main.png" alt="Google Ads AI Management Tools" className="home-main-img" />
      <p className="home-subheading">Choose a tool to get started</p>
      <div className="home-tools">
        <button
          className="home-tool-card"
          onClick={() => onNavigate('/negative-keywords')}
        >
          <div className="home-tool-icon">
            <img src="/assets/logo.png" alt="Negative Keywords" />
          </div>
          <div className="home-tool-info">
            <span className="home-tool-name">Negative Keywords</span>
            <span className="home-tool-desc">
              Scan your site with AI, review search terms, and push negative keywords straight to Google Ads.
            </span>
          </div>
          <i className="fas fa-arrow-right home-tool-arrow" />
        </button>
        {user && user.isSuperUser && (
          <button
            className="home-tool-card"
            onClick={() => onNavigate('/admin')}
          >
            <div className="home-tool-icon">
              <i className="fas fa-users-cog" style={{ fontSize: '2rem', color: '#667eea' }}></i>
            </div>
            <div className="home-tool-info">
              <span className="home-tool-name">User Administration</span>
              <span className="home-tool-desc">
                Approve new users and manage access permissions for the application.
              </span>
            </div>
            <i className="fas fa-arrow-right home-tool-arrow" />
          </button>
        )}
      </div>
    </div>
  )
}

function NegativeKeywordsPage({
  user,
  onLogout,
  clients,
  currentClientId,
  onClientChange,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  today,
  onDateRangeSubmit,
  websiteUrl,
  setWebsiteUrl,
  aiStats,
  aiLoading,
  searchTerms,
  campaigns,
  adGroupsByCampaign,
  pendingNegatives,
  setPendingNegatives,
  sharedSets,
  setSharedSets,
  selectedSharedSetId,
  setSelectedSharedSetId,
  lastScannedAt,
  onRescan,
  onCreateSharedSet,
  onAddManualNegative,
  onRemoveNegative,
  onRemoveGoogleNegative,
  onSubmitNegatives,
  submitSuccess,
  setSubmitSuccess,
  submitError,
  setSubmitError,
  manualAddSuccess,
  manualAddError,
  submissionHistory,
  rowNegatives,
  error,
  loading,
  showUrlPopup,
  tempWebsiteUrl,
  setTempWebsiteUrl,
  urlPopupLoading,
  handleSaveWebsiteUrl,
  handleSkipWebsiteUrl,
  existingNegatives,
  onSaveWork,
  onClearWork,
  reviewLinkError = '',
  onCreateReviewRequest,
  onSaveDefaultSharedSet,
  savedWorkRestoreNotice = null,
  onDismissSavedWorkRestoreNotice,
  searchTermsEmptyReason = '',
  highVolumeModal = null,
  onHighVolumeConfirm,
  onHighVolumeCancel,
}) {
  const location = useLocation()
  const clientName = currentClientId
    ? (clients.find(c => c.customerId === currentClientId)?.descriptiveName || currentClientId)
    : ''

  const showClientIntro =
    !currentClientId && !reviewLinkError && location.pathname !== '/review'
  const showReviewConnecting =
    location.pathname === '/review' && !currentClientId && !reviewLinkError && !loading
  const isReviewMode = location.pathname === '/review'
  const showNoTermsEmpty =
    !!currentClientId &&
    !loading &&
    !error &&
    searchTerms.length === 0 &&
    !aiLoading &&
    !reviewLinkError

  return (
    <>
      <header className="sticky-header">
        <div className="header-inner">
          <div className="header-brand">
            <span className="header-title">Google Ads — Negative Keyword Tool</span>
          </div>
          <div className="header-controls">
            <div className="header-control-group">
              <label className="header-control-label">CLIENT ACCOUNT</label>
              <Select
                options={clients.map(c => ({
                  value: c.customerId,
                  label: c.descriptiveName || c.customerId,
                }))}
                value={
                  currentClientId
                    ? { value: currentClientId, label: clients.find(c => c.customerId === currentClientId)?.descriptiveName || currentClientId }
                    : null
                }
                onChange={opt => onClientChange(opt ? opt.value : '')}
                onKeyDown={e => {
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation()
                }}
                placeholder="Select a client"
                isClearable
                isSearchable
                styles={{
                  container: base => ({ ...base, minWidth: 200 }),
                  control: base => ({
                    ...base,
                    minHeight: 31,
                    height: 31,
                    fontSize: '0.875rem',
                    borderColor: '#dee2e6',
                    boxShadow: 'none',
                    '&:hover': { borderColor: '#86b7fe' },
                  }),
                  valueContainer: base => ({ ...base, padding: '0 8px' }),
                  indicatorsContainer: base => ({ ...base, height: 31 }),
                  dropdownIndicator: base => ({ ...base, padding: '0 6px' }),
                  clearIndicator: base => ({ ...base, padding: '0 6px' }),
                  menu: base => ({ ...base, fontSize: '0.875rem', zIndex: 9999 }),
                }}
              />
            </div>
            <div className="header-control-group">
              <label className="header-control-label">DATE RANGE</label>
              <div className="header-date-row">
                <input
                  type="date"
                  className="form-control form-control-sm"
                  value={startDate}
                  max={endDate || today}
                  onChange={e => onStartDateChange(e.target.value)}
                  style={{ width: 130 }}
                />
                <span className="date-sep">to</span>
                <input
                  type="date"
                  className="form-control form-control-sm"
                  value={endDate}
                  min={startDate}
                  max={today}
                  onChange={e => onEndDateChange(e.target.value)}
                  style={{ width: 130 }}
                />
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!currentClientId}
                  onClick={onDateRangeSubmit}
                >
                  Apply
                </button>
              </div>
            </div>
            <div className="header-divider"></div>
            <div className="header-control-group">
              <div className="user-dropdown">
                <button className="user-dropdown-toggle" type="button">
                  <div className="user-avatar">
                    <i className="fas fa-user"></i>
                  </div>
                  <i className="fas fa-chevron-down user-dropdown-arrow"></i>
                </button>
                <div className="user-dropdown-menu">
                  <div className="user-dropdown-header">
                    <div className="user-info">
                      <div className="user-name">{user.name || 'User'}</div>
                      <div className="user-email">{user.email}</div>
                    </div>
                  </div>
                  <div className="user-dropdown-divider"></div>
                  {user.isSuperUser && (
                    <>
                      <button 
                        className="user-dropdown-item admin-btn" 
                        onClick={() => window.location.href = '/admin'}
                      >
                        <i className="fas fa-users-cog"></i>
                        <span>User Management</span>
                      </button>
                      <div className="user-dropdown-divider"></div>
                    </>
                  )}
                  <button className="user-dropdown-item logout-btn" onClick={onLogout}>
                    <i className="fas fa-sign-out-alt"></i>
                    <span>Logout</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div
        className={`app-wrapper page-negative-keywords${currentClientId ? ' page-negative-keywords--has-client' : ''}`}
      >
        {reviewLinkError ? (
          <div className="alert alert-warning mb-3" role="alert">{reviewLinkError}</div>
        ) : null}

        {showClientIntro ? (
          <div className="negative-kw-intro-sole">
            <div className="negative-kw-intro-side-inner">
              <span className="negative-kw-intro-badge">Get started</span>
              <h2 id="negative-kw-intro-heading" className="negative-kw-intro-title">
                Select a Google Ads account
              </h2>
              <p className="negative-kw-intro-lede">
                We’ll load recent search terms, run the AI scanner against your site, and show a review table where
                you can send negatives straight to Google Ads. The <strong>Negative Keyword Scanner</strong> appears
                after you choose a client.
              </p>
              <ol className="negative-kw-intro-steps">
                <li>
                  <i className="fas fa-mouse-pointer negative-kw-intro-step-icon" aria-hidden />
                  Use <strong>Client account</strong> in the header to pick an MCC-linked client.
                </li>
                <li>
                  <i className="fas fa-calendar-alt negative-kw-intro-step-icon" aria-hidden />
                  Adjust the <strong>date range</strong> if needed, then click <strong>Apply</strong>.
                </li>
                <li>
                  <i className="fas fa-robot negative-kw-intro-step-icon" aria-hidden />
                  Use the scanner to confirm your <strong>website URL</strong> and run AI, then review suggestions in the
                  table.
                </li>
              </ol>
            </div>
          </div>
        ) : (
          <>
            {savedWorkRestoreNotice ? (
              <div className="saved-work-restore-banner" role="status">
                <i className="fas fa-history saved-work-restore-icon" aria-hidden />
                <span className="saved-work-restore-text">
                  Restored{' '}
                  <strong>{savedWorkRestoreNotice.count}</strong>{' '}
                  saved pending keyword{savedWorkRestoreNotice.count === 1 ? '' : 's'} from{' '}
                  {savedWorkRestoreNotice.clientName ? (
                    <>
                      your last session for <strong>{savedWorkRestoreNotice.clientName}</strong>
                    </>
                  ) : (
                    'your last session'
                  )}
                  .
                  {savedWorkRestoreNotice.skippedAutoAiScan ? (
                    <> Automatic AI scan was skipped so this list stays as you saved it. Use Re-scan for new suggestions.</>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="saved-work-restore-dismiss"
                  onClick={() =>
                    onDismissSavedWorkRestoreNotice && onDismissSavedWorkRestoreNotice()
                  }
                >
                  Dismiss
                </button>
              </div>
            ) : null}
            {!isReviewMode && (
              <AIPanel
                currentClientId={currentClientId}
                websiteUrl={websiteUrl}
                setWebsiteUrl={setWebsiteUrl}
                onSaveWebsiteUrl={async (url) => {
                  if (!currentClientId) return
                  try {
                    await authenticatedFetch('/api/client-website-url', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ clientId: currentClientId, websiteUrl: url }),
                    })
                  } catch (err) {
                    console.error('Failed to save website URL:', err)
                  }
                }}
                aiStats={aiStats}
                aiLoading={aiLoading}
                lastScannedAt={lastScannedAt}
                onRescan={onRescan}
              />
            )}
          </>
        )}

        {showReviewConnecting ? (
          <div className="negative-kw-review-connecting" role="status">
            <div className="spinner-border text-primary spinner-border-sm me-2" aria-hidden />
            Opening shared review link…
          </div>
        ) : null}

        {error && <div className="alert alert-danger mx-0 mb-3">{error}</div>}

        {loading && (
          <div className="text-center p-4">
            <div className="spinner-border text-primary" role="status">
              <span className="visually-hidden">Loading…</span>
            </div>
            <p className="mt-2 text-muted">Loading data…</p>
          </div>
        )}

        {!loading && searchTerms.length > 0 && aiLoading && (
          <AIScanTablePlaceholder clientName={clientName} />
        )}

        {showNoTermsEmpty ? (
          <div className="negative-kw-empty-terms" role="region" aria-label="No search terms">
            <div className="negative-kw-empty-terms-inner">
              <i className="fas fa-search negative-kw-empty-terms-icon" aria-hidden />
              <h3 className="negative-kw-empty-terms-title">
                {searchTermsEmptyReason === 'no_clicks_only'
                  ? 'No clicked search terms found for this date range'
                  : 'No search terms in this range'}
              </h3>
              <p className="negative-kw-empty-terms-copy">
                {searchTermsEmptyReason === 'no_clicks_only' ? (
                  <>
                    We found search terms for this account in the selected period, but none of them received clicks.
                    Because this view currently shows only search terms with at least one click, the table is empty.
                    Try expanding the date range, or enable 0-click terms if you want to review all search queries.
                  </>
                ) : (
                  <>
                    Try a wider date range with <strong>Apply</strong>, or verify this account has search term data for
                    the selected period.
                  </>
                )}
              </p>
            </div>
          </div>
        ) : null}

        {!loading && searchTerms.length > 0 && !aiLoading && (
          <SearchTermsTable
            searchTerms={searchTerms}
            rowNegatives={rowNegatives}
            onAddNegative={onAddManualNegative}
            onRemoveNegative={onRemoveNegative}
            onRemoveGoogleNegative={onRemoveGoogleNegative}
            existingNegatives={existingNegatives}
            pendingNegatives={pendingNegatives}
            setPendingNegatives={setPendingNegatives}
            campaigns={campaigns}
            adGroupsByCampaign={adGroupsByCampaign}
            sharedSets={sharedSets}
            onCreateSharedSet={onCreateSharedSet}
            onSubmitNegatives={onSubmitNegatives}
            submissionHistory={submissionHistory}
            clientName={clientName}
            submitSuccess={submitSuccess}
            setSubmitSuccess={setSubmitSuccess}
            submitError={submitError}
            setSubmitError={setSubmitError}
            manualAddSuccess={manualAddSuccess}
            manualAddError={manualAddError}
            onSaveWork={onSaveWork}
            onClearWork={onClearWork}
            approvalClientId={currentClientId}
            onCreateReviewRequest={onCreateReviewRequest}
            defaultSharedSetId={selectedSharedSetId}
            onSaveDefaultSharedSet={onSaveDefaultSharedSet}
            isReviewMode={isReviewMode}
          />
        )}
      </div>

      {/* High-volume search terms warning (before full Google pull) */}
      {highVolumeModal && (
        <div
          className="website-url-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="high-volume-modal-title"
          onClick={e => e.target === e.currentTarget && onHighVolumeCancel?.()}
        >
          <div className="website-url-modal-box" onClick={e => e.stopPropagation()}>
            <div className="website-url-modal-header">
              <h3 id="high-volume-modal-title" className="website-url-modal-title">
                Large search terms report
              </h3>
            </div>
            <div className="website-url-modal-body">
              <p className="mb-2">
                <strong>Date range:</strong>{' '}
                <span className="text-muted">
                  {highVolumeModal.startDate} — {highVolumeModal.endDate}
                </span>
              </p>
              <p className="mb-2">
                A quick preview found <strong>{highVolumeModal.rowCount}</strong> search-term row
                {highVolumeModal.rowCount === 1 ? '' : 's'} with clicks in the sample (there may be
                more). This range likely reaches <strong>{highVolumeModal.threshold}+</strong>{' '}
                rows.
              </p>
              <p className="mb-0">
                If you continue, the app loads up to <strong>{highVolumeModal.mergeCap}</strong>{' '}
                search-term rows with the most clicks in this range. Additional rows in Google Ads
                are not loaded.
              </p>
            </div>
            <div className="website-url-modal-footer">
              <button type="button" className="btn btn-outline-secondary" onClick={() => onHighVolumeCancel?.()}>
                Go back
              </button>
              <button type="button" className="btn btn-primary" onClick={() => onHighVolumeConfirm?.()}>
                Load anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Website URL Popup */}
      {showUrlPopup && (
        <div className="website-url-modal-backdrop">
          <div className="website-url-modal-box">
            <div className="website-url-modal-header">
              <h3 className="website-url-modal-title">Website URL Required</h3>
            </div>
            <div className="website-url-modal-body">
              <p>
                We couldn't automatically detect your website URL from Google Ads. 
                To analyze your search terms with AI, please enter your website URL below:
              </p>
              <div className="website-url-input-group">
                <label className="website-url-label">Website URL</label>
                <input
                  type="url"
                  className="form-control"
                  placeholder="https://yourwebsite.com"
                  value={tempWebsiteUrl}
                  onChange={e => setTempWebsiteUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSaveWebsiteUrl()}
                  autoFocus
                />
              </div>
            </div>
            <div className="website-url-modal-footer">
              <button
                className="btn btn-outline-secondary"
                onClick={handleSkipWebsiteUrl}
                disabled={urlPopupLoading}
              >
                Skip for now
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSaveWebsiteUrl}
                disabled={!tempWebsiteUrl.trim() || urlPopupLoading}
              >
                {urlPopupLoading ? 'Saving...' : 'Save & Scan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default function App() {
  const { user, loading, logout } = useAuth();
  const location = useLocation();

  // Public review page (`/review-public?t=...`) renders outside the auth gate
  // so clients can review without an account.
  if (location.pathname === '/review-public') {
    return (
      <Routes>
        <Route path="/review-public" element={<PublicReviewPage />} />
      </Routes>
    );
  }

  // If still checking authentication, show loading
  if (loading) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
      }}>
        <div style={{ 
          background: 'white', 
          padding: '40px', 
          borderRadius: '12px',
          textAlign: 'center'
        }}>
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading...</span>
          </div>
          <p style={{ marginTop: '20px', color: '#666' }}>Checking authentication...</p>
        </div>
      </div>
    );
  }

  // If not authenticated, show login page
  if (!user) {
    return <AuthPage />;
  }

  // If authenticated, show the main app
  return <AuthenticatedApp user={user} onLogout={logout} />;
}

function AuthenticatedApp({ user, onLogout }) {
  const { startDate: defaultStart, endDate: defaultEnd } = getDefaultDates()
  
  const today = new Date().toISOString().split('T')[0]

  const navigate = useNavigate()
  const location = useLocation()
  const locationRef = useRef(location)
  locationRef.current = location
  const [searchParams] = useSearchParams()
  /** Cleared when leaving /review so the same query can hydrate again after navigation. */
  const reviewHandledSearchRef = useRef('')
  const [reviewLinkError, setReviewLinkError] = useState('')
  const handleClientChangeRef = useRef(async () => {})

  // Core data
  const [clients, setClients] = useState([])
  const [currentClientId, setCurrentClientId] = useState('')
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(defaultEnd)
  const [searchTerms, setSearchTerms] = useState([])
  const [searchTermsEmptyReason, setSearchTermsEmptyReason] = useState('')

  // Negative keywords
  const [existingNegatives, setExistingNegatives] = useState([])
  const [dbSavedNegatives, setDbSavedNegatives] = useState([])

  // Pending negatives: [{ keyword, matchType, source: 'ai'|'manual', selected }]
  const [pendingNegatives, setPendingNegatives] = useState([])

  // Shared sets (keyword lists) from Google Ads
  const [sharedSets, setSharedSets] = useState([])
  const [selectedSharedSetId, setSelectedSharedSetId] = useState('')

  // AI panel
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [aiStats, setAiStats] = useState(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [lastScannedAt, setLastScannedAt] = useState(null)

  // Submission history
  const [submissionHistory, setSubmissionHistory] = useState([])

  // UI
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [submitSuccess, setSubmitSuccess] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [manualAddSuccess, setManualAddSuccess] = useState('')
  const [manualAddError, setManualAddError] = useState('')
  const [savedWorkRestoreNotice, setSavedWorkRestoreNotice] = useState(null)

  const dismissSavedWorkRestoreNotice = useCallback(() => {
    setSavedWorkRestoreNotice(null)
  }, [])
  
  // Website URL popup
  const [showUrlPopup, setShowUrlPopup] = useState(false)
  const [pendingClientId, setPendingClientId] = useState('')
  const [tempWebsiteUrl, setTempWebsiteUrl] = useState('')
  const [urlPopupLoading, setUrlPopupLoading] = useState(false)
  /** When set, NegativeKeywordsPage shows the high-volume modal; resolver completes loadSearchTerms’ Promise. */
  const [highVolumeModal, setHighVolumeModal] = useState(null)
  const highVolumeResolveRef = useRef(null)

  const confirmHighVolumeLoad = useCallback(() => {
    setHighVolumeModal(null)
    const r = highVolumeResolveRef.current
    highVolumeResolveRef.current = null
    if (r) r(true)
  }, [])

  const cancelHighVolumeLoad = useCallback(() => {
    setHighVolumeModal(null)
    const r = highVolumeResolveRef.current
    highVolumeResolveRef.current = null
    if (r) r(false)
  }, [])

  useEffect(() => {
    if (!highVolumeModal) return
    const onKey = e => {
      if (e.key === 'Escape') cancelHighVolumeLoad()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [highVolumeModal, cancelHighVolumeLoad])

  // Campaigns derived from the already-client-scoped search terms data (guaranteed client-specific)
  const campaigns = useMemo(() => {
    const map = new Map()
    searchTerms.forEach(t => {
      if (t.campaignId && !map.has(t.campaignId)) {
        map.set(t.campaignId, { id: t.campaignId, name: t.campaign })
      }
    })
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [searchTerms])

  // Ad groups per campaign, derived from the same search terms data
  const adGroupsByCampaign = useMemo(() => {
    const map = {}
    searchTerms.forEach(t => {
      if (!t.campaignId || !t.adGroupId) return
      if (!map[t.campaignId]) map[t.campaignId] = new Map()
      if (!map[t.campaignId].has(t.adGroupId)) {
        map[t.campaignId].set(t.adGroupId, { id: t.adGroupId, name: t.adGroup })
      }
    })
    // Convert inner Maps to sorted arrays
    return Object.fromEntries(
      Object.entries(map).map(([cid, agMap]) => [
        cid,
        [...agMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      ])
    )
  }, [searchTerms])

  // rowNegatives: Map<searchTerm, Set<prefixed-phrase>>
  const rowNegatives = useMemo(() => {
    const map = new Map()

    // Only show a Google chip when the negative is actually in scope for this
    // row's campaign / ad group — matches what Google Ads actually applies.
    const negativeAppliesToRow = (neg, term) => {
      if (typeof neg === 'string') return false
      const cid = String(term.campaignId || '')
      const aid = String(term.adGroupId || '')
      if (neg.source === 'AD_GROUP')   return String(neg.adGroupId || '') === aid
      if (neg.source === 'CAMPAIGN')   return String(neg.campaignId || '') === cid
      if (neg.source === 'SHARED_SET') return (neg.appliedCampaignIds || []).map(String).includes(cid)
      return false
    }

    searchTerms.forEach(term => {
      const termStr = term.searchTerm
      const negatives = new Set()

      // Check existing Google negatives (text match AND scope match)
      existingNegatives.forEach(existing => {
        const matchType = typeof existing === 'string'
          ? 'EXACT'
          : convertMatchTypeToText(existing.matchType || 'EXACT')
        const originalKeyword = typeof existing === 'string' ? existing : existing.keyword
        if (
          googleNegativeMatchesSearchQuery(termStr, originalKeyword, matchType) &&
          negativeAppliesToRow(existing, term)
        ) {
          negatives.add(`google:${originalKeyword} (${matchType})`)
        }
      })

      // Check pending negatives
      pendingNegatives.forEach(item => {
        if (item.alreadyInGoogle) return
        const kwLower = item.keyword.toLowerCase()
        const escaped = escapeRegex(kwLower)
        const regex = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i')
        if (regex.test(termStr)) {
          const matchType = convertMatchTypeToText(item.matchType)
          negatives.add(`${item.source}:${item.keyword} (${matchType})`)
        }
      })

      if (negatives.size > 0) map.set(termStr, negatives)
    })

    return map
  }, [searchTerms, existingNegatives, pendingNegatives])

  // Load clients on mount
  useEffect(() => {
    authenticatedFetch('/api/clients')
      .then(r => r.json())
      .then(data => setClients(Array.isArray(data) ? data : []))
      .catch(err => setError('Error loading clients: ' + err.message))
  }, [])

  function resetState() {
    setSearchTerms([])
    setSearchTermsEmptyReason('')
    setExistingNegatives([])
    setDbSavedNegatives([])
    setPendingNegatives([])
    setSharedSets([])
    setSelectedSharedSetId('')
    setWebsiteUrl('')
    setAiStats(null)
    setLastScannedAt(null)
    setSubmissionHistory([])
    setSubmitSuccess('')
    setSubmitError('')
    setManualAddError('')
    setError('')
    setAiLoading(false)
    setSavedWorkRestoreNotice(null)
  }

  // Returns the loaded terms array so callers can use it for auto-scanning.
  // Returns null if the user cancels the high-volume confirmation.
  // skipPendingRestore: if true, skip the plain-keyword pendingNegatives init (rich state already restored)
  async function loadSearchTerms(
    clientId,
    start,
    end,
    googleNegs,
    dbNegs,
    skipPendingRestore = false,
    defaultSharedSetIdOverride = null,
    { skipHighVolumePreview = false } = {},
  ) {
    if (!clientId) { setError('Please select a client first'); return [] }
    if (!skipHighVolumePreview) {
      try {
        const q = new URLSearchParams({
          clientId: String(clientId),
          startDate: String(start),
          endDate: String(end),
        })
        const pr = await authenticatedFetch(`/api/search-terms-preview?${q}`)
        const preview = await pr.json().catch(() => ({}))
        if (pr.ok && preview.highVolume) {
          const thr = preview.threshold ?? 500
          const confirmed = await new Promise(resolve => {
            highVolumeResolveRef.current = resolve
            setHighVolumeModal({
              threshold: thr,
              rowCount: preview.rowCount,
              mergeCap: preview.mergeCap ?? 500,
              startDate: String(start),
              endDate: String(end),
            })
          })
          if (!confirmed) return null
        }
      } catch (e) {
        console.warn('search-terms preview failed:', e.message)
      }
    }
    setLoading(true)
    setError('')
    setSearchTermsEmptyReason('')
    try {
      const url = `/api/search-terms?clientId=${clientId}&startDate=${start}&endDate=${end}`;
      const r = await authenticatedFetch(url)
      if (!r.ok) {
        const d = await r.json()
        throw new Error(d.error || 'Failed to fetch data')
      }
      const data = await r.json()
      // Handle new response structure with searchTerms and summary
      const terms = data.searchTerms || data // Fallback for backward compatibility
      setSearchTerms(terms)
      setSearchTermsEmptyReason(data?.emptyReason || '')

      if (googleNegs !== undefined) setExistingNegatives(googleNegs)
      if (dbNegs !== undefined) {
        setDbSavedNegatives(dbNegs)
        if (!skipPendingRestore) {
          const googleNegLower = new Set((googleNegs || existingNegatives).map(k => 
            typeof k === 'string' ? k.toLowerCase() : k.keyword.toLowerCase()
          ))
          const pendingFromDb = dbNegs
            .filter(kw => !googleNegLower.has(kw.toLowerCase()))
            .map(kw => ({
              keyword: kw,
              matchType: 'PHRASE',
              source: 'manual',
              selected: true,
              destination: 'NEGATIVE_LIST',
              sharedSetId: defaultSharedSetIdOverride || selectedSharedSetId || null,
            }))
          setPendingNegatives(pendingFromDb)
        }
      }
      return terms
    } catch (err) {
      setError('Error loading data: ' + err.message)
      return []
    } finally {
      setLoading(false)
    }
  }

  async function handleClientChange(clientId) {
    setCurrentClientId(clientId)
    resetState()
    if (!clientId) {
      return
    }

    try {
      const [settingsRes, negRes, setsRes, historyRes, savedPendingState] = await Promise.all([
        authenticatedFetch(`/api/client-settings?clientId=${clientId}`).then(r => r.json()),
        authenticatedFetch(`/api/negative-keywords?clientId=${clientId}`).then(r => r.json()),
        authenticatedFetch(`/api/shared-sets?clientId=${clientId}`).then(r => r.json()),
        authenticatedFetch(`/api/submission-history?clientId=${clientId}`).then(r => r.json()),
        fetchPendingStateForClient(clientId),
      ])
      setSubmissionHistory(Array.isArray(historyRes) ? historyRes : [])

      const savedNegatives = settingsRes.savedNegatives || []
      const googleNegatives = negRes['Global Negative Keywords'] || []
      const sets = Array.isArray(setsRes) ? setsRes : []
      const configuredDefaultListId = settingsRes.defaultSharedSetId
      const hasConfiguredDefault =
        configuredDefaultListId != null &&
        sets.some(s => String(s.id) === String(configuredDefaultListId))
      const defaultListId = hasConfiguredDefault ? String(configuredDefaultListId) : sets[0]?.id ?? null

      setDbSavedNegatives(savedNegatives)
      setExistingNegatives(googleNegatives)
      setSharedSets(sets)
      setSelectedSharedSetId(defaultListId || '')

      const hasRestoredPendingFromDb = savedPendingState.length > 0
      let restoredFromDb = null

      // Restore rich pending state if it was saved, otherwise fall back to plain-keyword DB list
      if (hasRestoredPendingFromDb) {
        restoredFromDb = filterPendingNotInGoogle(
          savedPendingState.map(item => mapRestoredPendingItem(item, defaultListId)),
          googleNegatives,
        ).map(item => ({
            ...item,
            selected: item.selected !== false,
          }))
        setPendingNegatives(restoredFromDb)
        if (restoredFromDb.length !== savedPendingState.length) {
          const items = serializePendingItemsForPersist(restoredFromDb)
          void authenticatedFetch('/api/pending-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              clientId: canonicalPendingStateClientId(clientId),
              items,
            }),
          }).catch(console.error)
        }
      } else {
        setSavedWorkRestoreNotice(null)
      }

      // Determine website URL — await detection so we have it before scanning
      let urlToUse = settingsRes.websiteUrl || ''
      if (urlToUse) {
        setWebsiteUrl(urlToUse)
      } else {
        try {
          const d = await authenticatedFetch(`/api/detect-website?clientId=${clientId}`).then(r => r.json())
          if (d.websiteUrl) {
            urlToUse = d.websiteUrl
            setWebsiteUrl(d.websiteUrl)
          }
        } catch {}
      }

      const willAutoAi =
        locationRef.current.pathname !== '/review' &&
        !!String(urlToUse || '').trim() &&
        !hasRestoredPendingFromDb
      if (willAutoAi) {
        setAiLoading(true)
      }

      const terms = await loadSearchTerms(
        clientId,
        startDate,
        endDate,
        googleNegatives,
        savedNegatives,
        hasRestoredPendingFromDb,
        defaultListId,
      )
      if (terms === null) {
        setAiLoading(false)
        return
      }

      if (hasRestoredPendingFromDb && restoredFromDb) {
        setSavedWorkRestoreNotice({
          count: restoredFromDb.length,
          clientName:
            clients.find(c => String(c.customerId) === String(clientId))?.descriptiveName ||
            clientId ||
            '',
          skippedAutoAiScan:
            hasRestoredPendingFromDb &&
            locationRef.current.pathname !== '/review' &&
            !!String(urlToUse || '').trim() &&
            !!(terms && terms.length > 0),
        })
      }

      // If no website URL found and we have search terms, show popup to ask user
      if (!urlToUse && terms && terms.length > 0) {
        setPendingClientId(clientId)
        setShowUrlPopup(true)
        return
      }

      if (willAutoAi && (!terms || terms.length === 0)) {
        setAiLoading(false)
      }

      // Auto-scan immediately after loading — skip on /review; skip when DB had saved pending work
      if (willAutoAi && urlToUse && terms && terms.length > 0) {
        try {
          const result = await postAiRecommendNegatives({
            searchTerms: terms,
            websiteUrl: urlToUse.trim(),
            clientId,
          })
          handleAiResults(result)
          if (!result.scanSkippedDueToBadWebsiteUrl) {
            setLastScannedAt(new Date())
          }
        } catch (err) {
          console.error('Auto-scan failed:', err.message)
          setSubmitError(err.message || 'AI scan failed.')
        } finally {
          setAiLoading(false)
        }
      }
    } catch (err) {
      setError('Error loading client data: ' + err.message)
      setAiLoading(false)
    }
  }

  handleClientChangeRef.current = handleClientChange

  // /review?client=... — resolve Google Ads client by descriptive name or numeric ID; load same data as main tool (including DB pending state)
  useEffect(() => {
    if (location.pathname !== '/review') {
      reviewHandledSearchRef.current = ''
      setReviewLinkError('')
      return
    }
    const raw = searchParams.get('client')
    if (!raw || !String(raw).trim()) {
      reviewHandledSearchRef.current = ''
      setReviewLinkError(
        'This review link is missing a client. Use ?client=CUSTOMER_ID or ?client=Exact%20account%20name.',
      )
      return
    }
    if (!clients.length) return

    const searchKey = location.search
    if (reviewHandledSearchRef.current === searchKey) return

    let param
    try {
      param = decodeURIComponent(String(raw).trim())
    } catch {
      param = String(raw).trim()
    }

    const paramLower = param.toLowerCase()
    const paramDigits = param.replace(/\D/g, '')
    const byName = clients.find(c => (c.descriptiveName || '').trim().toLowerCase() === paramLower)
    const byId = paramDigits.length >= 6
      ? clients.find(c => String(c.customerId).replace(/\D/g, '') === paramDigits)
      : null
    const match = byName || byId

    if (!match) {
      reviewHandledSearchRef.current = ''
      setReviewLinkError(
        `No client matched "${param}". Ask the sender for a link with the numeric Google Ads customer ID, or the exact account name.`,
      )
      return
    }

    reviewHandledSearchRef.current = searchKey
    setReviewLinkError('')
    void handleClientChangeRef.current(match.customerId)
  }, [location.pathname, location.search, clients, searchParams])

  /**
   * Creates a public review request and (optionally) emails the client.
   * Replaces the previous `/api/send-approval-email` flow — the strategist now
   * confirms decisions via /review-confirm/:id before anything goes to Google Ads.
   */
  async function handleCreateReviewRequest(body) {
    const r = await authenticatedFetch('/api/review-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let data = {}
    try {
      data = await r.json()
    } catch {
      /* ignore */
    }
    if (!r.ok) {
      throw new Error(data.details || data.error || 'Failed to create review request')
    }
    return data
  }

  // Helper function to convert numeric match types to text
  function convertMatchTypeToText(matchType) {
    if (typeof matchType === 'string') return matchType;
    if (matchType === 2) return 'EXACT';
    if (matchType === 3) return 'PHRASE'; 
    if (matchType === 4) return 'BROAD';
    return 'EXACT'; // default
  }

  function handleStartDateChange(newStartDate) {
    setStartDate(newStartDate)
  }

  function handleEndDateChange(newEndDate) {
    setEndDate(newEndDate)
  }

  async function handleDateRangeSubmit(e) {
    e.preventDefault()
    setAiStats(null)
    setLastScannedAt(null)
    // Clear AI-sourced pending negatives; keep manual ones
    setPendingNegatives(prev => prev.filter(item => item.source !== 'ai'))

    const shouldRunAi = !!(currentClientId && String(websiteUrl || '').trim())
    if (shouldRunAi) setAiLoading(true)

    try {
      const terms = await loadSearchTerms(
        currentClientId,
        startDate,
        endDate,
        undefined,
        undefined,
        false,
        selectedSharedSetId || null,
      )
      if (terms === null) {
        if (shouldRunAi) setAiLoading(false)
        return
      }

      if (!(shouldRunAi && websiteUrl && terms && terms.length > 0)) return

      const result = await postAiRecommendNegatives({
        searchTerms: terms,
        websiteUrl: websiteUrl.trim(),
        clientId: currentClientId,
      })
      handleAiResults(result)
      if (!result.scanSkippedDueToBadWebsiteUrl) {
        setLastScannedAt(new Date())
      }
    } catch (err) {
      console.error('Auto-scan failed:', err.message)
      if (shouldRunAi) setSubmitError(err.message || 'AI scan failed.')
    } finally {
      if (shouldRunAi) setAiLoading(false)
    }
  }

  // Called when user text-selects a phrase, clicks hover-flag button, or manually adds a keyword.
  // Defaults: phrase match + keyword list (caller may override match type / destination).
  const handleAddManualNegative = useCallback((keyword, matchType = null, campaignId = null, campaignName = null, adGroupId = null, adGroupName = null, destination = null) => {
    const normalizedKeyword = String(keyword ?? '').replace(/\u00A0/g, ' ').trim().replace(/\s+/g, ' ')
    const inferred = inferKeywordDestination(normalizedKeyword, searchTerms)
    let finalCampaignId = campaignId || inferred.campaignId
    let finalCampaignName = campaignName || inferred.campaignName
    let finalAdGroupId = adGroupId || inferred.adGroupId
    let finalAdGroupName = adGroupName || inferred.adGroupName
    let finalDestination = destination || inferred.destination || 'NEGATIVE_LIST'
    let finalMatchType = (matchType != null && matchType !== '') ? matchType : inferred.matchType
    if (finalDestination === 'NEGATIVE_LIST') {
      finalCampaignId = null
      finalCampaignName = null
      finalAdGroupId = null
      finalAdGroupName = null
    }
    if ((finalDestination === 'CAMPAIGN' || finalDestination === 'ADGROUP') && finalMatchType === 'BROAD') {
      finalMatchType = 'PHRASE'
    }

    const normalizedMatchType = String(finalMatchType || 'EXACT').toUpperCase()
    const existingGoogleEntry = existingNegatives.find(existing => {
      if (typeof existing === 'string') {
        return existing.toLowerCase() === normalizedKeyword.toLowerCase() && normalizedMatchType === 'EXACT'
      }
      const existingMatchType = String(existing.matchType || 'EXACT').toUpperCase()
      return (
        String(existing.keyword || '').toLowerCase() === normalizedKeyword.toLowerCase() &&
        existingMatchType === normalizedMatchType
      )
    })
    const existsInGoogle = !!existingGoogleEntry
    const alreadyPending = pendingNegatives.some(
      item => item.keyword.toLowerCase() === normalizedKeyword.toLowerCase() && item.matchType === finalMatchType
    )
    // Check if this specific keyword + match type combination already exists in Google
    if (existsInGoogle) {
      let locationLabel = 'Google Ads'
      if (existingGoogleEntry && typeof existingGoogleEntry === 'object') {
        if (existingGoogleEntry.source === 'SHARED_SET') {
          const resolvedListName =
            existingGoogleEntry.sharedSetName ||
            sharedSets.find(s => String(s.id) === String(existingGoogleEntry.sharedSetId || ''))?.name ||
            null
          locationLabel = resolvedListName ? `keyword list "${resolvedListName}"` : 'a keyword list'
        } else if (existingGoogleEntry.source === 'AD_GROUP') {
          const adGroupNameFromTerms =
            searchTerms.find(t => String(t.adGroupId || '') === String(existingGoogleEntry.adGroupId || ''))?.adGroup ||
            null
          const campaignNameFromTerms =
            searchTerms.find(t => String(t.campaignId || '') === String(existingGoogleEntry.campaignId || ''))?.campaign ||
            null
          const adGroupLabel =
            existingGoogleEntry.adGroupName ||
            adGroupNameFromTerms ||
            existingGoogleEntry.adGroupId ||
            null
          const campaignLabel =
            existingGoogleEntry.campaignName ||
            campaignNameFromTerms ||
            existingGoogleEntry.campaignId ||
            null
          if (adGroupLabel && campaignLabel) locationLabel = `ad group "${adGroupLabel}" in campaign "${campaignLabel}"`
          else if (adGroupLabel) locationLabel = `ad group "${adGroupLabel}"`
          else locationLabel = 'an ad group'
        } else if (existingGoogleEntry.source === 'CAMPAIGN') {
          const campaignNameFromTerms =
            searchTerms.find(t => String(t.campaignId || '') === String(existingGoogleEntry.campaignId || ''))?.campaign ||
            null
          const campaignLabel =
            existingGoogleEntry.campaignName ||
            campaignNameFromTerms ||
            existingGoogleEntry.campaignId ||
            null
          locationLabel = campaignLabel ? `campaign "${campaignLabel}"` : 'a campaign'
        }
      }
      setManualAddSuccess('')
      setManualAddError(
        `"${normalizedKeyword}" already in Google Ads (${finalMatchType.toLowerCase()}) in ${locationLabel}.`,
      )
      setTimeout(() => setManualAddError(''), 3500)
      return // Don't add if exact combination already exists
    }

    if (currentClientId && !dbSavedNegatives.map(k => k.toLowerCase()).includes(normalizedKeyword.toLowerCase())) {
      setDbSavedNegatives(prev => [...prev, normalizedKeyword])
      authenticatedFetch('/api/client-saved-negatives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: currentClientId, keywords: [normalizedKeyword] }),
      }).catch(console.error)
    }

    const listDefaultSharedSetId =
      finalDestination === 'NEGATIVE_LIST'
        ? (selectedSharedSetId || sharedSets[0]?.id || null)
        : null

    setPendingNegatives(prev => {
      if (prev.some(item => item.keyword.toLowerCase() === normalizedKeyword.toLowerCase() && item.matchType === finalMatchType)) {
        setManualAddSuccess('')
        setManualAddError(`"${normalizedKeyword}" already in pending (${finalMatchType.toLowerCase()}).`)
        setTimeout(() => setManualAddError(''), 3000)
        return prev
      }
      return [...prev, {
        keyword: normalizedKeyword,
        matchType: finalMatchType,
        source: 'manual',
        selected: true,
        destination: finalDestination,
        sharedSetId: listDefaultSharedSetId,
        campaignId: finalCampaignId,
        campaignName: finalCampaignName,
        adGroupId: finalAdGroupId,
        adGroupName: finalAdGroupName,
      }]
    })
    setAiStats(prev => prev || {})
    setSubmitSuccess('')
    setManualAddError('')
    if (!alreadyPending) {
      setManualAddSuccess(`"${normalizedKeyword}" added to pending keywords`)
      setTimeout(() => setManualAddSuccess(''), 3000)
    }
  }, [currentClientId, dbSavedNegatives, existingNegatives, pendingNegatives, searchTerms, sharedSets])

  const handleRemoveNegativeFromRow = useCallback((keyword, opts) => {
    const kwLower = keyword.toLowerCase()
    const explicitFeedback = opts != null && Object.prototype.hasOwnProperty.call(opts, 'feedback')
    const feedbackBody = explicitFeedback
      ? (opts.feedback == null ? null : String(opts.feedback).trim() || null)
      : null

    let hadAi = false
    setPendingNegatives((prev) => {
      const touching = prev.filter((i) => i.keyword.toLowerCase() === kwLower)
      hadAi = touching.some((i) => i.source === 'ai')
      return prev.filter((item) => item.keyword.toLowerCase() !== kwLower)
    })

    if (hadAi && currentClientId) {
      void authenticatedFetch('/api/rejected-ai-negatives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: currentClientId,
          keyword,
          feedback: feedbackBody,
        }),
      }).catch(console.error)
    }

    if (currentClientId && dbSavedNegatives.map((k) => k.toLowerCase()).includes(kwLower)) {
      setDbSavedNegatives((prev) => prev.filter((k) => k.toLowerCase() !== kwLower))
      authenticatedFetch('/api/client-saved-negatives', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: currentClientId, keyword }),
      }).catch(console.error)
    }
  }, [currentClientId, dbSavedNegatives])

  const handleRemoveGoogleNegative = useCallback(async (resourceName, source) => {
    if (!currentClientId || !resourceName) return
    try {
      const r = await authenticatedFetch('/api/remove-google-negative', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: currentClientId, resourceName, source }),
      })
      if (!r.ok) {
        const d = await r.json()
        throw new Error(d.details || d.error || 'Failed to remove')
      }
      setExistingNegatives(prev => prev.filter(n => n.resourceName !== resourceName))
      setPendingNegatives(prev => prev.filter(n => n.googleResourceName !== resourceName))
    } catch (err) {
      console.error('Failed to remove Google negative:', err.message)
    }
  }, [currentClientId])

  const handleAiResults = useCallback((result) => {
    if (result.scanSkippedDueToBadWebsiteUrl) {
      setSubmitSuccess('')
      setSubmitError(
        'This website URL did not load. Edit the URL under Negative Keyword Scanner, save the correct homepage, then click Re-scan.',
      )
      const total = result.summary?.totalSearchTerms ?? 0
      setAiStats({
        ...(result.summary || {
          totalSearchTerms: total,
          negativeCount: 0,
          qualityPercentage: 100,
        }),
        negativeCount: 0,
        qualityPercentage: 100,
        explanation: '',
        websiteContextStatus: 'unreadable',
        websiteFetchDetail: result.websiteFetchDetail ?? null,
      })
      return
    }

    const defaultListId = selectedSharedSetId || sharedSets[0]?.id || null
    const aiKeywords = result.negativeKeywords || []
    const sourcesMap = result.negativeKeywordSources || {}

    const trueNewKeywords = aiKeywords.filter(kw => !isKeywordInGoogle(kw, existingNegatives))

    setPendingNegatives(prev => {
      const existingAiKw = new Set(prev.filter(i => i.source === 'ai').map(i => i.keyword.toLowerCase()))
      const newItems = aiKeywords
        .filter(kw => !existingAiKw.has(kw.toLowerCase()))
        .filter(kw => !isKeywordInGoogle(kw, existingNegatives))
        .map(kw => buildAiPendingRow(kw, sourcesMap, existingNegatives, defaultListId))
        .filter(Boolean)
      const normalizedPrev = filterPendingNotInGoogle(
        prev.map(i => normalizeAiPendingItem(i, defaultListId)),
        existingNegatives,
      )
      return [...normalizedPrev, ...newItems]
    })

    const wcStatus = result.websiteContextStatus
    const wcDetail = result.websiteFetchDetail ?? null

    setAiStats(
      result.summary
        ? {
            ...result.summary,
            negativeCount: trueNewKeywords.length,
            qualityPercentage:
              result.summary.totalSearchTerms > 0
                ? Math.round(
                    ((result.summary.totalSearchTerms - trueNewKeywords.length) /
                      result.summary.totalSearchTerms) *
                      100,
                  )
                : 100,
            explanation: result.explanation,
            websiteContextStatus: wcStatus,
            websiteFetchDetail: wcDetail,
          }
        : {
            websiteContextStatus: wcStatus,
            websiteFetchDetail: wcDetail,
            explanation: result.explanation,
          },
    )
  }, [existingNegatives, searchTerms, sharedSets, selectedSharedSetId])

  async function handleCreateSharedSet(name) {
    if (!currentClientId) throw new Error('No client selected')
    const r = await authenticatedFetch('/api/create-shared-set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: currentClientId, name }),
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.details || d.error || 'Failed to create list')
    const newSet = d.sharedSet
    setSharedSets(prev => [...prev, newSet].sort((a, b) => a.name.localeCompare(b.name)))
    return newSet
  }

  // Called by AIPanel Re-scan button (or Scan page button)
  async function handleRescan(specificUrl) {
    const urlToUse = specificUrl || websiteUrl
    if (!urlToUse || searchTerms.length === 0) return
    setAiLoading(true)
    setSubmitSuccess('')
    setSubmitError('')
    try {
      const result = await postAiRecommendNegatives({
        searchTerms,
        websiteUrl: urlToUse.trim(),
        clientId: currentClientId,
      })
      handleAiResults(result)
      if (result.scanSkippedDueToBadWebsiteUrl) {
        /* submitError set in handleAiResults */
      } else {
        setLastScannedAt(new Date())
        if ((result.negativeKeywords || []).length === 0) {
          setSubmitError('AI scan completed but found no new negative keywords for this account.')
        }
      }
    } catch (err) {
      console.error('Re-scan failed:', err.message)
      setSubmitError(err.message || 'AI scan failed.')
    } finally {
      setAiLoading(false)
    }
  }

  // Handle website URL popup
  async function handleSaveWebsiteUrl() {
    if (!tempWebsiteUrl.trim()) return
    
    setUrlPopupLoading(true)
    try {
      // Save the website URL to the database
      await authenticatedFetch('/api/client-website-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: pendingClientId,
          websiteUrl: tempWebsiteUrl.trim()
        })
      })
      
      // Update local state
      setWebsiteUrl(tempWebsiteUrl.trim())
      
      // Close popup
      setShowUrlPopup(false)
      setTempWebsiteUrl('')
      
      // Now trigger AI scan with the new URL
      if (searchTerms.length > 0) {
        setAiLoading(true)
        try {
          const result = await postAiRecommendNegatives({
            searchTerms,
            websiteUrl: tempWebsiteUrl.trim(),
            clientId: pendingClientId,
          })
          handleAiResults(result)
          if (!result.scanSkippedDueToBadWebsiteUrl) {
            setLastScannedAt(new Date())
          }
        } catch (err) {
          console.error('Auto-scan failed after URL save:', err.message)
          setSubmitError(err.message || 'AI scan failed after saving URL.')
        } finally {
          setAiLoading(false)
        }
      }
    } catch (err) {
      console.error('Failed to save website URL:', err)
      setSubmitError('Failed to save website URL: ' + err.message)
    } finally {
      setUrlPopupLoading(false)
    }
  }

  function handleSkipWebsiteUrl() {
    setShowUrlPopup(false)
    setTempWebsiteUrl('')
    setPendingClientId('')
  }

  async function handleSubmitNegatives() {
    if (!currentClientId) { setSubmitError('Please select a client first.'); return }
    const toSubmit = pendingNegatives.filter(item => item.selected && !item.alreadyInGoogle)
    if (toSubmit.length === 0) { setSubmitError('No negative keywords selected.'); return }

    // Partition by destination
    const listKeywords = toSubmit.filter(item => (item.destination || 'NEGATIVE_LIST') === 'NEGATIVE_LIST')
    const campaignKeywords = toSubmit.filter(item => (item.destination || 'NEGATIVE_LIST') === 'CAMPAIGN')
    const adGroupKeywords = toSubmit.filter(item => (item.destination || 'NEGATIVE_LIST') === 'ADGROUP')

    // Validate selections
    const missingCampaign = campaignKeywords.filter(item => !item.campaignId)
    const missingAdGroup = adGroupKeywords.filter(item => !item.adGroupId)
    const missingList = listKeywords.filter(item => !item.sharedSetId)

    if (missingCampaign.length > 0) {
      setSubmitError(`${missingCampaign.length} keyword(s) with "Campaign level" destination need a campaign selected.`)
      return
    }
    if (missingAdGroup.length > 0) {
      setSubmitError(`${missingAdGroup.length} keyword(s) with "Ad group level" destination need a campaign and ad group selected.`)
      return
    }
    if (missingList.length > 0) {
      setSubmitError(`${missingList.length} keyword(s) with "Keyword list" destination need a list selected.`)
      return
    }

    setSubmitError('')
    setSubmitSuccess('')

    const submittedKeywords = []
    const summaryParts = []

    try {
      // ── 1. Negative keyword list submissions (grouped by sharedSetId) ──────
      if (listKeywords.length > 0) {
        const byList = {}
        listKeywords.forEach(item => {
          if (!byList[item.sharedSetId]) byList[item.sharedSetId] = []
          byList[item.sharedSetId].push(item)
        })
        const listResults = await Promise.all(
          Object.entries(byList).map(async ([sid, items]) => {
            const selectedSet = sharedSets.find(s => s.id === sid)
            const r = await authenticatedFetch('/api/add-to-exclusion-list', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                negativeKeywords: items.map(i => ({ keyword: i.keyword, matchType: i.matchType })),
                sharedSetId: sid,
                sharedSetResourceName: selectedSet?.resourceName,
                clientId: currentClientId,
              }),
            })
            const d = await r.json()
            if (!r.ok) throw new Error(d.details || d.error || 'Failed to submit to keyword list')
            return selectedSet?.name || sid
          })
        )
        listKeywords.forEach(item => submittedKeywords.push(item.keyword))
        const listNames = [...new Set(listResults)]
        summaryParts.push(`${listKeywords.length} to list${listNames.length > 1 ? 's' : ''}: ${listNames.join(', ')}`)
      }

      // ── 2. Campaign-level submissions (grouped by campaignId) ─────────────
      if (campaignKeywords.length > 0) {
        const byCampaign = {}
        campaignKeywords.forEach(item => {
          if (!byCampaign[item.campaignId]) byCampaign[item.campaignId] = []
          byCampaign[item.campaignId].push(item)
        })
        await Promise.all(
          Object.entries(byCampaign).map(async ([campaignId, items]) => {
            const payload = {
              negativeKeywords: items.map(i => ({ keyword: i.keyword, matchType: i.matchType })),
              campaignId,
              clientId: currentClientId,
            }
            
            const r = await authenticatedFetch('/api/add-campaign-negative', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
            const d = await r.json()
            
            // Check for partial failures or null campaign_criterion
            const failedKeywords = []
            if (d.response?.results) {
              d.response.results.forEach((result, index) => {
                if (result.campaign_criterion === null) {
                  // This is normal with Basic Access - keyword likely created successfully
                }
              })
            }
            
            // Don't treat null criterion as failure since keywords are actually being created
            // Only fail if the HTTP status is not ok
            if (!r.ok) throw new Error(d.details || d.error || 'Failed to submit campaign-level negatives')
          })
        )
        campaignKeywords.forEach(item => submittedKeywords.push(item.keyword))
        const campaignNames = [...new Set(campaignKeywords.map(i => i.campaignName || i.campaignId))]
        summaryParts.push(`${campaignKeywords.length} at campaign level (${campaignNames.join(', ')})`)
      }

      // ── 3. Ad group-level submissions (grouped by adGroupId) ─────────────
      if (adGroupKeywords.length > 0) {
        const byAdGroup = {}
        adGroupKeywords.forEach(item => {
          if (!byAdGroup[item.adGroupId]) byAdGroup[item.adGroupId] = []
          byAdGroup[item.adGroupId].push(item)
        })
        await Promise.all(
          Object.entries(byAdGroup).map(async ([adGroupId, items]) => {
            const payload = {
              negativeKeywords: items.map(i => ({ keyword: i.keyword, matchType: i.matchType })),
              adGroupId,
              clientId: currentClientId,
            }
            
            const r = await authenticatedFetch('/api/add-adgroup-negative', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
            const d = await r.json()
            
            // Check for partial failures or null ad_group_criterion
            const failedKeywords = []
            if (d.response?.results) {
              d.response.results.forEach((result, index) => {
                if (result.ad_group_criterion === null) {
                  // This is normal with Basic Access - keyword likely created successfully
                }
              })
            }
            
            // Don't treat null criterion as failure since keywords are actually being created
            // Only fail if the HTTP status is not ok
            if (!r.ok) throw new Error(d.details || d.error || 'Failed to submit ad group-level negatives')
          })
        )
        adGroupKeywords.forEach(item => submittedKeywords.push(item.keyword))
        const agNames = [...new Set(adGroupKeywords.map(i => i.adGroupName || i.adGroupId))]
        summaryParts.push(`${adGroupKeywords.length} at ad group level (${agNames.join(', ')})`)
      }

      const submittedSet = new Set(
        toSubmit.map(i => `${i.keyword.toLowerCase()}:${(i.matchType || 'PHRASE').toString().toUpperCase()}`),
      )
      const nextPending = pendingNegatives.filter(
        item => !submittedSet.has(`${item.keyword.toLowerCase()}:${(item.matchType || 'PHRASE').toString().toUpperCase()}`),
      )
      setPendingNegatives(nextPending)
      setSubmitSuccess(`Keywords submitted — ${summaryParts.join(' · ')}`)

      try {
        const negRes = await authenticatedFetch(`/api/negative-keywords?clientId=${currentClientId}`)
        if (negRes.ok) {
          const negData = await negRes.json()
          setExistingNegatives(negData['Global Negative Keywords'] || [])
        }
      } catch (err) {
        console.error('Failed to refresh Google negatives after submit:', err)
      }

      try {
        const items = serializePendingItemsForPersist(nextPending)
        await authenticatedFetch('/api/pending-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: canonicalPendingStateClientId(currentClientId),
            items,
          }),
        })
      } catch (err) {
        console.error('Failed to save pending state after submit:', err)
      }

      // Save history for all submissions
      if (toSubmit.length > 0) {
        const qualityPercentageBefore = computeSubmissionQualityPercentage(aiStats, pendingNegatives)
        const qualityPercentageAfter = computeSubmissionQualityPercentage(aiStats, nextPending)
        const allSubmitted = toSubmit.map(i => ({
          keyword: i.keyword,
          matchType: i.matchType,
          appliedTo: formatSubmissionAppliedTo(i, sharedSets),
        }))
        const uniqueTypes = [...new Set(toSubmit.map(item => item.matchType))]
        const matchTypeLabel = uniqueTypes.length === 1
          ? ({ EXACT: 'Exact match', PHRASE: 'Phrase match', BROAD: 'Broad match' }[uniqueTypes[0]] || uniqueTypes[0])
          : 'Mixed match types'

        // Build a destination label for the history entry
        const destParts = []
        if (listKeywords.length > 0) {
          const listNames = [...new Set(listKeywords.map(i => sharedSets.find(s => s.id === i.sharedSetId)?.name || i.sharedSetId))]
          destParts.push(`List: ${listNames.join(', ')}`)
        }
        if (campaignKeywords.length > 0) {
          const campaignNames = [...new Set(campaignKeywords.map(i => i.campaignName || i.campaignId))]
          destParts.push(`Campaign: ${campaignNames.join(', ')}`)
        }
        if (adGroupKeywords.length > 0) {
          const agNames = [...new Set(adGroupKeywords.map(i => i.adGroupName || i.adGroupId))]
          destParts.push(`Ad group: ${agNames.join(', ')}`)
        }
        const destLabel = destParts.join(' · ')

        authenticatedFetch('/api/submission-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: currentClientId,
            keywords: allSubmitted,
            listName: destLabel,
            matchTypes: matchTypeLabel,
            qualityPercentageBefore,
            qualityPercentageAfter,
          }),
        })
          .then(r => r.json())
          .then(() => {
            setSubmissionHistory(prev => [{
              id: Date.now(),
              submitted_at: new Date().toISOString(),
              keyword_count: allSubmitted.length,
              list_name: destLabel,
              match_types: matchTypeLabel,
              keywords: allSubmitted,
              quality_percentage: qualityPercentageBefore,
              quality_percentage_before: qualityPercentageBefore,
              quality_percentage_after: qualityPercentageAfter,
              submitted_by_email: user.email,
              submitted_by_name: user.name || ''
            }, ...prev])
          })
          .catch(console.error)
      }
    } catch (err) {
      const isManagerList =
        /manager/i.test(err.message) ||
        /RESOURCE_NOT_FOUND/i.test(err.message) ||
        /owned by/i.test(err.message)
      setSubmitError(
        isManagerList
          ? "Submission failed: You can't submit to a list owned by a manager account."
          : 'Submission failed: ' + err.message
      )
    }
  }

  async function onSaveWork() {
    if (!currentClientId) return
    const items = serializePendingItemsForPersist(pendingNegatives)
    const r = await authenticatedFetch('/api/pending-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: canonicalPendingStateClientId(currentClientId), items }),
    })
    if (!r.ok) {
      let d = {}
      try {
        d = await r.json()
      } catch {
        /* ignore */
      }
      throw new Error(d.details || d.error || 'Failed to save pending state')
    }
  }

  async function onClearWork() {
    setPendingNegatives([])
    setSavedWorkRestoreNotice(null)
    if (!currentClientId) return
    await authenticatedFetch('/api/pending-state', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: canonicalPendingStateClientId(currentClientId) }),
    }).catch(() => {})
  }

  async function handleSaveDefaultSharedSet(sharedSetId) {
    if (!currentClientId) throw new Error('Please select a client first.')
    await saveDefaultSharedSetForClient(currentClientId, sharedSetId)
    setSelectedSharedSetId(sharedSetId ? String(sharedSetId) : '')
    if (sharedSetId) {
      setPendingNegatives(prev =>
        prev.map(item => {
          const dest = item.destination || 'NEGATIVE_LIST'
          if (dest !== 'NEGATIVE_LIST') return item
          return { ...item, sharedSetId: item.sharedSetId || String(sharedSetId) }
        }),
      )
    }
  }

  /** Keeps Recommended negatives / Quality % in sync as users remove or clear AI suggestions. */
  const aiStatsForScanner = useMemo(() => {
    if (!aiStats || aiStats.totalSearchTerms === undefined) return aiStats
    const total = aiStats.totalSearchTerms
    const recommended = (pendingNegatives || []).filter(
      i => i.source === 'ai' && !i.alreadyInGoogle
    ).length
    const qualityPercentage =
      total > 0 ? Math.round(((total - recommended) / total) * 100) : 100
    return {
      ...aiStats,
      negativeCount: recommended,
      qualityPercentage: Math.min(100, Math.max(0, qualityPercentage)),
    }
  }, [aiStats, pendingNegatives])

  return (
    <Routes>
      <Route path="/" element={<HomePage onNavigate={navigate} user={user} />} />
      <Route path="/negative-keywords" element={
        <NegativeKeywordsPage
          user={user}
          onLogout={onLogout}
          clients={clients}
          currentClientId={currentClientId}
          onClientChange={handleClientChange}
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={handleStartDateChange}
          onEndDateChange={handleEndDateChange}
          today={today}
          onDateRangeSubmit={handleDateRangeSubmit}
          websiteUrl={websiteUrl}
          setWebsiteUrl={setWebsiteUrl}
          aiStats={aiStatsForScanner}
          aiLoading={aiLoading}
          searchTerms={searchTerms}
          campaigns={campaigns}
          adGroupsByCampaign={adGroupsByCampaign}
          pendingNegatives={pendingNegatives}
          setPendingNegatives={setPendingNegatives}
          sharedSets={sharedSets}
          setSharedSets={setSharedSets}
          selectedSharedSetId={selectedSharedSetId}
          setSelectedSharedSetId={setSelectedSharedSetId}
          lastScannedAt={lastScannedAt}
          onRescan={handleRescan}
          onCreateSharedSet={handleCreateSharedSet}
          onAddManualNegative={handleAddManualNegative}
          onRemoveNegative={handleRemoveNegativeFromRow}
          onRemoveGoogleNegative={handleRemoveGoogleNegative}
          onSubmitNegatives={handleSubmitNegatives}
          submitSuccess={submitSuccess}
          setSubmitSuccess={setSubmitSuccess}
          submitError={submitError}
          setSubmitError={setSubmitError}
          manualAddSuccess={manualAddSuccess}
          manualAddError={manualAddError}
          submissionHistory={submissionHistory}
          rowNegatives={rowNegatives}
          error={error}
          loading={loading}
          showUrlPopup={showUrlPopup}
          tempWebsiteUrl={tempWebsiteUrl}
          setTempWebsiteUrl={setTempWebsiteUrl}
          urlPopupLoading={urlPopupLoading}
          handleSaveWebsiteUrl={handleSaveWebsiteUrl}
          handleSkipWebsiteUrl={handleSkipWebsiteUrl}
          existingNegatives={existingNegatives}
          onSaveWork={onSaveWork}
          onClearWork={onClearWork}
          reviewLinkError={reviewLinkError}
          onCreateReviewRequest={handleCreateReviewRequest}
          onSaveDefaultSharedSet={handleSaveDefaultSharedSet}
          savedWorkRestoreNotice={savedWorkRestoreNotice}
          onDismissSavedWorkRestoreNotice={dismissSavedWorkRestoreNotice}
          searchTermsEmptyReason={searchTermsEmptyReason}
          highVolumeModal={highVolumeModal}
          onHighVolumeConfirm={confirmHighVolumeLoad}
          onHighVolumeCancel={cancelHighVolumeLoad}
        />
      } />
      <Route path="/review" element={
        <NegativeKeywordsPage
          user={user}
          onLogout={onLogout}
          clients={clients}
          currentClientId={currentClientId}
          onClientChange={handleClientChange}
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={handleStartDateChange}
          onEndDateChange={handleEndDateChange}
          today={today}
          onDateRangeSubmit={handleDateRangeSubmit}
          websiteUrl={websiteUrl}
          setWebsiteUrl={setWebsiteUrl}
          aiStats={aiStatsForScanner}
          aiLoading={aiLoading}
          searchTerms={searchTerms}
          campaigns={campaigns}
          adGroupsByCampaign={adGroupsByCampaign}
          pendingNegatives={pendingNegatives}
          setPendingNegatives={setPendingNegatives}
          sharedSets={sharedSets}
          setSharedSets={setSharedSets}
          selectedSharedSetId={selectedSharedSetId}
          setSelectedSharedSetId={setSelectedSharedSetId}
          lastScannedAt={lastScannedAt}
          onRescan={handleRescan}
          onCreateSharedSet={handleCreateSharedSet}
          onAddManualNegative={handleAddManualNegative}
          onRemoveNegative={handleRemoveNegativeFromRow}
          onRemoveGoogleNegative={handleRemoveGoogleNegative}
          onSubmitNegatives={handleSubmitNegatives}
          submitSuccess={submitSuccess}
          setSubmitSuccess={setSubmitSuccess}
          submitError={submitError}
          setSubmitError={setSubmitError}
          manualAddSuccess={manualAddSuccess}
          manualAddError={manualAddError}
          submissionHistory={submissionHistory}
          rowNegatives={rowNegatives}
          error={error}
          loading={loading}
          showUrlPopup={showUrlPopup}
          tempWebsiteUrl={tempWebsiteUrl}
          setTempWebsiteUrl={setTempWebsiteUrl}
          urlPopupLoading={urlPopupLoading}
          handleSaveWebsiteUrl={handleSaveWebsiteUrl}
          handleSkipWebsiteUrl={handleSkipWebsiteUrl}
          existingNegatives={existingNegatives}
          onSaveWork={onSaveWork}
          onClearWork={onClearWork}
          reviewLinkError={reviewLinkError}
          onCreateReviewRequest={handleCreateReviewRequest}
          onSaveDefaultSharedSet={handleSaveDefaultSharedSet}
          savedWorkRestoreNotice={savedWorkRestoreNotice}
          onDismissSavedWorkRestoreNotice={dismissSavedWorkRestoreNotice}
          searchTermsEmptyReason={searchTermsEmptyReason}
          highVolumeModal={highVolumeModal}
          onHighVolumeConfirm={confirmHighVolumeLoad}
          onHighVolumeCancel={cancelHighVolumeLoad}
        />
      } />
      <Route path="/review-confirm/:id" element={<StrategistConfirmPage />} />
      <Route path="/admin" element={
        user && user.isSuperUser ? (
          <AdminPanel user={user} />
        ) : (
          <div className="access-denied">
            <div className="access-denied-content">
              <i className="fas fa-shield-alt text-danger mb-3" style={{ fontSize: '4rem' }}></i>
              <h3>Access Denied</h3>
              <p className="text-muted">You don't have permission to access this page.</p>
              <button className="btn btn-primary" onClick={() => navigate('/')}>
                <i className="fas fa-home me-1"></i>
                Go Home
              </button>
            </div>
          </div>
        )
      } />
    </Routes>
  )
}
