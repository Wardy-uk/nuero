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

export default function PeopleBoard() {
  const [peopleData, setPeopleData] = useState({});
  const [n8nConfigured, setN8nConfigured] = useState(false);
  const [running121, setRunning121] = useState(null); // person name currently running
  const [snapshotResult, setSnapshotResult] = useState(null); // { name, data }

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
                <div key={person.id} className={`person-card status-${status}`}>
                  <div className="person-header">
                    <span className="person-name">{person.name}</span>
                    <span className="person-id">{person.id}</span>
                  </div>
                  <span className="person-role">{person.role}</span>
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
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

