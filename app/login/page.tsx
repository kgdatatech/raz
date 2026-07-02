'use client'

import { useState } from 'react'

export default function LoginPage() {
  const [token, setToken]     = useState('')
  const [error, setError]     = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!token.trim() || pending) return
    setPending(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token: token.trim() }),
      })
      if (res.ok) {
        window.location.href = '/'
        return
      }
      const body = await res.json().catch(() => ({ error: 'Login failed.' }))
      setError(typeof body.error === 'string' ? body.error : 'Login failed.')
    } catch {
      setError('Could not reach the server.')
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-lg font-semibold text-gray-900">RAZ</h1>
        <p className="mt-1 text-sm text-gray-500">Enter the API token to access the dashboard.</p>
        <input
          type="password"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="RAZ_API_TOKEN"
          className="mt-4 w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none"
        />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={pending || !token.trim()}
          className="mt-4 w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
