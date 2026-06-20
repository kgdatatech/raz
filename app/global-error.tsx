'use client'

// Global error boundary for Next.js.
// Must render its own <html> and <body> — it replaces the root layout.
// Kept deliberately minimal: no font context or providers that could
// fail when React renders this page in isolation during the build.
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}): React.ReactElement {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#0a0a0a', color: '#ededed', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.75rem' }}>Something went wrong</h1>
          <button
            onClick={reset}
            style={{ padding: '0.4rem 1rem', background: '#6366f1', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.875rem' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
