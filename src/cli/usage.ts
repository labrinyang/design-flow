/** A command called the wrong way: it exits 2, where a failure while running exits 1. */
export class UsageError extends Error {}
