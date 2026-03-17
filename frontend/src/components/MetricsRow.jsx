import React from 'react';
import './MetricsRow.css';

export default function MetricsRow({ queueData }) {
  const atRisk = queueData?.at_risk_count ?? '-';
  const total = queueData?.total ?? '-';
  const p1s = queueData?.open_p1s ?? '-';
  const configured = queueData?.configured;

  if (!configured) {
    return (
      <div className="metrics-row">
        <div className="metric-card muted">
          <span className="metric-label">Jira not configured</span>
        </div>
      </div>
    );
  }

  return (
    <div className="metrics-row">
      <div className={`metric-card ${atRisk > 0 ? 'danger' : ''}`}>
        <span className="metric-value">{atRisk}</span>
        <span className="metric-label">SLA at risk</span>
      </div>
      <div className="metric-card">
        <span className="metric-value">{total}</span>
        <span className="metric-label">Queue depth</span>
      </div>
      <div className={`metric-card ${p1s > 0 ? 'warning' : ''}`}>
        <span className="metric-value">{p1s}</span>
        <span className="metric-label">Open P1s</span>
      </div>
      <div className="metric-card">
        <span className="metric-value">-</span>
        <span className="metric-label">Resolved today</span>
      </div>
    </div>
  );
}
