export const DEFAULT_DEBUG = 'rsss,rsss:*'

export function configureDebugStorage (
    isDevLike:boolean,
    storage:Storage = localStorage
):void {
    if (isDevLike) {
        if (storage.getItem('DEBUG') === null) {
            storage.setItem('DEBUG', DEFAULT_DEBUG)
        }
        return
    }

    if (storage.getItem('DEBUG') === DEFAULT_DEBUG) {
        storage.removeItem('DEBUG')
    }
}
