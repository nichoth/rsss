import { test } from '@substrate-system/tapzero'
import css from '../src/client/components/dot.css'

test('Dot CSS defines gray and blue using color variables', t => {
    const dotCss = String(css)

    t.ok(dotCss.includes('&.gray'), 'defines gray dot style')
    t.ok(dotCss.includes('&.blue'), 'defines blue dot style')
    t.ok(
        /&\.gray\s*{[^}]*fill:\s*var\(--color-dot-gray\)/s.test(dotCss),
        'gray dot fill uses the gray dot variable'
    )
    t.ok(
        /&\.blue\s*{[^}]*fill:\s*var\(--color-dot-blue\)/s.test(dotCss),
        'blue dot fill uses the blue dot variable'
    )
})
