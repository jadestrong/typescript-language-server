/*
 * Copyright (C) 2017, 2018 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as readline from 'readline';
import * as decoder from 'string_decoder';
import * as protocol from 'typescript/lib/protocol';
import * as tempy from 'tempy';

import { CommandTypes } from './tsp-command-types';
import { Logger, PrefixingLogger } from './logger';
import { Deferred } from './utils';
import { CancellationToken } from 'vscode-jsonrpc';

export interface TspClientOptions {
    logger: Logger;
    tsserverPath: string;
    logFile?: string;
    logVerbosity?: string;
    globalPlugins?: string[];
    pluginProbeLocations?: string[]
    onEvent?: (event: protocol.Event) => void;
}

// 这里对应 vscode/extensitions/typescript-langauge-features/src/typescriptService.ts 文件
// TypeScriptRequestTypes 实际支持三种请求类型，这里只集成了一种 ！！！
interface TypeScriptRequestTypes {
    'geterr': [protocol.GeterrRequestArgs, any],
    'documentHighlights': [protocol.DocumentHighlightsRequestArgs, protocol.DocumentHighlightsResponse],
    'applyCodeActionCommand': [protocol.ApplyCodeActionCommandRequestArgs, protocol.ApplyCodeActionCommandResponse];
    'completionEntryDetails': [protocol.CompletionDetailsRequestArgs, protocol.CompletionDetailsResponse];
    'completionInfo': [protocol.CompletionsRequestArgs, protocol.CompletionInfoResponse];
    'completions': [protocol.CompletionsRequestArgs, protocol.CompletionsResponse];
    'configure': [protocol.ConfigureRequestArguments, protocol.ConfigureResponse];
    'definition': [protocol.FileLocationRequestArgs, protocol.DefinitionResponse];
    'definitionAndBoundSpan': [protocol.FileLocationRequestArgs, protocol.DefinitionInfoAndBoundSpanReponse];
    'docCommentTemplate': [protocol.FileLocationRequestArgs, protocol.DocCommandTemplateResponse];
    'format': [protocol.FormatRequestArgs, protocol.FormatResponse];
    'formatonkey': [protocol.FormatOnKeyRequestArgs, protocol.FormatResponse];
    'getApplicableRefactors': [protocol.GetApplicableRefactorsRequestArgs, protocol.GetApplicableRefactorsResponse];
    'getCodeFixes': [protocol.CodeFixRequestArgs, protocol.GetCodeFixesResponse];
    'getCombinedCodeFix': [protocol.GetCombinedCodeFixRequestArgs, protocol.GetCombinedCodeFixResponse];
    'getEditsForFileRename': [protocol.GetEditsForFileRenameRequestArgs, protocol.GetEditsForFileRenameResponse];
    'getEditsForRefactor': [protocol.GetEditsForRefactorRequestArgs, protocol.GetEditsForRefactorResponse];
    'getOutliningSpans': [protocol.FileRequestArgs, protocol.OutliningSpansResponse];
    'getSupportedCodeFixes': [null, protocol.GetSupportedCodeFixesResponse];
    'implementation': [protocol.FileLocationRequestArgs, protocol.ImplementationResponse];
    'jsxClosingTag': [protocol.JsxClosingTagRequestArgs, protocol.JsxClosingTagResponse];
    'navto': [protocol.NavtoRequestArgs, protocol.NavtoResponse];
    'navtree': [protocol.FileRequestArgs, protocol.NavTreeResponse];
    'occurrences': [protocol.FileLocationRequestArgs, protocol.OccurrencesResponse];
    'organizeImports': [protocol.OrganizeImportsRequestArgs, protocol.OrganizeImportsResponse];
    'projectInfo': [protocol.ProjectInfoRequestArgs, protocol.ProjectInfoResponse];
    'quickinfo': [protocol.FileLocationRequestArgs, protocol.QuickInfoResponse];
    'references': [protocol.FileLocationRequestArgs, protocol.ReferencesResponse];
    'rename': [protocol.RenameRequestArgs, protocol.RenameResponse];
    'signatureHelp': [protocol.SignatureHelpRequestArgs, protocol.SignatureHelpResponse];
    'typeDefinition': [protocol.FileLocationRequestArgs, protocol.TypeDefinitionResponse];
    'compilerOptionsForInferredProjects': [protocol.SetCompilerOptionsForInferredProjectsArgs, protocol.SetCompilerOptionsForInferredProjectsResponse];
}
// 一个微型的 typescript-language-features 客户端，用来和 tsserver 通信
export class TspClient {
    private readlineInterface: readline.ReadLine;
    private tsserverProc: cp.ChildProcess;
    private seq = 0;

    private readonly deferreds: {
        [seq: number]: Deferred<any>
    } = {};

    private logger: Logger
    private tsserverLogger: Logger

    private cancellationPipeName: string | undefined;

    constructor(private options: TspClientOptions) {
        this.logger = new PrefixingLogger(options.logger, '[tsclient]')
        this.tsserverLogger = new PrefixingLogger(options.logger, '[tsserver]')
    }
    // 启动 tsserver ，由 tsp-client 负责与 tsserver 通信
    start() {
        if (this.readlineInterface) {
            return;
        }
        const { tsserverPath, logFile, logVerbosity, globalPlugins, pluginProbeLocations } = this.options;
        const args: string[] = [];
        if (logFile) {
            args.push('--logFile', logFile);
        }
        if (logVerbosity) {
            args.push('--logVerbosity', logVerbosity);
        }
        if (globalPlugins && globalPlugins.length) {
            args.push('--globalPlugins', globalPlugins.join(','))
        }
        if (pluginProbeLocations && pluginProbeLocations.length) {
            args.push('--pluginProbeLocations', pluginProbeLocations.join(','));
        }
        this.cancellationPipeName = tempy.file({ name: 'tscancellation' } as any);
        args.push('--cancellationPipeName', this.cancellationPipeName + '*');
        this.logger.info(`Starting tsserver : '${tsserverPath} ${args.join(' ')}'`);
        const tsserverPathIsModule = path.extname(tsserverPath) === ".js";
        // 使用 child_process 创建来进程，并启动了数据监听？
        this.tsserverProc = tsserverPathIsModule
            ? cp.fork(tsserverPath, args, { silent: true })
            : cp.spawn(tsserverPath, args);
        // readline vs stream 
        this.readlineInterface = readline.createInterface(this.tsserverProc.stdout!, this.tsserverProc.stdin!, undefined);
        process.on('exit', () => {
            this.readlineInterface.close();
            this.tsserverProc.stdin!.destroy();
            this.tsserverProc.kill();
        });
        // 监听 tsserver 的响应 FIXME 监听 line 与 data 的区别，这里用的是 readline
        this.readlineInterface.on('line', line => this.processMessage(line));

        const dec = new decoder.StringDecoder("utf-8");
        this.tsserverProc.stderr!.addListener('data', data => {
            const stringMsg = typeof data === 'string' ? data : dec.write(data);
            this.tsserverLogger.error(stringMsg);
        });
    }

    notify(command: CommandTypes.Open, args: protocol.OpenRequestArgs): void
    notify(command: CommandTypes.Close, args: protocol.FileRequestArgs): void
    notify(command: CommandTypes.Saveto, args: protocol.SavetoRequestArgs): void
    notify(command: CommandTypes.Change, args: protocol.ChangeRequestArgs): void
    notify(command: string, args: object): void {
        this.sendMessage(command, true, args);
    }
    // 一般只有不需要返回结果的，tokens 不需要传递，默认为 undefined
    // 这是 vscode/extenions/typescript-language-features/src/tsServer/server.ts
    // processBasedTsServer 中 executeImpl 方法的简化版
    // 最终所有 lsp 请求都要通过这个方法来和 tsserver 进行交流，这里有必要维护一个请求队列码？
    request<K extends keyof TypeScriptRequestTypes>(
        command: K,
        args: TypeScriptRequestTypes[K][0],
        token?: CancellationToken
    ): Promise<TypeScriptRequestTypes[K][1]> {
        // 看这里应该是有请求就发送了，如果过多可能会有性能损失，而 vscode 通过维护请求队列来处理，性能是不是更好呢？
        this.sendMessage(command, false, args);
        const seq = this.seq;
        // 声明一个带超时时间的 promise ，如何接收响应的呢？ 在下面 resolveResponse 方法中处理
        const request = (this.deferreds[seq] = new Deferred<any>(command)).promise;
        if (token) {
            const onCancelled = token.onCancellationRequested(() => {
                onCancelled.dispose();
                if (this.cancellationPipeName) {
                    const requestCancellationPipeName = this.cancellationPipeName + seq;
                    fs.writeFile(requestCancellationPipeName, '', err => {
                        if (!err) {
                            request.then(() =>
                                fs.unlink(requestCancellationPipeName, () => { /* no-op */ })
                            );
                        }
                    });
                }
            });
        }
        // 这里返回的是一个 Promise, 只有超时或 resolveResponse 响应函数执行之后才会 resolve 或 reject
        // 那个时候，才会返回给 lsp-client
        return request; 
    }

    // 发送信息，将信息组织成 tsserver 需要的格式
    protected sendMessage(command: string, notification: boolean, args?: any): void {
        this.seq = this.seq + 1;
        let request: protocol.Request = {
            command,
            seq: this.seq,
            type: 'request'
        };
        if (args) {
            request.arguments = args;
        }
        const serializedRequest = JSON.stringify(request) + "\n";
        // 将请求信息写入 child_process 
        this.tsserverProc.stdin!.write(serializedRequest);
        this.logger.log(notification ? "notify" : "request", request);
    }

    // 这里接收到响应信息，然后格式化后交给 resolveResponse 处理
    // 相当于 vscode/extenstions/typescript-language-features/src/tsServer/server.ts 文件中 dispatchMessage
    protected processMessage(untrimmedMessageString: string): void {
        const messageString = untrimmedMessageString.trim();
        if (!messageString || messageString.startsWith('Content-Length:')) {
            return;
        }
        const message: protocol.Message = JSON.parse(messageString);
        this.logger.log('processMessage', message);
        if (this.isResponse(message)) {
            this.resolveResponse(message, message.request_seq, message.success);
        } else if (this.isEvent(message)) {
            if (this.isRequestCompletedEvent(message)) {
                this.resolveResponse(message, message.body.request_seq, true);
            } else {
                if (this.options.onEvent) {
                    this.options.onEvent(message);
                }
            }
        }
    }
    // 这里处理响应信息，根据请求编号 request_seq ，找到对应的 promise 
    private resolveResponse(message: protocol.Message, request_seq: number, success: boolean) {
        const deferred = this.deferreds[request_seq];
        this.logger.log('request completed', { request_seq, success });
        if (deferred) {
            if (success) {
                // 这里直接将结果返回给调用 request 的哪里了，剩下的就是处理这个 message 了
                this.deferreds[request_seq].resolve(message);
            } else {
                this.deferreds[request_seq].reject(message);
            }
            delete this.deferreds[request_seq];
        }
    }

    private isEvent(message: protocol.Message): message is protocol.Event {
        return message.type === 'event';
    }

    private isResponse(message: protocol.Message): message is protocol.Response {
        return message.type === 'response';
    }

    private isRequestCompletedEvent(message: protocol.Message): message is protocol.RequestCompletedEvent {
        return this.isEvent(message) && message.event === 'requestCompleted';
    }
}
