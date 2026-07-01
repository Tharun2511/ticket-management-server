// ═══════════════════════════════════════════════════════════════════════════════
// src/config/redis.ts — Redis Client Singleton
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Creates and exports a single Redis client instance that the entire app shares.
//   This file mirrors the pattern of db.ts (PostgreSQL), but with one KEY difference
//   in error handling — read the "GRACEFUL DEGRADATION" section below.
//
// COMPARISON WITH db.ts:
//   ┌─────────────────┬───────────────────────────┬──────────────────────────────┐
//   │                  │  db.ts (PostgreSQL)        │  redis.ts (Redis)            │
//   ├─────────────────┼───────────────────────────┼──────────────────────────────┤
//   │ Role            │  Source of truth            │  Cache layer (optional)      │
//   │ Client type     │  new Pool() (many conns)    │  new Redis() (ONE conn)      │
//   │ Error behavior  │  process.exit(1) = CRASH    │  console.error() = LOG ONLY  │
//   │ If it's down    │  App CANNOT function         │  App works, just slower      │
//   │ Export          │  export { db }               │  export { redis }            │
//   └─────────────────┴───────────────────────────┴──────────────────────────────┘
//
// ═══════════════════════════════════════════════════════════════════════════════

import Redis from 'ioredis';
import { env } from './env';

// ─── CREATING THE CLIENT ────────────────────────────────────────────────────
//
// WHAT HAPPENS HERE:
//   `new Redis(url, options)` does three things:
//     1. Parses the connection string (redis://localhost:6379)
//     2. Opens a TCP connection to the Redis server on port 6379
//     3. Starts listening for responses
//
// WHY SINGLE CONNECTION (not a Pool like PostgreSQL)?
//   PostgreSQL uses a Pool of 10-20 connections because each connection can
//   only handle ONE query at a time. If you have 10 concurrent requests,
//   you need 10 connections.
//
//   Redis is different — it uses "pipelining":
//     - Your app sends commands WITHOUT waiting for each response
//     - Redis processes them in order and sends all responses back
//     - One connection can handle THOUSANDS of commands per second
//   So a single connection is sufficient. ioredis handles pipelining automatically.
//
//   Think of it like:
//     PostgreSQL = 10 separate phone calls (each waits for "hello" before talking)
//     Redis = 1 walkie-talkie channel (everyone talks, messages arrive in order)
//
const redis = new Redis(env.REDIS_URL, {

    // ─── maxRetriesPerRequest ────────────────────────────────────────
    // How many times to retry a SINGLE command (like GET, SET) if it fails.
    //
    // Default is 20, which is WAY too many for a cache. If a GET takes 20 retries,
    // that's slower than just asking PostgreSQL directly!
    //
    // We set 3: try the command, retry twice, then give up and let the fallback
    // (PostgreSQL query) handle it. Fast failure is better than slow retrying
    // when you have a fallback.
    maxRetriesPerRequest: 3,

    // ─── enableOfflineQueue ──────────────────────────────────────────
    // When Redis is unreachable, ioredis by default QUEUES commands and waits
    // for reconnection — so every cache read/write STALLS for seconds before it
    // eventually rejects. That silently turns "Redis is down" into "every request
    // is slow" (login could exceed 12s, and startup permission-cache writes stall).
    //
    // We have a PostgreSQL fallback behind every cache call, so we want the cache
    // to FAIL FAST when Redis is down, not block. Setting this to false makes
    // commands reject immediately while disconnected → the try/catch fallbacks
    // hit Postgres instantly. This is the same "fast failure" principle as
    // maxRetriesPerRequest above. When Redis is up, this has no effect.
    enableOfflineQueue: false,

    // ─── retryStrategy ───────────────────────────────────────────────
    // This is DIFFERENT from maxRetriesPerRequest!
    //
    // maxRetriesPerRequest = retries for individual commands (GET, SET, etc.)
    // retryStrategy        = retries for the TCP CONNECTION itself
    //
    // When the TCP connection to Redis drops (network blip, Redis restart),
    // ioredis calls this function to decide:
    //   - How long to wait before trying to reconnect (return a number in ms)
    //   - Whether to stop trying entirely (return null)
    //
    // The `times` parameter is the attempt number: 1st try, 2nd try, 3rd try...
    //
    // Our strategy: "exponential backoff with a cap"
    //   Attempt 1: wait 200ms
    //   Attempt 2: wait 400ms
    //   Attempt 3: wait 600ms
    //   ...
    //   Attempt 10+: wait 2000ms (cap)
    //
    // WHY BACKOFF? If Redis just crashed, hammering it with reconnection attempts
    // every 10ms won't help — it needs time to restart. Gradually increasing the
    // delay gives Redis time to recover without overwhelming it.
    //
    retryStrategy(times: number): number {
        const delay = Math.min(times * 200, 2000);
        console.log(`Redis: reconnecting in ${delay}ms (attempt ${times})...`);
        return delay;
    },
});

// ─── CONNECTION EVENTS ──────────────────────────────────────────────────────
//
// ioredis emits events as the connection state changes. These mirror the
// event pattern you already know from db.ts:
//   db.on('connect', ...) — PostgreSQL connected
//   db.on('error', ...)   — PostgreSQL error → process.exit(1)
//
// Redis events follow the same lifecycle:
//   connect → ready → (normal operation) → close → reconnecting → connect → ready
//                                           ↑                        ↓
//                                           └──── error (if fatal) ──┘
//

// Fires when TCP connection is established (but Redis may not be ready yet)
redis.on('connect', () => {
    console.log('Redis: connected');
});

// Fires when Redis is ready to accept commands
// (after connect + any AUTH/SELECT commands complete)
redis.on('ready', () => {
    console.log('Redis: ready to accept commands');
});

// ─── GRACEFUL DEGRADATION (THE MOST IMPORTANT CONCEPT IN THIS FILE) ────────
//
// Look at db.ts line 57-59:
//   db.on('error', (err) => {
//       console.error('PostgreSQL connection error', err);
//       process.exit(1);   // ← KILLS THE SERVER
//   });
//
// We intentionally DO NOT do this for Redis. Here's why:
//
// PostgreSQL is the SOURCE OF TRUTH:
//   - All user data, tickets, roles, permissions LIVE in PostgreSQL
//   - If PostgreSQL is gone, you literally cannot serve any data
//   - Crashing is the right choice — the app is useless without it
//
// Redis is a CACHE:
//   - Every piece of data in Redis is a COPY of something in PostgreSQL
//   - If Redis is gone, you still have all your data — just need to read
//     it from PostgreSQL (which is slower but works)
//   - Crashing would mean: "Your cache is down, so EVERYTHING is down" — wrong!
//
// THE PRINCIPLE:
//   Redis UP   → fast path   (0.1ms reads from Redis)
//   Redis DOWN → slow path   (2-5ms reads from PostgreSQL)
//   Redis DOWN ≠ app down
//
// This is "graceful degradation" — the app gets worse, not broken.
//
redis.on('error', (err) => {
    // Log the error so we know about it, but DO NOT crash.
    // Compare this with db.ts which calls process.exit(1) here.
    console.error('Redis: connection error -', err.message);
});

// Fires when ioredis is attempting to reconnect (after a connection drop)
redis.on('reconnecting', () => {
    console.log('Redis: attempting to reconnect...');
});

// Fires when the connection is closed (intentionally or due to error)
redis.on('close', () => {
    console.log('Redis: connection closed');
});

// ─── GRACEFUL SHUTDOWN ──────────────────────────────────────────────────────
//
// When you press Ctrl+C (or the process receives SIGINT), we need to close
// the Redis connection cleanly. Why?
//
// 1. PENDING COMMANDS: If your app just sent a SET command and you kill the
//    process, that command might not complete. `redis.quit()` waits for all
//    pending commands to finish, then sends the QUIT command to Redis.
//
// 2. CONNECTION CLEANUP: Redis tracks connected clients. If you don't
//    disconnect cleanly, Redis still holds the connection open until its
//    timeout (default: 300 seconds). Clean disconnection frees it immediately.
//
// 3. NO "BROKEN PIPE" ERRORS: Without this, you'd see ugly errors in the
//    console when the process exits because the TCP socket gets destroyed
//    while ioredis is still trying to use it.
//
// `quit()` vs `disconnect()`:
//   quit()       → sends QUIT to Redis, waits for pending commands, then closes (GRACEFUL)
//   disconnect() → immediately destroys the socket, pending commands are lost (FORCEFUL)
//
process.on('SIGINT', async () => {
    console.log('Redis: shutting down gracefully...');
    await redis.quit();
    console.log('Redis: connection closed cleanly');
    // Note: We don't call process.exit() here because other SIGINT handlers
    // (like Express shutdown) might also need to run.
});

// ─── EXPORT ─────────────────────────────────────────────────────────────────
//
// We export the redis instance as a named export (not default).
// This matches the pattern in db.ts: `export const db = new Pool(config)`
//
// Every file in the app imports the SAME instance:
//   import { redis } from '../config/redis';
//
// This is the "Singleton Pattern" — one instance shared everywhere.
// Creating multiple Redis clients would waste connections and memory.
//
export { redis };
