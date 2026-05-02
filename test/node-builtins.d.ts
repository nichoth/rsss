declare module 'node:fs' {
    export function readFileSync (
        path:string | URL,
        encoding:'utf8'
    ):string

    export function readdirSync (path:string | URL):string[]

    export function statSync (
        path:string | URL
    ):{ isDirectory ():boolean }
}

declare module 'node:path' {
    export function join (...paths:string[]):string
}
