import React from 'react';

export class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('React Crash Captured:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '30px', color: '#991b1b', background: '#fef2f2', borderRadius: '16px', margin: '20px', border: '1px solid #fecaca' }}>
          <h2 style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '10px' }}>⚠️ Component Render Error:</h2>
          <p style={{ fontSize: '14px', marginBottom: '10px' }}>{this.state.error?.toString()}</p>
          {this.state.error?.stack && (
            <pre style={{ fontSize: '11px', background: '#fff', padding: '12px', borderRadius: '8px', overflowX: 'auto', color: '#374151' }}>
              {this.state.error.stack}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
