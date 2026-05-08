import React from 'react'

export default function AIScanTablePlaceholder({ clientName }) {
  return (
    <div
      className="review-dashboard-card ai-scan-table-placeholder"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="ai-scan-ph-header">
        <h2 className="ai-scan-ph-title">
          Review your search terms{clientName ? ` — ${clientName}` : ''}
        </h2>
        <p className="ai-scan-ph-sub">Hang tight while AI finishes scanning your site.</p>
      </div>
      <div className="ai-scan-ph-body">
        <div className="ai-scan-ph-orbit" aria-hidden>
          <div className="ai-scan-ph-dot" />
        </div>
        <p className="ai-scan-ph-status">Analyzing search terms with AI…</p>
        <div className="ai-scan-ph-skeleton" aria-hidden>
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} className="ai-scan-ph-skel-row" style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      </div>
    </div>
  )
}
