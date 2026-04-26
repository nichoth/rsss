export function formatSqliteTs (date:Date):string {
    return date.toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, '')
}
