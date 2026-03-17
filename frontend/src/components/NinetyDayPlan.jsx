import React from 'react';
import './NinetyDayPlan.css';

const START_DATE = new Date('2026-03-16');

const PHASES = [
  { label: 'Phase 1: Visibility & Baseline', start: 0, end: 30,
    goals: ['Establish baseline metrics', 'Understand current queue performance', 'Map team capabilities', 'Build relationships with Engineering leads'] },
  { label: 'Phase 2: Tiered Support & QA', start: 30, end: 60,
    goals: ['Implement tiered support model', 'Strengthen Engineering relationship', 'Build QA framework', 'Define escalation paths'] },
  { label: 'Phase 3: Optimise & Evidence', start: 60, end: 90,
    goals: ['Optimise workflows based on data', 'Evidence progress to leadership', 'Embed continuous improvement', 'Solidify team structure'] }
];

export default function NinetyDayPlan() {
  const today = new Date();
  const dayCount = Math.max(0, Math.floor((today - START_DATE) / (1000 * 60 * 60 * 24)));
  const overallProgress = Math.min(100, (dayCount / 90) * 100);

  return (
    <div className="plan-container">
      <h2 className="plan-title">90-Day Plan</h2>
      <div className="plan-meta">
        <span>Day {dayCount} of 90</span>
        <span>{Math.round(overallProgress)}% complete</span>
      </div>

      <div className="plan-progress-bar">
        <div className="plan-progress-fill" style={{ width: `${overallProgress}%` }} />
        {PHASES.map((phase, i) => (
          <div key={i} className="plan-phase-marker" style={{ left: `${(phase.end / 90) * 100}%` }}>
            <span className="phase-marker-label">D{phase.end}</span>
          </div>
        ))}
      </div>

      <div className="plan-phases">
        {PHASES.map((phase, i) => {
          const isActive = dayCount >= phase.start && dayCount < phase.end;
          const isComplete = dayCount >= phase.end;
          const phaseProgress = isComplete ? 100 : isActive ? ((dayCount - phase.start) / (phase.end - phase.start)) * 100 : 0;

          return (
            <div key={i} className={`plan-phase ${isActive ? 'active' : ''} ${isComplete ? 'complete' : ''}`}>
              <div className="phase-header">
                <h3 className="phase-label">{phase.label}</h3>
                <span className="phase-status">
                  {isComplete ? 'Complete' : isActive ? `${Math.round(phaseProgress)}%` : 'Upcoming'}
                </span>
              </div>
              <ul className="phase-goals">
                {phase.goals.map((goal, j) => (
                  <li key={j}>{goal}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
