// V8 gives the main thread 984 KiB of stack, and Node keeps 192 KiB of a worker's for itself: a
// worker so sized nests to within 2% of the main thread's depth, where its default 4 MiB nests four
// times as deep, so only a file nested within that 2% extracts on the main thread and not on a worker.
export const WORKER_STACK_MB: number = (984 + 192) / 1024
