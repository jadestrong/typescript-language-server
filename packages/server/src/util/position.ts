import { Position } from 'vscode-languageserver';

export default class PositionUtil {
    static isBefore(pos: Position, other: Position): boolean {
        if (pos.line < other.line) {
            return true;
        }
        if (other.line < pos.line) {
            return false;
        }
        return pos.character < other.character;
    }

    static isBeforeOrEqual(_this: Position, other: Position): boolean {
        if (_this.line < other.line) {
            return true;
        }
        if (other.line < _this.line) {
            return false;
        }
        return _this.character <= other.character;
    }

    static isAfter(_this: Position, other: Position): boolean {
        return !PositionUtil.isBeforeOrEqual(_this, other);
    }

    static Min(...positions: Position[]): Position {
        if (positions.length === 0) {
            throw new TypeError();
        }
        let result = positions[0];
        for (let i = 1; i < positions.length; i++) {
            const p = positions[i];
            if (PositionUtil.isBefore(p, result!)) {
                result = p;
            }
        }
        return result;
    }

    static Max(...positions: Position[]): Position {
        if (positions.length === 0) {
            throw new TypeError();
        }
        let result = positions[0];
        for (let i = 1; i < positions.length; i++) {
            const p = positions[i];
            if (PositionUtil.isAfter(p, result!)) {
                result = p;
            }
        }
        return result;
    }
}