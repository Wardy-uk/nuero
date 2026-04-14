import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import PersonDetail from './PersonDetail';
import './PeopleBoard.css';

const TEAMS = {
  '2nd Line Technical Support': [
    { name: 'Abdi Mohamed', id: 'D2V00471', role: '2nd Line Support Analyst' },
    { name: 'Arman Shazad', id: 'D2V00451', role: '2nd Line Support Analyst' },
    { name: 'Luke Scaife', id: 'D2V00506', role: '2nd Line Support Analyst' },
    { name: 'Stephen Mitchell', id: 'D2V00391', role: 'Support Analyst', note: 'Trialling queue hygiene lead' },
    { name: 'Willem Kruger', id: 'D2V00255', role: '2nd Line Support Analyst' },
    { name: 'Nathan Rutland', id: 'D2V00269', role: 'Senior Service Desk Analyst' },
  ],
  '1st Line Customer Care': [
    { name: 'Adele Norman-Swift', id: 'D2V00427', role: 'Customer Service Agent' },
    { name: 'Heidi Power', id: 'D2V00505', role: 'Customer Service Agent', note: 'Active improvement window' },
    { name: 'Hope Goodall', id: '520', role: 'Customer Service Agent', note: 'Transitioning to call-taking' },
    { name: 'Maria Pappa', id: 'D2V00403', role: 'Customer Service Agent' },
    { name: 'Naomi Wentworth', id: 'D2V00509', role: 'Customer Service Agent', note: 'Confluence triage guide owner' },
    { name: 'Sebastian Broome', id: 'D2V00500', role: '1st Line Support Analyst' },
    { name: 'Zoe Rees', id: '517', role: 'Customer Service Agent' },
  ],
  'Digital Design': [
    { name: 'Isabel Busk', id: 'D2V00359', role: 'Digital Design Executive' },
    { name: 'Kayleigh Russell', id: 'D2V00318', role: 'Digital Design Executive' },
  ],
};

function get121Status(frontmatter) {
  const due = frontmatter?.['next-1-2-1-due'];
  if (!due) return null;
  const dueDate = new Date(due);
  dueDate.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysUntil = Math.round((dueDate - today) / (1000 * 60 * 60 * 24));
  if (daysUntil < 0) return { status: 'overdue', daysUntil, label: `Overdue by ${Math.abs(daysUntil)}d` };
  if (daysUntil <= 3) return { status: 'due-soon', daysUntil, label: `Due in ${daysUntil}d` };
  return { status: 'ok', daysUntil, label: `Due ${due}` };
}

function ApprovalPanel({ approvals, onRefresh }) {
  const [expanded, setExpanded] = useState(null); // id of expanded approval
  const [additionalSteps, setAdditionalSteps] = useState({});
  const [emailOverrides, setEmailOverrides] = useState({});
  const [acting, setActing] = useState(null); // id being acted on
  const [statusMsg, setStatusMsg] = useState({});

  if (!approvals.length) return null;

  const handleApprove = async (approval) => {
    setActing(approval.id);
    setStatusMsg({});
    try {
      const res = await fetch(apiUrl(`/api/n8n/121/approve/${approval.id}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentEmail: emailOverrides[approval.id] || approval.agentEmail,
          agentName: approval.agentName,
          additionalSteps: additionalSteps[approval.id] || '',
          worstQaCount: 0,
        })
      });
      const data = await res.json();
      if (data.success) {
        // Auto-download the MD review file
        const date = new Date().toISOString().split('T')[0];
        const fileName = `${date} – ${approval.agentName} 30-Day Performance Review.md`;
        let markdown = approval.markdown || '';
        const extra = (additionalSteps[approval.id] || '').trim();
        if (extra) {
          const lines = extra.split('\n').map(s => '- [ ] ' + s.trim()).filter(s => s.length > 6).join('\n');
          markdown = markdown.replace(/## Tracking/, lines + '\n\n## Tracking');
        }
        const frontmatter = `---\ntype: performance-review\nperson: "[[People/${approval.agentName}|${approval.agentName}]]"\ndate: ${date}\nsource: n8n-workflow\n---\n\n`;
        const blob = new Blob([frontmatter + markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);

        setStatusMsg(prev => ({ ...prev, [approval.id]: { type: 'ok', text: 'Approved — file downloaded, workflow resumed' } }));
        setTimeout(onRefresh, 1500);
      } else {
        setStatusMsg(prev => ({ ...prev, [approval.id]: { type: 'err', text: data.error || 'Approval failed' } }));
      }
    } catch (e) {
      setStatusMsg(prev => ({ ...prev, [approval.id]: { type: 'err', text: e.message } }));
    }
    setActing(null);
  };

  const handleDismiss = async (approval) => {
    setActing(approval.id);
    try {
      await fetch(apiUrl(`/api/n8n/121/dismiss/${approval.id}`), { method: 'POST' });
      onRefresh();
    } catch { /* ignore */ }
    setActing(null);
  };

  return (
    <div className="approval-panel">
      <div className="approval-panel-header">
        <span className="approval-panel-title">Pending Review Approvals</span>
        <span className="approval-badge">{approvals.length}</span>
      </div>
      <div className="approval-list">
        {approvals.map(a => (
          <div key={a.id} className="approval-item">
            <div className="approval-item-header">
              <span className="approval-item-name">{a.agentName}</span>
              <span className="approval-item-date">{new Date(a.receivedAt).toLocaleString()}</span>
            </div>
            {a.subject && <div className="approval-item-subject">{a.subject}</div>}
            <button
              className="approval-preview-toggle"
              onClick={() => setExpanded(expanded === a.id ? null : a.id)}
            >
              {expanded === a.id ? 'Hide Preview' : 'Show Preview'}
            </button>
            {expanded === a.id && (
              <>
                <div
                  className="approval-preview"
                  dangerouslySetInnerHTML={{ __html: (a.draftHtml || '')
                    .replace(/<a[^>]*Approve[^<]*<\/a>/gi, '')
                    .replace(/<a[^>]*approve[^<]*<\/a>/gi, '')
                    .replace(/<div[^>]*>[^<]*expire[^<]*<\/div>/gi, '')
                    .replace(/DRAFT REVIEW/gi, 'REVIEW PREVIEW')
                  }}
                />
                <div className="approval-email-override">
                  <label>Send to email</label>
                  <input
                    type="email"
                    placeholder={a.agentEmail}
                    value={emailOverrides[a.id] || ''}
                    onChange={e => setEmailOverrides(prev => ({ ...prev, [a.id]: e.target.value }))}
                  />
                </div>
                <div className="approval-additional">
                  <label>Additional next steps (one per line, optional)</label>
                  <textarea
                    rows={3}
                    placeholder="e.g. Schedule follow-up with team lead..."
                    value={additionalSteps[a.id] || ''}
                    onChange={e => setAdditionalSteps(prev => ({ ...prev, [a.id]: e.target.value }))}
                  />
                </div>
              </>
            )}
            {statusMsg[a.id] && (
              <div className={`approval-status-msg ${statusMsg[a.id].type}`}>
                {statusMsg[a.id].text}
              </div>
            )}
            <div className="approval-actions">
              <button
                className="approval-btn-approve"
                onClick={() => handleApprove(a)}
                disabled={acting === a.id}
              >
                {acting === a.id ? 'Approving...' : 'Approve & Send'}
              </button>
              <button
                className="approval-btn-dismiss"
                onClick={() => handleDismiss(a)}
                disabled={acting === a.id}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PrepViewer({ name, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(name)}/121-prep/latest`))
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setData({ found: false, error: 'Failed to load' }); setLoading(false); });
  }, [name]);

  return (
    <div className="note-editor-overlay" onClick={onClose}>
      <div className="note-editor" onClick={e => e.stopPropagation()}>
        <div className="note-editor-header">
          <span className="note-editor-title">
            {data?.found ? `${data.filename}` : `Latest 1-1 Prep — ${name}`}
          </span>
          <button className="note-editor-close" onClick={onClose}>x</button>
        </div>
        {loading ? (
          <div className="note-editor-loading">Loading...</div>
        ) : data?.found ? (
          <textarea
            className="note-editor-textarea"
            value={data.content}
            readOnly
            spellCheck={false}
          />
        ) : (
          <div className="note-editor-loading">No 1-1 prep note found for {name}.</div>
        )}
        <div className="note-editor-actions">
          {data?.found && <span className="update-msg">{data.path}</span>}
        </div>
      </div>
    </div>
  );
}

function NoteEditor({ name, onClose, onSaved }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(name)}`))
      .then(r => r.json())
      .then(d => {
        setContent(d.content || '');
        setLoading(false);
      })
      .catch(() => { setMsg('Failed to load note'); setLoading(false); });
  }, [name]);

  const handleSave = async () => {
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(name)}/raw`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      if (res.ok) {
        setMsg('Saved');
        if (onSaved) onSaved();
        setTimeout(onClose, 800);
      } else {
        const data = await res.json();
        setMsg(data.error || 'Save failed');
      }
    } catch (e) { setMsg(e.message || 'Save failed'); }
    setSaving(false);
  };

  return (
    <div className="note-editor-overlay" onClick={onClose}>
      <div className="note-editor" onClick={e => e.stopPropagation()}>
        <div className="note-editor-header">
          <span className="note-editor-title">Edit vault note — {name}.md</span>
          <button className="note-editor-close" onClick={onClose}>x</button>
        </div>
        {loading ? (
          <div className="note-editor-loading">Loading...</div>
        ) : (
          <textarea
            className="note-editor-textarea"
            value={content}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
          />
        )}
        <div className="note-editor-actions">
          {msg && <span className={`update-msg ${msg === 'Saved' ? 'ok' : ''}`}>{msg}</span>}
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function UpdateForm({ name, frontmatter, onClose, onSaved }) {
  const fm = frontmatter || {};
  const [last121, setLast121] = useState(fm['last-1-2-1'] || '');
  const [next121, setNext121] = useState(fm['next-1-2-1-due'] || '');
  const [employmentStatus, setEmploymentStatus] = useState(fm['employment-status'] || 'Permanent');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const handleSave = async () => {
    if (!last121 && !next121 && !notes.trim() && !employmentStatus) { setMsg('Fill in at least one field'); return; }
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(name)}/update`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          last121: last121 || undefined,
          next121Due: next121 || undefined,
          employmentStatus: employmentStatus || undefined,
          notes: notes.trim() || undefined
        })
      });
      if (res.ok) {
        setMsg('Saved');
        if (onSaved) onSaved();
        setTimeout(onClose, 1200);
      } else {
        const data = await res.json();
        setMsg(data.error || 'Save failed');
      }
    } catch { setMsg('Save failed'); }
    setSaving(false);
  };

  return (
    <div className="update-form">
      <div className="update-form-header">
        <span className="update-form-title">Update 1-2-1 — {name}</span>
        <button className="update-form-close" onClick={onClose}>x</button>
      </div>
      <label className="update-label">Last 1-2-1
        <input type="date" className="update-input" value={last121} onChange={e => setLast121(e.target.value)} />
      </label>
      <label className="update-label">Next 1-2-1 due
        <input type="date" className="update-input" value={next121} onChange={e => setNext121(e.target.value)} />
      </label>
      <label className="update-label">Employment Status
        <select className="update-input" value={employmentStatus} onChange={e => setEmploymentStatus(e.target.value)}>
          <option value="Permanent">Permanent</option>
          <option value="Probation">Probation</option>
          <option value="Improvement Window">Improvement Window</option>
          <option value="Notice">Notice</option>
          <option value="Contractor">Contractor</option>
        </select>
      </label>
      <label className="update-label">Notes
        <textarea className="update-textarea" rows={3} placeholder="Key points from meeting..." value={notes} onChange={e => setNotes(e.target.value)} />
      </label>
      <div className="update-actions">
        {msg && <span className={`update-msg ${msg === 'Saved' ? 'ok' : ''}`}>{msg}</span>}
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </div>
  );
}

export default function PeopleBoard() {
  const [peopleData, setPeopleData] = useState({});
  const [n8nConfigured, setN8nConfigured] = useState(false);
  const [running121, setRunning121] = useState(null); // person name currently running
  const [snapshotResult, setSnapshotResult] = useState(null); // { name, data }
  const [editingPerson, setEditingPerson] = useState(null); // person name being updated
  const [editingNote, setEditingNote] = useState(null); // person name whose raw note is being edited
  const [viewingPrep, setViewingPrep] = useState(null); // person name whose latest 1-1 prep is being viewed
  const [generatingPrep, setGeneratingPrep] = useState(null); // person name currently generating prep
  const [prepResult, setPrepResult] = useState(null); // { name, path, status, changes[] }
  const [autoExpanded, setAutoExpanded] = useState(() => sessionStorage.getItem('people-auto-expanded') === 'true');
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [selectedPerson, setSelectedPerson] = useState(null);
  const [viewMode, setViewMode] = useState('reports'); // reports | other
  const [personSummaries, setPersonSummaries] = useState({});

  // Auto-expand removed — was opening overdue 1-2-1 forms on every page visit

  useEffect(() => {
    // Fetch vault notes for each person
    const allPeople = Object.values(TEAMS).flat();
    allPeople.forEach(person => {
      fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(person.name)}`))
        .then(res => res.json())
        .then(data => {
          setPeopleData(prev => ({ ...prev, [person.name]: data }));
        })
        .catch(() => {});
    });

    // Fetch per-person tasks + decisions
    fetch(apiUrl('/api/person/summary/all'))
      .then(r => r.json())
      .then(d => setPersonSummaries(d.people || {}))
      .catch(() => {});

    // Check n8n status + pending approvals
    fetch(apiUrl('/api/n8n/status'))
      .then(r => r.json())
      .then(d => setN8nConfigured(d.configured))
      .catch(() => {});
    fetchApprovals();
    // Poll for new approvals every 10s
    const approvalTimer = setInterval(fetchApprovals, 10000);
    return () => clearInterval(approvalTimer);
  }, []);

  const fetchApprovals = () => {
    fetch(apiUrl('/api/n8n/121/pending'))
      .then(r => r.json())
      .then(d => {
        setPendingApprovals(d.approvals || []);
        // Auto-dismiss snapshot banner once an approval appears
        if (d.approvals?.length > 0) setSnapshotResult(null);
      })
      .catch(() => {});
  };

  const [snapshotOpts, setSnapshotOpts] = useState({}); // { [name]: { lookbackDays, nextStepsDays } }

  const getOpts = (personName) => snapshotOpts[personName] || { lookbackDays: 31, nextStepsDays: 31 };
  const setOpts = (personName, patch) => setSnapshotOpts(prev => ({
    ...prev,
    [personName]: { ...getOpts(personName), ...patch }
  }));

  const run121 = async (personName, mode = '30day') => {
    setRunning121(personName);
    setSnapshotResult(null);
    setEditingPerson(null);
    const opts = getOpts(personName);
    const fm = peopleData[personName]?.frontmatter || {};
    const isProbationary = /probation/i.test(fm['employment-status'] || '');
    try {
      const res = await fetch(apiUrl('/api/n8n/121'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nameHint: personName,
          mode,
          lookbackDays: opts.lookbackDays,
          nextStepsDays: opts.nextStepsDays,
          isProbationary
        })
      });
      const data = await res.json();
      setSnapshotResult({ name: personName, data });
      // Refresh approvals after a delay (n8n takes time to process)
      setTimeout(fetchApprovals, 15000);
      setTimeout(fetchApprovals, 30000);
    } catch (e) {
      setSnapshotResult({ name: personName, data: { success: false, error: e.message } });
    }
    setRunning121(null);
  };

  return (
    <div className="people-board">
      <div className="people-header">
        <h2 className="people-title">People</h2>
        <div className="people-toggle">
          <button
            className={`people-toggle-btn ${viewMode === 'reports' ? 'active' : ''}`}
            onClick={() => setViewMode('reports')}
          >Reports</button>
          <button
            className={`people-toggle-btn ${viewMode === 'other' ? 'active' : ''}`}
            onClick={() => setViewMode('other')}
          >Other</button>
        </div>
      </div>

      {viewMode === 'reports' && <ApprovalPanel approvals={pendingApprovals} onRefresh={fetchApprovals} />}

      {viewingPrep && (
        <PrepViewer name={viewingPrep} onClose={() => setViewingPrep(null)} />
      )}

      {editingNote && (
        <NoteEditor
          name={editingNote}
          onClose={() => setEditingNote(null)}
          onSaved={() => {
            fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(editingNote)}`))
              .then(r => r.json())
              .then(data => setPeopleData(prev => ({ ...prev, [editingNote]: data })))
              .catch(() => {});
          }}
        />
      )}

      {snapshotResult && (
        <div className={`snapshot-result ${snapshotResult.data.success ? 'success' : 'error'}`}>
          <div className="snapshot-header">
            <span className="snapshot-title">1-2-1 Snapshot: {snapshotResult.name}</span>
            <button className="snapshot-close" onClick={() => setSnapshotResult(null)}>x</button>
          </div>
          <div className="snapshot-body">
            {snapshotResult.data.success ? (
              <div className="snapshot-message">{snapshotResult.data.message}</div>
            ) : (
              <div className="snapshot-error">{snapshotResult.data.error || 'Workflow failed'}</div>
            )}
          </div>
        </div>
      )}

      {viewMode === 'other' && (
        <AllPeopleSection
          excludeNames={Object.values(TEAMS).flat().map(p => p.name)}
          onSelect={setSelectedPerson}
          expanded={true}
        />
      )}

      {viewMode === 'reports' && Object.entries(TEAMS).map(([teamName, members]) => (
        <div key={teamName} className="team-group">
          <h3 className="team-name">{teamName}</h3>
          <div className="team-cards">
            {members.map(person => {
              const vaultData = peopleData[person.name];
              const tags = vaultData?.tags || [];
              const fm = vaultData?.frontmatter || {};
              const status = fm.status || (person.note ? 'flag' : 'ok');
              const isRunning = running121 === person.name;

              return (
                <div key={person.id} className={`person-card status-${status}`} data-person={person.name}>
                  <div className="person-header" onClick={() => setSelectedPerson(person.name)} style={{ cursor: 'pointer' }}>
                    <span className="person-name person-name-clickable">{person.name}</span>
                    <span className="person-id">{person.id}</span>
                  </div>
                  <span className="person-role">{person.role}</span>
                  {(() => {
                    const s121 = get121Status(fm);
                    if (!s121) return null;
                    return (
                      <span className={`person-121-status person-121-${s121.status}`}>
                        {s121.label}
                      </span>
                    );
                  })()}
                  {person.note && <span className="person-note">{person.note}</span>}
                  {tags.length > 0 && (
                    <div className="person-tags">
                      {tags.map(tag => (
                        <span key={tag} className="person-tag">#{tag}</span>
                      ))}
                    </div>
                  )}
                  {!vaultData?.exists && (
                    <span className="person-no-note">No vault note</span>
                  )}
                  {personSummaries[person.name]?.tasks?.length > 0 && (
                    <div className="person-card-tasks">
                      {personSummaries[person.name].tasks.map((t, i) => (
                        <div key={i} className="person-card-task">
                          <span className="person-card-task-text">☐ {t.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {personSummaries[person.name]?.decisions?.length > 0 && (
                    <div className="person-card-decisions">
                      {personSummaries[person.name].decisions.map((d, i) => (
                        <div key={i} className="person-card-decision">
                          <span className="person-card-decision-date">{d.date}</span> {d.text}
                        </div>
                      ))}
                    </div>
                  )}
                  {n8nConfigured && (() => {
                    const opts = getOpts(person.name);
                    const empStatus = fm['employment-status'] || '';
                    const isProb = /probation/i.test(empStatus);
                    return (
                      <div className="person-snapshot-opts">
                        <label className="snapshot-opt">
                          <span>Lookback</span>
                          <select
                            value={opts.lookbackDays}
                            onChange={e => setOpts(person.name, { lookbackDays: Number(e.target.value) })}
                          >
                            <option value={7}>7 days</option>
                            <option value={14}>14 days</option>
                            <option value={31}>31 days</option>
                          </select>
                        </label>
                        <label className="snapshot-opt">
                          <span>Next steps</span>
                          <select
                            value={opts.nextStepsDays}
                            onChange={e => setOpts(person.name, { nextStepsDays: Number(e.target.value) })}
                          >
                            <option value={7}>7 days</option>
                            <option value={14}>14 days</option>
                            <option value={31}>31 days</option>
                          </select>
                        </label>
                        {empStatus && (
                          <span className={`person-emp-status${isProb ? ' probation' : ''}`}>{empStatus}</span>
                        )}
                      </div>
                    );
                  })()}
                  <div className="person-card-actions">
                    {vaultData?.exists && (
                      <button
                        className="person-update-btn"
                        onClick={() => setEditingPerson(editingPerson === person.name ? null : person.name)}
                      >
                        Update 1-2-1
                      </button>
                    )}
                    {vaultData?.exists && (
                      <button
                        className="person-edit-btn"
                        onClick={() => setEditingNote(person.name)}
                        title="Edit raw vault note"
                      >
                        Edit Note
                      </button>
                    )}
                    <button
                      className="person-prep-btn"
                      onClick={() => setViewingPrep(person.name)}
                      title="View the most recent 1-1 prep note"
                    >
                      View 1-1 Prep
                    </button>
                    <button
                      className={`person-generate-prep-btn ${generatingPrep === person.name ? 'running' : ''}`}
                      onClick={async () => {
                        if (generatingPrep) return;
                        setGeneratingPrep(person.name);
                        setPrepResult(null);
                        try {
                          let res = await fetch(apiUrl('/api/1to1/prep'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ person: person.name }),
                          });
                          let data = await res.json();
                          if (!data.ok && /already exists/i.test(data.error || '')) {
                            if (window.confirm(`Prep file already exists for ${person.name} today. Overwrite?`)) {
                              res = await fetch(apiUrl('/api/1to1/prep'), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ person: person.name, force: true }),
                              });
                              data = await res.json();
                            } else {
                              setGeneratingPrep(null);
                              return;
                            }
                          }
                          setPrepResult({ name: person.name, ...data });
                        } catch (e) {
                          setPrepResult({ name: person.name, ok: false, error: e.message });
                        } finally {
                          setGeneratingPrep(null);
                        }
                      }}
                      disabled={!!generatingPrep}
                      title="Generate a new 1-1 prep doc (NEURO)"
                    >
                      {generatingPrep === person.name ? 'Generating...' : 'Generate Prep'}
                    </button>
                    {n8nConfigured && (
                      <button
                        className={`person-121-btn ${isRunning ? 'running' : ''}`}
                        onClick={() => run121(person.name)}
                        disabled={isRunning || running121 !== null}
                      >
                        {isRunning ? 'Running...' : '1-2-1 Snapshot'}
                      </button>
                    )}
                    {n8nConfigured && person.note && /improvement window/i.test(person.note) && (
                      <button
                        className={`person-weekly-btn ${isRunning ? 'running' : ''}`}
                        onClick={() => run121(person.name, 'weekly')}
                        disabled={isRunning || running121 !== null}
                      >
                        {isRunning ? 'Running...' : 'Weekly Review'}
                      </button>
                    )}
                  </div>
                  {editingPerson === person.name && (
                    <UpdateForm
                      name={person.name}
                      frontmatter={fm}
                      onClose={() => setEditingPerson(null)}
                      onSaved={() => {
                        fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(person.name)}`))
                          .then(r => r.json())
                          .then(data => setPeopleData(prev => ({ ...prev, [person.name]: data })))
                          .catch(() => {});
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Person detail overlay */}
      {selectedPerson && (
        <PersonDetail name={selectedPerson} onClose={() => setSelectedPerson(null)} />
      )}
      {prepResult && (
        <div
          style={{
            position: 'fixed', bottom: 24, right: 24, zIndex: 10000,
            background: prepResult.ok ? '#1e3a2f' : '#3a1e1e',
            color: '#fff', padding: '14px 18px', borderRadius: 8,
            maxWidth: 420, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            fontSize: 13, lineHeight: 1.5,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <strong>{prepResult.name}</strong>
            <button
              onClick={() => setPrepResult(null)}
              style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 16 }}
            >×</button>
          </div>
          {prepResult.ok ? (
            <>
              <div>{prepResult.status === 'created' ? '✅ Created' : '✅ Updated'}: <code>{prepResult.path}</code></div>
              {(prepResult.changes || []).map((c, i) => <div key={i} style={{ opacity: 0.85 }}>• {c}</div>)}
            </>
          ) : (
            <div>❌ {prepResult.error || 'Failed'}</div>
          )}
        </div>
      )}
    </div>
  );
}

function AllPeopleSection({ excludeNames, onSelect, expanded: defaultExpanded = false }) {
  const [people, setPeople] = useState(null);
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    fetch(apiUrl('/api/person/list'))
      .then(r => r.json())
      .then(d => {
        const all = d.people || [];
        const filtered = all.filter(name => !excludeNames.some(ex => ex.toLowerCase() === name.toLowerCase()));
        setPeople(filtered);
      })
      .catch(() => setPeople([]));
  }, []);

  if (!people || people.length === 0) return null;

  return (
    <div className="team-section" style={{ marginTop: 24 }}>
      <button
        className="team-name"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer', background: 'none', border: 'none', color: 'inherit', font: 'inherit', padding: 0, textAlign: 'left', width: '100%' }}
      >
        {expanded ? '▾' : '▸'} Other People ({people.length})
      </button>
      {expanded && (
        <div className="team-cards" style={{ marginTop: 8 }}>
          {people.map(name => (
            <div
              key={name}
              className="person-card"
              onClick={() => onSelect(name)}
              style={{ cursor: 'pointer' }}
            >
              <div className="person-header">
                <span className="person-name person-name-clickable">{name}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

