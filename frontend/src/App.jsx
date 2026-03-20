import React, { useState, useEffect } from 'react';
import Topbar from './components/Topbar';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import PeopleBoard from './components/PeopleBoard';
import QueueTable from './components/QueueTable';
import StandupEditor from './components/StandupEditor';
import NinetyDayPlan from './components/NinetyDayPlan';
import TodoPanel from './components/TodoPanel';
import CalendarView from './components/CalendarView';
import InboxPanel from './components/InboxPanel';
import AdminPanel from './components/AdminPanel';
import NudgeBanner from './components/NudgeBanner';
import ChatPanel from './components/ChatPanel';
import QATab from './components/QATab';
import ImportsPanel from './components/ImportsPanel';
import InstallBanner from './components/InstallBanner';
import usePushNotifications from './usePushNotifications';
import { apiUrl } from './api';
import './App.css';

export default function App() {
  const [activeView, setActiveView] = useState('dashboard');
  const [status, setStatus] = useState(null);
  const [queueData, setQueueData] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const pushState = usePushNotifications();

  const fetchStatus = async () => {
    try {
      const res = await fetch(apiUrl('/api/status'));
      setStatus(await res.json());
    } catch (e) { console.error('Status fetch failed:', e); }
  };

  const fetchQueue = async () => {
    try {
      const res = await fetch(apiUrl('/api/queue'));
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

  const handleNavigate = (view) => {
    setActiveView(view);
    setSidebarOpen(false);
  };

  const renderView = () => {
    switch (activeView) {
      case 'dashboard': return <Dashboard queueData={queueData} />;
      case 'standup': return <StandupEditor />;
      case 'people': return <PeopleBoard />;
      case 'queue': return <QueueTable queueData={queueData} onRefresh={fetchQueue} />;
      case 'plan': return <NinetyDayPlan />;
      case 'todos': return <TodoPanel />;
      case 'calendar': return <CalendarView />;
      case 'imports': return <ImportsPanel />;
      case 'inbox': return <InboxPanel />;
      case 'qa': return <QATab />;
      case 'admin': return <AdminPanel pushState={pushState} />;
      default: return <Dashboard queueData={queueData} />;
    }
  };

  return (
    <div className="app-layout">
      <Topbar status={status} queueData={queueData} onMenuToggle={() => setSidebarOpen(o => !o)} onChatToggle={() => setChatOpen(o => !o)} chatOpen={chatOpen} />
      <NudgeBanner onGoToStandup={() => { setActiveView('standup'); setSidebarOpen(false); }} onGoToTodos={() => { setActiveView('todos'); setSidebarOpen(false); }} />
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <div className="app-body">
        <Sidebar activeView={activeView} onNavigate={handleNavigate} open={sidebarOpen} />
        <main className="main-panel">
          {renderView()}
        </main>
        <aside className={`chat-panel ${chatOpen ? 'chat-open' : ''}`}>
          <ChatPanel />
        </aside>
      </div>
      <InstallBanner />
    </div>
  );
}
