import ReportFixes from './ReportFixes';
import './ReportFixes.css';

// REPORTS → Fixes log. Fixes from NOVA, VANTAGE, NEURO and n8n that the SOAP
// and Weekly Risk reports carry; the vault notes are the master.
export default function FixesLogPanel() {
  return (
    <div className="rf-page">
      <div className="rf-page-top">
        <h1>Fixes log</h1>
        <p className="rf-meta">Fixes that changed a reported figure or affected the team or customers. Sessions propose them when they deploy; you include them, or add your own.</p>
      </div>
      <ReportFixes />
    </div>
  );
}
