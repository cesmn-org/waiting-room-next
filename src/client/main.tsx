import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error('Waiting room render error', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="auth-loading">
          <div>
            <h1>Waiting Room unavailable</h1>
            <p>Reload this page to try again.</p>
            <button onClick={() => window.location.reload()}>Reload</button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
