/*
 * Manual verification for US-062.
 *
 * Run `npm start`, open the app in Chrome, sign in, enable local-first in
 * Settings, wait for bootstrap to finish, reload, then paste this script in
 * DevTools. It verifies that the page is cross-origin isolated and that the
 * app's OPFS database directory is readable. Disable local-first in Settings
 * and run it again; the database file should no longer be listed.
 */
async function verifyLocalFirstOpfsPersistence () {
    const result = {
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        hasOpfs: Boolean(navigator.storage?.getDirectory),
        files: []
    }

    if (!result.crossOriginIsolated) {
        throw new Error('Expected crossOriginIsolated to be true')
    }

    if (!result.hasOpfs) {
        throw new Error('Expected navigator.storage.getDirectory')
    }

    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('rsss-db', { create: false })

    for await (const name of dir.keys()) {
        if (name.startsWith('rsss-') && name.endsWith('.db')) {
            result.files.push(name)
        }
    }

    console.table(result.files.map(file => ({ file })))
    console.log('US-062 OPFS check:', result)
}

verifyLocalFirstOpfsPersistence()
