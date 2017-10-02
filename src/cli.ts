#!/usr/bin/env node
/*
 * Copyright (C) 2017 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { Command } from 'commander';
import { getTsserverExecutable } from './utils';
import { createLspConnection } from './lsp-connection';
import * as lsp from 'vscode-languageserver';

const program = new Command('typescript-language-server')
    .version(require('../package.json').version)
    .option('--stdio', 'use stdio')
    .option('--node-ipc', 'use node-ipc')
    .option('--socket <port>', 'use socket. example: --socket=5000')
    .option('--tsserver-logFile <tsServerLogFile>', 'Specify a tsserver log file. example: --tsServerLogFile=ts-logs.txt')
    .option('--tsserver-path <path>', `Specifiy path to tsserver. example: --tsserver-path=${getTsserverExecutable()}`)
    .parse(process.argv);

if (!(program.stdio || program.socket || program['node-ipc'])) {
    console.error('Connection type required (stdio, node-ipc, socket). Refer to --help for more details.');
    process.exit(1);
}

createLspConnection({
    tsserverPath: program.path,
    tsserverLogFile: program.tsServerLogFile,
    showMessageLevel: lsp.MessageType.Info
}).listen();
