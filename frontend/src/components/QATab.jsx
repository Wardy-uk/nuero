import React, { useState, useEffect, useCallback } from 'react';
import './QATab.css';

const GRADE_COLOURS = { GREEN: '#22c55e', AMBER: '#f59e0b', RED: '#ef4444' };
const GRADE_BG = { GREEN: '#052e16', AMBER: '#1c1400', RED: '#1c0a0a' };

function StatCard({ label, value, sub }) {
  return (
    <div className="qa-stat-card">
      <div className="qa-stat-value">{value ?? '—'}</div>
      <div className="qa-stat-label">{label}</div>
      {sub && <div className="qa-stat-sub">{sub}</div>}
    </div>
  );
}

function GradeBar({ green = 0, amber = 0, red = 0 }) {
  const total = green + amber + red;
  if (!total) return <div className="qa-grade-bar-empty">No data</div>;
  const pct = n => Math.round((n / total) * 100);
  return (
    <div className="qa-grade-bar-wrap">
      <div className="qa-grade-bar">
        {green > 0 && <div className="qa-bar-seg" style={{ width: `${pct(green)}%`, background: GRADE_COLOURS.GREEN }} title={`Green: ${green}`} />}
        {amber > 0 && <div className="qa-bar-seg" style={{ width: `${pct(amber)}%`, background: GRADE_COLOURS.AMBER }} title={`Amber: ${amber}`} />}
        {red > 0 && <div className="qa-bar-seg" style={{ width: `${pct(red)}%`, background: GRADE_COLOURS.RED }} title={`Red: ${red}`} />}
      </div>
      <div className="qa-grade-legend">
        <span style={{ color: GRADE_COLOURS.GREEN }}>● Green {pct(green)}%</span>
        <span style={{ color: GRADE_COLOURS.AMBER }}>● Amber {pct(amber)}%</span>
        <span style={{ color: GRADE_COLOURS.RED }}>● Red {pct(red)}%</span>
      </div>
    </div>
  );
}

function AgentTable({ agents }) {
  if (!agents?.length) return <div className="qa-empty">No agent data</div>;
  return (
    <table className="qa-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Total</th>
          <th>Avg Score</th>
          <th className="grade-col green-col">G</th>
          <th className="grade-col amber-col">A</th>
          <th className="grade-col red-col">R</th>
          <th>Flagged</th>
        </tr>
      </thead>
      <tbody>
        {agents.map(a => (
          <tr key={a.assigneeName}>
            <td className="qa-agent-name">{a.assigneeName}</td>
            <td>{a.total}</td>
            <td>
              <span className="qa-score" style={{ color: a.avgScore >= 7 ? GRADE_COLOURS.GREEN : a.avgScore >= 5 ? GRADE_COLOURS.AMBER : GRADE_COLOURS.RED }}>
                {Number(a.avgScore).toFixed(1)}
              </span>
            </td>
            <td className="green-col">{a.green}</td>
            <td className="amber-col">{a.amber}</td>
            <td className="red-col">{a.red}</td>
            <td>{a.concerning > 0 ? <span className="qa-flag">⚑ {a.concerning}</span> : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ResultRow({ r }) {
  const [open, setOpen] = useState(false);
  const grade = r.grade || 'UNKNOWN';
  const colour = GRADE_COLOURS[grade] || '#888';
  const bg = GRADE_BG[grade] || '#111';
  return (
    <>
      <tr className={`qa-result-row ${open ? 'expanded' : ''}`} onClick={() => setOpen(o => !o)} style={{ cursor: 'pointer' }}>
        <td>
          <span className="qa-grade-badge" style={{ background: bg, color: colour, border: `1px solid ${colour}` }}>
            {grade}
          </span>
        </td>
        <td className="qa-key">{r.issueKey}</td>
        <td>{r.assigneeName}</td>
        <td>
          <span className="qa-score" style={{ color: colour }}>{Number(r.overallScore).toFixed(1)}</span>
        </td>
        <td>{r.category || '—'}</td>
        <td>{r.isConcerning ? <span className="qa-flag">⚑</span> : ''}</td>
        <td className="qa-date">{r.processedAt ? new Date(r.processedAt).toLocaleDateString() : '—'}</td>
        <td className="qa-expand">{open ? '▲' : '▼'}</td>
      </tr>
      {open && (
        <tr className="qa-detail-row">
          <td colSpan={8}>
            <div className="qa-detail">
              <div className="qa-detail-scores">
                {[['Accuracy', r.accuracyScore], ['Clarity', r.clarityScore], ['Tone', r.toneScore], ['Closure', r.closureScore]].map(([label, val]) => (
                  <div key={label} className="qa-detail-score">
                    <div className="qa-detail-score-val">{val}/10</div>
                    <div className="qa-detail-score-label">{label}</div>
                  </div>
                ))}
              </div>
              {r.issues && <div className="qa-detail-section"><strong>Issues:</strong> {r.issues}</div>}
              {r.coachingPoints && <div className="qa-detail-section"><strong>Coaching:</strong> {r.coachingPoints}</div>}
              {r.customerSentiment && <div className="qa-detail-section"><strong>Sentiment:</strong> {r.customerSentiment}</div>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function QATab() {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState(null);
  const [agents, setAgents] = useState(null);
  const [results, setResults] = useState(null);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ grade: '', agent: '', concerning: false });
  const [loading, setLoading] = useState(false);
  const [activeSection, setActiveSection] = useState('overview');

  const fetchSummary = useCallback(async () => {
    try {
      const r = await fetch(`/api/qa/summary?days=${days}`);
      if (r.ok) setSummary(await r.json());
    } catch (e) { console.error('QA summary error', e); }
  }, [days]);

  const fetchAgents = useCallback(async () => {
    try {
      const r = await fetch(`/api/qa/agents?days=${days}`);
      if (r.ok) {
        const d = await r.json();
        setAgents(d.agents || []);
      }
    } catch (e) { console.error('QA agents error', e); }
  }, [days]);

  const fetchResults = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ days, page: p, limit: 25 });
      if (filters.grade) params.set('grade', filters.grade);
      if (filters.agent) params.set('agent', filters.agent);
      if (filters.concerning) params.set('concerning', 'true');
      const r = await fetch(`/api/qa/results?${params}`);
      if (r.ok) {
        const d = await r.json();
        setResults(d);
        setPage(p);
      }
    } catch (e) { console.error('QA results error', e); }
    setLoading(false);
  }, [days, filters]);

  useEffect(() => {
    fetchSummary();
    fetchAgents();
    fetchResults(1);
  }, [fetchSummary, fetchAgents, fetchResults]);

  const handleFilterChange = (key, value) => {
    setFilters(f => ({ ...f, [key]: value }));
  };

  const applyFilters = () => fetchResults(1);

  const greenRate = summary ? Math.round((summary.green / (summary.fullQA || 1)) * 100) : 0;

  return (
    <div className="qa-tab">
      <div className="qa-header">
        <h2 className="qa-title">QA Dashboard</h2>
        <div className="qa-controls">
          <label>Period:
            <select value={days} onChange={e => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
        </div>
      </div>

      <div className="qa-tabs">
        {['overview', 'results', 'agents'].map(s => (
          <button key={s} className={`qa-tab-btn ${activeSection === s ? 'active' : ''}`} onClick={() => setActiveSection(s)}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {activeSection === 'overview' && (
        <div className="qa-section">
          <div className="qa-stats-grid">
            <StatCard label="Full QA'd" value={summary?.fullQA} />
            <StatCard label="Avg Score" value={summary ? Number(summary.avgScore).toFixed(1) : null} sub="/10" />
            <StatCard label="Green Rate" value={summary ? `${greenRate}%` : null} />
            <StatCard label="Flagged" value={summary?.concerning} />
            <StatCard label="Excluded" value={summary?.excluded} />
          </div>
          {summary && (
            <div className="qa-card">
              <div className="qa-card-title">Grade Distribution</div>
              <GradeBar green={summary.green} amber={summary.amber} red={summary.red} />
            </div>
          )}
        </div>
      )}

      {activeSection === 'results' && (
        <div className="qa-section">
          <div className="qa-filters">
            <select value={filters.grade} onChange={e => handleFilterChange('grade', e.target.value)}>
              <option value="">All grades</option>
              <option value="GREEN">Green</option>
              <option value="AMBER">Amber</option>
              <option value="RED">Red</option>
            </select>
            <input
              type="text"
              placeholder="Agent name..."
              value={filters.agent}
              onChange={e => handleFilterChange('agent', e.target.value)}
            />
            <label className="qa-checkbox-label">
              <input type="checkbox" checked={filters.concerning} onChange={e => handleFilterChange('concerning', e.target.checked)} />
              Flagged only
            </label>
            <button className="qa-apply-btn" onClick={applyFilters}>Apply</button>
          </div>

          {loading ? (
            <div className="qa-loading">Loading...</div>
          ) : (
            <>
              <table className="qa-table qa-results-table">
                <thead>
                  <tr>
                    <th>Grade</th>
                    <th>Ticket</th>
                    <th>Agent</th>
                    <th>Score</th>
                    <th>Category</th>
                    <th>Flag</th>
                    <th>Date</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {results?.results?.length
                    ? results.results.map(r => <ResultRow key={r.issueKey} r={r} />)
                    : <tr><td colSpan={8} className="qa-empty">No results</td></tr>
                  }
                </tbody>
              </table>
              <div className="qa-pagination">
                <button disabled={page <= 1} onClick={() => fetchResults(page - 1)}>← Prev</button>
                <span>Page {page}</span>
                <button disabled={!results?.results?.length || results.results.length < 25} onClick={() => fetchResults(page + 1)}>Next →</button>
              </div>
            </>
          )}
        </div>
      )}

      {activeSection === 'agents' && (
        <div className="qa-section">
          <AgentTable agents={agents} />
        </div>
      )}
    </div>
  );
}
