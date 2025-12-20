import { describe, test } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:net'
import { createSocket } from 'node:dgram'
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
    const code = `require('dgram').createSocket('udp4').bind(${port}, () => console.log('ready'))`
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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
    test('should throw if no port is provided', () => {
      assert.throws(() => kill(), /Invalid port number provided/)
    })

    test('should throw if port is undefined', () => {
      assert.throws(() => kill(undefined), /Invalid port number provided/)
    })

    test('should throw if port is null', () => {
      assert.throws(() => kill(null), /Invalid port number provided/)
    })

    test('should throw if port is NaN', () => {
      assert.throws(() => kill(NaN), /Invalid port number provided/)
    })

    test('should throw if port is a non-numeric string', () => {
      assert.throws(() => kill('abc'), /Invalid port number provided/)
    })

    test('should throw if port is an empty string', () => {
      assert.throws(() => kill(''), /Invalid port number provided/)
    })

    test('should throw if port is an object', () => {
      assert.throws(() => kill({}), /Invalid port number provided/)
    })

    test('should throw if port is zero', () => {
      assert.throws(() => kill(0), /Invalid port number provided/)
    })
  })

  describe('no process on port', () => {
    test('should throw if no process running on given port', () => {
      assert.throws(() => kill(59999), /No process running on port/)
    })

    test('should throw for TCP when no process on port', () => {
      assert.throws(() => kill(59998, 'tcp'), /No process running on port/)
    })
  })

  describe('method parameter', () => {
    test('should accept tcp method (lowercase)', () => {
      assert.throws(() => kill(59997, 'tcp'), /No process running on port/)
    })

    test('should accept TCP method (uppercase)', () => {
      assert.throws(() => kill(59996, 'TCP'), /No process running on port/)
    })

    test('should accept udp method (lowercase)', () => {
      assert.throws(() => kill(59995, 'udp'), /No process running on port/)
    })

    test('should accept UDP method (uppercase)', () => {
      assert.throws(() => kill(59994, 'UDP'), /No process running on port/)
    })
  })

  describe('port as string', () => {
    test('should parse numeric string port', () => {
      assert.throws(() => kill('59993'), /No process running on port/)
    })

    test('should parse numeric string with leading whitespace', () => {
      // parseInt handles leading whitespace, so ' 59992' parses as 59992
      assert.throws(() => kill(' 59992'), /No process running on port/)
    })
  })
})

describe('killPorts', () => {
  test('should be defined', () => {
    assert.ok(killPorts)
  })

  describe('invalid inputs', () => {
    test('should throw if port is invalid', () => {
      assert.throws(() => killPorts('abc'), /Invalid port number provided/)
    })

    test('should throw if array contains invalid port', () => {
      assert.throws(() => killPorts([8080, 'abc']), /Invalid port number provided/)
    })

    test('should throw if all ports are invalid', () => {
      assert.throws(() => killPorts(['abc', 'def']), /Invalid port number provided/)
    })

    test('should throw if array is empty after filtering', () => {
      assert.throws(() => killPorts([null, undefined]), /Invalid port number provided/)
    })
  })

  describe('no processes on ports', () => {
    test('should return not_found for port with no process', () => {
      const { results } = killPorts([59991])
      const result = results.get(59991)
      assert.strictEqual(result.status, 'not_found')
    })

    test('should return not_found for multiple ports with no processes', () => {
      const { results } = killPorts([59990, 59989, 59988])
      assert.strictEqual(results.get(59990).status, 'not_found')
      assert.strictEqual(results.get(59989).status, 'not_found')
      assert.strictEqual(results.get(59988).status, 'not_found')
    })
  })

  describe('method parameter', () => {
    test('should accept tcp method', () => {
      const { results } = killPorts([59987], 'tcp')
      assert.strictEqual(results.get(59987).status, 'not_found')
    })

    test('should accept udp method', () => {
      const { results } = killPorts([59986], 'udp')
      assert.strictEqual(results.get(59986).status, 'not_found')
    })
  })

  describe('single port as non-array', () => {
    test('should handle single port number', () => {
      const { results } = killPorts(59985)
      assert.strictEqual(results.get(59985).status, 'not_found')
    })

    test('should handle single port string', () => {
      const { results } = killPorts('59984')
      assert.strictEqual(results.get(59984).status, 'not_found')
    })
  })

  describe('duplicate ports', () => {
    test('should deduplicate ports', () => {
      const { results } = killPorts([59983, 59983, 59983])
      assert.strictEqual(results.size, 1)
      assert.strictEqual(results.get(59983).status, 'not_found')
    })
  })
})

describe('integration tests', () => {
  describe('killing TCP server', () => {
    test('should kill a process listening on a TCP port', async () => {
      const port = await findAvailablePort(41000)
      const child = await spawnTcpServer(port)

      const result = kill(port)
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

      const { results } = killPorts([port1, port2])

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
      const port = await findAvailablePort(43000)
      const child = await spawnUdpServer(port)

      const result = kill(port, 'udp')
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

      const { results } = killPorts([existingPort, nonExistingPort])

      assert.strictEqual(results.get(existingPort).status, 'killed')
      assert.strictEqual(results.get(nonExistingPort).status, 'not_found')

      // Verify server is killed by waiting for port to become available
      const available = await waitForPortAvailable(existingPort)
      assert.ok(available, 'Port should be available after killing the process')
    })
  })
})
