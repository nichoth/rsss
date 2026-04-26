import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const sourceUrl = new URL(
    '../src/server/durable-objects/index.ts',
    import.meta.url
)
const source = readFileSync(sourceUrl, 'utf8')
const file = ts.createSourceFile(
    sourceUrl.pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
)
const missingRadix = []

function visit (node) {
    if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'parseInt' &&
        node.arguments.length < 2
    ) {
        const position = file.getLineAndCharacterOfPosition(node.getStart())
        missingRadix.push(position.line + 1)
    }

    ts.forEachChild(node, visit)
}

visit(file)

assert.deepEqual(
    missingRadix,
    [],
    'Durable Object parseInt calls must pass radix 10'
)
