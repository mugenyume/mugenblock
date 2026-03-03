export function withTimeout<T>(promise: Promise<T>, ms: number, defaultValue: T): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>(resolve => setTimeout(() => resolve(defaultValue), ms))
    ]);
}
