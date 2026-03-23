import React, { useState, useEffect, useCallback } from 'react';
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
import RecentPanel from './components/RecentPanel';
import VaultBrowser from './components/VaultBrowser';
import StravaPanel from './components/StravaPanel';
import InsightsPanel from './components/InsightsPanel';
import JournalPanel from './components/JournalPanel';
import InstallBanner from './components/InstallBanner';
import usePushNotifications from './usePushNotifications';
import useCachedFetch from './useCachedFetch';
import { apiUrl } from './api';
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
  const [vaultOpenPath, setVaultOpenPath] = useState(null);
  const [weekendOverride, setWeekendOverride] = useState(false);
  const weekend = isWeekend() && !weekendOverride;
  const location = useLocation();
  const pushState = usePushNotifications();
  const [toast, setToast] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);

  // Online/offline detection
  useEffect(() => {
    const onOnline = () => { setOnline(true); setToast({ type: 'success', text: 'Back online' }); };
    const onOffline = () => { setOnline(false); setToast({ type: 'warn', text: 'Offline — captures will queue' }); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.type === 'warn' ? 5000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

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

  // Track tab opens
  React.useEffect(() => {
    if (!activeView) return;
    fetch(apiUrl('/api/activity/tab'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: activeView })
    }).catch(() => {}); // fire and forget — never block UI
  }, [activeView]);

  const handleNavigate = (view) => {
    if (view === 'chat') {
      setChatOpen(true);
      setSidebarOpen(false);
      return; // do NOT change activeView — chat lives in aside only
    }
    setChatOpen(false); // close aside when navigating away
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
      case 'recent': return <RecentPanel onOpenFile={(path) => { setVaultOpenPath(path); setActiveView('vault'); }} />;
      case 'imports': return <ImportsPanel />;
      case 'strava': return <StravaPanel />;
      case 'inbox': return <InboxPanel />;
      case 'vault': return <VaultBrowser initialOpenPath={vaultOpenPath} onClearInitialPath={() => setVaultOpenPath(null)} />;
      case 'qa': return <QATab />;
      case 'journal': return <JournalPanel />;
      case 'insights': return <InsightsPanel onNavigate={handleNavigate} />;
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
      <NudgeBanner onGoToStandup={() => { setActiveView('dashboard'); setSidebarOpen(false); }} onGoToTodos={() => { setActiveView('dashboard'); setSidebarOpen(false); }} onGoToJournal={() => { setActiveView('dashboard'); setSidebarOpen(false); }} onGoToPeople={() => { setActiveView('people'); setSidebarOpen(false); }} />
      <InstallBanner />
      {/* Mobile bottom nav */}
      <nav className="mobile-bottom-nav">
        <button className={activeView === 'dashboard' ? 'active' : ''} onClick={() => handleNavigate('dashboard')}>
          <span className="bottom-nav-icon">&#x2B21;</span>
          <span>Review</span>
        </button>
        <button className={chatOpen ? 'active' : ''} onClick={() => handleNavigate('chat')}>
          <span className="bottom-nav-icon">&#x203A;</span>
          <span>Ask</span>
        </button>
        <button className={activeView === 'capture' ? 'active' : ''} onClick={() => handleNavigate('capture')}>
          <span className="bottom-nav-icon">+</span>
          <span>Capture</span>
        </button>
      </nav>
      {/* Toast notifications */}
      {toast && (
        <div className={`app-toast app-toast-${toast.type}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
      {/* Offline indicator */}
      {!online && (
        <div className="app-offline-bar">Offline</div>
      )}
    </div>
  );
}
