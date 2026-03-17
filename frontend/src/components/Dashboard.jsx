import React from 'react';
import MetricsRow from './MetricsRow';
import NinetyDayPlan from './NinetyDayPlan';
import './Dashboard.css';

const START_DATE = new Date('2026-03-16');

export default function Dashboard({ queueData }) {
  const today = new Date();
  const dayCount = Math.max(0, Math.floor((today - START_DATE) / (1000 * 60 * 60 * 24)));
  const dateStr = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="dashboard">
      <div className="dashboard-greeting">
        <h1 className="greeting-text">Morning, Nick.</h1>
        <p className="greeting-meta">{dateStr} — Day {dayCount}</p>
      </div>

      <MetricsRow queueData={queueData} />

      <NinetyDayPlan />
    </div>
  );
}
