export function formatSqliteTs (date:Date):string {
    return date.toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, '')
}

export function parseSqliteTs (value:string):Date|null {
    const sqliteMatch = value.match(
        /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/
    )
    const date = sqliteMatch
        ? new Date(`${sqliteMatch[1]}T${sqliteMatch[2]}Z`)
        : new Date(value)

    return Number.isNaN(date.getTime()) ? null : date
}
