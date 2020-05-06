import * as vscode from 'vscode-languageserver';
import Proto from 'typescript/lib/protocol';
import { LspDocument } from '../document';
import { ScriptElementKind } from '../tsp-command-types';
import { DotAccessorContext } from '../lsp-server';
import { asRange } from '../protocol-translation';
import * as PConst from '../protocol.const';
import RangeUtil from '../util/range';

abstract class BaseCompletionItem implements vscode.CompletionItem {
    /**
     * The label of this completion item. By default
     * also the text that is inserted when selecting
     * this completion.
     */
    label: string;
    /**
     * The kind of this completion item. Based of the kind
     * an icon is chosen by the editor.
     */
    kind?: vscode.CompletionItemKind;
    /**
     * Tags for this completion item.
     *
     * @since 3.15.0
     */
    tags?: vscode.CompletionItemTag[];
    /**
     * A human-readable string with additional information
     * about this item, like type or symbol information.
     */
    detail?: string;
    /**
     * A human-readable string that represents a doc-comment.
     */
    documentation?: string | vscode.MarkupContent;
    /**
     * Indicates if this item is deprecated.
     * @deprecated Use `tags` instead.
     */
    deprecated?: boolean;
    /**
     * Select this item when showing.
     *
     * *Note* that only one completion item can be selected and that the
     * tool / client decides which item that is. The rule is that the *first*
     * item of those that match best is selected.
     */
    preselect?: boolean;
    /**
     * A string that should be used when comparing this item
     * with other items. When `falsy` the [label](#CompletionItem.label)
     * is used.
     */
    sortText?: string;
    /**
     * A string that should be used when filtering a set of
     * completion items. When `falsy` the [label](#CompletionItem.label)
     * is used.
     */
    filterText?: string;
    /**
     * A string that should be inserted into a document when selecting
     * this completion. When `falsy` the [label](#CompletionItem.label)
     * is used.
     *
     * The `insertText` is subject to interpretation by the client side.
     * Some tools might not take the string literally. For example
     * VS Code when code complete is requested in this example `con<cursor position>`
     * and a completion item with an `insertText` of `console` is provided it
     * will only insert `sole`. Therefore it is recommended to use `textEdit` instead
     * since it avoids additional client side interpretation.
     */
    insertText?: string;
    /**
     * The format of the insert text. The format applies to both the `insertText` property
     * and the `newText` property of a provided `textEdit`. If ommitted defaults to
     * `InsertTextFormat.PlainText`.
     */
    insertTextFormat?: vscode.InsertTextFormat;
    /**
     * An [edit](#TextEdit) which is applied to a document when selecting
     * this completion. When an edit is provided the value of
     * [insertText](#CompletionItem.insertText) is ignored.
     *
     * *Note:* The text edit's range must be a [single line] and it must contain the position
     * at which completion has been requested.
     */
    textEdit?: vscode.TextEdit;
    /**
     * An optional array of additional [text edits](#TextEdit) that are applied when
     * selecting this completion. Edits must not overlap (including the same insert position)
     * with the main [edit](#CompletionItem.textEdit) nor with themselves.
     *
     * Additional text edits should be used to change text unrelated to the current cursor position
     * (for example adding an import statement at the top of the file if the completion item will
     * insert an unqualified type).
     */
    additionalTextEdits?: vscode.TextEdit[];
    /**
     * An optional set of characters that when pressed while this completion is active will accept it first and
     * then type that character. *Note* that all commit characters should have `length=1` and that superfluous
     * characters will be ignored.
     */
    commitCharacters?: string[];
    /**
     * An optional [command](#Command) that is executed *after* inserting this completion. *Note* that
     * additional modifications to the current document should be described with the
     * [additionalTextEdits](#CompletionItem.additionalTextEdits)-property.
     */
    command?: vscode.Command;
    /**
     * An data entry field that is preserved on a completion item between
     * a [CompletionRequest](#CompletionRequest) and a [CompletionResolveRequest]
     * (#CompletionResolveRequest)
     */
    data?: Proto.CompletionDetailsRequestArgs;
    range?: vscode.Range | { inserting: vscode.Range; replacing: vscode.Range }
}

interface CompletionContext {
    readonly isNewIdentifierLocation: boolean;
    readonly isMemberCompletion: boolean;
    readonly isInValidCommitCharacterContext: boolean;
    readonly enableCallCompletions: boolean;
    readonly dotAccessorContext?: DotAccessorContext;
}

export class MyCompletionItem extends BaseCompletionItem {
    constructor(
        public readonly entry: Proto.CompletionEntry,
        file: string,
        public readonly position: vscode.Position,
        public readonly document: LspDocument,
        public readonly completionContext: CompletionContext
    ) {
        super();
        this.label = entry.name;
        this.kind = this.convertCompletionKind(entry.kind);
        this.sortText = entry.sortText;
        this.commitCharacters = this.convertCommitCharacters(entry.kind);
        this.data = {
            file,
            line: position.line + 1,
            offset: position.character + 1,
            entryNames: [
                entry.source ? { name: entry.name, source: entry.source } : entry.name
            ]
        };
        this.filterText = entry.insertText;

        if (entry.source) {
            // De-prioritze auto-imports
            // https://github.com/Microsoft/vscode/issues/40311
            this.sortText = '\uffff' + entry.sortText;
        }
        if (entry.isRecommended) {
            // Make sure isRecommended property always comes first
            // https://github.com/Microsoft/vscode/issues/40325
            this.preselect = true;
        }
        if (this.kind === vscode.CompletionItemKind.Function || this.kind === vscode.CompletionItemKind.Method) {
            this.insertTextFormat = vscode.InsertTextFormat.Snippet;
        }

        this.insertText = entry.insertText;
        let line = document.getLine(position.line + 1);
        this.filterText = this.getFilterText(line, entry.insertText);

        let replaceRange;
        if (entry.replacementSpan) {
            replaceRange = asRange(entry.replacementSpan);
            if (replaceRange.start.line !== replaceRange.end.line) {
                replaceRange = vscode.Range.create(replaceRange.start, document.getLineEnd(replaceRange.start.line));
            }
            this.range = {
                inserting: vscode.Range.create(replaceRange.start, position),
                replacing: replaceRange
            };
        }
        if (completionContext.isMemberCompletion && completionContext.dotAccessorContext) {
            this.filterText = completionContext.dotAccessorContext.text + (this.insertText || this.label);
            if (!this.range) {
                const replacementRange = this.getReplaceRange(line);
                if (replacementRange) {
                    this.range = {
                        inserting: completionContext.dotAccessorContext.range,
                        replacing: RangeUtil.union(completionContext.dotAccessorContext.range, replacementRange)
                    };
                } else {
                    this.range = completionContext.dotAccessorContext.range;
                }
                this.insertText = this.filterText;
            }
        }
        
        if (entry.kindModifiers) {
            const kindModifiers = new Set(entry.kindModifiers.split(/\s+/g));
            if (kindModifiers.has(PConst.KindModifiers.optional)) { // FIXME 抽出成常量
                if (!this.insertText) {
                    this.insertText = this.label;
                }
                if (!this.filterText) {
                    this.filterText = this.label;
                }
                this.label += '?';
            }
            // Not need this, because this is only work for vscode
            // if (kindModifiers.has('color')) {
            //     item.kind = 15;
            // }
            if (entry.kind === PConst.Kind.script) {
                for (const extModifier of PConst.KindModifiers.fileExtensionKindModifiers) {
                    if (kindModifiers.has(extModifier)) {
                        if (entry.name.toLowerCase().endsWith(extModifier)) {
                            this.detail = entry.name;
                        } else {
                            this.detail = entry.name + extModifier;
                        }
                        break;
                    }
                }
            }
        }
        // NOTE 搞清楚 textEdit 和 Range 之间的区别：TextEdit 是 Range 的一个变种
        // 在 vscode 中 textEdit 被标记为 deprecated ，推荐使用 range + insertText 代替，但是 lsp 协议并没有改
        if (this.insertText && replaceRange) {
            // TextEdit {range: Range, newLabel: string} 定义在 vscode-langaugeserver-types 中
            this.textEdit = vscode.TextEdit.replace(replaceRange, this.insertText);
        } else {
            this.insertText = this.insertText;
        }

        this.resolveRange(line);
    }

    private resolveRange(line: string): void {
        if (!this.range) {
            const replaceRange = this.getReplaceRange(line);
            if (replaceRange) {
                this.range = {
                    inserting: vscode.Range.create(replaceRange.start, this.position),
                    replacing: replaceRange
                }
            }
        }
    }

    private convertCommitCharacters(kind: ScriptElementKind): string[] | undefined {
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

    private convertCompletionKind(kind: ScriptElementKind): vscode.CompletionItemKind {
        switch (kind) {
            case ScriptElementKind.primitiveType:
            case ScriptElementKind.keyword:
                return vscode.CompletionItemKind.Keyword;
            case ScriptElementKind.constElement:
                return vscode.CompletionItemKind.Constant;
            case ScriptElementKind.letElement:
            case ScriptElementKind.variableElement:
            case ScriptElementKind.localVariableElement:
            case ScriptElementKind.alias:
                return vscode.CompletionItemKind.Variable;
            case ScriptElementKind.memberVariableElement:
            case ScriptElementKind.memberGetAccessorElement:
            case ScriptElementKind.memberSetAccessorElement:
                return vscode.CompletionItemKind.Field;
            case ScriptElementKind.functionElement:
                return vscode.CompletionItemKind.Function;
            case ScriptElementKind.memberFunctionElement:
            case ScriptElementKind.constructSignatureElement:
            case ScriptElementKind.callSignatureElement:
            case ScriptElementKind.indexSignatureElement:
                return vscode.CompletionItemKind.Method;
            case ScriptElementKind.enumElement:
                return vscode.CompletionItemKind.Enum;
            case ScriptElementKind.moduleElement:
            case ScriptElementKind.externalModuleName:
                return vscode.CompletionItemKind.Module;
            case ScriptElementKind.classElement:
            case ScriptElementKind.typeElement:
                return vscode.CompletionItemKind.Class;
            case ScriptElementKind.interfaceElement:
                return vscode.CompletionItemKind.Interface;
            case ScriptElementKind.warning:
            case ScriptElementKind.scriptElement:
                return vscode.CompletionItemKind.File;
            case ScriptElementKind.directory:
                return vscode.CompletionItemKind.Folder;
            case ScriptElementKind.string:
                return vscode.CompletionItemKind.Constant;
        }
        return vscode.CompletionItemKind.Property;
    }

    private getFilterText(line: string, insertText: string | undefined): string | undefined {
        if (this.entry.name.startsWith('#')) {
            const wordRange = this.document.getWordRangeAtPosition(this.position);
            const wordStart = wordRange ? line.charAt(wordRange.start.character) : undefined;
            if (insertText) {
                if (insertText.startsWith('this.#')) {
                    return wordStart === '#' ? insertText : insertText.replace(/^this\.#/, '');
                } else {
                    return insertText;
                }
            } else {
                return wordStart === '#' ? undefined : this.entry.name.replace(/^#/, '');
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
    private getReplaceRange(line: string) {
        const wordRange = this.document.getWordRangeAtPosition(this.position);
        let replaceRange = wordRange;

        const text = line.slice(Math.max(0, this.position.character - this.label.length), this.position.character).toLowerCase();
        const entryName = this.label.toLowerCase();
        for (let i = entryName.length; i >= 0; --i) {
            if (text.endsWith(entryName.substr(0, i)) && (!wordRange || wordRange.start.character > this.position.character - i)) {
                replaceRange = vscode.Range.create(
                    vscode.Position.create(this.position.line, Math.max(0, this.position.character - i)),
                    this.position
                );
                break;
            }
        }
        return replaceRange;
    }
}
