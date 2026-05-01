let _currentlyOpenItemId:number|null = null

export function setCurrentlyOpenItemId (id:number|null):void {
    _currentlyOpenItemId = id
}

export function getCurrentlyOpenItemId ():number|null {
    return _currentlyOpenItemId
}

export function _resetOpenItemRegistry ():void {
    _currentlyOpenItemId = null
}
