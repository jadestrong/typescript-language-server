/*
 * Copyright (C) 2017, 2018 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as path from 'path';
import * as tempy from 'tempy';
import * as lsp from 'vscode-languageserver';
import * as lspcalls from './lsp-protocol.calls.proposed';
import * as tsp from 'typescript/lib/protocol';
import * as fs from 'fs-extra';
import * as commandExists from 'command-exists';
import debounce = require('p-debounce');

import { CommandTypes, EventTypesEnum } from './tsp-command-types';

import { Logger, PrefixingLogger } from './logger';
import { TspClient } from './tsp-client';

import { LspClient } from './lsp-client';
import { DiagnosticEventQueue } from './diagnostic-queue';
import { findPathToModule } from './modules-resolver';
import {
    toDocumentHighlight, asRange, asTagsDocumentation,
    uriToPath, toSymbolKind, toLocation, toPosition,
    pathToUri, toTextEdit, toFileRangeRequestArgs,
} from './protocol-translation';
import { getTsserverExecutable } from './utils';
import { LspDocuments, LspDocument } from './document';
import { TSCompletionItem, asResolvedCompletionItem } from './completion';
import { asSignatureHelp } from './hover';
import { Commands } from './commands';
import { provideQuickFix } from './quickfix';
import { provideRefactors } from './refactor';
import { provideOrganizeImports } from './organize-imports';
import { TypeScriptInitializeParams, TypeScriptInitializationOptions, TypeScriptInitializeResult } from './ts-protocol';
import { collectDocumentSymbols, collectSymbolInformations } from './document-symbol';
import { computeCallers, computeCallees } from './calls';
import * as PConst from './protocol.const';
// import winstonLogger from './winstonLogger';
// import { MyCompletionItem } from './features/completions';
import { asCompletionItem } from './completion';
// import { fuzzyScore, fuzzyScoreGracefulAggressive, FuzzyScorer, FuzzyScore, anyScore } from './filters';

export interface DotAccessorContext {
    readonly range: lsp.Range;
    readonly text: string;
}


export interface IServerOptions {
    logger: Logger
    tsserverPath?: string;
    tsserverLogFile?: string;
    tsserverLogVerbosity?: string;
    lspClient: LspClient;
}

interface CompletionConfiguration {
    readonly useCodeSnippetsOnMethodSuggest: boolean;
    readonly nameSuggestions: boolean;
    readonly pathSuggestions: boolean;
    readonly autoImportSuggestions: boolean;
    readonly includeAutomaticOptionalChainCompletions: boolean;
}

function showExcludeCompletionEntry(
    element: protocol.CompletionEntry,
    completionConfiguration: CompletionConfiguration
) {
    return (
        (!completionConfiguration.nameSuggestions && element.kind === PConst.Kind.warning)
        || (!completionConfiguration.pathSuggestions &&
            (element.kind === PConst.Kind.directory || element.kind === PConst.Kind.script || element.kind === PConst.Kind.externalModuleName))
        || (!completionConfiguration.autoImportSuggestions && element.hasAction)
    );
}

// language-server 服务，用于和 lsp-client 通信，然后将其转发给 tspClient ，由其与 tsserver 通信
// vscode 中应该是 lsp-client 直接与 tsserver 通信
// 编辑器会将变化通知 lsp-client ，然后它与 language-server 通信获取反馈后再交给编辑器来渲染结果
// 一些 vscode 在 client 层的做的优化，由于 emacs 的 lsp 没有专门的 javascript/typescript 的 lsp-client ，因此，应该放在这个中间服务来做；
// 这个中间服务是按 lsp 协议实现的，所以，在 tsserver 返回的结果时进行这些优化处理，
// 以及一些 lsp-client 没有做的默认请求配置，比如 compilerOptions 等需要放到这个中间 server 中来做
export class LspServer {

    private initializeParams: TypeScriptInitializeParams;
    private initializeResult: TypeScriptInitializeResult;
    private tspClient: TspClient;
    private diagnosticQueue: DiagnosticEventQueue;
    private logger: Logger;

    private readonly documents = new LspDocuments();

    constructor(private options: IServerOptions) {
        this.logger = new PrefixingLogger(options.logger, '[lspserver]')
        this.diagnosticQueue = new DiagnosticEventQueue(
            diagnostics => this.options.lspClient.publishDiagnostics(diagnostics),
            this.documents,
            this.logger
        );
    }

    closeAll(): void {
        for (const file of [...this.documents.files]) {
            this.closeDocument(file);
        }
    }

    protected findTsserverPath(): string {
        if (this.options.tsserverPath) {
            return this.options.tsserverPath;
        }
        // 1) look into node_modules of workspace root
        let executable = findPathToModule(this.rootPath(), `.bin/${getTsserverExecutable()}`);
        if (executable) {
            return executable;
        }
        // 2) use globally installed tsserver
        if (commandExists.sync(getTsserverExecutable())) {
            return getTsserverExecutable();
        }
        // 3) look into node_modules of typescript-language-server
        const bundled = findPathToModule(__dirname, path.join("typescript", "lib", "tsserver.js"));
        if (!bundled) {
            throw Error(`Couldn't find '${getTsserverExecutable()}' executable or 'tsserver.js' module`)
        }
        return bundled;
    }

    async initialize(params: TypeScriptInitializeParams): Promise<TypeScriptInitializeResult> {
        this.logger.log('initialize', params);
        this.initializeParams = params;

        const { logVerbosity, plugins }: TypeScriptInitializationOptions = {
            logVerbosity: this.options.tsserverLogVerbosity,
            plugins: [],
            ...this.initializeParams.initializationOptions
        };
        const logFile = this.getLogFile(logVerbosity);
        const globalPlugins: string[] = [];
        const pluginProbeLocations: string[] = [];
        for (const plugin of plugins) {
            globalPlugins.push(plugin.name);
            pluginProbeLocations.push(plugin.location);
        }

        const tsserverPath = this.findTsserverPath();
        this.tspClient = new TspClient({
            tsserverPath,
            logFile,
            logVerbosity,
            globalPlugins,
            pluginProbeLocations,
            logger: this.options.logger,
            onEvent: this.onTsEvent.bind(this)
        });
        this.tspClient.start(); // 缺少在 service start 之后，配置 compilerOptions 的请求

        this.tspClient.request(CommandTypes.Configure, {
            // hostInfo: 'Emacs 26.3',
            hostInfo: 'vscode',
            preferences: {
                allowRenameOfImportPath: true,
                providePrefixAndSuffixTextForRename: true
            },
            watchOptions: {}
        });

        // 需要在这里进行 compilerOptions 配置
        this.tspClient.request(CommandTypes.CompilerOptionsForInferredProjects, {
            options: {
                module: 'commonjs' as protocol.ModuleKind,
                target: 'es2016' as protocol.ScriptTarget,
                jsx: 'preserve' as protocol.JsxEmit,
                allowJs: true,
                allowSyntheticDefaultImports: true,
                allowNonTsExtensions: true,
                resolveJsonModule: true,
                sourceMap: true,
                strictNullChecks: true
            }
        });

        const logFileUri = logFile && pathToUri(logFile, undefined);
        this.initializeResult = {
            capabilities: {
                textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
                completionProvider: {
                    triggerCharacters: ['.', '"', '\'', '/', '@', '<'],
                    resolveProvider: true
                },
                codeActionProvider: true,
                definitionProvider: true,
                documentFormattingProvider: true,
                documentHighlightProvider: true,
                documentSymbolProvider: true,
                executeCommandProvider: {
                    commands: [
                        Commands.APPLY_WORKSPACE_EDIT,
                        Commands.APPLY_CODE_ACTION,
                        Commands.APPLY_REFACTORING,
                        Commands.ORGANIZE_IMPORTS,
                        Commands.APPLY_RENAME_FILE
                    ]
                },
                hoverProvider: true,
                renameProvider: true,
                referencesProvider: true,
                signatureHelpProvider: {
                    triggerCharacters: ['(', ',', '<']
                },
                workspaceSymbolProvider: true,
                implementationProvider: true,
                typeDefinitionProvider: true,
                foldingRangeProvider: true
            },
            logFileUri
        };
        (this.initializeResult.capabilities as lspcalls.CallsServerCapabilities).callsProvider = true;
        this.logger.log('onInitialize result', this.initializeResult);
        return this.initializeResult;
    }
    protected getLogFile(logVerbosity: string | undefined): string | undefined {
        if (logVerbosity === undefined) {
            return undefined;
        }
        const logFile = this.doGetLogFile();
        if (logFile) {
            fs.ensureFileSync(logFile);
            return logFile;
        }
        return tempy.file(<any>{ name: 'tsserver.log' });

    }
    protected doGetLogFile(): string | undefined {
        if (process.env.TSSERVER_LOG_FILE) {
            return process.env.TSSERVER_LOG_FILE;
        }
        if (this.options.tsserverLogFile) {
            return this.options.tsserverLogFile;
        }
        if (this.initializeParams.rootUri) {
            return path.join(uriToPath(this.initializeParams.rootUri)!, '.log/tsserver.log');
        }
        if (this.initializeParams.rootPath) {
            return path.join(this.initializeParams.rootPath, '.log/tsserver.log');
        }
        return undefined;
    }

    protected diagnosticsTokenSource: lsp.CancellationTokenSource | undefined;
    protected interuptDiagnostics<R>(f: () => R): R {
        if (!this.diagnosticsTokenSource) {
            return f();
        }
        this.cancelDiagnostics();
        const result = f();
        this.requestDiagnostics();
        return result;
    }
    readonly requestDiagnostics = debounce(() => this.doRequestDiagnostics(), 200);
    protected async doRequestDiagnostics(): Promise<tsp.RequestCompletedEvent> {
        this.cancelDiagnostics();
        const geterrTokenSource = new lsp.CancellationTokenSource();
        this.diagnosticsTokenSource = geterrTokenSource;

        const { files } = this.documents;
        try {
            return await this.tspClient.request(CommandTypes.Geterr, { delay: 0, files }, this.diagnosticsTokenSource.token);
        } finally {
            if (this.diagnosticsTokenSource === geterrTokenSource) {
                this.diagnosticsTokenSource = undefined;
            }
        }
    }
    protected cancelDiagnostics(): void {
        if (this.diagnosticsTokenSource) {
            this.diagnosticsTokenSource.cancel();
            this.diagnosticsTokenSource = undefined;
        }
    }

    didOpenTextDocument(params: lsp.DidOpenTextDocumentParams): void {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('onDidOpenTextDocument', params, file);
        if (!file) {
            return;
        }
        if (this.documents.open(file, params.textDocument)) {
            this.tspClient.notify(CommandTypes.Open, {
                file,
                fileContent: params.textDocument.text,
                scriptKindName: this.getScriptKindName(params.textDocument.languageId),
                projectRootPath: this.rootPath()
            });
            this.requestDiagnostics();
        } else {
            this.logger.log(`Cannot open already opened doc '${params.textDocument.uri}'.`);
            this.didChangeTextDocument({
                textDocument: params.textDocument,
                contentChanges: [
                    {
                        text: params.textDocument.text
                    }
                ]
            });
        }
    }

    protected getScriptKindName(languageId: string): tsp.ScriptKindName | undefined {
        switch (languageId) {
            case 'typescript': return 'TS';
            case 'typescriptreact': return 'TSX';
            case 'javascript': return 'JS';
            case 'javascriptreact': return 'JSX';
        }
        return undefined;
    }

    didCloseTextDocument(params: lsp.DidCloseTextDocumentParams): void {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('onDidCloseTextDocument', params, file);
        if (!file) {
            return;
        }
        this.closeDocument(file);
    }
    protected closeDocument(file: string): void {
        const document = this.documents.close(file);
        if (!document) {
            return;
        }
        this.tspClient.notify(CommandTypes.Close, { file });

        // We won't be updating diagnostics anymore for that file, so clear them
        // so we don't leave stale ones.
        this.options.lspClient.publishDiagnostics({
            uri: document.uri,
            diagnostics: [],
        });
    }

    didChangeTextDocument(params: lsp.DidChangeTextDocumentParams): void {
        const { textDocument } = params;
        const file = uriToPath(textDocument.uri);
        this.logger.log('onDidChangeTextDocument', params, file);
        if (!file) {
            return;
        }

        const document = this.documents.get(file);
        if (!document) {
            this.logger.error("Received change on non-opened document " + textDocument.uri);
            throw new Error("Received change on non-opened document " + textDocument.uri);
        }
        if (textDocument.version === null) {
            throw new Error(`Received document change event for ${textDocument.uri} without valid version identifier`);
        }

        for (const change of params.contentChanges) {
            let line, offset, endLine, endOffset = 0;
            if ('range' in change) {
                line = change.range.start.line + 1;
                offset = change.range.start.character + 1;
                endLine = change.range.end.line + 1;
                endOffset = change.range.end.character + 1;
            } else {
                line = 1;
                offset = 1;
                const endPos = document.positionAt(document.getText().length);
                endLine = endPos.line + 1;
                endOffset = endPos.character + 1;
            }
            this.tspClient.notify(CommandTypes.Change, {
                file,
                line,
                offset,
                endLine,
                endOffset,
                insertString: change.text
            });
            document.applyEdit(textDocument.version, change);
        }
        this.requestDiagnostics();
    }

    didSaveTextDocument(params: lsp.DidChangeTextDocumentParams): void {
        // do nothing
    }

    async definition(params: lsp.TextDocumentPositionParams): Promise<lsp.Definition> {
        // TODO: implement version checking and if semver.gte(version, 270) use `definitionAndBoundSpan` instead
        return this.getDefinition({
            type: 'definition',
            params
        });
    }

    async implementation(params: lsp.TextDocumentPositionParams): Promise<lsp.Definition> {
        return this.getDefinition({
            type: 'implementation',
            params
        });
    }

    async typeDefinition(params: lsp.TextDocumentPositionParams): Promise<lsp.Definition> {
        return this.getDefinition({
            type: 'typeDefinition',
            params
        });
    }

    protected async getDefinition({ type, params }: {
        type: 'definition' | 'implementation' | 'typeDefinition',
        params: lsp.TextDocumentPositionParams
    }): Promise<lsp.Definition> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log(type, params, file);
        if (!file) {
            return [];
        }

        const result = await this.tspClient.request(type as CommandTypes.Definition, {
            file,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });
        return result.body ? result.body.map(fileSpan => toLocation(fileSpan, this.documents)) : [];
    }

    async documentSymbol(params: lsp.TextDocumentPositionParams): Promise<lsp.DocumentSymbol[] | lsp.SymbolInformation[]> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('symbol', params, file);
        if (!file) {
            return [];
        }

        const response = await this.tspClient.request(CommandTypes.NavTree, {
            file
        });
        const tree = response.body;
        if (!tree || !tree.childItems) {
            return [];
        }
        if (this.supportHierarchicalDocumentSymbol) {
            const symbols: lsp.DocumentSymbol[] = [];
            for (const item of tree.childItems) {
                collectDocumentSymbols(item, symbols);
            }
            return symbols;
        }
        const symbols: lsp.SymbolInformation[] = [];
        for (const item of tree.childItems) {
            collectSymbolInformations(params.textDocument.uri, item, symbols);
        }
        return symbols;
    }
    protected get supportHierarchicalDocumentSymbol(): boolean {
        const textDocument = this.initializeParams.capabilities.textDocument;
        const documentSymbol = textDocument && textDocument.documentSymbol;
        return !!documentSymbol && !!documentSymbol.hierarchicalDocumentSymbolSupport
    }

    /*
     * implemented based on
     * https://github.com/Microsoft/vscode/blob/master/extensions/typescript-language-features/src/features/completions.ts
     */
    async completion(params: lsp.CompletionParams): Promise<lsp.CompletionList | null> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('completion', params, file); // 这个是发送给 lsp-client 的信息，就是我们在 lsp-xxx.log
        //  文件中看到的那些，包含了请求和响应
        if (!file) {
            return { isIncomplete: false, items: [] };
        }

        const document = this.documents.get(file);
        // winstonLogger.log('info', 'the line text is: %s', document?.lineAt(params.position.line));
        // NOTE params.position 与 vscode 内部的 position 的转换关系就在 extHostTypeConverters.ts 文件 Position.to 方法中
        //   { lineNumber: params.position.line + 1, column: params.position.character + 1 }
        if (!document) {
            throw new Error("The document should be opened for completion, file: " + file);
        }
        const args: protocol.CompletionsRequestArgs & { includeAutomaticOptionalChainCompletions?: boolean } = {
            file,
            line: params.position.line + 1,
            offset: params.position.character + 1,
            includeExternalModuleExports: true,
            includeInsertTextCompletions: true,
            includeAutomaticOptionalChainCompletions: true,
            triggerCharacter: params.context?.triggerCharacter as tsp.CompletionsTriggerCharacter 
        };
        try {
            // {
            // "seq":0,
            // "type":"response",
            // "command":"completionInfo",
            // "request_seq":36,
            // "success":true,
            // "performanceData":{"updateGraphDurationMs":6},
            // "body":{"isGlobalCompletion":false,"isMemberCompletion":true,"isNewIdentifierLocation":false,"entries":[{"name":"child","kind":"warning","kindModifiers":"","sortText":"6"},{"name":"clearImmediate","kind":"function","kindModifiers":"declare","sortText":"0"},{"name":"clearInterval","kind":"function","kindModifiers":"declare","sortText":"0"},{"name":"clearTimeout","kind":"function","kindModifiers":"declare","sortText":"0"},{"name":"cp","kind":"warning","kindModifiers":"","sortText":"6"},{"name":"fork","kind":"warning","kindModifiers":"","sortText":"6"},{"name":"fs","kind":"warning","kindModifiers":"","sortText":"6"},{"name":"net","kind":"warning","kindModifiers":"","sortText":"6"},{"name":"setImmediate","kind":"function","kindModifiers":"declare","sortText":"0"},{"name":"setInterval","kind":"function","kindModifiers":"declare","sortText":"0"},{"name":"setTimeout","kind":"function","kindModifiers":"declare","sortText":"0"}]}
            // }
            // this.tspClient.request 会返回一个 promise ，具体调用是放在这个 interuptDiagnostics 函数内执行的
            // TODO interuptDiagnostics 具体作用？？

            let isNewIdentifierLocation = true;
            // let isIncomplete = false;
            let isMemberCompletion = false;
            let dotAccessorContext: DotAccessorContext | undefined;
            let entries: ReadonlyArray<protocol.CompletionEntry>;
            // let metadata: any | undefined;
            const result = await this.interuptDiagnostics(() => this.tspClient.request(CommandTypes.CompletionInfo, args));
            if (result.type !== 'response' || !result.body) {
                return null;
            }

            // winstonLogger.log('info', 'response: %s', JSON.stringify(result.body));
            isNewIdentifierLocation = result.body.isNewIdentifierLocation;
            isMemberCompletion = result.body.isMemberCompletion;
            if (isMemberCompletion) {
                // TODO
                const line = document?.lineAt(params.position.line);
                const dotMatch = line.slice(0, params.position.character).match(/\??\.\s*$/) || undefined;
                if (dotMatch) {
                    const range = lsp.Range.create(lsp.Position.create(params.position.line, params.position.character - dotMatch[0].length), params.position);
                    const text = document.getText(range);
                    dotAccessorContext = { range, text };
                }
                // winstonLogger.log('info', 'dotAccessorContext: %s', JSON.stringify(dotAccessorContext));
            }

            // {"seq":0,"type":"response","command":"completionInfo","request_seq":201,"success":true,"performanceData":{"updateGraphDurationMs":1},
            // "body":{
            // "isGlobalCompletion":false,
            // "isMemberCompletion":true,
            // "isNewIdentifierLocation":false,
            // "entries":[
            // {"name":"message","kind":"property","kindModifiers":"","sortText":"0",
            // "insertText":"?.message",
            // "replacementSpan":{"start":{"line":5,"offset":7},"end":{"line":5,"offset":8}}}]}}

            // isIncomplete = (result as any).metadata && (result as any).metadata.isIncomplete;
            // metadata = result.metadata;
            entries = result.body.entries;
            const completionConfiguration = {
                useCodeSnippetsOnMethodSuggest: false,
                pathSuggestions: true,
                autoImportSuggestions: true,
                nameSuggestions: true,
                includeAutomaticOptionalChainCompletions: true
            };
            // winstonLogger.log('info', 'suggests length: %s', entries.length);
            // return [];
            // 对应 completions.ts 文件
            const items = entries
                .filter(entry => !showExcludeCompletionEntry(entry, completionConfiguration))
                .map(entry => asCompletionItem(entry, file, params.position, document, {
                    isNewIdentifierLocation,
                    isMemberCompletion,
                    isInValidCommitCharacterContext: true,
                    enableCallCompletions: !completionConfiguration.useCodeSnippetsOnMethodSuggest,
                    dotAccessorContext
                }));
            // const items = entries
            //     .filter(entry => !showExcludeCompletionEntry(entry, completionConfiguration))
            //     .map(entry => new MyCompletionItem(entry, file, params.position, document, {
            //         isNewIdentifierLocation,
            //         isMemberCompletion,
            //         dotAccessorContext,
            //         isInValidCommitCharacterContext: true,
            //         enableCallCompletions: !completionConfiguration.useCodeSnippetsOnMethodSuggest
            //     }));
            // winstonLogger.log('info', 'suggests: %s', JSON.stringify(items[0]));
            return {
                isIncomplete: false,
                items
            };
        } catch (error) {
            if (error.message === "No content available.") {
                this.logger.info('No content was available for completion request');
                return null;
            } else {
                throw error;
            }
        }
    }

    // private _createCachedState(_items: TSCompletionItem[]): void {
    //     const source = _items;
    //     const target = [];
    //     const scoreFn: FuzzyScorer = source.length > 2000 ? fuzzyScore : fuzzyScoreGracefulAggressive;
    //     for (let i = 0; i < source.length; i++) {
    //         const item = source[i];

    //     }
    // }

    async completionResolve(item: TSCompletionItem): Promise<lsp.CompletionItem> {
        this.logger.log('completion/resolve', item);
        // winstonLogger.log('info', "completion/resolve: %s", JSON.stringify(item));

        const { body } = await this.interuptDiagnostics(() => this.tspClient.request(CommandTypes.CompletionDetails, item.data));
        // winstonLogger.log('info', "body: %s", JSON.stringify(body));
        const details = body && body.length && body[0];
        if (!details) {
            return item;
        }
        return asResolvedCompletionItem(item, details);
    }

    async hover(params: lsp.TextDocumentPositionParams): Promise<lsp.Hover> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('hover', params, file);
        if (!file) {
            return { contents: [] };
        }

        const result = await this.interuptDiagnostics(() => this.getQuickInfo(file, params.position));
        if (!result || !result.body) {
            return { contents: [] };
        }
        const range = asRange(result.body);
        const contents: lsp.MarkedString[] = [
            { language: 'typescript', value: result.body.displayString }
        ];
        const tags = asTagsDocumentation(result.body.tags);
        contents.push(result.body.documentation + (tags ? '\n\n' + tags : ''));
        return {
            contents,
            range
        }
    }
    protected async getQuickInfo(file: string, position: lsp.Position): Promise<tsp.QuickInfoResponse | undefined> {
        try {
            return await this.tspClient.request(CommandTypes.Quickinfo, {
                file,
                line: position.line + 1,
                offset: position.character + 1
            });
        } catch (err) {
            return undefined;
        }
    }

    async rename(params: lsp.RenameParams): Promise<lsp.WorkspaceEdit | undefined> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('onRename', params, file);
        if (!file) {
            return undefined;
        }

        const result = await this.tspClient.request(CommandTypes.Rename, {
            file,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });

        if (!result.body || !result.body.info.canRename || result.body.locs.length === 0) {
            return undefined;
        }
        const workspaceEdit: lsp.WorkspaceEdit = {
            changes: {}
        };
        result.body.locs
            .forEach((spanGroup) => {
                const uri = pathToUri(spanGroup.file, this.documents),
                    textEdits = workspaceEdit.changes![uri] || (workspaceEdit.changes![uri] = []);

                spanGroup.locs.forEach((textSpan) => {
                    textEdits.push({
                        newText: params.newName,
                        range: {
                            start: toPosition(textSpan.start),
                            end: toPosition(textSpan.end)
                        }
                    });
                });
            });

        return workspaceEdit;
    }

    async references(params: lsp.TextDocumentPositionParams): Promise<lsp.Location[]> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('onReferences', params, file);
        if (!file) {
            return [];
        }

        const result = await this.tspClient.request(CommandTypes.References, {
            file,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });
        if (!result.body) {
            return [];
        }
        return result.body.refs
            .map(fileSpan => toLocation(fileSpan, this.documents));
    }

    async documentFormatting(params: lsp.DocumentFormattingParams): Promise<lsp.TextEdit[]> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('documentFormatting', params, file);
        if (!file) {
            return [];
        }

        let opts = <tsp.FormatCodeSettings>{
            ...params.options
        }

        // translate
        if (opts.convertTabsToSpaces === undefined) {
            opts.convertTabsToSpaces = params.options.insertSpaces
        }
        if (opts.indentSize === undefined) {
            opts.indentSize = params.options.tabSize
        }

        try {
            opts = JSON.parse(fs.readFileSync(this.rootPath() + "/tsfmt.json", 'utf-8'));
        } catch (err) {
            this.logger.log("No formatting options found " + err)
        }

        // options are not yet supported in tsserver, but we can send a configure request first
        await this.tspClient.request(CommandTypes.Configure, {
            formatOptions: opts
        });

        const response = await this.tspClient.request(CommandTypes.Format, {
            file,
            line: 1,
            offset: 1,
            endLine: Number.MAX_SAFE_INTEGER,
            endOffset: Number.MAX_SAFE_INTEGER,
            options: opts
        });
        if (response.body) {
            return response.body.map(e => toTextEdit(e));
        }
        return [];
    }

    async signatureHelp(params: lsp.TextDocumentPositionParams): Promise<lsp.SignatureHelp | undefined> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('signatureHelp', params, file);
        if (!file) {
            return undefined;
        }

        const response = await this.interuptDiagnostics(() => this.getSignatureHelp(file, params.position));
        if (!response || !response.body) {
            return undefined;
        }
        // const info = response.body;
        return asSignatureHelp(response.body);
    }
    protected async getSignatureHelp(file: string, position: lsp.Position): Promise<tsp.SignatureHelpResponse | undefined> {
        try {
            return await this.tspClient.request(CommandTypes.SignatureHelp, {
                file,
                line: position.line + 1,
                offset: position.character + 1
            });
        } catch (err) {
            return undefined;
        }
    }

    async codeAction(params: lsp.CodeActionParams): Promise<(lsp.Command | lsp.CodeAction)[]> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('codeAction', params, file);
        if (!file) {
            return [];
        }
        const args = toFileRangeRequestArgs(file, params.range);
        const codeActions: (lsp.Command | lsp.CodeAction)[] = [];
        const errorCodes = params.context.diagnostics.map(diagnostic => Number(diagnostic.code));
        provideQuickFix(await this.getCodeFixes({ ...args, errorCodes }), codeActions, this.documents);
        provideRefactors(await this.getRefactors(args), codeActions, args);
        provideOrganizeImports(file, params.context, codeActions);
        return codeActions;
    }
    protected async getCodeFixes(args: tsp.CodeFixRequestArgs): Promise<tsp.GetCodeFixesResponse | undefined> {
        try {
            return await this.tspClient.request(CommandTypes.GetCodeFixes, args);
        } catch (err) {
            return undefined;
        }
    }
    protected async getRefactors(args: tsp.GetApplicableRefactorsRequestArgs): Promise<tsp.GetApplicableRefactorsResponse | undefined> {
        try {
            return await this.tspClient.request(CommandTypes.GetApplicableRefactors, args);
        } catch (err) {
            return undefined;
        }
    }

    async executeCommand(arg: lsp.ExecuteCommandParams): Promise<void> {
        this.logger.log('executeCommand', arg);
        if (arg.command === Commands.APPLY_WORKSPACE_EDIT && arg.arguments) {
            const edit = arg.arguments[0] as lsp.WorkspaceEdit;
            await this.options.lspClient.applyWorkspaceEdit({
                edit
            });
        } else if (arg.command === Commands.APPLY_CODE_ACTION && arg.arguments) {
            const codeAction = arg.arguments[0] as tsp.CodeAction;
            if (!await this.applyFileCodeEdits(codeAction.changes)) {
                return;
            }
            if (codeAction.commands && codeAction.commands.length) {
                for (const command of codeAction.commands) {
                    await this.tspClient.request(CommandTypes.ApplyCodeActionCommand, { command })
                }
            }
        } else if (arg.command === Commands.APPLY_REFACTORING && arg.arguments) {
            const args = arg.arguments[0] as tsp.GetEditsForRefactorRequestArgs;
            const { body } = await this.tspClient.request(CommandTypes.GetEditsForRefactor, args);
            if (!body || !body.edits.length) {
                return;
            }
            for (const edit of body.edits) {
                await fs.ensureFile(edit.fileName);
            }
            if (!await this.applyFileCodeEdits(body.edits)) {
                return;
            }
            const renameLocation = body.renameLocation;
            if (renameLocation) {
                await this.options.lspClient.rename({
                    textDocument: {
                        uri: pathToUri(args.file, this.documents)
                    },
                    position: toPosition(renameLocation)
                });
            }
        } else if (arg.command === Commands.ORGANIZE_IMPORTS && arg.arguments) {
            const file = arg.arguments[0] as string;
            const { body } = await this.tspClient.request(CommandTypes.OrganizeImports, {
                scope: {
                    type: 'file',
                    args: { file }
                }
            });
            await this.applyFileCodeEdits(body);
        } else if (arg.command === Commands.APPLY_RENAME_FILE && arg.arguments) {
            const { sourceUri, targetUri } = arg.arguments[0] as {
                sourceUri: string
                targetUri: string
            };
            this.applyRenameFile(sourceUri, targetUri);
        } else {
            this.logger.error(`Unknown command ${arg.command}.`)
        }
    }
    protected async applyFileCodeEdits(edits: ReadonlyArray<tsp.FileCodeEdits>): Promise<boolean> {
        if (!edits.length) {
            return false;
        }
        const changes: { [uri: string]: lsp.TextEdit[] } = {};
        for (const edit of edits) {
            changes[pathToUri(edit.fileName, this.documents)] = edit.textChanges.map(toTextEdit);
        }
        const { applied } = await this.options.lspClient.applyWorkspaceEdit({
            edit: { changes }
        });
        return applied;
    }

    protected async applyRenameFile(sourceUri: string, targetUri: string): Promise<void> {
        const edits = await this.getEditsForFileRename(sourceUri, targetUri);
        this.applyFileCodeEdits(edits);
    }
    protected async getEditsForFileRename(sourceUri: string, targetUri: string): Promise<ReadonlyArray<tsp.FileCodeEdits>> {
        const newFilePath = uriToPath(targetUri);
        const oldFilePath = uriToPath(sourceUri);
        if (!newFilePath || !oldFilePath) {
            return [];
        }
        try {
            const { body } = await this.tspClient.request(CommandTypes.GetEditsForFileRename, {
                oldFilePath,
                newFilePath
            });
            return body;
        } catch (err) {
            return [];
        }
    }

    async documentHighlight(arg: lsp.TextDocumentPositionParams): Promise<lsp.DocumentHighlight[]> {
        const file = uriToPath(arg.textDocument.uri);
        this.logger.log('documentHighlight', arg, file);
        if (!file) {
            return [];
        }
        let response: tsp.DocumentHighlightsResponse;
        try {
            response = await this.tspClient.request(CommandTypes.DocumentHighlights, {
                file,
                line: arg.position.line + 1,
                offset: arg.position.character + 1,
                filesToSearch: [file]
            })
        } catch (err) {
            return [];
        }
        if (!response.body) {
            return []
        }
        const result: lsp.DocumentHighlight[] = [];
        for (const item of response.body) {
            // tsp returns item.file with POSIX path delimiters, whereas file is platform specific.
            // Converting to a URI and back to a path ensures consistency.
            if (uriToPath(pathToUri(item.file, this.documents)) === file) {
                const highlights = toDocumentHighlight(item);
                result.push(...highlights)
            }
        }
        return result;
    }

    private rootPath(): string {
        return this.initializeParams.rootUri ? uriToPath(this.initializeParams.rootUri)! : this.initializeParams.rootPath!;
    }

    private lastFileOrDummy(): string {
        return this.documents.files[0] || this.rootPath();
    }

    async workspaceSymbol(params: lsp.WorkspaceSymbolParams): Promise<lsp.SymbolInformation[]> {
        const result = await this.tspClient.request(CommandTypes.Navto, {
            file: this.lastFileOrDummy(),
            searchValue: params.query
        });
        if (!result.body) {
            return []
        }
        return result.body.map(item => {
            return <lsp.SymbolInformation>{
                location: {
                    uri: pathToUri(item.file, this.documents),
                    range: {
                        start: toPosition(item.start),
                        end: toPosition(item.end)
                    }
                },
                kind: toSymbolKind(item.kind),
                name: item.name
            };
        });
    }

    /**
     * implemented based on https://github.com/Microsoft/vscode/blob/master/extensions/typescript-language-features/src/features/folding.ts
     */
    async foldingRanges(params: lsp.FoldingRangeRequestParam): Promise<lsp.FoldingRange[] | undefined> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('foldingRanges', params, file);
        if (!file) {
            return undefined;
        }

        const document = this.documents.get(file);
        if (!document) {
            throw new Error("The document should be opened for foldingRanges', file: " + file);
        }
        const { body } = await this.tspClient.request(CommandTypes.GetOutliningSpans, { file });
        if (!body) {
            return undefined;
        }
        const foldingRanges: lsp.FoldingRange[] = [];
        for (const span of body) {
            const foldingRange = this.asFoldingRange(span, document);
            if (foldingRange) {
                foldingRanges.push(foldingRange);
            }
        }
        return foldingRanges;
    }
    protected asFoldingRange(span: tsp.OutliningSpan, document: LspDocument): lsp.FoldingRange | undefined {
        const range = asRange(span.textSpan);
        const kind = this.asFoldingRangeKind(span);

        // workaround for https://github.com/Microsoft/vscode/issues/49904
        if (span.kind === 'comment') {
            const line = document.getLine(range.start.line);
            if (line.match(/\/\/\s*#endregion/gi)) {
                return undefined;
            }
        }

        const startLine = range.start.line;

        // workaround for https://github.com/Microsoft/vscode/issues/47240
        const endLine = (range.end.character > 0 && document.getText(lsp.Range.create(
            lsp.Position.create(range.end.line, range.end.character - 1),
            range.end
        )) === '}') ? Math.max(range.end.line - 1, range.start.line) : range.end.line;

        return {
            startLine,
            endLine,
            kind
        }
    }
    protected asFoldingRangeKind(span: tsp.OutliningSpan): lsp.FoldingRangeKind | undefined {
        switch (span.kind) {
            case 'comment': return lsp.FoldingRangeKind.Comment;
            case 'region': return lsp.FoldingRangeKind.Region;
            case 'imports': return lsp.FoldingRangeKind.Imports;
            case 'code':
            default: return undefined;
        }
    }

    protected onTsEvent(event: protocol.Event): void {
        function isDiagnosticEvent(evt: protocol.Event | tsp.DiagnosticEvent): evt is tsp.DiagnosticEvent {
            return evt.event === EventTypesEnum.SementicDiag ||
            evt.event === EventTypesEnum.SyntaxDiag ||
            evt.event === EventTypesEnum.SuggestionDiag;
        }
        if (
            isDiagnosticEvent(event)
            // event.event === EventTypes.SementicDiag ||
            // event.event === EventTypes.SyntaxDiag ||
            // event.event === EventTypes.SuggestionDiag
            ) {
            this.diagnosticQueue.updateDiagnostics(event.event, event);
        } else {
            this.logger.log("Ignored event", {
                "event": event.event
            });
        }
    }

    async calls(params: lspcalls.CallsParams): Promise<lspcalls.CallsResult> {
        let callsResult = <lspcalls.CallsResult>{ calls: [] };
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('calls', params, file);
        if (!file) {
            return callsResult;
        }
        if (params.direction === lspcalls.CallDirection.Outgoing) {
            const documentProvider = (file: string) => this.documents.get(file);
            callsResult = await computeCallees(this.tspClient, params, documentProvider);
        } else {
            callsResult = await computeCallers(this.tspClient, params);
        }
        return callsResult;
    }
}
