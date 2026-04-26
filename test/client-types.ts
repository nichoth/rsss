import type {
    Feed as DbFeed,
    Item as DbItem
} from '../src/client/db/types.js'
import type {
    Feed as StateFeed,
    Item as StateItem
} from '../src/client/state.js'

type Equal<A, B> = (
    (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2) ?
        true :
        false
)

type Assert<T extends true> = T

type FeedIsShared = Assert<Equal<StateFeed, DbFeed>>
type ItemIsShared = Assert<Equal<StateItem, DbItem>>

export type {
    FeedIsShared,
    ItemIsShared
}
