// loaded on demand: the linux fast path never spawns, so a top-level import is dead weight there
let spawnProcess = null
const loadSpawn = async () => (spawnProcess ??= (await import('child_process')).spawn)

// killPorts and cli.js both match on this text, so it lives in one place
const NO_PROCESS = 'No process running on port'

const toPortNumber = (value) => Number.parseInt(value, 10) || null
const isUdp = (method) => String(method || 'tcp').toLowerCase() === 'udp'
const toPositivePid = (value) => {
	const pid = Number.parseInt(String(value), 10)
	// ports sometimes are open but not assigned to any process
	return Number.isInteger(pid) && pid > 0 ? String(pid) : null
}

// absolute paths skip the PATH search execvp would otherwise do per candidate directory;
// the bare name stays reachable so unusual layouts still work, cached after the first miss
const commandPaths = process.platform === 'darwin'
	? { netstat: '/usr/sbin/netstat', lsof: '/usr/sbin/lsof' }
	: process.platform === 'linux'
		? { lsof: '/usr/bin/lsof', fuser: '/usr/bin/fuser' }
		: {}

const resolveCommand = (name) => commandPaths[name] || name
const demoteCommand = (name) => { commandPaths[name] = name }

async function run(command, args, stdio) {
	const spawn = await loadSpawn()
	return new Promise((resolve) => {
		const attempt = (cmd) => {
			// a failed spawn emits 'error' then 'close', so the abandoned child must not
			// settle the promise once a retry has taken over
			let retried = false
			const child = spawn(cmd, args, { windowsHide: true, stdio })
			const out = []
			const err = []
			if (child.stdout) child.stdout.on('data', c => out.push(c))
			if (child.stderr) child.stderr.on('data', c => err.push(c))
			child.on('close', code => {
				if (retried) return
				resolve({
					stdout: out.length === 1 ? out[0].toString() : Buffer.concat(out).toString(),
					stderr: err.length === 1 ? err[0].toString() : Buffer.concat(err).toString(),
					code,
					error: null,
				})
			})
			child.on('error', error => {
				if (error?.code === 'ENOENT' && cmd !== command) {
					retried = true
					demoteCommand(command)
					return attempt(command)
				}
				resolve({ stdout: '', stderr: '', code: null, error })
			})
		}
		attempt(resolveCommand(command))
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

const allPidsIn = (portMap) => new Set([...portMap.values()].flatMap(pids => [...pids]))

function shapePortResults(ports, portMap, failedPidSet) {
	const results = new Map()
	for (const port of ports) {
		const pids = portMap.get(port)
		if (!pids?.size) {
			results.set(port, { status: 'not_found' })
		} else if (failedPidSet && [...pids].some(pid => failedPidSet.has(String(pid)))) {
			results.set(port, { status: 'failed', error: new Error('Failed to kill process') })
		} else {
			results.set(port, { status: 'killed', pids: [...pids] })
		}
	}
	return results
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
	// exit 1 with a silent stderr is fuser stating that nothing holds these ports; it
	// matches every socket state, so `lsof -sTCP:LISTEN` is a strict subset of what it
	// just ruled out. Output on stderr means fuser complained, so lsof still gets a turn.
	if (res.code === 1 && portMap.size === 0 && res.stderr.trim() !== '') return null
	return { portMap }
}

// Loaded on demand so macOS and Windows, which never read /proc, do not pay the import.
let readFileSync, readdirSync, readlinkSync
const loadProcFs = async () => {
	if (!readFileSync) ({ readFileSync, readdirSync, readlinkSync } = await import('node:fs'))
}

// null means /proc/net was unreadable, whereas an empty map is an authoritative
// "nothing holds these ports" -- the callers depend on that distinction
function collectSocketLinks(portSet, method) {
	const linkToPort = new Map()
	let readAny = false

	const files = isUdp(method)
		? ['/proc/net/udp', '/proc/net/udp6']
		: ['/proc/net/tcp', '/proc/net/tcp6']

	for (const file of files) {
		let text
		try { text = readFileSync(file, 'latin1') } catch { continue }
		readAny = true

		const length = text.length
		let pos = text.indexOf('\n') + 1
		while (pos > 0 && pos < length) {
			let eol = text.indexOf('\n', pos)
			if (eol === -1) eol = length
			let i = pos
			pos = eol + 1

			while (i < eol && text.charCodeAt(i) === 32) i++
			while (i < eol && text.charCodeAt(i) !== 32) i++
			while (i < eol && text.charCodeAt(i) === 32) i++
			const addrStart = i
			while (i < eol && text.charCodeAt(i) !== 32) i++
			const addrEnd = i

			const colon = text.lastIndexOf(':', addrEnd - 1)
			if (colon < addrStart || colon + 1 === addrEnd) continue

			// parsed in place to avoid allocating a substring per row
			let port = 0
			for (let k = colon + 1; k < addrEnd; k++) {
				const c = text.charCodeAt(k)
				const digit = c >= 48 && c <= 57 ? c - 48
					: c >= 65 && c <= 70 ? c - 55
						: c >= 97 && c <= 102 ? c - 87 : -1
				if (digit < 0) { port = -1; break }
				port = port * 16 + digit
			}
			if (port <= 0 || !portSet.has(port)) continue

			let column = 1
			while (i < eol) {
				while (i < eol && text.charCodeAt(i) === 32) i++
				if (i >= eol) break
				const tokenStart = i
				while (i < eol && text.charCodeAt(i) !== 32) i++
				if (++column === 9) {
					linkToPort.set(`socket:[${text.slice(tokenStart, i)}]`, port)
					break
				}
			}
		}
	}

	return readAny ? linkToPort : null
}

// Every process is scanned: one socket can be held by a whole process tree (a forked or
// clustered server), and one process can hold sockets for several of the requested
// ports, so there is no sound place to stop early. fuser resolves owners the same way.
function pidsByPortFromProc(linkToPort) {
	const map = new Map()
	if (linkToPort.size === 0) return map

	let entries
	try { entries = readdirSync('/proc') } catch { return map }

	for (const entry of entries) {
		const code = entry.charCodeAt(0)
		if (code < 48 || code > 57) continue
		const dir = `/proc/${entry}/fd/`
		let fds
		try { fds = readdirSync(dir) } catch { continue }
		for (let i = 0; i < fds.length; i++) {
			let link
			try { link = readlinkSync(dir + fds[i]) } catch { continue }
			// only socket:[…] can match, so most fds skip the map lookup entirely
			if (link.charCodeAt(0) !== 115) continue
			const port = linkToPort.get(link)
			if (port !== undefined) addToMapSet(map, port, entry)
		}
	}
	return map
}

// /proc is where fuser and lsof read from anyway, so resolving it in-process skips a
// fork+exec and measured faster than fuser at every process count tested
async function procPidsByPort(portSet, method) {
	try {
		await loadProcFs()
		const linkToPort = collectSocketLinks(portSet, method)
		return linkToPort && pidsByPortFromProc(linkToPort)
	} catch { return null }
}

// must match \s / String#trim exactly: this replaced a trim()+split(/\s+/) parser,
// and netstat output never reaches the non-ASCII arm in practice
const UNICODE_SPACE = new Set([0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
	0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff])
const isSpace = (code) => code === 32 || (code >= 9 && code <= 13) || (code > 127 && UNICODE_SPACE.has(code))

// the column layout of `netstat -nav` varies across macOS releases, so the PID column
// is located by name rather than by a fixed offset
function findPidIndex(header) {
	const parts = header.split(/\s+/)
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
	return normalized.findIndex(p => p === 'pid' || p === 'process:pid')
}

function extractPid(parts, pidIndex) {
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

	return pid
}

// `netstat -nav` emits ~20 columns per socket, but only the local address decides
// whether a row is interesting, so non-matching rows are never fully split
export function parseDarwinNetstat(text, portSet) {
	const map = new Map()
	const seen = new Set()
	let pidIndex = -1
	let pos = 0
	const length = text.length

	while (pos < length) {
		let eol = text.indexOf('\n', pos)
		if (eol === -1) eol = length
		let start = pos
		let end = eol
		pos = eol + 1

		while (start < end && isSpace(text.charCodeAt(start))) start++
		while (end > start && isSpace(text.charCodeAt(end - 1))) end--
		if (start >= end) continue

		// short-circuits so the slice stays off the hot path
		if ((text.charCodeAt(start) | 32) === 112 && end - start >= 5
			&& text.slice(start, start + 5).toLowerCase() === 'proto') {
			pidIndex = findPidIndex(text.slice(start, end))
			continue
		}

		// column 3 is the local address
		let i = start
		let column = 0
		let addrStart = -1
		let addrEnd = -1
		while (i < end) {
			while (i < end && isSpace(text.charCodeAt(i))) i++
			if (i >= end) break
			const tokenStart = i
			while (i < end && !isSpace(text.charCodeAt(i))) i++
			if (column === 3) {
				addrStart = tokenStart
				addrEnd = i
				break
			}
			column++
		}
		if (addrStart === -1) continue

		const lastDot = text.lastIndexOf('.', addrEnd - 1)
		if (lastDot === -1 || lastDot < addrStart) continue

		const port = Number.parseInt(text.slice(lastDot + 1, addrEnd), 10)
		if (!port || !portSet.has(port)) continue

		// matching rows are rare, so fidelity beats speed from here on
		seen.add(port)
		const pid = extractPid(text.slice(start, end).split(/\s+/), pidIndex)
		if (pid) addToMapSet(map, port, pid)
	}

	return { map, seen, pidIndex }
}

async function readDarwinNetstat(method) {
	// stderr is unused here, so it is never given a pipe
	const res = await run('netstat', ['-nav', '-p', isUdp(method) ? 'udp' : 'tcp'], ['ignore', 'pipe', 'ignore'])
	if (res.error) throw res.error
	return res.stdout
}

async function lsofPidsByPort(ports, method) {
	const portList = ports.join(',')
	const lsofArgs = isUdp(method)
		? ['-nP', `-iUDP:${portList}`, '-Fpn']
		: ['-nP', `-iTCP:${portList}`, '-sTCP:LISTEN', '-Fpn']
	return run('lsof', lsofArgs)
}

async function listPidsByPort(ports, method) {
	const portSet = new Set(ports)

	if (process.platform === 'win32') {
		const protocol = isUdp(method) ? 'UDP' : 'TCP'
		const res = await run('netstat', ['-nao', '-p', protocol])
		if (res.error) throw res.error
		return res.stdout ? mapPidsFromNetstat(res.stdout, portSet, protocol) : new Map()
	}

	if (process.platform === 'darwin') {
		const stdout = await readDarwinNetstat(method)
		const { map, seen, pidIndex } = parseDarwinNetstat(stdout, portSet)

		// netstat reads the kernel socket table, so a port it never listed has nothing
		// bound and lsof cannot find it either. Only an absent PID column (older macOS)
		// or a listed socket whose PID would not parse is worth spawning lsof for.
		const missingPorts = []
		for (const port of portSet) {
			if (map.has(port)) continue
			if (pidIndex === -1 || seen.has(port)) missingPorts.push(port)
		}

		if (missingPorts.length > 0) {
			try {
				const res = await lsofPidsByPort(missingPorts, method)
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

		return map
	}

	const res = await lsofPidsByPort(ports, method)
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

		if (pids.size === 0) throw new Error(NO_PROCESS)
		return killPids([...pids])
	}

	if (process.platform === 'linux') {
		const procMap = await procPidsByPort(new Set([port]), method)
		const portMap = procMap ?? (await tryKillPortsWithFuser([port], method))?.portMap
		if (portMap) {
			const pids = portMap.get(port)
			if (!pids?.size) throw new Error(NO_PROCESS)
			// fuser -k already signalled what it found; the /proc path has to do it itself
			if (procMap) killPidsSafe(pids)
			return { pids: [...pids] }
		}
	}

	if (process.platform === 'darwin') {
		const pidMap = await listPidsByPort([port], method)
		const pids = pidMap.get(port)
		if (!pids || pids.size === 0) throw new Error(NO_PROCESS)
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
		throw new Error(NO_PROCESS)
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
			if (error?.message === NO_PROCESS) {
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
		// one pass covers every requested port, the same way a single fuser call did
		const procMap = await procPidsByPort(new Set(uniquePorts), method)
		const portMap = procMap ?? (await tryKillPortsWithFuser(uniquePorts, method))?.portMap
		if (portMap) {
			// fuser -k already signalled what it found; the /proc path has to do it itself
			if (procMap) killPidsSafe(allPidsIn(portMap))
			return { results: shapePortResults(uniquePorts, portMap), failures: [] }
		}
	}

	const portMap = await listPidsByPort(uniquePorts, method)
	const { failures } = killPidsSafe(allPidsIn(portMap))
	const failedPidSet = new Set(failures.map(f => String(f.pid)))

	return { results: shapePortResults(uniquePorts, portMap, failedPidSet), failures }
}
