import { useEffect, useState, useCallback } from 'react';
import { apiUrl } from './api';

export default function usePushNotifications() {
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }
    setSupported(true);
    // Register SW but don't auto-subscribe — iOS needs a user gesture
    checkExistingSubscription();
  }, []);

  async function checkExistingSubscription() {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        setSubscribed(true);
        // Re-send to server in case DB was reset
        await fetch(apiUrl('/api/push/subscribe'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(existing)
        });
      }
    } catch (e) {
      console.error('[Push] SW registration failed:', e);
      setError(e.message);
    }
  }

  const manualSubscribe = useCallback(async () => {
    try {
      setError(null);
      const registration = await navigator.serviceWorker.ready;

      const res = await fetch(apiUrl('/api/push/vapid-public-key'));
      if (!res.ok) { setError('Failed to get VAPID key'); return; }
      const { publicKey } = await res.json();

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });

      const subRes = await fetch(apiUrl('/api/push/subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription)
      });

      if (subRes.ok) {
        setSubscribed(true);
        console.log('[Push] Subscribed successfully');
      } else {
        setError('Server rejected subscription');
      }
    } catch (e) {
      console.error('[Push] Subscribe failed:', e);
      setError(e.message);
    }
  }, []);

  return { supported, subscribed, error, manualSubscribe };
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
