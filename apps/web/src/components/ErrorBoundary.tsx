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
        <h1>문제가 생겼습니다</h1>
        <p>이 화면을 보여 드리지 못했습니다. 새로 고침하면 이어서 할 수 있습니다.</p>
        <p>
          <button type="button" onClick={() => window.location.reload()}>
            새로 고침
          </button>{' '}
          <a href="/">처음으로</a>
        </p>
      </main>
    );
  }
}
