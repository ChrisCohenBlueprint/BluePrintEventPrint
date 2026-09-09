const { AsyncLocalStorage } = require('async_hooks');

/**
 * Which show the work in hand belongs to.
 *
 * Every collection is keyed by `showId`, and every model reads it as
 * `config.showId` — around 120 places. Threading a parameter through all of
 * them would be a large and error-prone change for no benefit, so instead the
 * show is carried in async context: set once when a request or socket arrives,
 * and read transparently by `config.showId` wherever the work ends up.
 *
 * This only works because nothing destructures `config.showId` — a
 * `const { showId } = config` anywhere would capture one value at load time and
 * quietly serve the wrong event. There is a guard for that in the tests.
 *
 * IMPORTANT: work that starts outside a request — a timer, a startup task — has
 * no context and falls back to the default show. That is correct for a
 * single-show deploy and WRONG for a multi-show one, so background work must
 * name its show explicitly with `runAs`. The hold-expiry loop is the live
 * example: without it, holds on one event expire against another.
 */
const store = new AsyncLocalStorage();

/** Run `fn` with `showId` as the current show. */
const runAs = (showId, fn) => store.run({ showId }, fn);

/** The current show, or null outside any context. */
const current = () => store.getStore()?.showId || null;

module.exports = { runAs, current };
