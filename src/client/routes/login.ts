import { html } from 'htm/preact'
import type { FunctionComponent } from 'preact'
import { useState } from 'preact/hooks'
import { useComputed } from '@preact/signals'
import { State, type AppState } from '../state.js'

export const LoginPage: FunctionComponent<{ state: AppState }> = function LoginPage ({ state }) {
    const [handle, setHandle] = useState('')
    const authLoading = useComputed(() => state.authLoading.value)
    const authError = useComputed(() => state.authError.value)

    // Check for error in URL params
    const urlParams = new URLSearchParams(window.location.search)
    const urlError = urlParams.get('error')

    async function handleSubmit (e: Event) {
        e.preventDefault()
        if (!handle.trim()) return
        await State.login(state, handle.trim())
    }

    async function handleDevLogin (e: Event) {
        e.preventDefault()
        await State.devLogin(state)
        state._setRoute('/')
    }

    return html`
        <div class="login-page">
            <div class="login-container">
                <div class="login-header">
                    <h1>RSSS</h1>
                    <p>Really Simple Syndication Service</p>
                </div>

                ${(authError.value || urlError) && html`
                    <div class="error-message">
                        ${authError.value || urlError}
                    </div>
                `}

                <form onSubmit=${handleSubmit} class="login-form">
                    <div class="form-group">
                        <label for="handle">
                            Bluesky / AT protocol Handle
                        </label>
                        <input
                            type="text"
                            id="handle"
                            name="handle"
                            placeholder="yourname.bsky.social"
                            value=${handle}
                            onInput=${(e: Event) => setHandle((e.target as HTMLInputElement).value)}
                            disabled=${authLoading.value}
                            required
                        />
                    </div>

                    <button
                        type="submit"
                        class="btn btn-primary"
                        disabled=${authLoading.value || !handle.trim()}
                    >
                        ${authLoading.value ? 'Signing in...' : 'Sign in with Bluesky'}
                    </button>
                </form>

                ${import.meta.env.DEV && html`
                    <div class="dev-login">
                        <hr />
                        <p>Development mode:</p>
                        <button
                            type="button"
                            class="btn btn-secondary"
                            onClick=${handleDevLogin}
                        >
                            Dev Login (skip OAuth)
                        </button>
                    </div>
                `}

                <div class="login-footer">
                    <p>
                        Sign in with an AT protocol account to access your
                        feed reader.
                    </p>
                </div>
            </div>
        </div>
    `
}
