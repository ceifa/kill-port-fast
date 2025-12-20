import { spawn, spawnSync } from 'node:child_process'
import killPortFast, { killPorts } from './index.js'
import killPort from 'kill-port'

const ITERATIONS = 10
const BASE_PORT = 45000
const DEBUG = process.argv.includes('--debug') || ['1', 'true', 'yes'].includes(String(process.env.BENCHMARK_DEBUG || '').toLowerCase())

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 })
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.status,
    error: result.error || null
  }
}

function logDebugLines(label, output) {
  if (!DEBUG) return
  const lines = String(output || '').split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) {
    console.log(`[debug] ${label}: <empty>`)
    return
  }
  for (const line of lines) {
    console.log(`[debug] ${label}: ${line}`)
  }
}

function filterPortLines(output, port) {
  const dot = `.${port}`
  const colon = `:${port}`
  return String(output || '').split(/\r?\n/).filter(line => line.includes(dot) || line.includes(colon))
}

function dumpPortDiagnostics(port, label, error, childPid) {
  if (!DEBUG) return
  console.log('\n[debug] benchmark diagnostics')
  if (label) console.log(`[debug] target=${label} port=${port}`)
  if (childPid) console.log(`[debug] childPid=${childPid}`)
  if (error?.message) console.log(`[debug] error=${error.message}`)
  console.log(`[debug] platform=${process.platform} node=${process.version} pid=${process.pid}`)
  if (process.env.GITHUB_ACTIONS) console.log(`[debug] GITHUB_ACTIONS=${process.env.GITHUB_ACTIONS}`)

  if (process.platform === 'darwin') {
    const netstat = run('netstat', ['-nav', '-p', 'tcp'])
    if (netstat.error) {
      console.log(`[debug] netstat error=${netstat.error.message}`)
    } else {
      console.log(`[debug] netstat exit=${netstat.code}`)
      const lines = filterPortLines(netstat.stdout, port)
      if (lines.length === 0) {
        console.log('[debug] netstat matches: <none>')
      } else {
        for (const line of lines) {
          console.log(`[debug] netstat: ${line}`)
        }
      }
    }
  }

  const lsof = run('lsof', ['-nP', `-iTCP:${port}`])
  if (lsof.error) {
    console.log(`[debug] lsof error=${lsof.error.message}`)
  } else {
    console.log(`[debug] lsof exit=${lsof.code}`)
    logDebugLines('lsof', lsof.stdout || lsof.stderr)
  }
}

function spawnTcpServer(port) {
  return new Promise((resolve, reject) => {
    const code = `require('net').createServer().listen(${port}, () => console.log('ready'))`
    const child = spawn('node', ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] })
    child.stdout.on('data', (data) => {
      if (data.toString().includes('ready')) {
        resolve(child)
      }
    })
    child.on('error', reject)
    setTimeout(() => reject(new Error('Timeout')), 5000)
  })
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function benchmarkSingle(name, killFn, iterations) {
  const times = []

  for (let i = 0; i < iterations; i++) {
    const port = BASE_PORT + i
    const child = await spawnTcpServer(port)
    await delay(50) // Ensure server is fully up

    const start = performance.now()
    try {
      await killFn(port)
    } catch (error) {
      dumpPortDiagnostics(port, name, error, child?.pid)
      throw error
    }
    const end = performance.now()

    times.push(end - start)
    await delay(100) // Wait for port release
  }

  return times
}

async function benchmarkBatch(name, killFn, iterations, batchSize) {
  const times = []

  for (let i = 0; i < iterations; i++) {
    const ports = []
    const children = []
    for (let j = 0; j < batchSize; j++) {
      const port = BASE_PORT + 100 + (i * batchSize) + j
      const child = await spawnTcpServer(port)
      ports.push(port)
      children.push(child)
    }
    await delay(50)

    const start = performance.now()
    try {
      await killFn(ports)
    } catch (error) {
      ports.forEach((port, index) => dumpPortDiagnostics(port, name, error, children[index]?.pid))
      throw error
    }
    const end = performance.now()

    times.push(end - start)
    await delay(100)
  }

  return times
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b)
  const sum = times.reduce((a, b) => a + b, 0)
  return {
    avg: sum / times.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)]
  }
}

function formatMs(ms) {
  return ms.toFixed(2) + 'ms'
}

function printResults(name, times) {
  const s = stats(times)
  console.log(`  ${name}:`)
  console.log(`    avg: ${formatMs(s.avg)} | median: ${formatMs(s.median)} | min: ${formatMs(s.min)} | max: ${formatMs(s.max)}`)
}

async function main() {
  console.log('Kill Port Benchmark')
  console.log('===================')
  console.log(`Iterations: ${ITERATIONS}\n`)
  if (DEBUG) console.log('[debug] benchmark diagnostics enabled\n')

  console.log('Single port kill:')

  const killPortFastTimes = await benchmarkSingle('kill-port-fast', killPortFast, ITERATIONS)
  printResults('kill-port-fast', killPortFastTimes)

  const killPortTimes = await benchmarkSingle('kill-port', killPort, ITERATIONS)
  printResults('kill-port', killPortTimes)

  const singleSpeedup = stats(killPortTimes).avg / stats(killPortFastTimes).avg
  console.log(`  Speedup: ${singleSpeedup.toFixed(2)}x faster\n`)

  console.log('Batch kill (5 ports):')

  const batchFastTimes = await benchmarkBatch('kill-port-fast', killPorts, ITERATIONS, 5)
  printResults('kill-port-fast (killPorts)', batchFastTimes)

  const batchKillPort = async (ports) => {
    await Promise.all(ports.map(port => killPort(port)))
  }
  const batchSlowTimes = await benchmarkBatch('kill-port', batchKillPort, ITERATIONS, 5)
  printResults('kill-port (Promise.all)', batchSlowTimes)

  const batchSpeedup = stats(batchSlowTimes).avg / stats(batchFastTimes).avg
  console.log(`  Speedup: ${batchSpeedup.toFixed(2)}x faster\n`)

  console.log('Summary:')
  console.log(`  Single port: kill-port-fast is ${singleSpeedup.toFixed(2)}x faster`)
  console.log(`  Batch (5 ports): kill-port-fast is ${batchSpeedup.toFixed(2)}x faster`)
}

await main()
