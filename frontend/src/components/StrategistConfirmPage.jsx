import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

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

function statusCopy(status) {
  switch (status) {
    case 'pending_client':
      return 'Waiting for client to submit their review.'
    case 'client_submitted':
      return 'Client submitted their review — confirm or reject below.'
    case 'expired':
      return 'This review link has expired before the client submitted.'
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

  const items = data?.items || []
  const blockItems = useMemo(() => items.filter((it) => it.decision === 'block'), [items])
  const keepItems = useMemo(() => items.filter((it) => it.decision === 'keep'), [items])
  const undecided = useMemo(() => items.filter((it) => !it.decision), [items])
  const status = data?.status || ''
  const canFinalize = status === 'client_submitted'
  const canReject = status === 'client_submitted' || status === 'pending_client'
  const actionsLocked = actionPending !== '' || patchingItemId !== null

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

  if (loading) {
    return (
      <div className="review-clean-wrap" style={{ padding: '24px 16px' }}>
        <div className="review-clean-header-card">
          <div className="spinner-border text-primary spinner-border-sm me-2" aria-hidden />
          Loading review…
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="review-clean-wrap" style={{ padding: '24px 16px' }}>
        <div className="alert alert-danger" role="alert">{error}</div>
        <button className="btn btn-outline-secondary btn-sm" onClick={() => navigate('/negative-keywords')}>
          Back to negative keywords
        </button>
      </div>
    )
  }

  return (
    <div className="review-clean-wrap" style={{ padding: '24px 16px' }}>
      <section className="review-clean-header-card">
        <h2 className="review-clean-title">Confirm client review</h2>
        {data?.clientName ? (
          <p className="review-clean-sub">
            <strong>{data.clientName}</strong>
          </p>
        ) : null}
        <p className="review-clean-sub" style={{ margin: 0 }}>
          Status: <strong>{status.replace(/_/g, ' ')}</strong> — {statusCopy(status)}
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 12, fontSize: '0.9rem', color: '#4b5563' }}>
          <span>
            Block: <strong>{blockItems.length}</strong>
          </span>
          <span>
            Keep: <strong>{keepItems.length}</strong>
          </span>
          {undecided.length > 0 ? (
            <span>
              Undecided: <strong>{undecided.length}</strong>
            </span>
          ) : null}
        </div>
        {canFinalize && blockItems.length === 0 ? (
          <p
            className="review-clean-sub"
            style={{ marginTop: 10, marginBottom: 0, fontSize: '0.85rem', color: '#6b7280' }}
          >
            Only terms marked <strong style={{ fontWeight: 600 }}>block</strong> are pushed to Google Ads.
            If you still want a term the client kept, use <strong>Add as negative</strong> on that row below.
          </p>
        ) : null}
      </section>

      {actionError ? <div className="alert alert-danger" role="alert">{actionError}</div> : null}
      {actionResult?.kind === 'finalized' ? (
        <div className="alert alert-success" role="alert">
          Submitted to Google Ads — {actionResult.body?.summary || `${actionResult.body?.blockCount || 0} blocked`}.
        </div>
      ) : null}
      {actionResult?.kind === 'rejected' ? (
        <div className="alert alert-info" role="alert">
          Review rejected. Nothing was submitted to Google Ads.
        </div>
      ) : null}

      {blockItems.length > 0 ? (
        <div className="review-clean-list" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '0.85rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Will block ({blockItems.length})
          </div>
          {blockItems.map((it) => (
            <article key={`b-${it.id}`} className="review-clean-item">
              <div>
                <div className="review-clean-item-kw">{formatNegLabel(it.keyword, it.matchType)}</div>
                <div className="review-clean-item-meta">{destLabel(it)}</div>
              </div>
              <div className="review-clean-item-actions">
                {canFinalize ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    disabled={actionsLocked}
                    onClick={() => patchItemDecision(it.id, 'keep')}
                  >
                    {patchingItemId === it.id ? 'Updating…' : "Don't add"}
                  </button>
                ) : null}
                <span className="badge bg-danger-subtle text-danger" style={{ alignSelf: 'center' }}>
                  Block
                </span>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {keepItems.length > 0 ? (
        <div className="review-clean-list" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '0.85rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Client kept ({keepItems.length})
          </div>
          {keepItems.map((it) => (
            <article key={`k-${it.id}`} className="review-clean-item">
              <div>
                <div className="review-clean-item-kw">{formatNegLabel(it.keyword, it.matchType)}</div>
                <div className="review-clean-item-meta">{destLabel(it)}</div>
              </div>
              <div className="review-clean-item-actions">
                {canFinalize ? (
                  <button
                    type="button"
                    className="btn btn-sm review-clean-btn-block"
                    disabled={actionsLocked}
                    onClick={() => patchItemDecision(it.id, 'block')}
                  >
                    {patchingItemId === it.id ? 'Updating…' : 'Add as negative'}
                  </button>
                ) : null}
                <span className="badge bg-success-subtle text-success" style={{ alignSelf: 'center' }}>
                  Keep
                </span>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {undecided.length > 0 ? (
        <div className="review-clean-list" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '0.85rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            No decision ({undecided.length})
          </div>
          {undecided.map((it) => (
            <article key={`u-${it.id}`} className="review-clean-item">
              <div>
                <div className="review-clean-item-kw">{formatNegLabel(it.keyword, it.matchType)}</div>
                <div className="review-clean-item-meta">{destLabel(it)}</div>
              </div>
              <div className="review-clean-item-actions">
                {canFinalize ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm review-clean-btn-block"
                      disabled={actionsLocked}
                      onClick={() => patchItemDecision(it.id, 'block')}
                    >
                      {patchingItemId === it.id ? '…' : 'Block'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm review-clean-btn-keep"
                      disabled={actionsLocked}
                      onClick={() => patchItemDecision(it.id, 'keep')}
                    >
                      {patchingItemId === it.id ? '…' : 'Keep'}
                    </button>
                  </>
                ) : (
                  <span className="badge bg-secondary" style={{ alignSelf: 'center' }}>—</span>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : null}

      <div className="review-clean-submit-row">
        <button
          type="button"
          className="btn btn-success"
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
          className="btn btn-outline-danger"
          disabled={!canReject || actionsLocked}
          onClick={reject}
        >
          {actionPending === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          type="button"
          className="btn btn-outline-secondary"
          onClick={() => navigate('/negative-keywords')}
        >
          Back to dashboard
        </button>
      </div>
    </div>
  )
}
