import React from 'react'

export default function AiScanProgressIndicator({ loading, progress }) {
  if (!loading) return null

  const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0))
  const label = progress?.label || 'Analyzing search terms…'

  return (
    <div className="ai-scan-progress-toast" role="status" aria-live="polite" aria-busy="true">
      <div className="ai-scan-progress-header">
        <i className="fas fa-spinner fa-spin ai-scan-progress-icon" aria-hidden />
        <span className="ai-scan-progress-title">AI scan in progress</span>
        <span className="ai-scan-progress-percent">{percent}%</span>
      </div>
      <p className="ai-scan-progress-label">{label}</p>
      <div className="ai-scan-progress-track" aria-hidden>
        <div className="ai-scan-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
