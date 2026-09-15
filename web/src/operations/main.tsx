import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppProviders } from '@common/components/AppProviders';
import { App } from './App';
import '../common/styles/global.css';
import '../common/styles/redesign.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>,
);

// PWA: Service Worker 注册（保持与旧版一致）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => { (window as any)._swRegistration = reg; })
      .catch(err => console.warn('[PWA] ServiceWorker 注册失败:', err));
  });
}
