import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import Select from 'react-select'
import { getDefaultDates, escapeRegex } from './utils'
import SearchTermsTable from './SearchTermsTable'
import AIPanel from './AIPanel'

function HomePage({ onNavigate }) {
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
      </div>
    </div>
  )
}

function NegativeKeywordsPage({
  clients,
  currentClientId,
  onClientChange,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
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
  selectedSharedSetId,
  setSelectedSharedSetId,
  lastScannedAt,
  onRescan,
  onAddManualNegative,
  onRemoveNegative,
  onSubmitNegatives,
  submitSuccess,
  setSubmitSuccess,
  submitError,
  setSubmitError,
  submissionHistory,
  rowNegatives,
  error,
  loading,
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
                  onChange={e => setStartDate(e.target.value)}
                  style={{ width: 130 }}
                />
                <span className="date-sep">to</span>
                <input
                  type="date"
                  className="form-control form-control-sm"
                  value={endDate}
                  min={startDate}
                  max={today}
                  onChange={e => setEndDate(e.target.value)}
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
          onAddManualNegative={onAddManualNegative}
          onRemoveNegative={onRemoveNegative}
          onSubmitNegatives={onSubmitNegatives}
          submitSuccess={submitSuccess}
          setSubmitSuccess={setSubmitSuccess}
          submitError={submitError}
          setSubmitError={setSubmitError}
          submissionHistory={submissionHistory}
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
            />
          </>
        )}
      </div>
    </>
  )
}

export default function App() {
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

  // rowNegatives: Map<searchTerm, Set<prefixed-phrase>>
  const rowNegatives = useMemo(() => {
    const map = new Map()
    const googleLower = existingNegatives.map(k => k.toLowerCase())

    searchTerms.forEach(term => {
      const termStr = term.searchTerm
      const negatives = new Set()

      googleLower.forEach(neg => {
        if (termStr.toLowerCase().includes(neg)) {
          negatives.add('google:' + neg)
        }
      })

      pendingNegatives.forEach(item => {
        const kwLower = item.keyword.toLowerCase()
        const escaped = escapeRegex(kwLower)
        const regex = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i')
        if (regex.test(termStr)) {
          negatives.add(item.source + ':' + item.keyword)
        }
      })

      if (negatives.size > 0) map.set(termStr, negatives)
    })

    return map
  }, [searchTerms, existingNegatives, pendingNegatives])

  // Load clients on mount
  useEffect(() => {
    fetch('/api/clients')
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
      const r = await fetch(`/api/search-terms?clientId=${clientId}&startDate=${start}&endDate=${end}`)
      if (!r.ok) {
        const d = await r.json()
        throw new Error(d.error || 'Failed to fetch data')
      }
      const terms = await r.json()
      setSearchTerms(terms)

      if (googleNegs !== undefined) setExistingNegatives(googleNegs)
      if (dbNegs !== undefined) {
        setDbSavedNegatives(dbNegs)
        const googleNegLower = new Set((googleNegs || existingNegatives).map(k => k.toLowerCase()))
        const pendingFromDb = dbNegs
          .filter(kw => !googleNegLower.has(kw.toLowerCase()))
          .map(kw => ({ keyword: kw, matchType: 'EXACT', source: 'manual', selected: true }))
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
        fetch(`/api/client-settings?clientId=${clientId}`).then(r => r.json()),
        fetch(`/api/negative-keywords?clientId=${clientId}`).then(r => r.json()),
        fetch(`/api/shared-sets?clientId=${clientId}`).then(r => r.json()),
        fetch(`/api/submission-history?clientId=${clientId}`).then(r => r.json()),
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
          const d = await fetch(`/api/detect-website?clientId=${clientId}`).then(r => r.json())
          if (d.websiteUrl) {
            urlToUse = d.websiteUrl
            setWebsiteUrl(d.websiteUrl)
          }
        } catch {}
      }

      const terms = await loadSearchTerms(clientId, startDate, endDate, googleNegatives, savedNegatives)

      // Auto-scan immediately after loading — use local vars to avoid stale closure
      if (urlToUse && terms && terms.length > 0) {
        setAiLoading(true)
        try {
          const r = await fetch('/api/ai-recommend-negatives', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ searchTerms: terms, websiteUrl: urlToUse.trim() }),
          })
          if (r.ok) {
            const result = await r.json()
            const googleNegLower = new Set(googleNegatives.map(k => k.toLowerCase()))
            const aiKeywords = result.negativeKeywords || []

            // Hard filter
            const termsLower = terms.map(st => st.searchTerm.toLowerCase())
            const filtered = aiKeywords.filter(kw => {
              const kwLower = kw.toLowerCase().trim()
              const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i')
              return termsLower.some(t => re.test(t))
            })

            setPendingNegatives(prev => {
              const existingKws = new Set(prev.map(i => i.keyword.toLowerCase()))
              const newItems = filtered
                .filter(kw => !existingKws.has(kw.toLowerCase()))
                .map(kw => {
                  const inGoogle = googleNegLower.has(kw.toLowerCase())
                  return { keyword: kw, matchType: 'EXACT', source: 'ai', selected: !inGoogle, alreadyInGoogle: inGoogle }
                })
              return [...prev, ...newItems]
            })
            setAiStats(result.summary
              ? { ...result.summary, explanation: result.explanation }
              : {})
            setLastScannedAt(new Date())
          }
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
        const r = await fetch('/api/ai-recommend-negatives', {
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

  // Called when user text-selects a phrase or clicks hover-flag button
  const handleAddManualNegative = useCallback((keyword, matchType = 'EXACT') => {
    const kwLower = keyword.toLowerCase()
    const googleNegLower = new Set(existingNegatives.map(k => k.toLowerCase()))
    if (googleNegLower.has(kwLower)) return

    if (currentClientId && !dbSavedNegatives.map(k => k.toLowerCase()).includes(kwLower)) {
      setDbSavedNegatives(prev => [...prev, keyword])
      fetch('/api/client-saved-negatives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: currentClientId, keywords: [keyword] }),
      }).catch(console.error)
    }

    setPendingNegatives(prev => {
      if (prev.some(item => item.keyword.toLowerCase() === kwLower)) return prev
      return [...prev, { keyword, matchType, source: 'manual', selected: true }]
    })
    setAiStats(prev => prev || {})
    setSubmitSuccess('')
  }, [currentClientId, dbSavedNegatives, existingNegatives])

  const handleRemoveNegativeFromRow = useCallback((keyword) => {
    const kwLower = keyword.toLowerCase()
    if (currentClientId && dbSavedNegatives.map(k => k.toLowerCase()).includes(kwLower)) {
      setDbSavedNegatives(prev => prev.filter(k => k.toLowerCase() !== kwLower))
      fetch('/api/client-saved-negatives', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: currentClientId, keyword }),
      }).catch(console.error)
    }
    setPendingNegatives(prev => prev.filter(item => item.keyword.toLowerCase() !== kwLower))
  }, [currentClientId, dbSavedNegatives])

  const handleAiResults = useCallback((result) => {
    const googleNegLower = new Set(existingNegatives.map(k => k.toLowerCase()))
    const aiKeywords = result.negativeKeywords || []

    setPendingNegatives(prev => {
      const existingKws = new Set(prev.map(item => item.keyword.toLowerCase()))
      const newItems = aiKeywords
        .filter(kw => !existingKws.has(kw.toLowerCase()))
        .map(kw => {
          const inGoogle = googleNegLower.has(kw.toLowerCase())
          return { keyword: kw, matchType: 'EXACT', source: 'ai', selected: !inGoogle, alreadyInGoogle: inGoogle }
        })
      return [...prev, ...newItems]
    })

    setAiStats(result.summary
      ? { ...result.summary, explanation: result.explanation }
      : {})
  }, [existingNegatives])

  // Called by AIPanel Re-scan button (or Scan page button)
  async function handleRescan(specificUrl) {
    const urlToUse = specificUrl || websiteUrl
    if (!urlToUse || searchTerms.length === 0) return
    setAiLoading(true)
    setSubmitSuccess('')
    try {
      const r = await fetch('/api/ai-recommend-negatives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchTerms, websiteUrl: urlToUse.trim() }),
      })
      if (!r.ok) {
        const d = await r.json()
        throw new Error(d.error || 'AI analysis failed')
      }
      const result = await r.json()
      handleAiResults(result)
      setLastScannedAt(new Date())
    } catch (err) {
      console.error('Re-scan failed:', err.message)
    } finally {
      setAiLoading(false)
    }
  }

  async function handleSubmitNegatives() {
    if (!currentClientId) { setSubmitError('Please select a client first.'); return }
    const toSubmit = pendingNegatives.filter(item => item.selected && !item.alreadyInGoogle)
    if (toSubmit.length === 0) { setSubmitError('No negative keywords selected.'); return }
    if (!selectedSharedSetId) { setSubmitError('Please select a keyword list.'); return }

    setSubmitError('')
    setSubmitSuccess('')

    try {
      const selectedSet = sharedSets.find(s => s.id === selectedSharedSetId)
      const r = await fetch('/api/add-to-exclusion-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          negativeKeywords: toSubmit.map(item => ({ keyword: item.keyword, matchType: item.matchType })),
          sharedSetId: selectedSharedSetId,
          sharedSetResourceName: selectedSet?.resourceName,
          clientId: currentClientId,
        }),
      })
      const d = await r.json()
      if (!r.ok) {
        throw new Error(d.details || d.error || 'Failed to submit to Google Ads')
      }
      const listName = sharedSets.find(s => s.id === selectedSharedSetId)?.name || selectedSharedSetId

      // Summarise match types for history label
      const uniqueTypes = [...new Set(toSubmit.map(item => item.matchType))]
      const matchTypeLabel = uniqueTypes.length === 1
        ? ({ EXACT: 'Exact match', PHRASE: 'Phrase match', BROAD: 'Broad match' }[uniqueTypes[0]] || uniqueTypes[0])
        : 'Mixed match types'

      const submittedKeywords = toSubmit.map(item => item.keyword)
      setExistingNegatives(prev => [...prev, ...submittedKeywords])
      setSubmitSuccess(`Keywords submitted with individual match types to "${listName}"`)
      setPendingNegatives([])

      // Save to submission history
      const historyRecord = {
        clientId: currentClientId,
        keywords: toSubmit.map(item => ({ keyword: item.keyword, matchType: item.matchType })),
        listName,
        matchTypes: matchTypeLabel,
      }
      fetch('/api/submission-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(historyRecord),
      })
        .then(r => r.json())
        .then(() => {
          // Prepend optimistically to local history
          setSubmissionHistory(prev => [{
            id: Date.now(),
            submitted_at: new Date().toISOString(),
            keyword_count: toSubmit.length,
            list_name: listName,
            match_types: matchTypeLabel,
            keywords: toSubmit.map(item => ({ keyword: item.keyword, matchType: item.matchType })),
          }, ...prev])
        })
        .catch(console.error)
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
      <Route path="/" element={<HomePage onNavigate={navigate} />} />
      <Route path="/negative-keywords" element={
        <NegativeKeywordsPage
          clients={clients}
          currentClientId={currentClientId}
          onClientChange={handleClientChange}
          startDate={startDate}
          setStartDate={setStartDate}
          endDate={endDate}
          setEndDate={setEndDate}
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
          selectedSharedSetId={selectedSharedSetId}
          setSelectedSharedSetId={setSelectedSharedSetId}
          lastScannedAt={lastScannedAt}
          onRescan={handleRescan}
          onAddManualNegative={handleAddManualNegative}
          onRemoveNegative={handleRemoveNegativeFromRow}
          onSubmitNegatives={handleSubmitNegatives}
          submitSuccess={submitSuccess}
          setSubmitSuccess={setSubmitSuccess}
          submitError={submitError}
          setSubmitError={setSubmitError}
          submissionHistory={submissionHistory}
          rowNegatives={rowNegatives}
          error={error}
          loading={loading}
        />
      } />
    </Routes>
  )
}
