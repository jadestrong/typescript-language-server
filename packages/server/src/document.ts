/*
 * Copyright (C) 2017, 2018 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as lsp from 'vscode-languageserver';
// import { Position } from './protocol-translation';

export class LspDocument implements lsp.TextDocument {

    protected document: lsp.TextDocument;

    constructor(doc: lsp.TextDocumentItem) {
        const { uri, languageId, version, text } = doc;
        this.document = lsp.TextDocument.create(uri, languageId, version, text);
    }

    get uri(): string {
        return this.document.uri;
    }

    get languageId(): string {
        return this.document.languageId;
    }

    get version(): number {
        return this.document.version;
    }

    getText(range?: lsp.Range): string {
        return this.document.getText(range);
    }

    positionAt(offset: number): lsp.Position {
        return this.document.positionAt(offset);
    }

    offsetAt(position: lsp.Position): number {
        return this.document.offsetAt(position);
    }

    get lineCount(): number {
        return this.document.lineCount;
    }

    lineAt(line: number): string {
        return this.document.getText(lsp.Range.create(line, -1, line, Number.MAX_VALUE));
    }

    // 这个应该可以用来实现 lineAt NOTE
    getLine(line: number): string {
        return this.lineAt(line);
        // const lineRange = this.getLineRange(line);
        // return this.getText(lineRange);
    }

    getLineRange(line: number): lsp.Range {
        const lineStart = this.getLineStart(line);
        const lineEnd = this.getLineEnd(line);
        return lsp.Range.create(lineStart, lineEnd);
    }

    getLineEnd(line: number): lsp.Position {
        const nextLineOffset = this.getLineOffset(line + 1);
        return this.positionAt(nextLineOffset - 1);
    }

    getLineOffset(line: number): number {
        const lineStart = this.getLineStart(line);
        return this.offsetAt(lineStart);
    }

    getLineStart(line: number): lsp.Position {
        return lsp.Position.create(line, 0);
    }

    applyEdit(version: number, change: lsp.TextDocumentContentChangeEvent): void {
        const content = this.getText();
        let newContent = change.text;
        if ('range' in change) {
            const start = this.offsetAt(change.range.start);
            const end = this.offsetAt(change.range.end);
            newContent = content.substr(0, start) + change.text + content.substr(end);
        }
        this.document = lsp.TextDocument.create(this.uri, this.languageId, version, newContent);
    }

    getWordRangeAtPosition(position: lsp.Position): lsp.Range | undefined {
        const lines = this.lineCount;
        const line = Math.min(lines - 1, Math.max(0, position.line));
        const lineText = this.getLine(line);
        const character = Math.min(lineText.length - 1, Math.max(0, position.character));
        let startChar = character;
        while(startChar > 0 && !/\s/.test(lineText.charAt(startChar - 1))) {
            --startChar;
        }
        let endChar = character;
        while(endChar < lineText.length - 1 && !/\s/.test(lineText.charAt(endChar))) {
            ++endChar;
        }
        if (startChar === endChar) {
            return undefined;
        } else {
            return lsp.Range.create(line, startChar, line, endChar);
        }
    }
}

// TODO 实现一个 lineAt 方法, 目前可以使用 getLine 方法代替
export class LspDocuments {

    private readonly _files: string[] = [];
    private readonly documents = new Map<string, LspDocument>();

    /**
     * Sorted by last access.
     */
    get files(): string[] {
        return this._files;
    }

    get(file: string): LspDocument | undefined {
        const document = this.documents.get(file);
        if (!document) {
            return undefined;
        }
        if (this.files[0] !== file) {
            this._files.splice(this._files.indexOf(file), 1);
            this._files.unshift(file);
        }
        return document;
    }

    open(file: string, doc: lsp.TextDocumentItem): boolean {
        if (this.documents.has(file)) {
            return false;
        }
        this.documents.set(file, new LspDocument(doc));
        this._files.unshift(file);
        return true;
    }

    close(file: string): LspDocument | undefined {
        const document = this.documents.get(file);
        if (!document) {
            return undefined;
        }
        this.documents.delete(file);
        this._files.splice(this._files.indexOf(file), 1);
        return document;
    }

}