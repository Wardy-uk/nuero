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
import VaultBrowser from './components/VaultBrowser';
import InstallBanner from './components/InstallBanner';
import usePushNotifications from './usePushNotifications';
import useCachedFetch from './useCachedFetch';
import CacheIndicator from './components/CacheIndicator';
import './App.css';

function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

// GPS location — requested once on load, refreshed every 30 minutes
function useLocation() {
  const [location, setLocation] = React.useState(null);
  // location shape: { lat, lng, place, accuracy, timestamp }

  const requestLocation = React.useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          timestamp: Date.now(),
          place: null // populated by reverse geocode below
        });
      },
      () => {}, // silently ignore denied/unavailable
      { timeout: 10000, maximumAge: 5 * 60 * 1000 }
    );
  }, []);

  React.useEffect(() => {
    requestLocation();
    const interval = setInterval(requestLocation, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [requestLocation]);

  return location;
}

export default function App() {
  const isMobile = window.innerWidth <= 768;
  const [activeView, setActiveView] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [weekendOverride, setWeekendOverride] = useState(false);
  const weekend = isWeekend() && !weekendOverride;
  const location = useLocation();
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
      case 'vault': return <VaultBrowser />;
      case 'qa': return <QATab />;
      case 'admin': return <AdminPanel pushState={pushState} />;
      default: return <Dashboard queueData={queueData} onNavigate={handleNavigate} />;
    }
  };

  return (
    <div className="app-layout">
      <Topbar status={status} queueData={queueData} onMenuToggle={() => setSidebarOpen(o => !o)} onChatToggle={() => setChatOpen(o => !o)} chatOpen={chatOpen} weekend={weekend} onWeekendOverride={() => setWeekendOverride(o => !o)} weekendOverride={weekendOverride}>
        <CacheIndicator status={worstStatus} cacheAge={worstCacheAge} />
      </Topbar>
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <div className="app-body">
        <Sidebar activeView={activeView} onNavigate={handleNavigate} open={sidebarOpen} />
        <main className="main-panel">
          {renderView()}
        </main>
        <aside className={`chat-panel ${chatOpen ? 'chat-open' : ''}`}>
          <ChatPanel location={location} />
        </aside>
      </div>
      <NudgeBanner onGoToStandup={() => { setActiveView('standup'); setSidebarOpen(false); }} onGoToTodos={() => { setActiveView('todos'); setSidebarOpen(false); }} />
      <InstallBanner />
    </div>
  );
}
