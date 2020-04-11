/*
 * Copyright (C) 2018 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as lsp from 'vscode-languageserver';
import * as tsp from 'typescript/lib/protocol';
import { LspDocument } from './document';
import { ScriptElementKind } from './tsp-command-types';
import { asRange, toTextEdit, asPlainText, asTagsDocumentation, asDocumentation } from './protocol-translation';
import { Commands } from './commands';
import * as PConst from './protocol.const';

export interface TSCompletionItem extends lsp.CompletionItem {
    data: tsp.CompletionDetailsRequestArgs
}

function getFilterText(line: string, insertText: string | undefined, entry: import('typescript/lib/protocol').CompletionEntry, position: lsp.Position, document: LspDocument): string | undefined {
    if (entry.name.startsWith('#')) {
        const wordRange = document.getWordRangeAtPosition(position);
        const wordStart = wordRange ? line.charAt(wordRange.start.character) : undefined;
        if (insertText) {
            if (insertText.startsWith('this.#')) {
                return wordStart === '#' ? insertText : insertText.replace(/^this\.#/, '');
            } else {
                return insertText;
            }
        } else {
            return wordStart === '#' ? undefined : entry.name.replace(/^#/, '');
        }
    }
    // For `this.` completions, generally don't set the filter text since we don't want them to be overly prioritized. #74164
    if (insertText?.startsWith('this.')) {
        return undefined;
    }
    // Handle the case:
    // ```
    // const xyz = { 'ab c': 1 };
    // xyz.ab|
    // ```
    // In which case we want to insert a bracket accessor but should use `.abc` as the filter text instead of
    // the bracketed insert text.
    else if (insertText?.startsWith('[')) {
        return insertText.replace(/^\[['"](.+)[['"]\]$/, '.$1');
    }
    return insertText;
}

export function asCompletionItem(entry: import('typescript/lib/protocol').CompletionEntry, file: string, position: lsp.Position, document: LspDocument): TSCompletionItem {
    const item: TSCompletionItem = {
        label: entry.name,
        kind: asCompletionItemKind(entry.kind),
        sortText: entry.sortText,
        commitCharacters: asCommitCharacters(entry.kind),
        data: {
            file,
            line: position.line + 1,
            offset: position.character + 1,
            entryNames: [
                entry.source ? { name: entry.name, source: entry.source } : entry.name
            ]
        },
        filterText: entry.insertText
    }
    if (entry.source) {
        // De-prioritze auto-imports
        // https://github.com/Microsoft/vscode/issues/40311
        item.sortText = '\uffff' + entry.sortText;
    }
    if (entry.isRecommended) {
        // Make sure isRecommended property always comes first
        // https://github.com/Microsoft/vscode/issues/40325
        item.preselect = true;
    }
    if (item.kind === lsp.CompletionItemKind.Function || item.kind === lsp.CompletionItemKind.Method) {
        item.insertTextFormat = lsp.InsertTextFormat.Snippet;
    }
    // {"seq":0,"type":"response","command":"completionInfo","request_seq":489,"success":true,"performanceData":{"updateGraphDurationMs":6},"body":{"isGlobalCompletion":false,"isMemberCompletion":true,"isNewIdentifierLocation":false,"entries":[{"name":"message","kind":"property","kindModifiers":"","sortText":"0",
    // "insertText":"?.message","replacementSpan":{"start":{"line":6,"offset":7},"end":{"line":6,"offset":15}}}]}}
    let insertText = item.insertText = entry.insertText;
    let line = document.getLine(position.line + 1);
    item.filterText = getFilterText(line, insertText, entry, position, document);

    // NOTE vscode use Range property, but it isn't a LSP property, so we must use TextEdit property, it need a replacementRange.
    let replacementRange = entry.replacementSpan && asRange(entry.replacementSpan);
    // Make sure we only replace a single line at most
    if (replacementRange && replacementRange.start.line !== replacementRange.end.line) {
        replacementRange = lsp.Range.create(replacementRange.start, document.getLineEnd(replacementRange.start.line));
    }

    if (entry.kindModifiers) {
        const kindModifiers = new Set(entry.kindModifiers.split(/\s+/g));
        if (kindModifiers.has(PConst.KindModifiers.optional)) { // FIXME 抽出成常量
            if (!insertText) {
                insertText = item.label;
            }
            if (!item.filterText) {
                item.filterText = item.label;
            }
            item.label += '?';
        }
        // Not need this, because this is only work for vscode
        // if (kindModifiers.has('color')) {
        //     item.kind = 15;
        // }
        if (entry.kind === PConst.Kind.script) {
            for (const extModifier of PConst.KindModifiers.fileExtensionKindModifiers) {
                if (kindModifiers.has(extModifier)) {
                    if (entry.name.toLowerCase().endsWith(extModifier)) {
                        item.detail = entry.name;
                    } else {
                        item.detail = entry.name + extModifier;
                    }
                    break;
                }
            }
        }
    }
    // NOTE 搞清楚 textEdit 和 Range 之间的区别：TextEdit 是 Range 的一个变种
    // 在 vscode 中 textEdit 被标记为 deprecated ，推荐使用 range + insertText 代替，但是 lsp 协议并没有改
    if (insertText && replacementRange) {
        // TextEdit {range: Range, newLabel: string} 定义在 vscode-langaugeserver-types 中
        item.textEdit = lsp.TextEdit.replace(replacementRange, insertText);
    } else {
        item.insertText = insertText;
    }
    return item;
}

export function asCompletionItemKind(kind: ScriptElementKind): lsp.CompletionItemKind {
    switch (kind) {
        case ScriptElementKind.primitiveType:
        case ScriptElementKind.keyword:
            return lsp.CompletionItemKind.Keyword;
        case ScriptElementKind.constElement:
            return lsp.CompletionItemKind.Constant;
        case ScriptElementKind.letElement:
        case ScriptElementKind.variableElement:
        case ScriptElementKind.localVariableElement:
        case ScriptElementKind.alias:
            return lsp.CompletionItemKind.Variable;
        case ScriptElementKind.memberVariableElement:
        case ScriptElementKind.memberGetAccessorElement:
        case ScriptElementKind.memberSetAccessorElement:
            return lsp.CompletionItemKind.Field;
        case ScriptElementKind.functionElement:
            return lsp.CompletionItemKind.Function;
        case ScriptElementKind.memberFunctionElement:
        case ScriptElementKind.constructSignatureElement:
        case ScriptElementKind.callSignatureElement:
        case ScriptElementKind.indexSignatureElement:
            return lsp.CompletionItemKind.Method;
        case ScriptElementKind.enumElement:
            return lsp.CompletionItemKind.Enum;
        case ScriptElementKind.moduleElement:
        case ScriptElementKind.externalModuleName:
            return lsp.CompletionItemKind.Module;
        case ScriptElementKind.classElement:
        case ScriptElementKind.typeElement:
            return lsp.CompletionItemKind.Class;
        case ScriptElementKind.interfaceElement:
            return lsp.CompletionItemKind.Interface;
        case ScriptElementKind.warning:
        case ScriptElementKind.scriptElement:
            return lsp.CompletionItemKind.File;
        case ScriptElementKind.directory:
            return lsp.CompletionItemKind.Folder;
        case ScriptElementKind.string:
            return lsp.CompletionItemKind.Constant;
    }
    return lsp.CompletionItemKind.Property;
}

export function asCommitCharacters(kind: ScriptElementKind): string[] | undefined {
    const commitCharacters: string[] = [];
    switch (kind) {
        case ScriptElementKind.memberGetAccessorElement:
        case ScriptElementKind.memberSetAccessorElement:
        case ScriptElementKind.constructSignatureElement:
        case ScriptElementKind.callSignatureElement:
        case ScriptElementKind.indexSignatureElement:
        case ScriptElementKind.enumElement:
        case ScriptElementKind.interfaceElement:
            commitCharacters.push('.');
            break;

        case ScriptElementKind.moduleElement:
        case ScriptElementKind.alias:
        case ScriptElementKind.constElement:
        case ScriptElementKind.letElement:
        case ScriptElementKind.variableElement:
        case ScriptElementKind.localVariableElement:
        case ScriptElementKind.memberVariableElement:
        case ScriptElementKind.classElement:
        case ScriptElementKind.functionElement:
        case ScriptElementKind.memberFunctionElement:
            commitCharacters.push('.', ',');
            commitCharacters.push('(');
            break;
    }

    return commitCharacters.length === 0 ? undefined : commitCharacters;
}

export function asResolvedCompletionItem(item: TSCompletionItem, details: tsp.CompletionEntryDetails): TSCompletionItem {
    item.detail = asDetail(details);
    item.documentation = asDocumentation(details);
    Object.assign(item, asCodeActions(details, item.data.file));
    return item;
}

export function asCodeActions(details: tsp.CompletionEntryDetails, filepath: string): {
    command?: lsp.Command, additionalTextEdits?: lsp.TextEdit[]
} {
    if (!details.codeActions || !details.codeActions.length) {
        return {};
    }

    // Try to extract out the additionalTextEdits for the current file.
    // Also check if we still have to apply other workspace edits and commands
    // using a vscode command
    const additionalTextEdits: lsp.TextEdit[] = [];
    let hasReaminingCommandsOrEdits = false;
    for (const tsAction of details.codeActions) {
        if (tsAction.commands) {
            hasReaminingCommandsOrEdits = true;
        }

        // Apply all edits in the current file using `additionalTextEdits`
        if (tsAction.changes) {
            for (const change of tsAction.changes) {
                if (change.fileName === filepath) {
                    for (const textChange of change.textChanges) {
                        additionalTextEdits.push(toTextEdit(textChange));
                    }
                } else {
                    hasReaminingCommandsOrEdits = true;
                }
            }
        }
    }

    let command: lsp.Command | undefined = undefined;
    if (hasReaminingCommandsOrEdits) {
        // Create command that applies all edits not in the current file.
        command = {
            title: '',
            command: Commands.APPLY_COMPLETION_CODE_ACTION,
            arguments: [filepath, details.codeActions.map(codeAction => ({
                commands: codeAction.commands,
                description: codeAction.description,
                changes: codeAction.changes.filter(x => x.fileName !== filepath)
            }))]
        };
    }

    return {
        command,
        additionalTextEdits: additionalTextEdits.length ? additionalTextEdits : undefined
    };
}

export function asDetail({ displayParts, source }: tsp.CompletionEntryDetails): string | undefined {
    const result: string[] = [];
    const importPath = asPlainText(source);
    if (importPath) {
        result.push(`Auto import from '${importPath}'`);
    }
    const detail = asPlainText(displayParts);
    if (detail) {
        result.push(detail);
    }
    return result.join('\n');
}
