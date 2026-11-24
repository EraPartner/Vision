import Foundation
import VisionNativeCore

/// `generateLoanRepaymentSchedule` of `services/calculations/loanSchedule.ts`: the
/// installment table of a loan planned transaction. The arithmetic is JavaScript doubles
/// (`Number()`, `Math.pow`), every emitted figure and every running balance is rounded
/// half-even to two places, and the due dates walk calendar months clamped to their last
/// day. The generator validates its own config and answers the enumerated reasons as one
/// 400; an unsupported type answers its own 401-worded 400.
enum LoanSchedule {
    /// One `LoanInstallment`.
    struct Installment: Sendable, Equatable {
        let number: Int
        let dueDate: String
        let paymentAmount: Double
        let principalAmount: Double
        let interestAmount: Double
        let remainingPrincipal: Double
    }

    /// The generator's return value.
    struct Answer: Sendable {
        let regularPaymentAmount: Double
        let firstDueDate: String?
        let schedule: [Installment]

        var json: JSONValue {
            .object([
                ("regular_payment_amount", JSValue.number(LoanSchedule.money(regularPaymentAmount)).envelopeValue),
                ("first_due_date", firstDueDate.map(JSONValue.string) ?? .null),
                ("schedule", .array(schedule.map { installment in
                    .object([
                        ("installment_number", .int(installment.number)),
                        ("due_date", .string(installment.dueDate)),
                        ("payment_amount", JSValue.number(LoanSchedule.money(installment.paymentAmount)).envelopeValue),
                        ("principal_amount", JSValue.number(LoanSchedule.money(installment.principalAmount)).envelopeValue),
                        ("interest_amount", JSValue.number(LoanSchedule.money(installment.interestAmount)).envelopeValue),
                        (
                            "remaining_principal",
                            JSValue.number(LoanSchedule.money(installment.remainingPrincipal)).envelopeValue
                        ),
                    ])
                })),
            ])
        }
    }

    /// JavaScript truthiness of a config value.
    static func truthy(_ value: JSValue) -> Bool {
        switch value {
        case .null: return false
        case .bool(let flag): return flag
        case .number(let number): return number != 0 && !number.isNaN
        case .string(let text): return !text.isEmpty
        default: return true
        }
    }

    /// `roundMoney(value, 2)`: half-even to two places, doubles in and out.
    static func money(_ value: Double) -> Double {
        guard let decimal = try? DecimalJS.from(SQLArguments.javaScriptText(value)) else { return value }
        return decimal.toDecimalPlaces(2).toNumber
    }

    /// The raw loan config fields, as the request body holds them.
    struct Config: Sendable {
        var loanType: JSValue?
        var loanPrincipal: JSValue?
        var loanAnnualInterestRate: JSValue?
        var loanTermMonths: JSValue?
        var loanStartDate: JSValue?
        var loanPaymentDay: JSValue?
    }

    /// `addMonthsAtDay`: `monthOffset` months after the base date, on `preferredDay`,
    /// clamped to the target month's last day. The base's own day-of-month is ignored
    /// (the TypeScript only reads the year and month of the split), and a year from 0 to 99
    /// means 1900 to 1999, as `Date.UTC` reads it.
    static func addMonthsAtDay(_ baseDateStr: String, _ monthOffset: Int, _ preferredDay: Int) -> String {
        let parts = baseDateStr.split(separator: "-", omittingEmptySubsequences: false)
            .map { JavaScriptNumber.fromString(String($0)) }
        let year = parts.count > 0 ? parts[0] : .nan
        let month = parts.count > 1 ? parts[1] : .nan
        guard month.isFinite, year.isFinite,
            let firstOfTargetDay = exactDay(
                CalendarDays.utc(year: Int(year), monthIndex: Int(month) - 1 + monthOffset, day: 1))
        else { return "Invalid Date" }
        // The last day of the target month is the 0th of the next.
        let lastDay: Int
        if let zeroth = exactDay(
            CalendarDays.utc(year: firstOfTargetDay.year, monthIndex: firstOfTargetDay.month, day: 0))
        {
            lastDay = zeroth.day
        } else {
            lastDay = 1
        }
        let day = max(1, min(LoanSchedule.nonZeroOr(preferredDay, 1), lastDay))
        guard let result = exactDay(
            CalendarDays.utc(year: firstOfTargetDay.year, monthIndex: firstOfTargetDay.month - 1, day: day))
        else { return "Invalid Date" }
        return "\(String(format: "%04d", result.year))-\(String(format: "%02d", result.month))-\(String(format: "%02d", result.day))"
    }

    /// A day number as an instant, or nil when the year and month cannot name one.
    private static func exactDay(_ epochMilliseconds: Int) ->
        (year: Int, month: Int, day: Int)?
    {
        guard epochMilliseconds.magnitude <= CalendarDays.dayLimit * CalendarDays.millisecondsPerDay else {
            return nil
        }
        let day = FormulaSemantics.CalendarDay(
            dayNumber: CalendarDays.floorDivide(epochMilliseconds, CalendarDays.millisecondsPerDay))
        return (day.year, day.month, day.day)
    }

    /// `nonZeroOr` of `lib/math.ts`.
    static func nonZeroOr(_ value: Double, _ fallback: Double) -> Double {
        value == 0 || value.isNaN ? fallback : value
    }

    /// `validateLoanConfig`: every field's reasons, in the module's order.
    static func validate(_ config: Config) -> (errors: [String], normalized: (
        loanType: String?, principal: Double, annualRate: Double, termMonths: Double,
        startDate: JSValue?, paymentDay: Double
    )) {
        var errors: [String] = []
        let principal = config.loanPrincipal?.javaScriptNumber ?? .nan
        let annualRate: Double
        if let rate = config.loanAnnualInterestRate, rate != .null {
            annualRate = rate.javaScriptNumber
        } else {
            annualRate = 0
        }
        let termMonths = config.loanTermMonths?.javaScriptNumber ?? .nan
        let paymentDay = config.loanPaymentDay?.javaScriptNumber ?? .nan
        let loanType = JavaScriptWhitespace.trim(truthy(config.loanType)
            ? config.loanType?.javaScriptString ?? ""
            : "")
        if loanType.isEmpty { errors.append("loan_type is required for loan planned transactions") }
        if !principal.isFinite || principal <= 0 {
            errors.append("loan_principal must be a positive number")
        }
        if !annualRate.isFinite || annualRate < 0 || annualRate > 100 {
            errors.append("loan_annual_interest_rate must be between 0 and 100")
        }
        if termMonths.rounded() != termMonths || !(1...600).contains(termMonths) {
            errors.append("loan_term_months must be an integer between 1 and 600")
        }
        var startShape: String?
        if let startDate = config.loanStartDate, truthy(startDate) {
            startShape = startDate.javaScriptString
        }
        guard let shape = startShape ?? "", TransactionsArea.isYmdShape(shape) else {
            errors.append("loan_start_date must be in YYYY-MM-DD format")
            if paymentDay.rounded() != paymentDay || !(1...31).contains(paymentDay) {
                errors.append("loan_payment_day must be an integer between 1 and 31")
            }
            return (errors, (nil, principal, annualRate, termMonths, config.loanStartDate ?? nil, paymentDay))
        }
        if paymentDay.rounded() != paymentDay || !(1...31).contains(paymentDay) {
            errors.append("loan_payment_day must be an integer between 1 and 31")
        }
        return (
            errors,
            (
                loanType.isEmpty ? nil : loanType, principal, annualRate, termMonths, config.loanStartDate ?? nil,
                paymentDay
            )
        )
    }

    /// `generateLoanRepaymentSchedule`: the schedule, or the 400 of its enumerated
    /// reasons / unsupported type.
    static func generate(_ config: Config) throws -> Answer {
        let validated = validate(config)
        guard validated.errors.isEmpty else {
            throw BackendHTTPError.validation("Invalid loan configuration: \(validated.errors.joined(separator: ", "))")
        }
        let loanType = validated.normalized.loanType ?? ""
        let principal = validated.normalized.principal
        let annualRate = validated.normalized.annualRate
        let termMonths = validated.normalized.termMonths
        let paymentDay = validated.normalized.paymentDay
        let startDate = validated.normalized.startDate

        let monthlyRate = annualRate / 100 / 12
        var remaining = principal
        var schedule: [Installment] = []

        let regularPayment: Double
        if loanType == "amortizing" {
            if abs(monthlyRate) < 0.0000001 {
                regularPayment = principal / termMonths
            } else {
                regularPayment = (principal * monthlyRate)
                    / (1 - Foundation.pow(1 + monthlyRate, -termMonths))
            }
        } else if loanType == "fixed_principal" {
            regularPayment = principal / termMonths
        } else if loanType == "interest_only" {
            regularPayment = principal * monthlyRate
        } else {
            throw BackendHTTPError.validation(
                "Unsupported loan_type '\(loanType)'. Use amortizing, fixed_principal, or interest_only."
            )
        }

        // A first installment before the loan exists shifts the whole schedule a month.
        let startDateStr = startDate?.javaScriptString ?? ""
        let startYmd = String(startDateStr.prefix(10))
        let monthOffset = addMonthsAtDay(
            startDateStr, 0, Int(validated.normalized.paymentDay)
        ) < startYmd ? 1 : 0

        for installment in 1...Int(termMonths) {
            let dueDate = addMonthsAtDay(startDateStr, installment - 1 + monthOffset, Int(paymentDay))
            let interestAmount = money(remaining * monthlyRate)
            var principalAmount: Double
            var paymentAmount: Double
            if loanType == "amortizing" {
                principalAmount = money(regularPayment - interestAmount)
                if installment == Int(termMonths) || principalAmount > remaining {
                    principalAmount = money(remaining)
                }
                paymentAmount = money(principalAmount + interestAmount)
            } else if loanType == "fixed_principal" {
                principalAmount = money(principal / termMonths)
                if installment == Int(termMonths) || principalAmount > remaining {
                    principalAmount = money(remaining)
                }
                paymentAmount = money(principalAmount + interestAmount)
            } else {
                principalAmount = installment == Int(termMonths) ? money(remaining) : 0
                paymentAmount = money(principalAmount + interestAmount)
            }
            remaining = money(max(0, remaining - principalAmount))
            schedule.append(
                Installment(
                    number: installment, dueDate: dueDate, paymentAmount: paymentAmount,
                    principalAmount: principalAmount, interestAmount: interestAmount,
                    remainingPrincipal: remaining))
        }
        return Answer(
            regularPaymentAmount: money(regularPayment), firstDueDate: schedule.first?.dueDate,
            schedule: schedule)
    }
}

