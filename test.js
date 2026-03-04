import { describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createSocket } from 'node:dgram'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import kill, { killPorts } from './index.js'

function createTcpServer(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(port, () => resolve(server))
    server.on('error', reject)
  })
}

function createUdpServer(port) {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    socket.bind(port, () => resolve(socket))
    socket.on('error', reject)
  })
}

async function findAvailablePort(startPort = 40000) {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      const server = await createTcpServer(port)
      server.close()
      return port
    } catch {
      continue
    }
  }
  throw new Error('No available port found')
}

function spawnTcpServer(port) {
  return new Promise((resolve, reject) => {
    const code = `require('net').createServer().listen(${port}, () => console.log('ready'))`
    const child = spawn('node', ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.on('data', (data) => {
      if (data.toString().includes('ready')) {
        resolve(child)
      }
    })
    child.on('error', reject)
    setTimeout(() => reject(new Error('Timeout waiting for server')), 5000)
  })
}

function spawnUdpServer(port) {
  return new Promise((resolve, reject) => {
    const code = `
      const socket = require('dgram').createSocket('udp4');
      socket.on('error', (err) => {
        console.error('Socket error:', err.message);
        process.exit(1);
      });
      socket.bind(${port}, () => console.log('ready'));
    `
    const child = spawn('node', ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.on('data', (data) => {
      if (data.toString().includes('ready')) {
        resolve(child)
      }
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`UDP server exited with code ${code}`))
      }
    })
    setTimeout(() => reject(new Error('Timeout waiting for UDP server')), 5000)
  })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function runCli(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cli.js', ...args], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => { stdout += data.toString() })
    child.stderr.on('data', (data) => { stderr += data.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function waitForPortAvailable(port, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const server = await createTcpServer(port)
      server.close()
      return true
    } catch {
      await delay(100)
    }
  }
  return false
}

async function waitForUdpPortAvailable(port, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const socket = await createUdpServer(port)
      socket.close()
      return true
    } catch {
      await delay(100)
    }
  }
  return false
}

describe('killPort', () => {
  test('should be defined', () => {
    assert.ok(kill)
  })

  describe('invalid port inputs', () => {
    test('should throw if no port is provided', async () => {
      await assert.rejects(() => kill(), /Invalid port number provided/)
    })

    test('should throw if port is undefined', async () => {
      await assert.rejects(() => kill(undefined), /Invalid port number provided/)
    })

    test('should throw if port is null', async () => {
      await assert.rejects(() => kill(null), /Invalid port number provided/)
    })

    test('should throw if port is NaN', async () => {
      await assert.rejects(() => kill(NaN), /Invalid port number provided/)
    })

    test('should throw if port is a non-numeric string', async () => {
      await assert.rejects(() => kill('abc'), /Invalid port number provided/)
    })

    test('should throw if port is an empty string', async () => {
      await assert.rejects(() => kill(''), /Invalid port number provided/)
    })

    test('should throw if port is an object', async () => {
      await assert.rejects(() => kill({}), /Invalid port number provided/)
    })

    test('should throw if port is zero', async () => {
      await assert.rejects(() => kill(0), /Invalid port number provided/)
    })
  })

  describe('no process on port', () => {
    test('should throw if no process running on given port', async () => {
      await assert.rejects(() => kill(59999), /No process running on port/)
    })

    test('should throw for TCP when no process on port', async () => {
      await assert.rejects(() => kill(59998, 'tcp'), /No process running on port/)
    })
  })

  describe('method parameter', () => {
    test('should accept tcp method (lowercase)', async () => {
      await assert.rejects(() => kill(59997, 'tcp'), /No process running on port/)
    })

    test('should accept TCP method (uppercase)', async () => {
      await assert.rejects(() => kill(59996, 'TCP'), /No process running on port/)
    })

    test('should accept udp method (lowercase)', async () => {
      await assert.rejects(() => kill(59995, 'udp'), /No process running on port/)
    })

    test('should accept UDP method (uppercase)', async () => {
      await assert.rejects(() => kill(59994, 'UDP'), /No process running on port/)
    })
  })

  describe('port as string', () => {
    test('should parse numeric string port', async () => {
      await assert.rejects(() => kill('59993'), /No process running on port/)
    })

    test('should parse numeric string with leading whitespace', async () => {
      // parseInt handles leading whitespace, so ' 59992' parses as 59992
      await assert.rejects(() => kill(' 59992'), /No process running on port/)
    })
  })
})

describe('killPorts', () => {
  test('should be defined', () => {
    assert.ok(killPorts)
  })

  describe('invalid inputs', () => {
    test('should throw if port is invalid', async () => {
      await assert.rejects(() => killPorts('abc'), /Invalid port number provided/)
    })

    test('should throw if array contains invalid port', async () => {
      await assert.rejects(() => killPorts([8080, 'abc']), /Invalid port number provided/)
    })

    test('should throw if all ports are invalid', async () => {
      await assert.rejects(() => killPorts(['abc', 'def']), /Invalid port number provided/)
    })

    test('should throw if array is empty after filtering', async () => {
      await assert.rejects(() => killPorts([null, undefined]), /Invalid port number provided/)
    })
  })

  describe('no processes on ports', () => {
    test('should return not_found for port with no process', async () => {
      const { results } = await killPorts([59991])
      const result = results.get(59991)
      assert.strictEqual(result.status, 'not_found')
    })

    test('should return not_found for multiple ports with no processes', async () => {
      const { results } = await killPorts([59990, 59989, 59988])
      assert.strictEqual(results.get(59990).status, 'not_found')
      assert.strictEqual(results.get(59989).status, 'not_found')
      assert.strictEqual(results.get(59988).status, 'not_found')
    })
  })

  describe('method parameter', () => {
    test('should accept tcp method', async () => {
      const { results } = await killPorts([59987], 'tcp')
      assert.strictEqual(results.get(59987).status, 'not_found')
    })

    test('should accept udp method', async () => {
      const { results } = await killPorts([59986], 'udp')
      assert.strictEqual(results.get(59986).status, 'not_found')
    })
  })

  describe('single port as non-array', () => {
    test('should handle single port number', async () => {
      const { results } = await killPorts(59985)
      assert.strictEqual(results.get(59985).status, 'not_found')
    })

    test('should handle single port string', async () => {
      const { results } = await killPorts('59984')
      assert.strictEqual(results.get(59984).status, 'not_found')
    })
  })

  describe('duplicate ports', () => {
    test('should deduplicate ports', async () => {
      const { results } = await killPorts([59983, 59983, 59983])
      assert.strictEqual(results.size, 1)
      assert.strictEqual(results.get(59983).status, 'not_found')
    })
  })
})

describe('integration tests', () => {
  test('should ignore PID 0 netstat entries in CLI output', { skip: process.platform !== 'win32' }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'kpf-netstat-'))
    try {
      writeFileSync(join(tempDir, 'netstat.cmd'), `@echo off
echo Proto  Local Address          Foreign Address        State           PID
echo TCP    0.0.0.0:41000           0.0.0.0:0              LISTENING       0
`)

      const env = { ...process.env, PATH: `${tempDir};${process.env.PATH || ''}` }
      const result = await runCli(['41000'], env)

      assert.strictEqual(result.code, 0)
      assert.match(result.stdout, /Could not kill process on port 41000\. No process running on port\./)
      assert.strictEqual(result.stderr, '')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('killing TCP server', () => {
    test('should kill a process listening on a TCP port', async () => {
      const port = await findAvailablePort(41000)
      const child = await spawnTcpServer(port)

      const result = await kill(port)
      assert.ok(result.pids)
      assert.ok(result.pids.length > 0)

      // Verify server is killed by waiting for port to become available
      const available = await waitForPortAvailable(port)
      assert.ok(available, 'Port should be available after killing the process')
    })

    test('should kill multiple TCP servers with killPorts', async () => {
      const port1 = await findAvailablePort(42000)
      const port2 = await findAvailablePort(port1 + 1)

      const child1 = await spawnTcpServer(port1)
      const child2 = await spawnTcpServer(port2)

      const { results } = await killPorts([port1, port2])

      assert.strictEqual(results.get(port1).status, 'killed')
      assert.strictEqual(results.get(port2).status, 'killed')
      assert.ok(results.get(port1).pids.length > 0)
      assert.ok(results.get(port2).pids.length > 0)

      // Verify servers are killed by waiting for ports to become available
      const available1 = await waitForPortAvailable(port1)
      const available2 = await waitForPortAvailable(port2)
      assert.ok(available1, 'Port 1 should be available after killing')
      assert.ok(available2, 'Port 2 should be available after killing')
    })
  })

  describe('killing UDP server', () => {
    test('should kill a process listening on a UDP port', async () => {
      // Find a port that's available for UDP
      let port = 43000
      let found = false
      for (let i = 0; i < 100 && !found; i++) {
        try {
          const testSocket = await createUdpServer(port + i)
          testSocket.close()
          port = port + i
          found = true
        } catch {
          continue
        }
      }
      if (!found) throw new Error('Could not find available UDP port')

      const child = await spawnUdpServer(port)

      const result = await kill(port, 'udp')
      assert.ok(result.pids)
      assert.ok(result.pids.length > 0)

      // Verify socket is killed by waiting for port to become available
      const available = await waitForUdpPortAvailable(port)
      assert.ok(available, 'Port should be available after killing the process')
    })
  })

  describe('mixed scenarios with killPorts', () => {
    test('should handle mix of existing and non-existing processes', async () => {
      const existingPort = await findAvailablePort(44000)
      const nonExistingPort = 59980

      const child = await spawnTcpServer(existingPort)

      const { results } = await killPorts([existingPort, nonExistingPort])

      assert.strictEqual(results.get(existingPort).status, 'killed')
      assert.strictEqual(results.get(nonExistingPort).status, 'not_found')

      // Verify server is killed by waiting for port to become available
      const available = await waitForPortAvailable(existingPort)
      assert.ok(available, 'Port should be available after killing the process')
    })
  })
})
