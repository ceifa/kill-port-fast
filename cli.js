#!/usr/bin/env node

import { killPorts } from './index.js'

const args = process.argv.slice(2)
let method = 'tcp'
let verbose = false
const ports = []

for (let i = 0; i < args.length; i++) {
	const arg = args[i]

	if (arg === '--') {
		args.slice(i + 1).forEach(a => ports.push(...a.split(',')))
		break
	}
	if (arg === '-v' || arg === '--verbose') { verbose = true; continue }
	if (arg === '-m' || arg === '--method') { method = args[++i] || method; continue }
	if (arg.startsWith('--method=')) { method = arg.slice(9) || method; continue }
	if (arg === '-p' || arg === '--port') { ports.push(...(args[++i] || '').split(',')); continue }
	if (arg.startsWith('--port=')) { ports.push(...arg.slice(7).split(',')); continue }
	if (!arg.startsWith('-')) ports.push(...arg.split(','))
}

const inputPorts = ports.filter(Boolean).length ? ports.filter(Boolean) : [undefined]
const parsedPorts = inputPorts.map(p => parseInt(p, 10) || null)
const uniquePorts = [...new Set(parsedPorts.filter(Boolean))]

const log = (port, success, info) => {
	console.log(success ? `Process on port ${port} killed` : `Could not kill process on port ${port}. ${info}.`)
	if (verbose) console.log(success ? { pids: info } : info)
}

if (!uniquePorts.length) {
	inputPorts.forEach(p => log(p, false, 'Invalid port number provided'))
} else {
	try {
		const { results } = killPorts(uniquePorts, method)
		const seen = new Set()

		inputPorts.forEach((port, i) => {
			const parsed = parsedPorts[i]
			if (!parsed) return log(port, false, 'Invalid port number provided')

			const entry = results.get(parsed)
			if (!entry || entry.status === 'not_found' || seen.has(parsed)) {
				log(port, false, 'No process running on port')
			} else if (entry.status === 'killed') {
				seen.add(parsed)
				log(port, true, entry.pids)
			} else {
				log(port, false, entry.error?.message || 'Failed to kill process')
			}
		})
	} catch (error) {
		inputPorts.forEach((port, i) => {
			log(port, false, parsedPorts[i] ? error.message : 'Invalid port number provided')
		})
	}
}
