import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
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
        setStatusMsg(prev => ({ ...prev, [approval.id]: { type: 'ok', text: 'Approved — workflow resumed' } }));
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

function UpdateForm({ name, frontmatter, onClose, onSaved }) {
  const fm = frontmatter || {};
  const [last121, setLast121] = useState(fm['last-1-2-1'] || '');
  const [next121, setNext121] = useState(fm['next-1-2-1-due'] || '');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const handleSave = async () => {
    if (!last121 && !next121 && !notes.trim()) { setMsg('Fill in at least one field'); return; }
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(name)}/update`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          last121: last121 || undefined,
          next121Due: next121 || undefined,
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
  const [autoExpanded, setAutoExpanded] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState([]);

  useEffect(() => {
    if (autoExpanded) return;
    const allPeople = Object.values(TEAMS).flat();
    for (const person of allPeople) {
      const vaultData = peopleData[person.name];
      if (!vaultData?.frontmatter) continue;
      const status = get121Status(vaultData.frontmatter);
      if (status?.status === 'overdue') {
        setEditingPerson(person.name);
        setAutoExpanded(true);
        // Scroll to overdue card after short delay
        setTimeout(() => {
          const el = document.querySelector(`[data-person="${person.name}"]`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
        break; // only auto-expand first overdue person
      }
    }
  }, [peopleData, autoExpanded]);

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

  const run121 = async (personName) => {
    setRunning121(personName);
    setSnapshotResult(null);
    setEditingPerson(null);
    try {
      const res = await fetch(apiUrl('/api/n8n/121'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nameHint: personName })
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
      <h2 className="people-title">Team / People</h2>

      <ApprovalPanel approvals={pendingApprovals} onRefresh={fetchApprovals} />

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

      {Object.entries(TEAMS).map(([teamName, members]) => (
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
                  <div className="person-header">
                    <span className="person-name">{person.name}</span>
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
                  <div className="person-card-actions">
                    {vaultData?.exists && (
                      <button
                        className="person-update-btn"
                        onClick={() => setEditingPerson(editingPerson === person.name ? null : person.name)}
                      >
                        Update 1-2-1
                      </button>
                    )}
                    {n8nConfigured && (
                      <button
                        className={`person-121-btn ${isRunning ? 'running' : ''}`}
                        onClick={() => run121(person.name)}
                        disabled={isRunning || running121 !== null}
                      >
                        {isRunning ? 'Running...' : '1-2-1 Snapshot'}
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
    </div>
  );
}

