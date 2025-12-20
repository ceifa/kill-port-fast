import { spawnSync } from 'child_process'

const toPortNumber = (value) => Number.parseInt(value, 10) || null
const isUdp = (method) => String(method || 'tcp').toLowerCase() === 'udp'

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

function mapPidsFromFuser(stdout, stderr, portSet) {
	const map = new Map()

	// fuser output format:
	// stdout: "    18    19" (PIDs only, space-separated)
	// stderr (non-verbose): "3456/tcp:           \n3457/tcp:           \n"
	// stderr (verbose):
	//   "                     USER        PID ACCESS COMMAND\n"
	//   "3456/tcp:            root      F.... node\n"
	//   "3457/tcp:            root      F.... node\n"
	//
	// PIDs in stdout appear in same order as ports in stderr

	const portsInOrder = []
	const portHeaderPattern = /^(\d+)\/(?:tcp|tcp6|udp|udp6):/gim
	for (const match of stderr.matchAll(portHeaderPattern)) {
		const port = Number.parseInt(match[1], 10)
		if (port) portsInOrder.push(port)
	}

	const pidsInOrder = stdout.trim().split(/\s+/).filter(p => /^\d+$/.test(p))
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

function tryKillPortsWithFuser(ports, method) {
	const res = sh('fuser', ['-k', ...buildFuserArgs(ports, method)])
	if (res.error) {
		return null
	}
	if (res.code > 1) {
		return null
	}

	const portSet = new Set(ports)
	const portMap = mapPidsFromFuser(res.stdout, res.stderr, portSet)
	// If exit code 1 (no processes found) and couldn't parse any PIDs, fall back to other methods
	// Note: exit code 0 means fuser killed something, so we return the result even if parsing failed
	if (res.code === 1 && portMap.size === 0) return null
	return { portMap }
}

function listPidsByPort(ports, method) {
	const portSet = new Set(ports)
	const protocol = isUdp(method) ? 'UDP' : 'TCP'

	if (process.platform === 'win32') {
		const res = sh('netstat', ['-nao', '-p', protocol])
		if (res.error) throw res.error
		return res.stdout ? mapPidsFromNetstat(res.stdout, portSet, protocol) : new Map()
	}

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
