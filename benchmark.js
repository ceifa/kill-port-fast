import { spawn } from 'node:child_process'
import killPortFast, { killPorts } from './index.js'
import killPort from 'kill-port'

const ITERATIONS = 10
const BASE_PORT = 45000

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
    await spawnTcpServer(port)
    await delay(50) // Ensure server is fully up

    const start = performance.now()
    await killFn(port)
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
    for (let j = 0; j < batchSize; j++) {
      const port = BASE_PORT + 100 + (i * batchSize) + j
      await spawnTcpServer(port)
      ports.push(port)
    }
    await delay(50)

    const start = performance.now()
    await killFn(ports)
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
