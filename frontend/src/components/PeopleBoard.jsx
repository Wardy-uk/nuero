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

    // Check n8n status
    fetch(apiUrl('/api/n8n/status'))
      .then(r => r.json())
      .then(d => setN8nConfigured(d.configured))
      .catch(() => {});
  }, []);

  const run121 = async (personName) => {
    setRunning121(personName);
    setSnapshotResult(null);
    try {
      const res = await fetch(apiUrl('/api/n8n/121'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nameHint: personName })
      });
      const data = await res.json();
      setSnapshotResult({ name: personName, data });
    } catch (e) {
      setSnapshotResult({ name: personName, data: { success: false, error: e.message } });
    }
    setRunning121(null);
  };

  return (
    <div className="people-board">
      <h2 className="people-title">Team / People</h2>

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

