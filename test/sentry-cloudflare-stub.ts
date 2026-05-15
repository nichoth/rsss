// Stub for @sentry/cloudflare used when bundling worker code into
// browser test bundles. The real SDK imports node:async_hooks, which
// esbuild can't resolve without --platform=node. These no-op pass-
// throughs preserve the runtime shape of the wrapped handlers and DO
// class without pulling in Node built-ins.

export function withSentry<T> (_optionsCallback:unknown, handler:T):T {
    return handler
}

export function instrumentDurableObjectWithSentry<T> (
    _optionsCallback:unknown,
    DurableObjectClass:T
):T {
    return DurableObjectClass
}

export function instrumentD1WithSentry<T> (binding:T):T {
    return binding
}

export function instrumentWorkflowWithSentry<T> (
    _optionsCallback:unknown,
    WorkflowClass:T
):T {
    return WorkflowClass
}

export function sentryPagesPlugin (_optionsCallback:unknown):unknown {
    return () => undefined
}

export function captureException (_err:unknown):void {}
export function captureMessage (_msg:unknown):void {}
export function setUser (_user:unknown):void {}
export function setTag (_key:string, _value:unknown):void {}
export function setContext (_name:string, _ctx:unknown):void {}
export function addBreadcrumb (_crumb:unknown):void {}
export function startSpan<T> (_opts:unknown, fn:() => T):T {
    return fn()
}
