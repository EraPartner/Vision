import Foundation

/// What `now()` reads (`ConnectionClock` of functions.ts): the transaction start inside a
/// transaction, else the statement start, else the current time.
public final class SQLConnectionClock {
    public var transactionStart: SQLTimestamps.Instant?
    public var statementStart: SQLTimestamps.Instant?

    public init() {}

    public var now: SQLTimestamps.Instant {
        if let transactionStart { return transactionStart }
        if let statementStart { return statementStart }
        let ms = Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
        return SQLTimestamps.Instant(ms: ms)
    }
}

extension SQLiteConnection {
    /// The date and timestamp functions of functions.ts.
    public func registerTimestampFunctions(_ time: SQLTimestamps, clock: SQLConnectionClock) throws {
        typealias A = SQLArguments
        typealias T = SQLTimestamps
        func formatted(_ moment: T.Moment) throws -> SQLValue {
            switch moment {
            case .date(let date): return .text(T.formatDate(date))
            case .instant(let instant): return .text(try T.formatInstant(instant))
            }
        }
        try defineFunction("now", argumentCount: 0, deterministic: false) { _ in
            .text(try T.formatInstant(clock.now))
        }
        try defineFunction("today", argumentCount: 0, deterministic: false) { _ in
            .text(T.formatDate(time.localDate(of: clock.now)))
        }
        try defineFunction("vision_ts", argumentCount: 1) { args in
            if args[0].isNull { return .null }
            return .text(try time.canonicalTimestamp(A.text(args[0], "vision_ts")))
        }
        try defineFunction("vision_ts_ok", argumentCount: 1) { args in
            guard case .text(let text) = args[0] else { return args[0].isNull ? .null : .integer(0) }
            let canonical = try? time.canonicalTimestamp(text)
            return A.bool(T.isTimestampText(text) && canonical == text)
        }
        try defineFunction("vision_date_ok", argumentCount: 1) { args in
            guard case .text(let text) = args[0] else { return args[0].isNull ? .null : .integer(0) }
            let parsed = try? T.parseDate(text)
            return A.bool(parsed.map(T.formatDate) == text)
        }
        // `x::date`.
        try defineFunction("ts_date", argumentCount: 1) { args in
            if args[0].isNull { return .null }
            return .text(try time.dateInputText(A.text(args[0], "ts_date")))
        }
        // `d::timestamptz`: local midnight of a date, or a timestamp as is.
        try defineFunction("date_ts", argumentCount: 1) { args in
            if args[0].isNull { return .null }
            return .text(try T.formatInstant(time.parseInstant(A.text(args[0], "date_ts"))))
        }
        try defineFunction("date_trunc", argumentCount: 2) { args in
            guard let moment = try time.moment(args[1], "date_trunc") else { return .null }
            let unit = try A.text(args[0], "date_trunc")
            switch moment {
            case .instant(let instant): return .text(try T.formatInstant(time.truncInstant(unit, instant)))
            case .date(let date): return .text(T.formatDate(try T.truncDate(unit, date)))
            }
        }
        try defineFunction("add_months", argumentCount: 2) { args in
            guard let moment = try time.moment(args[0], "add_months"), !args[1].isNull else { return .null }
            let months = Int64(try A.integer(args[1], "add_months"))
            switch moment {
            case .instant(let instant):
                return try formatted(.instant(time.addInterval(instant, .init(months: Double(months), days: 0, micros: 0))))
            case .date(let date):
                return try formatted(.date(T.addMonths(date, months)))
            }
        }
        try defineFunction("add_days", argumentCount: 2) { args in
            guard let moment = try time.moment(args[0], "add_days"), !args[1].isNull else { return .null }
            let days = Int64(try A.integer(args[1], "add_days"))
            switch moment {
            case .instant(let instant):
                return try formatted(.instant(time.addInterval(instant, .init(months: 0, days: Double(days), micros: 0))))
            case .date(let date):
                return try formatted(.date(T.addDays(date, days)))
            }
        }
        for (name, negate) in [("add_interval", false), ("sub_interval", true)] {
            try defineFunction(name, argumentCount: 2) { args in
                guard let moment = try time.moment(args[0], name), !args[1].isNull else { return .null }
                var interval = try T.parseInterval(A.text(args[1], name))
                if negate { interval = T.negate(interval) }
                switch moment {
                case .instant(let instant): return try formatted(.instant(time.addInterval(instant, interval)))
                case .date(let date): return try formatted(.date(T.addInterval(date, interval)))
                }
            }
        }
        func civil(_ moment: T.Moment) -> T.CivilDate {
            switch moment {
            case .date(let date): return date
            case .instant(let instant): return time.localDate(of: instant)
            }
        }
        try defineFunction("month_end", argumentCount: 1) { args in
            guard let moment = try time.moment(args[0], "month_end") else { return .null }
            var date = civil(moment)
            date.day = T.daysInMonth(date.year, date.month)
            return .text(T.formatDate(date))
        }
        // `a - b` on dates: whole days. Timestamps use their local dates.
        try defineFunction("date_diff_days", argumentCount: 2) { args in
            guard let a = try time.moment(args[0], "date_diff_days"), let b = try time.moment(args[1], "date_diff_days")
            else { return .null }
            return .integer(T.diffDays(civil(a), civil(b)))
        }
        try defineFunction("make_date", argumentCount: 3) { args in
            if args.contains(where: \.isNull) { return .null }
            let year = Int64(try A.integer(args[0], "make_date"))
            let month = Int64(try A.integer(args[1], "make_date"))
            let day = Int64(try A.integer(args[2], "make_date"))
            guard T.validCivil(year, month, day) else {
                // String(n).padStart(2, "0")
                func pad(_ n: Int64) -> String {
                    let digits = String(n)
                    return digits.count < 2 ? "0" + digits : digits
                }
                let text = "\(year)-\(pad(month))-\(pad(day))"
                throw SQLStateError("date field value out of range: \(text)", code: "22008")
            }
            return .text(T.formatDate(T.CivilDate(year: year, month: month, day: day)))
        }
        // A whole result is an INTEGER (as EXTRACT prints it); a fraction stays REAL.
        try defineFunction("date_part", argumentCount: 2) { args in
            guard let moment = try time.moment(args[1], "date_part") else { return .null }
            let part = try time.datePart(A.text(args[0], "date_part"), moment)
            if part.rounded(.towardZero) == part, abs(part) <= 9_007_199_254_740_991 { return .integer(Int64(part)) }
            return .real(part)
        }
        try defineFunction("to_char", argumentCount: 2) { args in
            guard let moment = try time.moment(args[0], "to_char") else { return .null }
            return .text(try time.toChar(moment, A.text(args[1], "to_char")))
        }
        // Whole months between two dates' month starts.
        try defineFunction("month_diff", argumentCount: 2) { args in
            guard let a = try time.moment(args[0], "month_diff"), let b = try time.moment(args[1], "month_diff") else {
                return .null
            }
            let x = civil(a)
            let y = civil(b)
            return .integer(x.year * 12 + x.month - (y.year * 12 + y.month))
        }
    }
}
