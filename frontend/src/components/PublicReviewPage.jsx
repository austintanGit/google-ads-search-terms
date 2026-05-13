import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

function formatNegLabel(keyword, matchType) {
  const mt = String(matchType || 'PHRASE').toUpperCase()
  if (mt === 'EXACT') return `[${keyword}]`
  if (mt === 'PHRASE') return `"${keyword}"`
  return keyword
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
        <div className="review-client-wrap">
          <div className="review-client-panel">
            <div className="review-client-panel__header">
              <div className="spinner-border text-primary spinner-border-sm me-2" aria-hidden />
              Loading your review…
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="public-review-shell">
        <div className="review-client-wrap">
          <div className="review-client-panel">
            <div className="review-client-panel__header">
              <h2 className="review-client-title">Review unavailable</h2>
              <p className="review-client-sub">{error}</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const progressPct = items.length ? Math.round((reviewedCount / items.length) * 100) : 0

  return (
    <div className="public-review-shell">
      <div className="review-client-wrap">
        <StatusMessage status={status} expiresAt={data?.expiresAt} />

        {submitError ? (
          <div className="alert alert-danger mb-3" role="alert">
            {submitError}
          </div>
        ) : null}

        {items.length === 0 ? (
          <div className="review-client-panel">
            <div className="review-client-panel__header">
              <p className="review-client-sub" style={{ margin: 0 }}>
                There are no keywords attached to this review.
              </p>
            </div>
          </div>
        ) : (
          <div className="review-client-panel">
            <div className="review-client-panel__header">
              <h2 className="review-client-title">Review your negative keywords</h2>
              <p className="review-client-sub">
                Your agency flagged these search terms as potential negatives for your Google Ads. For each
                one, let us know if it&apos;s relevant to your business or not. By providing this insight,
                we&apos;ll be able to improve your Google Ads account.
              </p>
              {isPending && data?.expiresAt ? (
                <p className="review-client-sub review-client-sub--muted">
                  This link expires on {new Date(data.expiresAt).toLocaleString()} and can only be submitted
                  once.
                </p>
              ) : null}
            </div>

            {isPending && items.length > 0 ? (
              <>
                <hr className="review-client-panel__divider" />
                <div className="review-client-progress">
                  <span className="review-client-progress-label">
                    {reviewedCount} of {items.length} reviewed
                  </span>
                  <div className="review-client-progress-track">
                    <div
                      className={`review-client-progress-fill${allReviewed ? ' is-complete' : ''}`}
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
                <div className="review-client-colhead" aria-hidden>
                  <span className="review-client-colhead-spacer" />
                  <span className="review-client-colhead-flagged">Flagged search term</span>
                  <span className="review-client-colhead-decision">Your decision</span>
                </div>
              </>
            ) : null}

            <div className="review-client-rows">
              {items.map((item) => {
                const choice = choices[item.id]
                return (
                  <article key={item.id} className="review-client-row">
                    <input
                      type="checkbox"
                      className="review-client-row-check"
                      checked={!!choice}
                      onChange={() => {}}
                      tabIndex={-1}
                      aria-label={choice ? 'Reviewed' : 'Not yet reviewed'}
                    />
                    <div className="review-client-row-term">{formatNegLabel(item.keyword, item.matchType)}</div>
                    <div className="review-client-row-actions">
                      <button
                        type="button"
                        className={`review-client-btn${choice === 'block' ? ' is-active' : ''}`}
                        disabled={isLocked}
                        onClick={() => setChoices((prev) => ({ ...prev, [item.id]: 'block' }))}
                      >
                        Not relevant to my business
                      </button>
                      <button
                        type="button"
                        className={`review-client-btn${choice === 'keep' ? ' is-active' : ''}`}
                        disabled={isLocked}
                        onClick={() => setChoices((prev) => ({ ...prev, [item.id]: 'keep' }))}
                      >
                        This could be a customer
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>

            {isPending && items.length > 0 ? (
              <div className="review-client-footer">
                <button
                  type="button"
                  className="review-client-submit"
                  disabled={!allReviewed || submitting || isLocked}
                  onClick={submitDecisions}
                >
                  {submitting ? 'Submitting…' : 'Submit my review'}
                </button>
                <span className="review-client-submit-hint">
                  {!allReviewed
                    ? 'Review all keywords to submit.'
                    : 'Your strategist will confirm before anything is sent to Google Ads.'}
                </span>
              </div>
            ) : null}
          </div>
        )}

        {submitResult ? (
          <div className="review-client-panel mt-3">
            <div className="review-client-panel__header">
              <h3 className="review-client-title" style={{ fontSize: '1.15rem' }}>
                Review submitted
              </h3>
              <p className="review-client-sub" style={{ margin: 0 }}>
                Thanks — your strategist has been notified. They will finalize the changes in Google Ads.
                Not relevant: <strong>{submitResult.blockCount}</strong> · Could be a customer:{' '}
                <strong>{submitResult.keepCount}</strong>
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
