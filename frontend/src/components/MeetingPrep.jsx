import React, { useState } from 'react';
import useCachedFetch from '../useCachedFetch';
import './MeetingPrep.css';

export default function MeetingPrep() {
  const { data, status, refresh } = useCachedFetch('/api/meeting-prep', { interval: 60000 });
  const [showAll, setShowAll] = useState(false);
  const { data: allData } = useCachedFetch(
    showAll ? '/api/meeting-prep/all' : null,
    { interval: 60000 }
  );

  const meeting = data?.meeting;
  const laterToday = data?.laterToday || [];

  if (!meeting) {
    return (
      <div className="prep-container">
        <div className="prep-header">
          <h2 className="prep-title">Meeting Prep</h2>
          <button className="btn btn-secondary" onClick={refresh}>Refresh</button>
        </div>
        <div className="prep-empty">
          <div className="prep-empty-icon">📅</div>
          <div className="prep-empty-text">No upcoming meetings</div>
          <div className="prep-empty-sub">Next 4 hours are clear.</div>
        </div>
      </div>
    );
  }

  const prep = meeting.prep || {};
  const imminent = meeting.minutesAway <= 15;

  return (
    <div className="prep-container">
      <div className="prep-header">
        <h2 className="prep-title">Meeting Prep</h2>
        <button className="btn btn-secondary" onClick={refresh}>Refresh</button>
      </div>

      {/* Next meeting card */}
      <div className={`prep-meeting-card ${imminent ? 'prep-imminent' : ''}`}>
        <div className="prep-meeting-time">
          {imminent ? `Starting in ${meeting.minutesAway} min` : `In ${meeting.minutesAway} min`}
          <span className="prep-meeting-slot">{meeting.startFormatted}–{meeting.endFormatted}</span>
        </div>
        <h3 className="prep-meeting-subject">{meeting.subject}</h3>
        {meeting.location && (
          <div className="prep-meeting-location">{meeting.location}</div>
        )}
      </div>

      {/* Attendees */}
      {prep.attendees && prep.attendees.length > 0 && (
        <div className="prep-section">
          <div className="prep-section-title">People</div>
          {prep.attendees.map((att, i) => (
            <div key={i} className="prep-person">
              <div className="prep-person-header">
                <span className="prep-person-name">{att.name}</span>
                {att.role && <span className="prep-person-role">{att.role}</span>}
              </div>
              {att.last121 && (
                <div className="prep-person-meta">Last 1-2-1: {att.last121}</div>
              )}
              {att.recentNotes && (
                <div className="prep-person-notes">{att.recentNotes}</div>
              )}
              {att.tags && att.tags.length > 0 && (
                <div className="prep-person-tags">
                  {att.tags.map(t => <span key={t} className="prep-tag">{t}</span>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Suggested topics */}
      {prep.suggestedTopics && prep.suggestedTopics.length > 0 && (
        <div className="prep-section">
          <div className="prep-section-title">Suggested Topics</div>
          <ul className="prep-topics">
            {prep.suggestedTopics.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Recent decisions */}
      {prep.recentDecisions && prep.recentDecisions.length > 0 && (
        <div className="prep-section">
          <div className="prep-section-title">Recent Decisions</div>
          {prep.recentDecisions.map((d, i) => (
            <div key={i} className="prep-decision">
              <span className="prep-decision-date">{d.date}</span>
              <span className="prep-decision-text">{d.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Checklist */}
      {prep.checklist && prep.checklist.length > 0 && (
        <div className="prep-section">
          <div className="prep-section-title">Checklist</div>
          <ul className="prep-checklist">
            {prep.checklist.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Later today */}
      {laterToday.length > 0 && (
        <div className="prep-section">
          <div className="prep-section-title">Later Today</div>
          {laterToday.map((m, i) => (
            <div key={i} className="prep-later">
              <span className="prep-later-time">
                {new Date(m.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="prep-later-subject">{m.subject}</span>
            </div>
          ))}
          {!showAll && (
            <button className="btn btn-secondary btn-sm" onClick={() => setShowAll(true)} style={{ marginTop: 8 }}>
              Show all with prep
            </button>
          )}
        </div>
      )}

      {/* All meetings expanded */}
      {showAll && allData?.meetings && (
        <div className="prep-section">
          <div className="prep-section-title">All Meetings Today</div>
          {allData.meetings.map((m, i) => (
            <div key={i} className="prep-meeting-card prep-meeting-mini">
              <div className="prep-meeting-time">{m.startFormatted}–{m.endFormatted}</div>
              <div className="prep-meeting-subject">{m.subject}</div>
              {m.prep?.attendees?.length > 0 && (
                <div className="prep-person-meta">
                  People: {m.prep.attendees.map(a => a.name).join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
