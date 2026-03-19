import React, { useState, useEffect } from 'react';

export default function InstallBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Only show on iOS Safari when NOT running as installed PWA
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone === true;
    const dismissed = sessionStorage.getItem('install-banner-dismissed');

    if (isIOS && !isStandalone && !dismissed) {
      setShow(true);
    }
  }, []);

  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    sessionStorage.setItem('install-banner-dismissed', '1');
  };

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      background: '#1a1a2e',
      borderTop: '1px solid #00ff88',
      padding: '12px 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      zIndex: 9999,
      fontFamily: 'IBM Plex Sans, sans-serif',
      fontSize: '13px',
      color: '#ccc'
    }}>
      <div>
        <strong style={{ color: '#00ff88' }}>Install NEURO</strong>
        <br />
        Tap <span style={{ fontSize: '16px' }}>&#x2191;</span> then "Add to Home Screen" for push notifications
      </div>
      <button
        onClick={dismiss}
        style={{
          background: 'none',
          border: '1px solid #555',
          color: '#999',
          padding: '4px 10px',
          borderRadius: '4px',
          cursor: 'pointer',
          flexShrink: 0,
          marginLeft: '12px'
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
