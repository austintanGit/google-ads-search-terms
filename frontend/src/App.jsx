import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import Select from 'react-select'
import { getDefaultDates, escapeRegex } from './utils'
import SearchTermsTable from './SearchTermsTable'
import AIPanel from './AIPanel'
import AuthPage from './components/AuthPage'
import AdminPanel from './components/AdminPanel'

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

// Single word → Exact, multi-word → Phrase
function inferMatchType(kw) {
  return 'PHRASE'
}

// Infer campaign/adgroup, destination type, and match type for a keyword based on search term data.
// - 1 ad group  → ADGROUP (most targeted)
// - 1 campaign, multiple ad groups → CAMPAIGN
// - Multiple campaigns → NEGATIVE_LIST (can't target all campaigns at once)
function inferKeywordDestination(kw, terms) {
  const kwLower = kw.toLowerCase()
  const matching = terms.filter(t => t.searchTerm.toLowerCase().includes(kwLower))
  const matchType = inferMatchType(kw)

  if (matching.length === 0) {
    return { campaignId: null, campaignName: null, adGroupId: null, adGroupName: null, destination: 'CAMPAIGN', matchType }
  }

  // Find the best matching search term (highest clicks)
  const best = [...matching].sort((a, b) => (b.clicks || 0) - (a.clicks || 0))[0]

  // Always default destination to CAMPAIGN as requested, but preserve campaign/adgroup context
  return {
    campaignId: best?.campaignId || null,
    campaignName: best?.campaign || null,
    adGroupId: best?.adGroupId || null,
    adGroupName: best?.adGroup || null,
    destination: 'CAMPAIGN', // Always default to CAMPAIGN level
    matchType
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
}) {
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

      <div className="app-wrapper">
        <AIPanel
          currentClientId={currentClientId}
          websiteUrl={websiteUrl}
          setWebsiteUrl={setWebsiteUrl}
          aiStats={aiStats}
          aiLoading={aiLoading}
          pendingNegatives={pendingNegatives}
          setPendingNegatives={setPendingNegatives}
          sharedSets={sharedSets}
          selectedSharedSetId={selectedSharedSetId}
          setSelectedSharedSetId={setSelectedSharedSetId}
          lastScannedAt={lastScannedAt}
          onRescan={onRescan}
          onCreateSharedSet={onCreateSharedSet}
          onAddManualNegative={onAddManualNegative}
          onRemoveNegative={onRemoveNegative}
          onSubmitNegatives={onSubmitNegatives}
          submitSuccess={submitSuccess}
          setSubmitSuccess={setSubmitSuccess}
          submitError={submitError}
          setSubmitError={setSubmitError}
          submissionHistory={submissionHistory}
          existingNegatives={existingNegatives}
        />

        {error && <div className="alert alert-danger mx-0 mb-3">{error}</div>}

        {loading && (
          <div className="text-center p-4">
            <div className="spinner-border text-primary" role="status">
              <span className="visually-hidden">Loading…</span>
            </div>
            <p className="mt-2 text-muted">Loading data…</p>
          </div>
        )}

        {!loading && searchTerms.length > 0 && (
          <>
            <div className="step-heading" id="search-terms-section">
              <div className="step-heading-num">2</div>
              <div className="step-heading-text">
                <div className="step-heading-title">Review your search terms</div>
                <div className="step-heading-sub">Flag irrelevant terms directly from your search term report</div>
              </div>
            </div>
            
            <SearchTermsTable
              searchTerms={searchTerms}
              rowNegatives={rowNegatives}
              onAddNegative={onAddManualNegative}
              onRemoveNegative={onRemoveNegative}
              onRemoveGoogleNegative={onRemoveGoogleNegative}
              existingNegatives={existingNegatives}
            />
          </>
        )}
      </div>

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

  // Core data
  const [clients, setClients] = useState([])
  const [currentClientId, setCurrentClientId] = useState('')
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(defaultEnd)
  const [searchTerms, setSearchTerms] = useState([])

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
  
  // Website URL popup
  const [showUrlPopup, setShowUrlPopup] = useState(false)
  const [pendingClientId, setPendingClientId] = useState('')
  const [tempWebsiteUrl, setTempWebsiteUrl] = useState('')
  const [urlPopupLoading, setUrlPopupLoading] = useState(false)

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

    searchTerms.forEach(term => {
      const termStr = term.searchTerm
      const negatives = new Set()

      // Check existing Google negatives
      existingNegatives.forEach(existing => {
        let keyword, matchType
        if (typeof existing === 'string') {
          // Old format - just keyword text
          keyword = existing.toLowerCase()
          matchType = 'EXACT'
        } else {
          // New format - object with keyword and matchType
          keyword = existing.keyword.toLowerCase()
          matchType = convertMatchTypeToText(existing.matchType || 'EXACT')
        }
        
        if (termStr.toLowerCase().includes(keyword)) {
          // Use the original keyword case from existing negatives, not the lowercase version
          const originalKeyword = typeof existing === 'string' ? existing : existing.keyword
          negatives.add(`google:${originalKeyword} (${matchType})`)
        }
      })

      // Check pending negatives
      pendingNegatives.forEach(item => {
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
    setError('')
  }

  // Returns the loaded terms array so callers can use it for auto-scanning
  async function loadSearchTerms(clientId, start, end, googleNegs, dbNegs) {
    if (!clientId) { setError('Please select a client first'); return [] }
    setLoading(true)
    setError('')
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

      if (googleNegs !== undefined) setExistingNegatives(googleNegs)
      if (dbNegs !== undefined) {
        setDbSavedNegatives(dbNegs)
        const googleNegLower = new Set((googleNegs || existingNegatives).map(k => 
          typeof k === 'string' ? k.toLowerCase() : k.keyword.toLowerCase()
        ))
        const pendingFromDb = dbNegs
          .filter(kw => !googleNegLower.has(kw.toLowerCase()))
          .map(kw => ({ keyword: kw, matchType: 'EXACT', source: 'manual', selected: true, destination: 'CAMPAIGN', sharedSetId: null }))
        setPendingNegatives(pendingFromDb)
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
    if (!clientId) return

    try {
      const [settingsRes, negRes, setsRes, historyRes] = await Promise.all([
        authenticatedFetch(`/api/client-settings?clientId=${clientId}`).then(r => r.json()),
        authenticatedFetch(`/api/negative-keywords?clientId=${clientId}`).then(r => r.json()),
        authenticatedFetch(`/api/shared-sets?clientId=${clientId}`).then(r => r.json()),
        authenticatedFetch(`/api/submission-history?clientId=${clientId}`).then(r => r.json()),
      ])
      setSubmissionHistory(Array.isArray(historyRes) ? historyRes : [])

      const savedNegatives = settingsRes.savedNegatives || []
      const googleNegatives = negRes['Global Negative Keywords'] || []
      const sets = Array.isArray(setsRes) ? setsRes : []

      setDbSavedNegatives(savedNegatives)
      setExistingNegatives(googleNegatives)
      setSharedSets(sets)
      if (sets.length > 0) setSelectedSharedSetId(sets[0].id)

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

      const terms = await loadSearchTerms(clientId, startDate, endDate, googleNegatives, savedNegatives)

      // If no website URL found and we have search terms, show popup to ask user
      if (!urlToUse && terms && terms.length > 0) {
        setPendingClientId(clientId)
        setShowUrlPopup(true)
        return
      }

      // Auto-scan immediately after loading — use local vars to avoid stale closure
      if (urlToUse && terms && terms.length > 0) {
        setAiLoading(true)
        try {
          const r = await authenticatedFetch('/api/ai-recommend-negatives', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ searchTerms: terms, websiteUrl: urlToUse.trim() }),
          })
          if (!r.ok) {
            const d = await r.json()
            throw new Error(d.error || 'AI analysis failed')
          }
          const result = await r.json()
          const aiKeywords = result.negativeKeywords || []
          const sourcesMap = result.negativeKeywordSources || {}
          
          // Only count truly new keywords (not existing in any match type)
          const trueNewKeywords = aiKeywords.filter(kw => {
            return !existingNegatives.some(existing => {
              const existingKeyword = typeof existing === 'string' ? existing : existing.keyword
              return existingKeyword.toLowerCase() === kw.toLowerCase()
            })
          })

          setPendingNegatives(prev => {
            const existingKws = new Set(prev.map(i => `${i.keyword.toLowerCase()}:${i.matchType}`))
            const newItems = aiKeywords
              .filter(kw => {
                const { matchType } = inferKeywordDestination(kw, terms)
                return !existingKws.has(`${kw.toLowerCase()}:${matchType}`)
              })
              .map(kw => {
                const { campaignId, campaignName, adGroupId, adGroupName, destination, matchType } = inferKeywordDestination(kw, terms)
                const inGoogle = isKeywordMatchTypeInGoogle(kw, matchType, googleNegatives)
                return { keyword: kw, matchType, source: 'ai', sourceSearchTerms: sourcesMap[kw] || [], selected: !inGoogle, alreadyInGoogle: inGoogle, destination, sharedSetId: null, campaignId, campaignName, adGroupId, adGroupName }
              })
            return [...prev, ...newItems]
          })
          setAiStats(result.summary ? {
            ...result.summary,
            negativeCount: trueNewKeywords.length,
            qualityPercentage: result.summary.totalSearchTerms > 0
              ? Math.round(((result.summary.totalSearchTerms - trueNewKeywords.length) / result.summary.totalSearchTerms) * 100)
              : 100,
            explanation: result.explanation,
          } : {})
          setLastScannedAt(new Date())
        } catch (err) {
          console.error('Auto-scan failed:', err.message)
        } finally {
          setAiLoading(false)
        }
      }
    } catch (err) {
      setError('Error loading client data: ' + err.message)
    }
  }

  // Helper function to convert numeric match types to text
  function convertMatchTypeToText(matchType) {
    if (typeof matchType === 'string') return matchType;
    if (matchType === 2) return 'EXACT';
    if (matchType === 3) return 'PHRASE'; 
    if (matchType === 4) return 'BROAD';
    return 'EXACT'; // default
  }

  // Helper function to check if a keyword + match type combination already exists in Google
  function isKeywordMatchTypeInGoogle(keyword, matchType, googleNegatives) {
    return googleNegatives.some(existing => {
      // Handle both old format (strings) and new format (objects with keyword/matchType)
      if (typeof existing === 'string') {
        return existing.toLowerCase() === keyword.toLowerCase()
      } else {
        return existing.keyword.toLowerCase() === keyword.toLowerCase() && 
               existing.matchType === matchType
      }
    })
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

    const terms = await loadSearchTerms(currentClientId, startDate, endDate)

    if (websiteUrl && terms && terms.length > 0) {
      setAiLoading(true)
      try {
        const r = await authenticatedFetch('/api/ai-recommend-negatives', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ searchTerms: terms, websiteUrl: websiteUrl.trim() }),
        })
        if (r.ok) {
          const result = await r.json()
          handleAiResults(result)
          setLastScannedAt(new Date())
        }
      } catch (err) {
        console.error('Auto-scan failed:', err.message)
      } finally {
        setAiLoading(false)
      }
    }
  }

  // Called when user text-selects a phrase, clicks hover-flag button, or manually adds a keyword.
  // When no campaign context is provided (manual text input), auto-infers from search terms.
  const handleAddManualNegative = useCallback((keyword, matchType = null, campaignId = null, campaignName = null, adGroupId = null, adGroupName = null, destination = null) => {
    // Infer destination/campaign from search terms when no explicit context; match type from word count unless caller passes one (e.g. manual add)
    const inferred = inferKeywordDestination(keyword, searchTerms)
    let finalCampaignId = campaignId || inferred.campaignId
    let finalCampaignName = campaignName || inferred.campaignName
    let finalAdGroupId = adGroupId || inferred.adGroupId
    let finalAdGroupName = adGroupName || inferred.adGroupName
    let finalDestination = destination || inferred.destination || 'CAMPAIGN'
    let finalMatchType = (matchType != null && matchType !== '') ? matchType : inferred.matchType
    if ((finalDestination === 'CAMPAIGN' || finalDestination === 'ADGROUP') && finalMatchType === 'BROAD') {
      finalMatchType = 'EXACT'
    }

    // Check if this specific keyword + match type combination already exists in Google
    if (isKeywordMatchTypeInGoogle(keyword, finalMatchType, existingNegatives)) {
      return // Don't add if exact combination already exists
    }

    if (currentClientId && !dbSavedNegatives.map(k => k.toLowerCase()).includes(keyword.toLowerCase())) {
      setDbSavedNegatives(prev => [...prev, keyword])
      authenticatedFetch('/api/client-saved-negatives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: currentClientId, keywords: [keyword] }),
      }).catch(console.error)
    }

    setPendingNegatives(prev => {
      // Check if this exact keyword + match type combination already exists in pending
      if (prev.some(item => item.keyword.toLowerCase() === keyword.toLowerCase() && item.matchType === finalMatchType)) return prev
      return [...prev, { keyword, matchType: finalMatchType, source: 'manual', selected: true, destination: finalDestination, sharedSetId: null, campaignId: finalCampaignId, campaignName: finalCampaignName, adGroupId: finalAdGroupId, adGroupName: finalAdGroupName }]
    })
    setAiStats(prev => prev || {})
    setSubmitSuccess('')
  }, [currentClientId, dbSavedNegatives, existingNegatives, searchTerms])

  const handleRemoveNegativeFromRow = useCallback((keyword) => {
    const kwLower = keyword.toLowerCase()
    
    if (currentClientId && dbSavedNegatives.map(k => k.toLowerCase()).includes(kwLower)) {
      setDbSavedNegatives(prev => prev.filter(k => k.toLowerCase() !== kwLower))
      authenticatedFetch('/api/client-saved-negatives', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: currentClientId, keyword }),
      }).catch(console.error)
    }
    
    setPendingNegatives(prev => {
      const filtered = prev.filter(item => item.keyword.toLowerCase() !== kwLower);
      return filtered;
    });
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
    } catch (err) {
      console.error('Failed to remove Google negative:', err.message)
    }
  }, [currentClientId])

  const handleAiResults = useCallback((result) => {
    const aiKeywords = result.negativeKeywords || []
    const sourcesMap = result.negativeKeywordSources || {}

    // Only count truly new keywords (not existing in any match type)
    const trueNewKeywords = aiKeywords.filter(kw => {
      return !existingNegatives.some(existing => {
        const existingKeyword = typeof existing === 'string' ? existing : existing.keyword
        return existingKeyword.toLowerCase() === kw.toLowerCase()
      })
    })

    setPendingNegatives(prev => {
      const existingKws = new Set(prev.map(item => `${item.keyword.toLowerCase()}:${item.matchType}`))
      const newItems = aiKeywords
        .filter(kw => {
          const { matchType } = inferKeywordDestination(kw, searchTerms)
          return !existingKws.has(`${kw.toLowerCase()}:${matchType}`)
        })
        .map(kw => {
          const { campaignId, campaignName, adGroupId, adGroupName, destination, matchType } = inferKeywordDestination(kw, searchTerms)
          const inGoogle = isKeywordMatchTypeInGoogle(kw, matchType, existingNegatives)
          return { keyword: kw, matchType, source: 'ai', sourceSearchTerms: sourcesMap[kw] || [], selected: !inGoogle, alreadyInGoogle: inGoogle, destination, sharedSetId: null, campaignId, campaignName, adGroupId, adGroupName }
        })
      return [...prev, ...newItems]
    })

    setAiStats(result.summary ? {
      ...result.summary,
      negativeCount: trueNewKeywords.length,
      qualityPercentage: result.summary.totalSearchTerms > 0
        ? Math.round(((result.summary.totalSearchTerms - trueNewKeywords.length) / result.summary.totalSearchTerms) * 100)
        : 100,
      explanation: result.explanation,
    } : {})
  }, [existingNegatives, searchTerms])

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
      const r = await fetch('/api/ai-recommend-negatives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchTerms, websiteUrl: urlToUse.trim() }),
      })
      if (!r.ok) {
        const d = await r.json()
        throw new Error(d.details || d.error || 'AI analysis failed')
      }
      const result = await r.json()
      handleAiResults(result)
      setLastScannedAt(new Date())
      if ((result.negativeKeywords || []).length === 0) {
        setSubmitError('AI scan completed but found no new negative keywords for this account.')
      }
    } catch (err) {
      console.error('Re-scan failed:', err.message)
      setSubmitError('AI scan failed: ' + err.message)
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
          const r = await authenticatedFetch('/api/ai-recommend-negatives', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ searchTerms, websiteUrl: tempWebsiteUrl.trim() }),
          })
          if (r.ok) {
            const result = await r.json()
            handleAiResults(result)
            setLastScannedAt(new Date())
          }
        } catch (err) {
          console.error('Auto-scan failed after URL save:', err.message)
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
    const listKeywords = toSubmit.filter(item => (item.destination || 'CAMPAIGN') === 'NEGATIVE_LIST')
    const campaignKeywords = toSubmit.filter(item => (item.destination || 'CAMPAIGN') === 'CAMPAIGN')
    const adGroupKeywords = toSubmit.filter(item => (item.destination || 'CAMPAIGN') === 'ADGROUP')

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
      setSubmitError(`${missingList.length} keyword(s) with "Negative keyword list" destination need a list selected.`)
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

      setExistingNegatives(prev => [...prev, ...submittedKeywords])
      setSubmitSuccess(`Keywords submitted — ${summaryParts.join(' · ')}`)

      const submittedSet = new Set(submittedKeywords.map(k => k.toLowerCase()))
      setPendingNegatives(prev => prev.filter(item => !submittedSet.has(item.keyword.toLowerCase())))

      // Save history for list submissions
      if (listKeywords.length > 0) {
        const uniqueTypes = [...new Set(listKeywords.map(item => item.matchType))]
        const matchTypeLabel = uniqueTypes.length === 1
          ? ({ EXACT: 'Exact match', PHRASE: 'Phrase match', BROAD: 'Broad match' }[uniqueTypes[0]] || uniqueTypes[0])
          : 'Mixed match types'
        const listNames = [...new Set(listKeywords.map(i => sharedSets.find(s => s.id === i.sharedSetId)?.name || i.sharedSetId))]
        authenticatedFetch('/api/submission-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: currentClientId,
            keywords: listKeywords.map(i => ({ keyword: i.keyword, matchType: i.matchType })),
            listName: listNames.join(', '),
            matchTypes: matchTypeLabel,
          }),
        })
          .then(r => r.json())
          .then(() => {
            setSubmissionHistory(prev => [{
              id: Date.now(),
              submitted_at: new Date().toISOString(),
              keyword_count: listKeywords.length,
              list_name: listNames.join(', '),
              match_types: matchTypeLabel,
              keywords: listKeywords.map(i => ({ keyword: i.keyword, matchType: i.matchType })),
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
          aiStats={aiStats}
          aiLoading={aiLoading}
          searchTerms={searchTerms}
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
        />
      } />
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
