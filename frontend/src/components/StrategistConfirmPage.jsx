import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

const AGENCY_NAME = import.meta.env.VITE_AGENCY_NAME || 'The Media Captain'

const authedFetch = (url, options = {}) => {
  const token = localStorage.getItem('authToken')
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
}

function formatNegLabel(keyword, matchType) {
  const mt = String(matchType || 'PHRASE').toUpperCase()
  if (mt === 'EXACT') return `[${keyword}]`
  if (mt === 'PHRASE') return `"${keyword}"`
  return keyword
}

function destLabel(item) {
  const dest = item?.destination || 'NEGATIVE_LIST'
  if (dest === 'NEGATIVE_LIST') return 'Keyword list'
  if (dest === 'CAMPAIGN') return item?.campaignName ? `Campaign: ${item.campaignName}` : 'Campaign level'
  if (dest === 'ADGROUP') {
    return item?.adGroupName
      ? `Ad group: ${item.adGroupName}${item.campaignName ? ` (${item.campaignName})` : ''}`
      : 'Ad group level'
  }
  return ''
}

function matchTypeLabel(matchType) {
  const mt = String(matchType || 'PHRASE').toUpperCase()
  if (mt === 'EXACT') return 'Exact match'
  if (mt === 'PHRASE') return 'Phrase match'
  return 'Broad match'
}

function sourceChipLabel(item) {
  const raw = item?.sourceMeta?.source
  if (raw === 'ai') return 'AI scanner'
  if (raw === 'manual') return 'Manual'
  if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim()
    return s.charAt(0).toUpperCase() + s.slice(1)
  }
  return destLabel(item)
}

function statusCopy(status) {
  switch (status) {
    case 'pending_client':
      return 'Waiting for the client to submit their review.'
    case 'client_submitted':
      return 'The client has submitted — review their responses and finalize below.'
    case 'expired':
      return 'This review link expired before the client submitted.'
    case 'cancelled':
      return 'This review was cancelled.'
    case 'approved_by_strategist':
      return 'Already finalized — block decisions were submitted to Google Ads.'
    case 'rejected_by_strategist':
      return 'You rejected this review. No changes were sent to Google Ads.'
    default:
      return ''
  }
}

function formatSubmittedDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  } catch {
    return ''
  }
}

/** Client’s answer; falls back to `decision` only on legacy rows before `client_decision` existed. */
function clientDecisionForDisplay(it) {
  return it.clientDecision ?? it.decision
}

function agencySelectionLabel(decision) {
  if (decision === 'block') return 'Add negative to Google Ads'
  if (decision === 'keep') return "Don't add as a negative"
  return ''
}

export default function StrategistConfirmPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [actionPending, setActionPending] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionResult, setActionResult] = useState(null)
  const [patchingItemId, setPatchingItemId] = useState(null)
  const [focusedItemId, setFocusedItemId] = useState(null)

  async function reload() {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const r = await authedFetch(`/api/review-requests/${id}`)
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || `Failed to load (${r.status})`)
      setData(body)
    } catch (err) {
      setError(err.message || 'Failed to load review request.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const items = useMemo(() => {
    const list = data?.items || []
    return [...list].sort((a, b) => Number(a.id) - Number(b.id))
  }, [data?.items])

  const blockItems = useMemo(() => items.filter((it) => it.decision === 'block'), [items])
  const clientBlockItems = useMemo(
    () => items.filter((it) => clientDecisionForDisplay(it) === 'block'),
    [items],
  )
  const clientKeepItems = useMemo(
    () => items.filter((it) => clientDecisionForDisplay(it) === 'keep'),
    [items],
  )
  const undecided = useMemo(() => items.filter((it) => !it.decision), [items])
  const status = data?.status || ''
  const canFinalize = status === 'client_submitted'
  const canReject = status === 'client_submitted' || status === 'pending_client'
  const actionsLocked = actionPending !== '' || patchingItemId !== null

  useEffect(() => {
    if (focusedItemId == null) return
    if (!items.some((it) => Number(it.id) === Number(focusedItemId))) {
      setFocusedItemId(null)
    }
  }, [items, focusedItemId])

  async function patchItemDecision(itemId, decision) {
    if (!canFinalize) return
    setPatchingItemId(itemId)
    setActionError('')
    try {
      const r = await authedFetch(`/api/review-requests/${id}/items/${itemId}/decision`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || body?.details || `Update failed (${r.status})`)
      await reload()
    } catch (err) {
      setActionError(err.message || 'Could not update decision.')
    } finally {
      setPatchingItemId(null)
    }
  }

  async function finalize() {
    if (!canFinalize) return
    const confirmMsg =
      blockItems.length > 0
        ? `Finalize and submit ${blockItems.length} blocked keyword${blockItems.length === 1 ? '' : 's'} to Google Ads?`
        : 'Finalize this review? No terms were marked to block — nothing new will be added to Google Ads (this just closes the review).'
    if (!window.confirm(confirmMsg)) return
    setActionPending('finalize')
    setActionError('')
    try {
      const r = await authedFetch(`/api/review-requests/${id}/finalize`, { method: 'POST' })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.details || body?.error || `Finalize failed (${r.status})`)
      setActionResult({ kind: 'finalized', body })
      await reload()
    } catch (err) {
      setActionError(err.message || 'Finalize failed.')
    } finally {
      setActionPending('')
    }
  }

  async function reject() {
    if (!canReject) return
    if (!window.confirm('Reject this review? Nothing will be submitted to Google Ads.')) return
    setActionPending('reject')
    setActionError('')
    try {
      const r = await authedFetch(`/api/review-requests/${id}/reject`, { method: 'POST' })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || `Reject failed (${r.status})`)
      setActionResult({ kind: 'rejected', body })
      await reload()
    } catch (err) {
      setActionError(err.message || 'Reject failed.')
    } finally {
      setActionPending('')
    }
  }

  function toggleRowFocus(itemId, ev) {
    ev.stopPropagation()
    setFocusedItemId((prev) => (prev === itemId ? null : itemId))
  }

  if (loading) {
    return (
      <div className="review-agency-wrap">
        <div className="review-client-panel">
          <div className="review-client-panel__header">
            <div className="spinner-border text-primary spinner-border-sm me-2" aria-hidden />
            Loading review…
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="review-agency-wrap">
        <div className="alert alert-danger" role="alert">{error}</div>
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => navigate('/negative-keywords')}>
          Back to negative keywords
        </button>
      </div>
    )
  }

  const submittedDateStr = formatSubmittedDate(data?.submittedAt)
  const showSubmittedBanner = canFinalize && submittedDateStr

  const instruction =
    status === 'client_submitted'
      ? 'Your client has reviewed these keywords and submitted their decisions. Review their responses below and finalize.'
      : status === 'pending_client'
        ? 'This review is waiting on your client. When they submit the link, you can confirm their responses and finalize here.'
        : 'Review the keywords and status for this request.'

  return (
    <div className="review-agency-wrap">
      <p className="review-agency-brand">{AGENCY_NAME}</p>
      <h1 className="review-agency-title">Confirm client review</h1>
      <p className="review-agency-instruction">{instruction}</p>

      {showSubmittedBanner ? (
        <div className="review-agency-banner" role="status">
          <span className="review-agency-banner-icon" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path d="M8.5 12.5l2.5 2.5 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>Client submitted their review on {submittedDateStr}</span>
        </div>
      ) : null}

      {!canFinalize ? (
        <p className="review-agency-status-note">
          <strong>Status:</strong> {status.replace(/_/g, ' ')} — {statusCopy(status)}
        </p>
      ) : null}

      {canFinalize && items.length > 0 ? (
        <div className="review-agency-summary">
          <span>
            Not relevant to their business: <strong>{clientBlockItems.length}</strong>
          </span>
          <span>
            Could be a customer: <strong>{clientKeepItems.length}</strong>
          </span>
          <span>
            Your selections — add as negative: <strong>{blockItems.length}</strong>
          </span>
          {undecided.length > 0 ? (
            <span>
              No agency selection yet: <strong>{undecided.length}</strong>
            </span>
          ) : null}
        </div>
      ) : null}

      {canFinalize && blockItems.length === 0 ? (
        <p className="review-agency-status-note" style={{ marginTop: 12 }}>
          Only terms marked <strong>Add Negative to Google Ads</strong> are pushed to Google Ads. If you still want
          a term the client kept, choose that action on the row below.
        </p>
      ) : null}

      {actionError ? <div className="alert alert-danger mt-3" role="alert">{actionError}</div> : null}
      {actionResult?.kind === 'finalized' ? (
        <div className="alert alert-success mt-3" role="alert">
          Submitted to Google Ads — {actionResult.body?.summary || `${actionResult.body?.blockCount || 0} blocked`}.
        </div>
      ) : null}
      {actionResult?.kind === 'rejected' ? (
        <div className="alert alert-info mt-3" role="alert">
          Review rejected. Nothing was submitted to Google Ads.
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="review-agency-panel">
          {canFinalize ? (
            <div className="review-agency-colhead" aria-hidden>
              <span className="review-agency-colhead-spacer" />
              <span className="review-agency-colhead-term">Flagged search term</span>
              <span className="review-agency-colhead-action">Action</span>
            </div>
          ) : (
            <div className="review-agency-colhead" aria-hidden>
              <span className="review-agency-colhead-spacer" />
              <span className="review-agency-colhead-term">Flagged search term</span>
              <span className="review-agency-colhead-action">Status</span>
            </div>
          )}
          <div className="review-agency-rows">
            {items.map((it) => {
              const isFocused = canFinalize && focusedItemId != null && Number(focusedItemId) === Number(it.id)
              const dec = it.decision
              const clientDec = clientDecisionForDisplay(it)
              const agencyLabel = agencySelectionLabel(dec)
              return (
                <article
                  key={it.id}
                  className={`review-agency-row${canFinalize ? ' review-agency-row--selectable' : ''}${isFocused ? ' is-focused' : ''}`}
                  onClick={() => {
                    if (canFinalize) setFocusedItemId(it.id)
                  }}
                >
                  <input
                    type="checkbox"
                    className="review-agency-row-check"
                    checked={isFocused}
                    disabled={!canFinalize}
                    onChange={(ev) => toggleRowFocus(it.id, ev)}
                    onClick={(ev) => ev.stopPropagation()}
                    aria-label="Highlight row"
                  />
                  <div className="review-agency-row-body">
                    <div className="review-agency-row-kw">{formatNegLabel(it.keyword, it.matchType)}</div>
                    <div className="review-agency-row-meta">
                      <span>{matchTypeLabel(it.matchType)}</span>
                      <span className="review-agency-chip">{sourceChipLabel(it)}</span>
                    </div>
                    <div className="review-agency-badge-stack">
                      {clientDec === 'block' ? (
                        <div className="review-agency-badge review-agency-badge--block">
                          <span aria-hidden>✕</span>
                          Client: Not relevant to my business
                        </div>
                      ) : clientDec === 'keep' ? (
                        <div className="review-agency-badge review-agency-badge--keep">
                          <span aria-hidden>▲</span>
                          Client: This could be a customer
                        </div>
                      ) : (
                        <div className="review-agency-badge review-agency-badge--none">No client decision yet</div>
                      )}
                      {agencyLabel ? (
                        <div className="review-agency-badge review-agency-badge--agency">
                          <span aria-hidden>◆</span>
                          {AGENCY_NAME}: {agencyLabel}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="review-agency-row-actions" onClick={(ev) => ev.stopPropagation()}>
                    {canFinalize ? (
                      patchingItemId === it.id ? (
                        <span className="text-muted small" style={{ alignSelf: 'center' }}>
                          Saving…
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="review-agency-action-btn"
                            disabled={actionsLocked}
                            onClick={() => patchItemDecision(it.id, 'keep')}
                          >
                            Don&apos;t add
                          </button>
                          <button
                            type="button"
                            className="review-agency-action-btn"
                            disabled={actionsLocked}
                            onClick={() => patchItemDecision(it.id, 'block')}
                          >
                            Add Negative to Google Ads
                          </button>
                        </>
                      )
                    ) : (
                      <span className="text-muted small" style={{ alignSelf: 'center' }}>
                        {dec === 'block' ? 'Negative (final)' : dec === 'keep' ? 'Not added (final)' : '—'}
                      </span>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        </div>
      ) : (
        <p className="review-agency-status-note">No keywords on this review.</p>
      )}

      <div className="review-agency-footer">
        <button
          type="button"
          className="review-agency-footer-finalize"
          disabled={!canFinalize || actionsLocked}
          onClick={finalize}
        >
          {actionPending === 'finalize'
            ? 'Submitting to Google Ads…'
            : blockItems.length > 0
              ? `Finalize — add ${blockItems.length} negative${blockItems.length === 1 ? '' : 's'}`
              : 'Finalize review (no negatives to add)'}
        </button>
        <button
          type="button"
          className="review-agency-footer-secondary"
          disabled={!canReject || actionsLocked}
          onClick={reject}
        >
          {actionPending === 'reject' ? 'Rejecting…' : 'Reject all'}
        </button>
        <button type="button" className="review-agency-footer-secondary" onClick={() => navigate('/negative-keywords')}>
          Back to dashboard
        </button>
      </div>
    </div>
  )
}
