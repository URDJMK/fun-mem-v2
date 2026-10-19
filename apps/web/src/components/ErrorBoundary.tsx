import { Component, type ReactNode } from 'react';

/**
 * The last net under every page. A page that throws while it draws would otherwise leave the
 * whole window blank, with nothing to press. This shows a plain sentence and a way out
 * instead, and nothing technical (React writes the details to the console).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" data-testid="error-boundary">
        <h1>Something went wrong</h1>
        <p>This page could not be shown. Reload it to carry on.</p>
        <p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>{' '}
          <a href="/">Go to the start</a>
        </p>
      </main>
    );
  }
}
