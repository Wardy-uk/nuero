import React, { useState, useEffect } from 'react';
import Topbar from './components/Topbar';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import PeopleBoard from './components/PeopleBoard';
import QueueTable from './components/QueueTable';
import StandupEditor from './components/StandupEditor';
import NinetyDayPlan from './components/NinetyDayPlan';
import TodoPanel from './components/TodoPanel';
import NudgeBanner from './components/NudgeBanner';
import ChatPanel from './components/ChatPanel';
import './App.css';

export default function App() {
  const [activeView, setActiveView] = useState('dashboard');
  const [status, setStatus] = useState(null);
  const [queueData, setQueueData] = useState(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      setStatus(await res.json());
    } catch (e) { console.error('Status fetch failed:', e); }
  };

  const fetchQueue = async () => {
    try {
      const res = await fetch('/api/queue');
      setQueueData(await res.json());
    } catch (e) { console.error('Queue fetch failed:', e); }
  };

  useEffect(() => {
    fetchStatus();
    fetchQueue();
    const interval = setInterval(() => {
      fetchStatus();
      fetchQueue();
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const renderView = () => {
    switch (activeView) {
      case 'dashboard': return <Dashboard queueData={queueData} />;
      case 'standup': return <StandupEditor />;
      case 'people': return <PeopleBoard />;
      case 'queue': return <QueueTable queueData={queueData} onRefresh={fetchQueue} />;
      case 'plan': return <NinetyDayPlan />;
      case 'todos': return <TodoPanel />;
      default: return <Dashboard queueData={queueData} />;
    }
  };

  return (
    <div className="app-layout">
      <Topbar status={status} queueData={queueData} />
      <NudgeBanner onGoToStandup={() => setActiveView('standup')} onGoToTodos={() => setActiveView('todos')} />
      <div className="app-body">
        <Sidebar activeView={activeView} onNavigate={setActiveView} />
        <main className="main-panel">
          {renderView()}
        </main>
        <aside className="chat-panel">
          <ChatPanel />
        </aside>
      </div>
    </div>
  );
}
