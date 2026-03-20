import React, { useState } from 'react';
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
import CapturePanel from './components/CapturePanel';
import InstallBanner from './components/InstallBanner';
import usePushNotifications from './usePushNotifications';
import useCachedFetch from './useCachedFetch';
import CacheIndicator from './components/CacheIndicator';
import './App.css';

export default function App() {
  const isMobile = window.innerWidth <= 768;
  const [activeView, setActiveView] = useState(isMobile ? 'capture' : 'dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const pushState = usePushNotifications();

  const statusFetch = useCachedFetch('/api/status', { interval: 30000 });
  const queueFetch = useCachedFetch('/api/queue', { interval: 30000 });

  const status = statusFetch.data;
  const queueData = queueFetch.data;

  // Worst status across core fetches for the indicator
  const worstStatus = statusFetch.status === 'unavailable' || queueFetch.status === 'unavailable'
    ? 'unavailable'
    : statusFetch.status === 'cached' || queueFetch.status === 'cached'
      ? 'cached'
      : 'live';
  const worstCacheAge = Math.max(statusFetch.cacheAge || 0, queueFetch.cacheAge || 0) || null;

  const handleNavigate = (view) => {
    setActiveView(view);
    setSidebarOpen(false);
  };

  const renderView = () => {
    switch (activeView) {
      case 'dashboard': return <Dashboard queueData={queueData} onNavigate={handleNavigate} />;
      case 'standup': return <StandupEditor />;
      case 'people': return <PeopleBoard />;
      case 'queue': return <QueueTable queueData={queueData} onRefresh={queueFetch.refresh} />;
      case 'plan': return <NinetyDayPlan />;
      case 'todos': return <TodoPanel />;
      case 'calendar': return <CalendarView />;
      case 'capture': return <CapturePanel />;
      case 'imports': return <ImportsPanel />;
      case 'inbox': return <InboxPanel />;
      case 'qa': return <QATab />;
      case 'admin': return <AdminPanel pushState={pushState} />;
      default: return <Dashboard queueData={queueData} onNavigate={handleNavigate} />;
    }
  };

  return (
    <div className="app-layout">
      <Topbar status={status} queueData={queueData} onMenuToggle={() => setSidebarOpen(o => !o)} onChatToggle={() => setChatOpen(o => !o)} chatOpen={chatOpen}>
        <CacheIndicator status={worstStatus} cacheAge={worstCacheAge} />
      </Topbar>
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
