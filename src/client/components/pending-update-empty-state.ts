export function pendingUpdateLabel (count:number):string {
    if (count === 1) {
        return '1 pending update'
    }
    return `${count} pending updates`
}
