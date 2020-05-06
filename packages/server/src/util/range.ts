import { Position, Range } from 'vscode-languageserver';
import PositionUtil from './position';

export default class RangeUtil {
    static contains(_this: Range, positionOrRange: Position | Range): boolean {
        if (Range.is(positionOrRange)) {
            return RangeUtil.contains(_this, positionOrRange.start)
            && RangeUtil.contains(_this, positionOrRange.end);
        } else if (Position.is(positionOrRange)) {
            if (PositionUtil.isBefore(positionOrRange, _this.start)) {
                return false;
            }
            if (PositionUtil.isBefore(_this.end, positionOrRange)) {
                return false;
            }
            return true;
        }
        return false;
    }

    static union(_this: Range, other: Range): Range {
        if (RangeUtil.contains(_this, other)) {
            return _this;
        } else if (RangeUtil.contains(other, _this)) {
            return other;
        }
        const start = PositionUtil.Min(other.start, _this.start);
        const end = PositionUtil.Max(other.end, _this.end);
        return Range.create(start, end);
    }
}