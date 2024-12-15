import { promises as fs } from 'fs';
import path from 'path';

/**
 * Interface that all cache storage implementations must implement
 */
interface CacheStorage<T> {
    get(key: string): Promise<CacheEntry<T> | undefined>;
    set(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
    size(): Promise<number>;
}

/**
 * Options for configuring the cached decorator
 */
export type CacheOptions<T, Args extends unknown[]> = {
    /**
     * The storage implementation to use for caching
     */
    storage: CacheStorage<T>;

    /**
     * Optional function to generate cache keys from function arguments
     * @default JSON.stringify
     */
    keyGenerator?: (...args: Args) => string;

    /**
     * Optional TTL (Time To Live) in milliseconds
     * After this time, cached values will be considered stale and re-fetched
     */
    ttl?: number;
};

/**
 * Cached value with a timestamp
 */
export type CacheEntry<T> = {
    value: T;
    timestamp: number;
};

/**
 * File-based storage implementation that persists cache to disk
 */
export class FileStorage<T> implements CacheStorage<T> {
    private readonly cacheDir: string;
    private readonly keysFile: string;
    private keys: Set<string>;

    constructor(options: { directory: string }) {
        this.cacheDir = path.resolve(options.directory);
        this.keysFile = path.join(this.cacheDir, '_keys.json');
        this.keys = new Set();
        void this.init();
    }

    private async init() {
        await fs.mkdir(this.cacheDir, { recursive: true });
        try {
            const keysContent = await fs.readFile(this.keysFile, 'utf-8');
            this.keys = new Set(JSON.parse(keysContent) as string[]);
        } catch {
            await this.saveKeys();
        }
    }

    private getFilePath(key: string) {
        // Use hash of key as filename to avoid invalid characters
        const hash = Buffer.from(key).toString('base64').replace(/[/+=]/g, '_');
        return path.join(this.cacheDir, `${hash}.json`);
    }

    private async saveKeys() {
        await fs.writeFile(this.keysFile, JSON.stringify([...this.keys]));
    }

    async get(key: string) {
        if (!this.keys.has(key)) return undefined;
        try {
            const content = await fs.readFile(this.getFilePath(key), 'utf-8');
            return JSON.parse(content) as CacheEntry<T>;
        } catch {
            this.keys.delete(key);
            await this.saveKeys();
            return undefined;
        }
    }

    async set(key: string, value: T) {
        const data: CacheEntry<T> = {
            value,
            timestamp: Date.now(),
        };
        await fs.writeFile(this.getFilePath(key), JSON.stringify(data));
        this.keys.add(key);
        await this.saveKeys();
    }

    async delete(key: string) {
        try {
            await fs.unlink(this.getFilePath(key));
        } catch {
            // Ignore errors if file doesn't exist
        }
        this.keys.delete(key);
        await this.saveKeys();
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    async size(): Promise<number> {
        return this.keys.size;
    }
}

/**
 * Creates a cached version of an async function that persists results using the specified storage.
 *
 * @template T The type of the value that the function resolves to
 * @template Args The tuple type representing the function's arguments
 *
 * @param fn The async function to cache
 * @param options Configuration options for caching
 *
 * @returns A cached version of the input function
 *
 * @example
 * const fetchContentSnapshot = cached(
 *   async (url: string) => {
 *     const response = await fetch(url);
 *     return {
 *       content: await response.text(),
 *     };
 *   },
 *   {
 *     storage: new FileStorage({ directory: './cache' }),
 *     keyGenerator: (url) => url`,
 *     ttl: 24 * 60 * 60 * 1000, // 24 hours
 *   }
 * );
 */
export function cached<T, Args extends unknown[]>(
    fn: (...args: Args) => Promise<T>,
    options: CacheOptions<T, Args>
): (...args: Args) => Promise<T> {
    return async (...args: Args): Promise<T> => {
        const key = options.keyGenerator
            ? options.keyGenerator(...args)
            : JSON.stringify(args);

        const cached = await options.storage.get(key);
        if (cached !== undefined) {
            // Check if the cached value is still valid
            const age = Date.now() - cached.timestamp;
            if (options.ttl === undefined || age < options.ttl) {
                return cached.value;
            }
            // Value is expired, delete it
            await options.storage.delete(key);
        }

        const result = await fn(...args);
        await options.storage.set(key, result);
        return result;
    };
}
