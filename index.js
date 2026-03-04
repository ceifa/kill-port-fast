import { spawn } from 'child_process'
import { createInterface } from 'readline'

const toPortNumber = (value) => Number.parseInt(value, 10) || null
const isUdp = (method) => String(method || 'tcp').toLowerCase() === 'udp'
const toPositivePid = (value) => {
	const pid = Number.parseInt(String(value), 10)
	// ports sometimes are open but not assigned to any process
	return Number.isInteger(pid) && pid > 0 ? String(pid) : null
}

function run(command, args) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { windowsHide: true })
		let stdout = ''
		let stderr = ''
		if (child.stdout) child.stdout.on('data', c => stdout += c)
		if (child.stderr) child.stderr.on('data', c => stderr += c)
		child.on('close', code => resolve({ stdout, stderr, code, error: null }))
		child.on('error', error => resolve({ stdout, stderr, code: null, error }))
	})
}

function killPidsSafe(pids) {
	const failures = []
	const killed = []
	for (const rawPid of pids) {
		const pid = toPositivePid(rawPid)
		if (!pid) continue
		try {
			process.kill(Number(pid), 'SIGKILL')
			killed.push(pid)
		} catch (error) {
			if (error?.code !== 'ESRCH') failures.push({ pid, error })
		}
	}
	return { killed, failures }
}

function killPids(pids) {
	const { killed, failures } = killPidsSafe(pids)
	if (failures.length > 0) {
		const error = new Error(`Failed to kill ${failures.length} process${failures.length > 1 ? 'es' : ''}`)
		error.failures = failures
		throw error
	}
	return { pids: killed }
}

function addToMapSet(map, key, value) {
	if (!map.has(key)) map.set(key, new Set())
	map.get(key).add(value)
}

function mapPidsFromLsof(stdout, portSet) {
	const map = new Map()
	let currentPid = null
	for (const line of stdout.split(/\r?\n/)) {
		if (!line) continue
		if (line[0] === 'p') {
			currentPid = toPositivePid(line.slice(1))
		} else if (line[0] === 'n' && currentPid) {
			const match = line.match(/:(\d+)(?:->|\s|$)/)
			const port = match && Number.parseInt(match[1], 10)
			if (port && portSet.has(port)) addToMapSet(map, port, currentPid)
		}
	}
	return map
}

function mapPidsFromNetstat(stdout, portSet, protocol) {
	const map = new Map()
	for (const rawLine of stdout.split(/\r?\n/)) {
		const parts = rawLine.trim().split(/\s+/)
		if (!parts[0] || parts[0].toUpperCase() !== protocol) continue
		const localAddress = parts[1]
		const colonIndex = localAddress?.lastIndexOf(':')
		if (colonIndex === -1 || colonIndex == null) continue
		const port = Number.parseInt(localAddress.slice(colonIndex + 1), 10)
		const pid = toPositivePid(parts[parts.length - 1])
		if (port && portSet.has(port) && pid) addToMapSet(map, port, pid)
	}
	return map
}

function mapPidsFromFuser(stdout, stderr, portSet) {
	const map = new Map()
	const portsInOrder = []
	const portHeaderPattern = /^(\d+)\/(?:tcp|tcp6|udp|udp6):/gim
	for (const match of stderr.matchAll(portHeaderPattern)) {
		const port = Number.parseInt(match[1], 10)
		if (port) portsInOrder.push(port)
	}

	const pidsInOrder = stdout
		.trim()
		.split(/\s+/)
		.map(toPositivePid)
		.filter(Boolean)
	if (portsInOrder.length === 1 && pidsInOrder.length > 0) {
		const port = portsInOrder[0]
		if (portSet.has(port)) {
			for (const pid of pidsInOrder) {
				addToMapSet(map, port, pid)
			}
		}
		return map
	}

	for (let i = 0; i < portsInOrder.length && i < pidsInOrder.length; i++) {
		const port = portsInOrder[i]
		const pid = pidsInOrder[i]
		if (portSet.has(port)) {
			addToMapSet(map, port, pid)
		}
	}
	return map
}

function buildFuserArgs(ports, method) {
	const protocol = isUdp(method) ? 'udp' : 'tcp'
	return ports.map(port => `${port}/${protocol}`)
}

async function tryKillPortsWithFuser(ports, method) {
	const res = await run('fuser', ['-k', ...buildFuserArgs(ports, method)])
	if (res.error) return null
	if (res.code > 1) return null

	const portSet = new Set(ports)
	const portMap = mapPidsFromFuser(res.stdout, res.stderr, portSet)
	if (res.code === 1 && portMap.size === 0) return null
	return { portMap }
}

async function listPidsByPort(ports, method) {
	const portSet = new Set(ports)
	const protocol = isUdp(method) ? 'UDP' : 'TCP'

	if (process.platform === 'win32') {
		const res = await run('netstat', ['-nao', '-p', protocol])
		if (res.error) throw res.error
		return res.stdout ? mapPidsFromNetstat(res.stdout, portSet, protocol) : new Map()
	}

	if (process.platform === 'darwin') {
		return new Promise((resolve, reject) => {
			const map = new Map()
			const args = ['-nav', '-p', protocol.toLowerCase()]
			const child = spawn('netstat', args, { windowsHide: true })
			if (child.error) return reject(child.error)

			const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
			let pidIndex = -1

			rl.on('line', (line) => {
				line = line.trim()
				if (!line) return

				if (line.toLowerCase().startsWith('proto')) {
					const parts = line.split(/\s+/)
					const normalized = []
					for (let i = 0; i < parts.length; i++) {
						const part = parts[i].toLowerCase()
						const next = parts[i + 1]?.toLowerCase()
						if (part === 'local' && next === 'address') {
							normalized.push('local_address')
							i++
							continue
						}
						if (part === 'foreign' && next === 'address') {
							normalized.push('foreign_address')
							i++
							continue
						}
						normalized.push(part)
					}
					pidIndex = normalized.findIndex(p => p === 'pid' || p === 'process:pid')
					return
				}

				const parts = line.split(/\s+/)
				const localAddress = parts[3]
				if (!localAddress) return

				const lastDotIndex = localAddress.lastIndexOf('.')
				if (lastDotIndex === -1) return

				const port = Number.parseInt(localAddress.slice(lastDotIndex + 1), 10)
				if (!port || !portSet.has(port)) return

				let pid = null
				const pidToken = pidIndex !== -1 ? parts[pidIndex] : null

				if (pidToken) {
					if (/^\d+$/.test(pidToken) && pidToken !== '0' && !pidToken.startsWith('0')) {
						pid = toPositivePid(pidToken)
					} else if (pidToken.includes(':')) {
						// Handle name:pid format in the column
						const split = pidToken.split(':')
						const last = split[split.length - 1]
						if (/^\d+$/.test(last) && last !== '0' && !last.startsWith('0')) pid = toPositivePid(last)
					}
				}

				if (!pid) {
					const namePid = parts.find(p => /:\d+$/.test(p) && !p.includes('.'))
					if (namePid) {
						pid = toPositivePid(namePid.split(':')[1])
					} else {
						const pidName = parts.find(p => /^\d+\/\S+/.test(p))
						if (pidName) pid = toPositivePid(pidName.split('/')[0])
					}
				}

				if (pid) {
					addToMapSet(map, port, pid)
				}
			})

			rl.on('close', async () => {
				// Fallback to lsof for any ports not found
				const missingPorts = [...portSet].filter(p => !map.has(p))
				if (missingPorts.length > 0) {
					try {
						const portList = missingPorts.join(',')
						const lsofArgs = isUdp(method)
							? ['-nP', `-iUDP:${portList}`, '-Fpn']
							: ['-nP', `-iTCP:${portList}`, '-sTCP:LISTEN', '-Fpn']

						const res = await run('lsof', lsofArgs)
						if (!res.error && res.code <= 1 && res.stdout) {
							const lsofMap = mapPidsFromLsof(res.stdout, new Set(missingPorts))
							for (const [port, pids] of lsofMap) {
								for (const pid of pids) addToMapSet(map, port, pid)
							}
						}
					} catch (e) {
						// Ignore lsof errors, return what we have
					}
				}
				resolve(map)
			})
			child.on('error', reject)
		})
	}

	const portList = ports.join(',')
	const lsofArgs = isUdp(method)
		? ['-nP', `-iUDP:${portList}`, '-Fpn']
		: ['-nP', `-iTCP:${portList}`, '-sTCP:LISTEN', '-Fpn']

	const res = await run('lsof', lsofArgs)
	if (res.error) throw res.error
	if (res.code > 1) throw new Error(res.stderr || 'Failed to run lsof')
	return res.stdout ? mapPidsFromLsof(res.stdout, portSet) : new Map()
}

export default async function killPort(port, method = 'tcp') {
	port = toPortNumber(port)
	if (!port) throw new Error('Invalid port number provided')

	const udp = isUdp(method)
	const protocol = udp ? 'UDP' : 'TCP'

	if (process.platform === 'win32') {
		const res = await run('netstat', ['-nao', '-p', protocol])
		if (res.error) throw res.error
		if (!res.stdout) return res

		const regex = new RegExp(`^ *${protocol} *[^ ]*:${port}\\b`, 'i')
		const pids = new Set()
		for (const line of res.stdout.split(/\r?\n/)) {
			if (!regex.test(line)) continue
			const match = line.match(/\s(\d+)\s*$/)
			const pid = match ? toPositivePid(match[1]) : null
			if (pid) pids.add(pid)
		}

		if (pids.size === 0) throw new Error('No process running on port')
		return killPids([...pids])
	}

	if (process.platform === 'linux') {
		const fuserResult = await tryKillPortsWithFuser([port], method)
		if (fuserResult) {
			const pids = fuserResult.portMap.get(port)
			if (!pids?.size) throw new Error('No process running on port')
			return { pids: [...pids] }
		}
	}

	if (process.platform === 'darwin') {
		const pidMap = await listPidsByPort([port], method)
		const pids = pidMap.get(port)
		if (!pids || pids.size === 0) throw new Error('No process running on port')
		return killPids([...pids])
	}

	const lsofArgs = udp
		? ['-nP', '-t', `-iUDP:${port}`]
		: ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']

	const res = await run('lsof', lsofArgs)
	if (res.error) throw res.error

	const pids = (res.stdout || '').trim().split(/\s+/).map(toPositivePid).filter(Boolean)
	if (pids.length === 0) {
		if (res.code > 1) throw new Error(res.stderr || 'Failed to run lsof')
		throw new Error('No process running on port')
	}
	return killPids(pids)
}

export async function killPorts(ports, method = 'tcp') {
	const portArray = Array.isArray(ports) ? ports : [ports]
	const normalizedPorts = portArray.map(p => {
		const parsed = toPortNumber(p)
		if (!parsed) throw new Error('Invalid port number provided')
		return parsed
	})

	const uniquePorts = [...new Set(normalizedPorts)]
	if (uniquePorts.length === 0) throw new Error('Invalid port number provided')

	if (uniquePorts.length === 1) {
		const port = uniquePorts[0]
		try {
			const result = await killPort(port, method)
			const pids = Array.isArray(result?.pids) ? result.pids : []
			const results = new Map()
			if (pids.length === 0) {
				results.set(port, { status: 'not_found' })
			} else {
				results.set(port, { status: 'killed', pids })
			}
			return { results, failures: [] }
		} catch (error) {
			const results = new Map()
			if (error?.message === 'No process running on port') {
				results.set(port, { status: 'not_found' })
				return { results, failures: [] }
			}
			if (error?.failures?.length) {
				results.set(port, { status: 'failed', error: new Error('Failed to kill process') })
				return { results, failures: error.failures }
			}
			throw error
		}
	}

	if (process.platform === 'linux') {
		const fuserResult = await tryKillPortsWithFuser(uniquePorts, method)
		if (fuserResult) {
			const results = new Map()
			for (const port of uniquePorts) {
				const pids = fuserResult.portMap.get(port)
				if (!pids?.size) {
					results.set(port, { status: 'not_found' })
				} else {
					results.set(port, { status: 'killed', pids: [...pids] })
				}
			}
			return { results, failures: [] }
		}
	}

	const portMap = await listPidsByPort(uniquePorts, method)
	const allPids = new Set([...portMap.values()].flatMap(pids => [...pids]))
	const { failures } = killPidsSafe([...allPids])
	const failedPidSet = new Set(failures.map(f => String(f.pid)))

	const results = new Map()
	for (const port of uniquePorts) {
		const pids = portMap.get(port)
		if (!pids?.size) {
			results.set(port, { status: 'not_found' })
		} else if ([...pids].some(pid => failedPidSet.has(String(pid)))) {
			results.set(port, { status: 'failed', error: new Error('Failed to kill process') })
		} else {
			results.set(port, { status: 'killed', pids: [...pids] })
		}
	}

	return { results, failures }
}
