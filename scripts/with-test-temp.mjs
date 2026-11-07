// Runs a command with its temp dir pointed at <repo>/.test-tmp/run-<pid>, then deletes that dir.
// Keeps test profiles, fixtures and browser data off C:\...\Temp, where they were never cleaned up.
// Usage: node scripts/with-test-temp.mjs <command> [args...]
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '.test-tmp')
mkdirSync(root, { recursive: true })
// Leftovers from runs that crashed before cleanup.
for (const name of readdirSync(root)) {
  try {
    rmSync(join(root, name), { recursive: true, force: true, maxRetries: 3 })
  } catch {} // still in use by a parallel run
}

const dir = join(root, `run-${process.pid}`)
mkdirSync(dir, { recursive: true })
const [cmd, ...args] = process.argv.slice(2)
const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir } })
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
process.exit(r.status ?? 1)
