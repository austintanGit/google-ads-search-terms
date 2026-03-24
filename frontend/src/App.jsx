import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { getDefaultDates, escapeRegex } from './utils'
import SearchTermsTable from './SearchTermsTable'
import AIPanel from './AIPanel'

export default function App() {
  const { startDate: defaultStart, endDate: defaultEnd } = getDefaultDates()
  const today = new Date().toISOString().split('T')[0]

  // Core data
  const [clients, setClients] = useState([])
  const [currentClientId, setCurrentClientId] = useState('')
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(defaultEnd)
  const [searchTerms, setSearchTerms] = useState([])

  // Negative keywords
  const [existingNegatives, setExistingNegatives] = useState([]) // already in Google Ads
  const [dbSavedNegatives, setDbSavedNegatives] = useState([])   // persisted in DB

  // Pending negatives: [{ keyword, matchType, source: 'ai'|'manual', selected }]
  const [pendingNegatives, setPendingNegatives] = useState([])

  // Shared sets (keyword lists) from Google Ads
  const [sharedSets, setSharedSets] = useState([])
  const [selectedSharedSetId, setSelectedSharedSetId] = useState('')

  // AI panel
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [aiStats, setAiStats] = useState(null)
  const [aiLoading, setAiLoading] = useState(false)

  // UI
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [submitSuccess, setSubmitSuccess] = useState('')
  const [submitError, setSubmitError] = useState('')

  // rowNegatives: Map<searchTerm, Set<prefixed-phrase>>
  // Prefixes: 'google:', 'ai:', 'manual:'
  const rowNegatives = useMemo(() => {
    const map = new Map()
    const googleLower = existingNegatives.map(k => k.toLowerCase())

    searchTerms.forEach(term => {
      const termStr = term.searchTerm
      const negatives = new Set()

      // Google Ads negatives
      googleLower.forEach(neg => {
        if (termStr.toLowerCase().includes(neg)) {
          negatives.add('google:' + neg)
        }
      })

      // Pending negatives (ai: or manual:)
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
    setSubmitSuccess('')
    setSubmitError('')
    setError('')
  }

  async function handleClientChange(clientId) {
    setCurrentClientId(clientId)
    resetState()
    if (!clientId) return

    try {
      const [settingsRes, negRes, setsRes] = await Promise.all([
        fetch(`/api/client-settings?clientId=${clientId}`).then(r => r.json()),
        fetch(`/api/negative-keywords?clientId=${clientId}`).then(r => r.json()),
        fetch(`/api/shared-sets?clientId=${clientId}`).then(r => r.json()),
      ])

      const savedNegatives = settingsRes.savedNegatives || []
      const googleNegatives = negRes['Global Negative Keywords'] || []
      const sets = Array.isArray(setsRes) ? setsRes : []

      setDbSavedNegatives(savedNegatives)
      setExistingNegatives(googleNegatives)

      // Use saved URL, or auto-detect from ads if none saved
      if (settingsRes.websiteUrl) {
        setWebsiteUrl(settingsRes.websiteUrl)
      } else {
        fetch(`/api/detect-website?clientId=${clientId}`)
          .then(r => r.json())
          .then(d => { if (d.websiteUrl) setWebsiteUrl(d.websiteUrl) })
          .catch(() => {})
      }
      setSharedSets(sets)
      if (sets.length > 0) setSelectedSharedSetId(sets[0].id)

      // Pre-populate pending negatives from DB-saved ones
      const googleNegLower = new Set(googleNegatives.map(k => k.toLowerCase()))
      const pendingFromDb = savedNegatives
        .filter(kw => !googleNegLower.has(kw.toLowerCase()))
        .map(kw => ({ keyword: kw, matchType: 'EXACT', source: 'manual', selected: true }))

      if (pendingFromDb.length > 0) {
        setPendingNegatives(pendingFromDb)
        setAiStats({})
      }

      await loadSearchTerms(clientId, startDate, endDate, googleNegatives, savedNegatives)
    } catch (err) {
      setError('Error loading client data: ' + err.message)
    }
  }

  async function loadSearchTerms(clientId, start, end, googleNegs, dbNegs) {
    if (!clientId) { setError('Please select a client first'); return }
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
        if (pendingFromDb.length > 0) setAiStats(prev => prev || {})
      }
    } catch (err) {
      setError('Error loading data: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleDateRangeSubmit(e) {
    e.preventDefault()
    setAiStats(null)
    await loadSearchTerms(currentClientId, startDate, endDate)
  }

  // Called when user text-selects a phrase or clicks hover-flag button
  const handleAddManualNegative = useCallback((keyword, matchType = 'EXACT') => {
    const kwLower = keyword.toLowerCase()
    const googleNegLower = new Set(existingNegatives.map(k => k.toLowerCase()))
    if (googleNegLower.has(kwLower)) return

    // Save to DB
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

  // Called when a keyword badge "×" is clicked in a table row
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

  // Called by AIPanel after a successful AI scan
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
      // Move submitted keywords into existingNegatives so the table shows them as green "in Google" badges
      const submittedKeywords = toSubmit.map(item => item.keyword)
      setExistingNegatives(prev => [...prev, ...submittedKeywords])
      setSubmitSuccess(`Keywords submitted with individual match types to "${listName}"`)
      setPendingNegatives([])
    } catch (err) {
      setSubmitError('Submission failed: ' + err.message)
    }
  }

  return (
    <div className="app-wrapper">
      {/* Page header */}
      <div className="app-header">
        <h1 className="app-title">Google Ads — Negative Keyword Tool</h1>
      </div>

      {/* Controls row */}
      <div className="controls-row">
        <div className="control-group">
          <label className="control-label">CLIENT ACCOUNT</label>
          <select
            className="form-select form-select-sm"
            value={currentClientId}
            onChange={e => handleClientChange(e.target.value)}
          >
            <option value="">Select a client</option>
            {clients.map(c => (
              <option key={c.customerId} value={c.customerId}>
                {c.descriptiveName || c.customerId}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label className="control-label">START DATE</label>
          <input
            type="date"
            className="form-control form-control-sm"
            value={startDate}
            max={endDate || today}
            onChange={e => setStartDate(e.target.value)}
          />
        </div>

        <div className="control-group">
          <label className="control-label">END DATE</label>
          <input
            type="date"
            className="form-control form-control-sm"
            value={endDate}
            min={startDate}
            max={today}
            onChange={e => setEndDate(e.target.value)}
          />
        </div>

        <div className="control-group control-group-btn">
          <label className="control-label">&nbsp;</label>
          <button
            className="btn btn-primary btn-sm"
            disabled={!currentClientId}
            onClick={handleDateRangeSubmit}
          >
            Apply date range
          </button>
        </div>
      </div>

      {/* AI Panel */}
      <AIPanel
        currentClientId={currentClientId}
        websiteUrl={websiteUrl}
        setWebsiteUrl={setWebsiteUrl}
        aiStats={aiStats}
        setAiStats={setAiStats}
        aiLoading={aiLoading}
        setAiLoading={setAiLoading}
        searchTerms={searchTerms}
        pendingNegatives={pendingNegatives}
        setPendingNegatives={setPendingNegatives}
        sharedSets={sharedSets}
        selectedSharedSetId={selectedSharedSetId}
        setSelectedSharedSetId={setSelectedSharedSetId}
        onAiResults={handleAiResults}
        onAddManualNegative={handleAddManualNegative}
        onRemoveNegative={handleRemoveNegativeFromRow}
        onSubmitNegatives={handleSubmitNegatives}
        submitSuccess={submitSuccess}
        setSubmitSuccess={setSubmitSuccess}
        submitError={submitError}
        setSubmitError={setSubmitError}
      />

      {/* Error */}
      {error && <div className="alert alert-danger mx-0 mb-3">{error}</div>}

      {/* Loading */}
      {loading && (
        <div className="text-center p-4">
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading…</span>
          </div>
          <p className="mt-2 text-muted">Loading data…</p>
        </div>
      )}

      {/* Search terms table */}
      {!loading && searchTerms.length > 0 && (
        <>
          <h2 className="section-title mb-3">Review your search terms</h2>
          <SearchTermsTable
            searchTerms={searchTerms}
            rowNegatives={rowNegatives}
            onAddNegative={handleAddManualNegative}
            onRemoveNegative={handleRemoveNegativeFromRow}
          />
        </>
      )}
    </div>
  )
}
