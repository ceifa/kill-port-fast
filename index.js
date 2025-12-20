import { spawnSync } from 'child_process'

const toPortNumber = (value) => Number.parseInt(value, 10) || null
const isUdp = (method) => String(method || 'tcp').toLowerCase() === 'udp'
let ssUsable = null
let fuserUsable = null

function sh(command, args) {
	const result = spawnSync(command, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
	return {
		stdout: result.stdout || '',
		stderr: result.stderr || '',
		code: result.status,
		error: result.error || null
	}
}

function killPidsSafe(pids) {
	const failures = []
	const killed = []
	for (const pid of pids) {
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
			currentPid = line.slice(1)
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
		const pid = parts[parts.length - 1]
		if (port && portSet.has(port) && pid) addToMapSet(map, port, pid)
	}
	return map
}

function mapPidsFromFuser(output, portSet) {
	const map = new Map()
	const pattern = /(\d+)\/(?:tcp|tcp6|udp|udp6):\s*([0-9\s]+)/gi
	for (const match of output.matchAll(pattern)) {
		const port = Number.parseInt(match[1], 10)
		if (!port || !portSet.has(port)) continue

		const pidPart = match[2].trim()
		if (!pidPart) continue

		for (const pid of pidPart.split(/\s+/)) {
			if (/^\d+$/.test(pid)) addToMapSet(map, port, pid)
		}
	}
	return map
}

function buildSsFilterTokens(ports) {
	const tokens = []
	ports.forEach((port, index) => {
		if (index > 0) tokens.push('or')
		tokens.push('sport', '=', `:${port}`)
	})
	return tokens
}

function buildSsArgs(ports, method) {
	const args = ['-H', isUdp(method) ? '-lunp' : '-ltnp']
	const filterTokens = buildSsFilterTokens([...new Set(ports)])
	if (filterTokens.length) args.push(...filterTokens)
	return args
}

function mapPidsFromSs(stdout, portSet) {
	const map = new Map()
	for (const rawLine of stdout.split(/\r?\n/)) {
		if (!rawLine) continue
		const parts = rawLine.trim().split(/\s+/)
		if (parts.length < 5) continue
		const localAddress = parts[3]
		const colonIndex = localAddress.lastIndexOf(':')
		if (colonIndex == null || colonIndex < 0) continue
		const port = Number.parseInt(localAddress.slice(colonIndex + 1), 10)
		if (!port || !portSet.has(port)) continue

		const processInfo = parts.slice(5).join(' ')
		if (!processInfo) continue

		for (const match of processInfo.matchAll(/pid=(\d+)/g)) {
			addToMapSet(map, port, match[1])
		}
	}
	return map
}

function buildFuserArgs(ports, method) {
	const protocol = isUdp(method) ? 'udp' : 'tcp'
	return [...new Set(ports)].map(port => `${port}/${protocol}`)
}

function tryKillPortsWithFuser(ports, method) {
	if (process.platform !== 'linux') return null
	if (fuserUsable === false) return null

	const res = sh('fuser', ['-k', ...buildFuserArgs(ports, method)])
	if (res.error) {
		if (res.error.code === 'ENOENT') fuserUsable = false
		return null
	}
	if (res.code > 1) {
		fuserUsable = false
		return null
	}

	fuserUsable = true
	const output = [res.stdout, res.stderr].filter(Boolean).join('\n')
	const portSet = new Set(ports)
	const portMap = output ? mapPidsFromFuser(output, portSet) : new Map()
	return { portMap }
}

function listPidsByPortWithSs(ports, portSet, method) {
	if (process.platform !== 'linux') return null
	if (ssUsable === false) return null

	const res = sh('ss', buildSsArgs(ports, method))
	if (res.error) {
		if (res.error.code === 'ENOENT') ssUsable = false
		return null
	}
	if (res.code > 1 || (res.code === 1 && res.stderr)) {
		ssUsable = false
		return null
	}

	ssUsable = true
	return res.stdout ? mapPidsFromSs(res.stdout, portSet) : new Map()
}

function listPidsByPort(ports, method) {
	const portSet = new Set(ports)
	const protocol = isUdp(method) ? 'UDP' : 'TCP'

	if (process.platform === 'win32') {
		const res = sh('netstat', ['-nao', '-p', protocol])
		if (res.error) throw res.error
		return res.stdout ? mapPidsFromNetstat(res.stdout, portSet, protocol) : new Map()
	}

	const ssMap = listPidsByPortWithSs(ports, portSet, method)
	if (ssMap !== null) return ssMap

	const portList = ports.join(',')
	const lsofArgs = isUdp(method)
		? ['-nP', `-iUDP:${portList}`, '-Fpn']
		: ['-nP', `-iTCP:${portList}`, '-sTCP:LISTEN', '-Fpn']

	const res = sh('lsof', lsofArgs)
	if (res.error) throw res.error
	if (res.code > 1) throw new Error(res.stderr || 'Failed to run lsof')
	return res.stdout ? mapPidsFromLsof(res.stdout, portSet) : new Map()
}

export default function killPort(port, method = 'tcp') {
	port = toPortNumber(port)
	if (!port) throw new Error('Invalid port number provided')

	const udp = isUdp(method)
	const protocol = udp ? 'UDP' : 'TCP'

	if (process.platform === 'win32') {
		const res = sh('netstat', ['-nao', '-p', protocol])
		if (res.error) throw res.error
		if (!res.stdout) return res

		const regex = new RegExp(`^ *${protocol} *[^ ]*:${port}\\b`, 'i')
		const pids = new Set()
		for (const line of res.stdout.split(/\r?\n/)) {
			if (!regex.test(line)) continue
			const match = line.match(/\s(\d+)\s*$/)
			if (match) pids.add(match[1])
		}

		if (pids.size === 0) throw new Error('No process running on port')
		return killPids([...pids])
	}

	if (process.platform === 'linux') {
		const fuserResult = tryKillPortsWithFuser([port], method)
		if (fuserResult) {
			const pids = fuserResult.portMap.get(port)
			if (!pids?.size) throw new Error('No process running on port')
			return { pids: [...pids] }
		}

		const portSet = new Set([port])
		const ssMap = listPidsByPortWithSs([port], portSet, method)
		if (ssMap !== null) {
			const pids = ssMap.get(port)
			if (!pids?.size) throw new Error('No process running on port')
			return killPids([...pids])
		}
	}

	const lsofArgs = udp
		? ['-nP', '-t', `-iUDP:${port}`]
		: ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']

	const res = sh('lsof', lsofArgs)
	if (res.error) throw res.error

	const pids = (res.stdout || '').trim().split(/\s+/).filter(Boolean)
	if (pids.length === 0) {
		if (res.code > 1) throw new Error(res.stderr || 'Failed to run lsof')
		throw new Error('No process running on port')
	}
	return killPids(pids)
}

export function killPorts(ports, method = 'tcp') {
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
			const result = killPort(port, method)
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
		const fuserResult = tryKillPortsWithFuser(uniquePorts, method)
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

	const portMap = listPidsByPort(uniquePorts, method)
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
