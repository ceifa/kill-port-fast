<h1 align="center">kill-port-fast</h1>
<div align="center">
  <strong>Kill process running on given port</strong>
</div>
<div align="center">
  <em>A speed-focused, drop-in replacement fork of <a href="https://github.com/tiaanduplessis/kill-port">kill-port</a></em>
</div>
<br>
<div align="center">
  <a href="https://npmjs.org/package/ceifa">
    <img src="https://img.shields.io/npm/v/ceifa.svg?style=flat-square" alt="Package version" />
  </a>
  <a href="https://npmjs.org/package/ceifa">
    <img src="https://img.shields.io/npm/dm/ceifa.svg?style=flat-square" alt="Downloads" />
  </a>
  <a href="https://github.com/ceifa/kill-port-fast/blob/master/LICENSE">
    <img src="https://img.shields.io/npm/l/kill-port-fast.svg?style=flat-square" alt="License" />
  </a>
</div>
<br>


## Table of Contents
- [Table of Contents](#table-of-contents)
- [Install](#install)
- [Usage](#usage)
- [API](#api)
- [CLI](#cli)
- [Contributing](#contributing)
- [License](#license)

## Install


With `npm`:
```sh
npm install --save kill-port-fast
```

With `yarn`:
```sh
yarn add kill-port-fast
```

With `pnpm`:
```sh
pnpm add kill-port-fast
```

## Usage

```js

const kill = require('kill-port-fast')
const http = require('http')
const port = 8080

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain'
  })

  res.end('Hi!')
})

server.listen(port, () => {
  setTimeout(() => {

    // Currently you can kill ports running on TCP or UDP protocols
    kill(port, 'tcp')
      .then(console.log)
      .catch(console.log)
  }, 1000)
})

```

## API

The module exports a single function that takes a port number as argument. It returns a promise.

## CLI

You can use `kill-port-fast` as a global package.

Install the package globally:

```sh
$ npm install --global kill-port-fast
# OR
$ yarn global add kill-port-fast
```

Then:

```sh
$ kill-port-fast --port 8080
# OR
$ kill-port-fast 9000
# OR you can use UDP
$ kill-port-fast 9000 --method udp
```

You can also kill multiple ports:

```sh
$ kill-port-fast --port 8080,5000,3000
# OR
$ kill-port-fast 9000 3000 5000
```

You can also use [npx](https://nodejs.dev/learn/the-npx-nodejs-package-runner) to `kill-port-fast` without installing:

```sh
# Kill a single port
$ npx kill-port-fast --port 8080
$ npx kill-port-fast 8080
# Use UDP
$ npx kill-port-fast 9000 --method udp
# Kill multiple ports
$ npx kill-port-fast --port 8080,5000,3000
$ npx kill-port-fast 9000 3000 5000
```

## Contributing

Got an idea for a new feature? Found a bug? Contributions are welcome! Please [open up an issue](https://github.com/tiaanduplessis/feature-flip/issues) or [make a pull request](https://makeapullrequest.com/).

## License

[MIT © Tiaan du Plessis](./LICENSE)
