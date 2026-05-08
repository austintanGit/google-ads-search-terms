import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

function formatNegLabel(keyword, matchType) {
  const mt = String(matchType || 'PHRASE').toUpperCase()
  if (mt === 'EXACT') return `[${keyword}]`
  if (mt === 'PHRASE') return `"${keyword}"`
  return keyword
}

function destLabel(item) {
  const dest = item?.destination || 'NEGATIVE_LIST'
  if (dest === 'NEGATIVE_LIST') return 'Keyword list'
  if (dest === 'CAMPAIGN') {
    return item?.campaignName ? `Campaign: ${item.campaignName}` : 'Campaign level'
  }
  if (dest === 'ADGROUP') {
    return item?.adGroupName
      ? `Ad group: ${item.adGroupName}${item.campaignName ? ` (${item.campaignName})` : ''}`
      : 'Ad group level'
  }
  return ''
}

function StatusMessage({ status, expiresAt }) {
  if (status === 'expired') {
    return (
      <div className="alert alert-warning" role="alert">
        This review link has expired{expiresAt ? ` on ${new Date(expiresAt).toLocaleString()}` : ''}.
        Please ask your strategist to send a new link.
      </div>
    )
  }
  if (status === 'cancelled') {
    return (
      <div className="alert alert-warning" role="alert">
        This review was cancelled by your strategist. Please contact them for a new link.
      </div>
    )
  }
  if (status === 'client_submitted') {
    return (
      <div className="alert alert-success" role="alert">
        Thanks — your review has been submitted. Your strategist will confirm and finalize the changes in
        Google Ads.
      </div>
    )
  }
  if (status === 'approved_by_strategist') {
    return (
      <div className="alert alert-success" role="alert">
        Your strategist has finalized this review and submitted the chosen negatives to Google Ads.
      </div>
    )
  }
  if (status === 'rejected_by_strategist') {
    return (
      <div className="alert alert-info" role="alert">
        Your strategist closed this review without submitting any changes to Google Ads.
      </div>
    )
  }
  return null
}

export default function PublicReviewPage() {
  const [searchParams] = useSearchParams()
  const token = (searchParams.get('t') || '').trim()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState(null)
  const [choices, setChoices] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitResult, setSubmitResult] = useState(null)

  useEffect(() => {
    if (!token) {
      setError('This review link is missing its token. Ask your strategist to resend the link.')
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    fetch(`/api/public/review?token=${encodeURIComponent(token)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body?.error || `Failed to load review (${r.status})`)
        return body
      })
      .then((body) => {
        if (cancelled) return
        setData(body)
        const seed = {}
        for (const it of body.items || []) seed[it.id] = null
        setChoices(seed)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message || 'Failed to load review.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const items = data?.items || []
  const reviewedCount = useMemo(
    () => items.filter((it) => choices[it.id]).length,
    [items, choices],
  )
  const allReviewed = items.length > 0 && reviewedCount === items.length
  const status = data?.status || ''
  const isPending = status === 'pending_client'
  const isLocked = !isPending || !!submitResult

  async function submitDecisions() {
    if (!isPending) return
    if (!allReviewed) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const decisions = items.map((it) => ({ itemId: it.id, decision: choices[it.id] }))
      const r = await fetch('/api/public/review/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, decisions }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || `Failed to submit review (${r.status})`)
      setSubmitResult(body)
      setData((prev) => (prev ? { ...prev, status: 'client_submitted' } : prev))
    } catch (err) {
      setSubmitError(err.message || 'Failed to submit review.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="public-review-shell">
        <div className="review-clean-wrap">
          <div className="review-clean-header-card">
            <div className="spinner-border text-primary spinner-border-sm me-2" aria-hidden />
            Loading your review…
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="public-review-shell">
        <div className="review-clean-wrap">
          <div className="review-clean-header-card">
            <h2 className="review-clean-title">Review unavailable</h2>
            <p className="review-clean-sub">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="public-review-shell">
      <div className="review-clean-wrap">
        <section className="review-clean-header-card">
          <h2 className="review-clean-title">Review your negative keywords</h2>
          <p className="review-clean-sub">
            {data?.requestedByName || data?.requestedByEmail || 'Your agency'} flagged these search terms
            as potential negatives for{' '}
            <strong>{data?.clientName || 'your Google Ads account'}</strong>. Choose whether to block each
            one or keep it. Your strategist will confirm before anything is added to Google Ads.
          </p>
          {isPending && data?.expiresAt ? (
            <p className="review-clean-sub" style={{ fontSize: '0.85rem', color: '#9ca3af' }}>
              This link expires on {new Date(data.expiresAt).toLocaleString()} and can only be submitted
              once.
            </p>
          ) : null}
          {isPending && items.length > 0 ? (
            <div className="review-clean-progress-row">
              <div className="review-clean-progress-track">
                <div
                  className="review-clean-progress-fill"
                  style={{ width: `${Math.round((reviewedCount / items.length) * 100)}%` }}
                />
              </div>
              <span className="review-clean-progress-label">
                {reviewedCount} of {items.length} reviewed
              </span>
            </div>
          ) : null}
        </section>

        <StatusMessage status={status} expiresAt={data?.expiresAt} />

        {submitError ? (
          <div className="alert alert-danger" role="alert">
            {submitError}
          </div>
        ) : null}

        {items.length === 0 ? (
          <div className="review-clean-header-card">
            <p className="review-clean-sub" style={{ margin: 0 }}>
              There are no keywords attached to this review.
            </p>
          </div>
        ) : (
          <div className="review-clean-list">
            {items.map((item) => {
              const choice = choices[item.id]
              return (
                <article key={item.id} className="review-clean-item">
                  <div>
                    <div className="review-clean-item-kw">
                      {formatNegLabel(item.keyword, item.matchType)}
                    </div>
                    <div className="review-clean-item-meta">
                      {String(item.matchType || 'PHRASE').toLowerCase()} match · {destLabel(item)}
                    </div>
                  </div>
                  <div className="review-clean-item-actions">
                    <button
                      type="button"
                      className={`btn btn-sm review-clean-btn-block${
                        choice === 'block' ? ' is-active' : ''
                      }`}
                      disabled={isLocked}
                      onClick={() =>
                        setChoices((prev) => ({ ...prev, [item.id]: 'block' }))
                      }
                    >
                      Block it
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm review-clean-btn-keep${
                        choice === 'keep' ? ' is-active' : ''
                      }`}
                      disabled={isLocked}
                      onClick={() =>
                        setChoices((prev) => ({ ...prev, [item.id]: 'keep' }))
                      }
                    >
                      Keep it
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}

        {isPending && items.length > 0 ? (
          <div className="review-clean-submit-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!allReviewed || submitting || isLocked}
              onClick={submitDecisions}
            >
              {submitting ? 'Submitting…' : 'Submit review'}
            </button>
            <span className="review-clean-submit-hint">
              {!allReviewed
                ? 'Review every keyword to enable submit.'
                : 'Your strategist will confirm before anything is sent to Google Ads.'}
            </span>
          </div>
        ) : null}

        {submitResult ? (
          <div className="review-clean-header-card" style={{ marginTop: 16 }}>
            <h3 style={{ marginTop: 0, fontSize: '1.1rem', color: '#111827' }}>Review submitted</h3>
            <p className="review-clean-sub" style={{ margin: 0 }}>
              Thanks — your strategist has been notified. They will finalize the changes in Google Ads.
              Block: <strong>{submitResult.blockCount}</strong> · Keep:{' '}
              <strong>{submitResult.keepCount}</strong>
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
